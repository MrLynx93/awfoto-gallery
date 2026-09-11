/**
 * A gallery's details, its link and its password.
 *
 * The link and the code come first, because that is what she opens the screen
 * for nine times out of ten -- to send them to a client, or to answer "what was
 * the password again?". The fields under them are corrections, and they save
 * themselves; the button below them only exists on the screen where the first
 * save has to *create* something.
 *
 * The photos are not in here. On a gallery that exists they are the page's own
 * grid, with the drop zone as its first card (PhotoUploader); on the empty
 * screen this component renders that uploader itself, because there dropping a
 * folder is what creates the gallery in the first place.
 *
 * Everything talks to /admin/api/galerie over fetch, and the page never
 * navigates: a reload would empty an upload queue mid-transfer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import PhotoUploader from './PhotoUploader.tsx';
// Pure string arithmetic, no server imports, so it bundles into the island --
// and the plural rule is written once for the whole panel.
import { dayCount } from '../../server/format.js';

export interface GalleryView {
  slug: string;
  sessionName: string;
  /** 'YYYY-MM-DD', or '' when she never set one. */
  sessionDate: string;
  status: string;
  photoCount: number;
  daysLeft: number | null;
  expired: boolean;
  shareUrl: string;
  path: string;
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
  /**
   * Present once there is a gallery to delete, absent on the new-gallery
   * screen. It is a link to the confirmation page rather than an action here:
   * the originals go with it.
   */
  deletePath?: string;
  /**
   * The new-gallery screen carries its own drop zone, because dropping a folder
   * there is one of the two ways a gallery gets created. A gallery that exists
   * has its uploader in the photo grid instead.
   */
  withUploader?: boolean;
}

/** '' means "leave the expiry alone", which is the default when editing. */
const UNCHANGED = '';

