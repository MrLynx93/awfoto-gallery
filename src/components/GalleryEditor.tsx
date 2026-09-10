/**
 * One screen for a gallery: its details, its link and password, and the photos.
 *
 * This replaces a two-page wizard -- name the session, then upload on the next
 * page -- for two reasons. The obvious one is that there was never enough on
 * either page to justify the step. The one that decided it is resumability: the
 * drop zone has to stay put while photos are transferring, so changing a name
 * or a date cannot be a form POST that reloads the page and throws away the
 * queue. Everything here talks to /admin/api/galerie over fetch, and the page
 * does not navigate once it is open.
 *
 * The same component is the edit screen, opened from the dashboard. An existing
 * gallery only differs in what it starts with: its details are filled in, and
 * its expiry already has a date, so the dropdown offers "leave it as it is"
 * alongside a new term.
 *
 * The constraint that outranks everything here: it has to be usable by someone
 * who does not know what a file path is. So one drop zone, per-file progress,
 * errors in plain Polish, and a finish line that is unmistakable -- the link and
 * the password, large, with one button that copies both.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Uppy from '@uppy/core';
import Tus from '@uppy/tus';
// @uppy/react v6 is headless -- it exports hooks and primitives, not a
// Dashboard component. The Dashboard is still the right UI here (CLAUDE.md
// asks for per-file progress), so it is mounted as a plugin against a ref.
import Dashboard from '@uppy/dashboard';
import Polish from '@uppy/locales/lib/pl_PL';

import '@uppy/core/css/style.min.css';
import '@uppy/dashboard/css/style.min.css';

export interface GalleryView {
  slug: string;
  clientName: string;
  /** 'YYYY-MM-DD', or '' when she never set one. */
  shootDate: string;
  status: string;
  photoCount: number;
  daysLeft: number | null;
  expired: boolean;
  shareUrl: string;
  editPath: string;
  viewPath: string;
}

interface ExpiryChoice {
  days: number;
  label: string;
}

interface Props {
  /** null on the new-gallery screen; the gallery itself when editing one. */
  gallery: GalleryView | null;
  /**
   * Null only for a gallery made before passwords were stored readably, or one
   * sealed under a SESSION_SECRET that has since been rotated. Otherwise it is
   * simply here, every time this screen is opened -- see server/passwords.js.
   */
  password: string | null;
  expiryChoices: ExpiryChoice[];
  defaultExpiryDays: number;
}

const STATUS_NOTE: Record<string, string> = {
  preparing: 'Przygotowuję zdjęcia. Klient widzi na razie informację, że galeria się szykuje.',
  ready: 'Galeria jest gotowa — klient widzi zdjęcia i może pobrać wszystkie naraz.',
  failed: 'Coś się nie udało przy przygotowaniu zdjęć. Spróbuj wysłać je jeszcze raz.',
  zip_unavailable:
    'Galeria jest gotowa. Paczka ZIP powstanie dopiero przy pobieraniu, bo na serwerze jest mało miejsca.',
};

/** '' means "leave the expiry alone", which is the default when editing. */
const UNCHANGED = '';

