/**
 * The drop zone, on its own.
 *
 * Split out of GalleryEditor because it has two homes now. On the new-gallery
 * screen it is the large panel CLAUDE.md asks for, and dropping a folder there
 * has to *create* the gallery first -- that is what `ensureGallery` is for. On a
 * gallery that exists it is the first card in the photo grid, the same size as
 * the photographs beside it, and it only uploads: the slug is already known, so
 * choosing a photo touches nothing else.
 *
 * The constraint that outranks everything here: it has to be usable by someone
 * who does not know what a file path is. So one drop zone, per-file progress,
 * and errors in plain Polish with a way to try again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Uppy from '@uppy/core';
import Tus from '@uppy/tus';
// @uppy/react v6 is headless -- it exports hooks and primitives, not a
// Dashboard component. The Dashboard is still the right UI here (CLAUDE.md
// asks for per-file progress), so it is mounted as a plugin against a ref.
import Dashboard from '@uppy/dashboard';
import Polish from '@uppy/locales/lib/pl_PL';

import '@uppy/core/css/style.min.css';
import '@uppy/dashboard/css/style.min.css';

interface Props {
  /** Known on a gallery that exists; null on the screen that has yet to make one. */
  slug: string | null;
  /**
   * Called when files are dropped and there is no slug yet: creates the gallery
   * and answers with it. Absent when the gallery is already there.
   */
  ensureGallery?: () => Promise<string | null>;
  /**
   * 'card' sizes the drop zone like a photo in the grid it sits in; 'panel' is
   * the tall box on the screen where uploading is the only thing happening.
   */
  variant?: 'card' | 'panel';
}

export default function PhotoUploader({ slug, ensureGallery, variant = 'panel' }: Props) {
  const [uploading, setUploading] = useState(false);
  const [sent, setSent] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  /** Files are waiting because the gallery could not be created yet. */
  const [held, setHeld] = useState(false);

  const dashboardRef = useRef<HTMLDivElement | null>(null);

  /**
   * Where the card variant's status and error text actually render.
   *
   * The card is sized and shaped like the photographs beside it, and "Wysłano
   * 800 zdjęć" -- or a list of failures -- does not fit inside that without
   * either breaking the grid's row height or being truncated to nothing. So
   * for a card, this component's own DOM position is the drop zone only; the
   * text below is portalled to a plain div admin/g/[slug].astro places after
   * the whole grid, which is where it was always meant to be. The panel
   * variant has no such constraint and keeps rendering inline, below.
   */
  const [feedbackTarget, setFeedbackTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (variant !== 'card') return;
    setFeedbackTarget(document.getElementById('uploader-feedback'));
  }, [variant]);

  const uppy = useMemo(
    () =>
      new Uppy({
        locale: Polish,
        // Not autoProceed: on the empty screen a file cannot be attached to a
        // gallery that does not exist yet, so the first drop has to create one.
        // startUpload() below does that and then starts the transfer itself.
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

  /**
   * Which gallery the files in flight belong to.
   *
   * On the new-gallery screen that is only known once `ensureGallery` has
   * created it, and the page around this was rendered before that -- so this
   * is what the upload event carries out to the preparing banner, which
   * otherwise has no gallery to ask about.
   */
  const uploadedSlug = useRef<string | null>(slug);

  const startUpload = useCallback(async () => {
    const target = slug ?? (ensureGallery ? await ensureGallery() : null);
    if (!target) {
      setHeld(true);
      return;
    }
    setHeld(false);
    uploadedSlug.current = target;
    uppy.setMeta({ slug: target });
    try {
      await uppy.upload();
    } catch {
      // Per-file failures arrive through upload-error; this only catches a
      // refusal to start at all, which the dashboard already shows.
    }
  }, [slug, ensureGallery, uppy]);

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
      // A card is as tall as the photo beside it; the panel is a place to drop
      // eight hundred files into.
      height: variant === 'card' ? '100%' : 420,
      proudlyDisplayPoweredByUppy: false,
      note:
        variant === 'card'
          ? 'JPG i PNG'
          : 'Przeciągnij tutaj cały folder ze zdjęciami. JPG i PNG.',
      showRemoveButtonAfterComplete: false,
      // Uppy's own upload button would start a transfer without going through
      // startUpload(), which is where a missing gallery gets created and the
      // slug attached -- so those files would arrive with nothing to belong to
      // and be dropped by the tus hook. Adding files is the only trigger.
      hideUploadButton: true,
    });

    return () => {
      const plugin = uppy.getPlugin('Dashboard');
      if (plugin) uppy.removePlugin(plugin);
    };
  }, [uppy, variant]);

  useEffect(() => {
    const onFilesAdded = () => {
      void startUploadRef.current();
    };
    const onUploadStart = () => setUploading(true);
    const onSuccess = () => {
      setSent((count) => count + 1);
      // The moment one file finishes, its tus hook has already moved it into
      // originals/ and woken the worker server-side -- real work is underway
      // whether or not the page around this is watching for it. This is the
      // cross-island signal PreparingBanner.astro listens for, to show its
      // progress immediately rather than on the next visit or when a timed
      // poll notices a few seconds later. The slug rides along because on the
      // new-gallery screen the banner has no other way to learn it: that
      // gallery did not exist when the page was rendered.
      window.dispatchEvent(
        new CustomEvent('zdjecia-wyslane', { detail: { slug: uploadedSlug.current } }),
      );
    };
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

  const feedback = (
    <>
      {held && (
        <div className="errors" role="alert">
          {/* Usually because the gallery has no name yet -- and then the message
              under the details says which field, and the cursor is already in
              it. Worded to hold for the other reason too: a save that could not
              reach the server. */}
          <p>
            Zdjęcia czekają. Uzupełnij dane sesji powyżej, a potem naciśnij
            „Wyślij zdjęcia”.
          </p>
          <button type="button" onClick={() => void startUpload()}>
            Wyślij zdjęcia
          </button>
        </div>
      )}

      {sent > 0 && (
        <p className="status" role="status">
          {/* No "refresh the page" anymore: the banner below says the page
              updates itself, and it does -- reloading once, on its own, when
              the worker has finished. Two instructions that disagree is worse
              than one that is merely redundant. */}
          Wysłano {sent} {sent === 1 ? 'zdjęcie' : 'zdjęć'}.
        </p>
      )}

      {failed.length > 0 && (
        <div className="errors" role="alert">
          <p>
            Nie udało się wysłać {failed.length}{' '}
            {failed.length === 1 ? 'pliku' : 'plików'}. Możesz przeciągnąć te same
            pliki jeszcze raz — wysyłanie ruszy od miejsca, w którym się zatrzymało.
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

      {variant === 'panel' && (
        <p className="hint">
          Nie zamykaj tej karty w trakcie wysyłania. Jeśli komputer uśpi ekran,
          wysyłanie się zatrzyma i ruszy dalej, gdy go obudzisz.
        </p>
      )}
    </>
  );

  return (
    <div className={variant === 'card' ? 'uploader uploader-card' : 'uploader'}>
      <div className="uploader-zone" ref={dashboardRef} />
      {/* Portalled below the whole grid for the card variant, where there is
          room for "Wysłano 800 zdjęć" or a list of failures; rendered right
          here for the panel, which already has that room itself. Falls back
          to rendering inline if the target div is ever missing -- a message
          in a slightly wrong place beats one that silently never appears. */}
      {variant === 'card' && feedbackTarget ? createPortal(feedback, feedbackTarget) : feedback}
    </div>
  );
}