export default function GalleryEditor({
  gallery: initialGallery,
  password: initialPassword,
  expiryChoices,
  defaultExpiryDays,
  deletePath,
  withUploader = false,
}: Props) {
  const [gallery, setGallery] = useState<GalleryView | null>(initialGallery);
  const [password, setPassword] = useState<string | null>(initialPassword);

  const [sessionName, setSessionName] = useState(initialGallery?.sessionName ?? '');
  const [sessionDate, setSessionDate] = useState(initialGallery?.sessionDate ?? '');
  // A new gallery needs a term chosen for it; an existing one already has a
  // date, and touching nothing must not move it.
  const [expiryDays, setExpiryDays] = useState<string>(
    initialGallery ? UNCHANGED : String(defaultExpiryDays),
  );

  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'link' | 'password' | null>(null);

  const nameInput = useRef<HTMLInputElement | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirty =
    !gallery ||
    sessionName !== gallery.sessionName ||
    sessionDate !== gallery.sessionDate ||
    expiryDays !== UNCHANGED;

  const flashSaved = () => {
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSavedFlash(false), 2500);
  };

  /**
   * Creates the gallery, or writes the changed details to the one that exists.
   *
   * Returns the slug, or null if nothing was saved -- the caller needs to know,
   * because dropping photos into an empty screen waits on this. Concurrent
   * callers (a debounced autosave landing exactly as she drops a folder) share
   * one request rather than racing to create two galleries.
   */
  const inFlight = useRef<Promise<string | null> | null>(null);

  const save = useCallback(async (): Promise<string | null> => {
    if (inFlight.current) return inFlight.current;

    const name = sessionName.trim();
    if (!name) {
      setFormError('Wpisz nazwę sesji — będzie widoczna na stronie ze zdjęciami.');
      nameInput.current?.focus();
      return null;
    }

    const request = (async () => {
      setSaving(true);
      setFormError(null);
      try {
        const body: Record<string, unknown> = { sessionName: name, sessionDate };
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
        setSessionName(saved.sessionName);
        setSessionDate(saved.sessionDate);
        setExpiryDays(UNCHANGED);
        if (data.password) setPassword(data.password);
        flashSaved();

        // From here on this *is* the gallery's own page, so a refresh reopens it
        // rather than offering a blank form.
        if (!gallery) window.history.replaceState(null, '', saved.path);

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
  }, [sessionName, sessionDate, expiryDays, gallery]);

  /**
   * Saving a gallery that already exists is not something she should have to
   * ask for.
   *
   * Every field here is a correction to something already saved -- a name typed
   * as "Kasia" that should read "Kasia i Tomek", a date picked wrong -- and a
   * screen that keeps those changes hostage behind a button is a screen that
   * loses them when she navigates away. So they save themselves: a moment after
   * she stops typing, or the instant she leaves the field.
   *
   * Only for a gallery that exists. On the empty screen the first save *creates*
   * something, and creating a gallery from the first letter of a name (and again
   * from the second) is not the same kind of harmless.
   */
  useEffect(() => {
    if (!gallery || !dirty || saving) return;
    // An empty name is not a save, it is a field she is in the middle of
    // clearing. The blur handler surfaces the error if she leaves it that way.
    if (!sessionName.trim()) return;

    autosaveTimer.current = setTimeout(() => void save(), 800);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [gallery, dirty, saving, sessionName, save]);

  /** Leaving a field is a decision; it does not wait out the timer. */
  const saveNow = () => {
    if (!gallery || !dirty) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    void save();
  };

  // Several of these are open at once when she is catching up on a backlog,
  // and "Nowa galeria" five times over is no help in a row of tabs.
  //
  // The breadcrumb gets the same treatment. On every screen this island appears
  // on, the last crumb names the gallery -- "Nowa galeria" until it has a name,
  // the client's name after that -- and the page never reloads to correct
  // either one.
  useEffect(() => {
    if (!gallery) return;
    document.title = `${gallery.sessionName} — AW Fotografia`;
    const crumb = document.querySelector('[data-crumb-current]');
    if (crumb) crumb.textContent = gallery.sessionName;
  }, [gallery?.sessionName]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    },
    [],
  );

  /**
   * The link and the code copy separately, never together: one message with
   * both in it puts the key beside the door, and keeping them apart is the
   * entire reason the gallery has a password.
   */
  const copy = async (what: 'link' | 'password') => {
    const text = what === 'link' ? gallery?.shareUrl : password;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 2500);
    } catch {
      // Clipboard access can be refused; both values are on screen to be read.
      setCopied(null);
    }
  };

  return (
    <div className="editor">
      {/* The heading is here rather than on the page around it because it
          changes: a gallery created on this screen turns "Nowa galeria" into the
          client's name without a reload, and the expiry warning below has to be
          able to go away the moment she gives the gallery a new term. The way
          back to the list is the breadcrumb in the header. */}
      <header className="editor-head">
        <h1>{gallery ? gallery.sessionName : 'Nowa galeria'}</h1>
        {gallery && deletePath && (
          /* A real link, so it works before this island hydrates and without
             JavaScript at all -- it leads to the page that asks the same
             question. When the dialog the page renders is there, it is asked
             here instead, without leaving the gallery she is looking at. */
          <a
            className="delete"
            href={deletePath}
            onClick={(event) => {
              const dialog = document.getElementById('usun-dialog');
              if (dialog instanceof HTMLDialogElement) {
                event.preventDefault();
                dialog.showModal();
              }
            }}
          >
            Usuń galerię
          </a>
        )}
      </header>

      {gallery?.expired && (
        <p className="warn" role="alert">
          Termin tej galerii już minął — klient jej nie otworzy. Wybierz niżej
          nowy termin i zapisz, żeby znów była dostępna. Zdjęcia kasują się przy
          nocnym porządkowaniu, więc zrób to jak najszybciej.
        </p>
      )}

      {gallery ? (
        /* What she came for, at the top: two columns, each copied on its own. */
        <section className="finish">
          <div className="finish-part">
            <p className="finish-label">Link dla klienta</p>
            <p className="finish-link">{gallery.shareUrl}</p>
            <button type="button" onClick={() => copy('link')}>
              {copied === 'link' ? 'Skopiowane ✓' : 'Kopiuj link'}
            </button>
          </div>

          <div className="finish-part">
            <p className="finish-label">Hasło</p>
            {password ? (
              <>
                <p className="finish-password">{password}</p>
                <button type="button" onClick={() => copy('password')}>
                  {copied === 'password' ? 'Skopiowane ✓' : 'Kopiuj hasło'}
                </button>
              </>
            ) : (
              /* A plain form, not a button with JavaScript behind it, so it works
                 even if this island never hydrates. The page it posts to
                 redirects back here with the new password. */
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
          </div>
        </section>
      ) : (
        <p className="hint">
          Link dla klienta i hasło pojawią się tutaj, gdy zapiszesz galerię albo
          przeciągniesz pierwsze zdjęcia.
        </p>
      )}

      <section className="card">
        <h2 className="card-title">O sesji</h2>

        {/* Still a form, so Enter in a field saves rather than doing nothing,
            and so the empty screen has something for its button to submit. */}
        <form
          className="details"
          onSubmit={(event) => {
            event.preventDefault();
            if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
            void save();
          }}
        >
          <label>
            <span>Sesja</span>
            <input
              ref={nameInput}
              name="sessionName"
              type="text"
              required
              autoFocus={!gallery}
              placeholder="Zuzia i Marek"
              value={sessionName}
              onChange={(event) => setSessionName(event.target.value)}
              onBlur={saveNow}
            />
          </label>

          <label>
            <span>Data sesji</span>
            <input
              name="sessionDate"
              type="date"
              value={sessionDate}
              onChange={(event) => setSessionDate(event.target.value)}
              onBlur={saveNow}
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
                  {gallery.expired
                    ? 'Wybierz nowy termin'
                    : `Bez zmian (${dayCount(gallery.daysLeft ?? 0)})`}
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
            {gallery ? (
              /* No button: the fields above save themselves. This says which of
                 the three states it is in, and nothing when it is in none of
                 them -- a line that reads "Zapisane ✓" permanently is furniture,
                 not feedback. */
              <p className="details-state" role="status">
                {saving
                  ? 'Zapisuję…'
                  : savedFlash
                    ? 'Zapisane ✓'
                    : dirty
                      ? 'Zmiany zapiszą się same.'
                      : ''}
              </p>
            ) : (
              <>
                <button type="submit" disabled={saving}>
                  {saving ? 'Zapisuję…' : 'Zapisz i pokaż link'}
                </button>
                <p className="details-state" role="status">
                  {savedFlash ? 'Zapisane ✓' : ''}
                </p>
              </>
            )}
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

      {withUploader && (
        <section className="card">
          <h2 className="card-title">Zdjęcia</h2>
          <PhotoUploader slug={gallery?.slug ?? null} ensureGallery={save} variant="panel" />
        </section>
      )}
    </div>
  );
}