export default function GalleryEditor({
  gallery: initialGallery,
  password: initialPassword,
  expiryChoices,
  defaultExpiryDays,
}: Props) {
  const [gallery, setGallery] = useState<GalleryView | null>(initialGallery);
  const [password, setPassword] = useState<string | null>(initialPassword);

  const [clientName, setClientName] = useState(initialGallery?.clientName ?? '');
  const [shootDate, setShootDate] = useState(initialGallery?.shootDate ?? '');
  // A new gallery needs a term chosen for it; an existing one already has a
  // date, and touching nothing must not move it.
  const [expiryDays, setExpiryDays] = useState<string>(
    initialGallery ? UNCHANGED : String(defaultExpiryDays),
  );

  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [sent, setSent] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  /** Files are waiting because the gallery could not be saved -- usually no name. */
  const [held, setHeld] = useState(false);

  const [copied, setCopied] = useState<'link' | 'both' | null>(null);

  const nameInput = useRef<HTMLInputElement | null>(null);
  const dashboardRef = useRef<HTMLDivElement | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirty =
    !gallery ||
    clientName !== gallery.clientName ||
    shootDate !== gallery.shootDate ||
    expiryDays !== UNCHANGED;

  const uppy = useMemo(
    () =>
      new Uppy({
        locale: Polish,
        // Not autoProceed: a file cannot be attached to a gallery that does not
        // exist yet, so the first drop has to create one first. startUpload()
        // below does that and then starts the transfer itself.
        autoProceed: false,
        // Photographs only. Restricting here means a stray .DS_Store or an
        // XMP sidecar from the Lightroom folder is rejected before it costs
        // any transfer, rather than confusing the worker later.
        restrictions: { allowedFileTypes: ['image/jpeg', 'image/png', '.jpg', '.jpeg', '.png'] },
      }).use(Tus, {
        // Absolute, from the page's own origin. tus-js-client resolves the
        // server's Location against this endpoint, and giving it a relative
        // base leaves that resolution dependent on document state we do not
        // control. The page is served over https, so this is too.
        endpoint:
          typeof window === 'undefined'
            ? '/admin/upload'
            : `${window.location.origin}/admin/upload`,
        // 6 MB: comfortably under any proxy body limit, and small enough that a
        // dropped connection costs seconds rather than minutes of re-transfer.
        chunkSize: 6 * 1024 * 1024,
        // The whole point. Without this Uppy does not remember an interrupted
        // upload, and re-adding the same folder starts from zero.
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        retryDelays: [0, 1000, 3000, 5000, 10_000],
      }),
    [],
  );

  const flashSaved = () => {
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSavedFlash(false), 2500);
  };

  /**
   * Creates the gallery, or writes the changed details to the one that exists.
   *
   * Returns the slug, or null if nothing was saved -- the caller needs to know,
   * because dropping photos in waits on this. Concurrent callers (she presses
   * save exactly as the first file lands) share one request rather than racing
   * to create two galleries.
   */
  const inFlight = useRef<Promise<string | null> | null>(null);

  const save = useCallback(async (): Promise<string | null> => {
    if (inFlight.current) return inFlight.current;

    const name = clientName.trim();
    if (!name) {
      setFormError('Wpisz imię klienta — będzie widoczne na stronie ze zdjęciami.');
      nameInput.current?.focus();
      return null;
    }

    const request = (async () => {
      setSaving(true);
      setFormError(null);
      try {
        const body: Record<string, unknown> = { clientName: name, shootDate };
        // Absent means "leave it": the server cannot tell "30 days" applied to a
        // gallery created three weeks ago from a deliberate new term.
        if (expiryDays !== UNCHANGED) body.expiryDays = Number(expiryDays);

        const response = gallery
          ? await fetch(`/admin/api/galerie/${gallery.slug}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
          : await fetch('/admin/api/galerie', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          setFormError(data.error ?? 'Nie udało się zapisać. Spróbuj jeszcze raz.');
          return null;
        }

        const saved: GalleryView = data.gallery;
        setGallery(saved);
        setClientName(saved.clientName);
        setShootDate(saved.shootDate);
        setExpiryDays(UNCHANGED);
        if (data.password) setPassword(data.password);
        flashSaved();

        // From here on this *is* the gallery's own page, so a refresh reopens it
        // rather than offering a blank form -- and the password cookie, scoped to
        // this path, is sent when it does.
        if (!gallery) window.history.replaceState(null, '', saved.editPath);

        return saved.slug;
      } catch {
        setFormError('Brak połączenia z serwerem. Sprawdź internet i spróbuj jeszcze raz.');
        return null;
      } finally {
        setSaving(false);
      }
    })();

    inFlight.current = request;
    try {
      return await request;
    } finally {
      inFlight.current = null;
    }
  }, [clientName, shootDate, expiryDays, gallery]);

  /**
   * Starts (or resumes) the transfer, creating the gallery first if needed.
   *
   * Called when files are dropped, and again by the "wyślij zdjęcia" button when
   * the first attempt was held back for want of a client name.
   */
  const startUpload = useCallback(async () => {
    const slug = dirty ? await save() : gallery?.slug ?? null;
    if (!slug) {
      setHeld(true);
      return;
    }
    setHeld(false);
    uppy.setMeta({ slug });
    try {
      await uppy.upload();
    } catch {
      // Per-file failures arrive through upload-error; this only catches a
      // refusal to start at all, which the dashboard already shows.
    }
  }, [dirty, save, gallery, uppy]);

  // Uppy's listeners are attached once, so they must not close over state that
  // changes. They call through these refs instead -- an earlier version
  // re-subscribed on every render and stacked up duplicate handlers.
  const startUploadRef = useRef(startUpload);
  const uploadingRef = useRef(uploading);
  useEffect(() => {
    startUploadRef.current = startUpload;
    uploadingRef.current = uploading;
  });

  useEffect(() => {
    if (!dashboardRef.current) return;

    uppy.use(Dashboard, {
      target: dashboardRef.current,
      inline: true,
      height: 420,
      proudlyDisplayPoweredByUppy: false,
      note: 'Przeciągnij tutaj cały folder ze zdjęciami. JPG i PNG.',
      showRemoveButtonAfterComplete: false,
      // Uppy's own upload button would start a transfer without going through
      // startUpload(), which is where the gallery gets created and the slug
      // attached -- so those files would arrive with nothing to belong to and be
      // dropped by the tus hook. Adding files is the only trigger there is.
      hideUploadButton: true,
    });

    return () => {
      const plugin = uppy.getPlugin('Dashboard');
      if (plugin) uppy.removePlugin(plugin);
    };
  }, [uppy]);

  useEffect(() => {
    const onFilesAdded = () => {
      void startUploadRef.current();
    };
    const onUploadStart = () => setUploading(true);
    const onSuccess = () => setSent((count) => count + 1);
    const onError = (file?: { name?: string }) => {
      setFailed((names) => [...names, file?.name ?? 'plik']);
    };
    const onComplete = () => setUploading(false);

    uppy.on('files-added', onFilesAdded);
    uppy.on('upload', onUploadStart);
    uppy.on('upload-success', onSuccess);
    uppy.on('upload-error', onError);
    uppy.on('complete', onComplete);

    return () => {
      uppy.off('files-added', onFilesAdded);
      uppy.off('upload', onUploadStart);
      uppy.off('upload-success', onSuccess);
      uppy.off('upload-error', onError);
      uppy.off('complete', onComplete);
    };
  }, [uppy]);

  // Nothing transfers while the tab is closed. Closing at 80% pauses the
  // upload rather than destroying it, but she has no way to know that, so
  // the browser's own warning is the honest place to say "not yet".
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!uploadingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // Several of these are open at once when she is catching up on a backlog,
  // and "Nowa galeria" five times over is no help in a row of tabs.
  useEffect(() => {
    if (gallery) document.title = `${gallery.clientName} — AW Fotografia`;
  }, [gallery?.clientName]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const copy = async (text: string, which: 'link' | 'both') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 2500);
    } catch {
      // Clipboard access can be refused; the values are on screen to be read.
      setCopied(null);
    }
  };

  return (
    <div className="editor">
      {/* The heading is here rather than on the page around it because it
          changes: a gallery created on this screen turns "Nowa galeria" into the
          client's name without a reload, and the expiry warning below has to be
          able to go away the moment she gives the gallery a new term. */}
      <header className="editor-head">
        <h1>{gallery ? gallery.clientName : 'Nowa galeria'}</h1>
        <a className="back" href="/admin">
          Wszystkie galerie
        </a>
      </header>

      {gallery?.expired && (
        <p className="warn" role="alert">
          Termin tej galerii już minął — klient jej nie otworzy. Wybierz niżej
          nowy termin i zapisz, żeby znów była dostępna. Zdjęcia kasują się przy
          nocnym porządkowaniu, więc zrób to jak najszybciej.
        </p>
      )}

      <section className="card">
        <h2 className="card-title">O sesji</h2>

        <form
          className="details"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            <span>Imię klienta</span>
            <input
              ref={nameInput}
              name="clientName"
              type="text"
              required
              autoFocus={!gallery}
              placeholder="Zuzia i Marek"
              value={clientName}
              onChange={(event) => setClientName(event.target.value)}
            />
          </label>

          <label>
            <span>Data sesji</span>
            <input
              name="shootDate"
              type="date"
              value={shootDate}
              onChange={(event) => setShootDate(event.target.value)}
            />
          </label>

          <label>
            <span>{gallery ? 'Termin galerii' : 'Galeria zniknie po'}</span>
            <select
              name="expiryDays"
              value={expiryDays}
              onChange={(event) => setExpiryDays(event.target.value)}
            >
              {gallery && (
                <option value={UNCHANGED}>
                  {gallery.expired ? 'Wybierz nowy termin' : `Bez zmian (${gallery.daysLeft} dni)`}
                </option>
              )}
              {expiryChoices.map((choice) => (
                <option key={choice.days} value={choice.days}>
                  {gallery ? `${choice.label} od dziś` : choice.label}
                </option>
              ))}
            </select>
          </label>

          <div className="details-actions">
            <button type="submit" disabled={saving || (!dirty && Boolean(gallery))}>
              {saving ? 'Zapisuję…' : gallery ? 'Zapisz zmiany' : 'Zapisz i pokaż link'}
            </button>
            <p className="details-state" role="status">
              {savedFlash ? 'Zapisane ✓' : dirty && gallery ? 'Są niezapisane zmiany.' : ''}
            </p>
          </div>
        </form>

        {formError && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}

        <p className="card-note">
          Zdjęcia kasują się same po upływie terminu, żeby na serwerze było miejsce
          na kolejne sesje.
        </p>
      </section>

      {gallery ? (
        <section className="finish">
          <p className="finish-label">Link dla klienta</p>
          <p className="finish-link">{gallery.shareUrl}</p>

          {password ? (
            <>
              <p className="finish-label">Hasło</p>
              <p className="finish-password">{password}</p>
            </>
          ) : (
            /* A plain form, not a button with JavaScript behind it, so it works
               even if this island never hydrates. The page it posts to redirects
               back here with the new password. */
            <form className="repass" method="POST">
              <p>
                Tej galerii nie da się już odczytać hasła — powstała, zanim panel
                zaczął je zapamiętywać. Ustaw nowe i wyślij je klientowi; stare
                przestanie wtedy działać.
              </p>
              <button type="submit" name="intent" value="new-password">
                Ustaw nowe hasło
              </button>
            </form>
          )}

          <div className="finish-actions">
            {password && (
              <button
                type="button"
                onClick={() => copy(`${gallery.shareUrl}\nHasło: ${password}`, 'both')}
              >
                {copied === 'both' ? 'Skopiowane ✓' : 'Kopiuj link i hasło'}
              </button>
            )}
            <button
              type="button"
              className="ghost"
              onClick={() => copy(gallery.shareUrl, 'link')}
            >
              {copied === 'link' ? 'Skopiowane ✓' : password ? 'Tylko link' : 'Kopiuj link'}
            </button>
            {/* Her own view of the gallery -- no password gate. The link above
                is the client's and does ask for one. */}
            <a className="ghost" href={gallery.viewPath}>
              Zobacz zdjęcia
            </a>
          </div>

          <p className="finish-note">
            {STATUS_NOTE[gallery.status] ?? 'Link działa od razu.'}
            {gallery.photoCount > 0 && ` W galerii jest ${gallery.photoCount} zdjęć.`}
          </p>
        </section>
      ) : (
        <p className="hint">
          Link dla klienta i hasło pojawią się tutaj, gdy zapiszesz galerię albo
          przeciągniesz pierwsze zdjęcia.
        </p>
      )}

      <section className="card">
        <h2 className="card-title">Zdjęcia</h2>

        {held && (
          <div className="errors" role="alert">
            {/* Usually because the gallery has no name yet -- and then the
                message under the details says which field, and the cursor is
                already in it. Worded to hold for the other reason too: a save
                that could not reach the server. */}
            <p>
              Zdjęcia czekają. Uzupełnij dane sesji powyżej, a potem naciśnij
              „Wyślij zdjęcia”.
            </p>
            <button type="button" onClick={() => void startUpload()}>
              Wyślij zdjęcia
            </button>
          </div>
        )}

        <div ref={dashboardRef} />

        {sent > 0 && (
          <p className="status" role="status">
            Wysłano {sent} {sent === 1 ? 'zdjęcie' : 'zdjęć'}.
          </p>
        )}

        {failed.length > 0 && (
          <div className="errors" role="alert">
            <p>
              Nie udało się wysłać {failed.length}{' '}
              {failed.length === 1 ? 'pliku' : 'plików'}. Możesz przeciągnąć te
              same pliki jeszcze raz — wysyłanie ruszy od miejsca, w którym się
              zatrzymało.
            </p>
            <button
              type="button"
              onClick={() => {
                setFailed([]);
                void uppy.retryAll();
              }}
            >
              Spróbuj ponownie
            </button>
          </div>
        )}

        <p className="hint">
          Nie zamykaj tej karty w trakcie wysyłania. Jeśli komputer uśpi ekran,
          wysyłanie się zatrzyma i ruszy dalej, gdy go obudzisz.
        </p>
      </section>
    </div>
  );
}
