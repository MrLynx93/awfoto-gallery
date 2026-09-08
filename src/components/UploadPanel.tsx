/**
 * The upload screen's only interactive part.
 *
 * The constraint that outranks everything here: it has to be usable by someone
 * who does not know what a file path is. So one drop zone, per-file progress,
 * and a finish line that is unmistakable — the link and the password, large,
 * with one button that copies them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
  slug: string;
  password: string;
  shareUrl: string;
}

export default function UploadPanel({ slug, password, shareUrl }: Props) {
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  const [copied, setCopied] = useState<'link' | 'both' | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dashboardRef = useRef<HTMLDivElement | null>(null);

  const uppy = useMemo(
    () =>
      new Uppy({
        locale: Polish,
        autoProceed: true,
        // Photographs only. Restricting here means a stray .DS_Store or an
        // XMP sidecar from the Lightroom folder is rejected before it costs
        // any transfer, rather than confusing the worker later.
        restrictions: { allowedFileTypes: ['image/jpeg', 'image/png', '.jpg', '.jpeg', '.png'] },
      }).use(Tus, {
        endpoint: '/admin/upload',
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

  useEffect(() => {
    if (!dashboardRef.current) return;

    uppy.use(Dashboard, {
      target: dashboardRef.current,
      inline: true,
      height: 420,
      proudlyDisplayPoweredByUppy: false,
      note: 'Przeciągnij tutaj cały folder ze zdjęciami. JPG i PNG.',
      showRemoveButtonAfterComplete: false,
    });

    return () => {
      const plugin = uppy.getPlugin('Dashboard');
      if (plugin) uppy.removePlugin(plugin);
    };
  }, [uppy]);

  useEffect(() => {
    uppy.setMeta({ slug });

    uppy.on('upload', () => setUploading(true));
    uppy.on('upload-success', () => setDone((count) => count + 1));
    uppy.on('upload-error', (file) => {
      setFailed((names) => [...names, file?.name ?? 'plik']);
    });
    uppy.on('complete', (result) => {
      setUploading(result.failed?.length ? false : false);
    });

    // Nothing transfers while the tab is closed. Closing at 80% pauses the
    // upload rather than destroying it, but she has no way to know that, so
    // the browser's own warning is the honest place to say "not yet".
    const warn = (event: BeforeUnloadEvent) => {
      if (!uploading) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uppy, slug, uploading]);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const copy = async (text: string, which: 'link' | 'both') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      copyTimer.current = setTimeout(() => setCopied(null), 2500);
    } catch {
      // Clipboard access can be refused; the values are on screen to be read.
      setCopied(null);
    }
  };

  return (
    <div className="panel">
      <section className="finish">
        <p className="finish-label">Link dla klienta</p>
        <p className="finish-link">{shareUrl}</p>

        <p className="finish-label">Hasło</p>
        <p className="finish-password">{password}</p>

        <div className="finish-actions">
          <button
            type="button"
            onClick={() => copy(`${shareUrl}\nHasło: ${password}`, 'both')}
          >
            {copied === 'both' ? 'Skopiowane ✓' : 'Kopiuj link i hasło'}
          </button>
          <button type="button" className="ghost" onClick={() => copy(shareUrl, 'link')}>
            {copied === 'link' ? 'Skopiowane ✓' : 'Tylko link'}
          </button>
        </div>

        <p className="finish-note">
          Link działa od razu. Dopóki zdjęcia się przetwarzają, klient zobaczy
          informację, że galeria się przygotowuje.
        </p>
      </section>

      <div ref={dashboardRef} />

      {done > 0 && (
        <p className="status" role="status">
          Wysłano {done} {done === 1 ? 'zdjęcie' : 'zdjęć'}.
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
          <button type="button" onClick={() => { setFailed([]); uppy.retryAll(); }}>
            Spróbuj ponownie
          </button>
        </div>
      )}

      <p className="hint">
        Nie zamykaj tej karty w trakcie wysyłania. Jeśli komputer uśpi ekran,
        wysyłanie się zatrzyma i ruszy dalej, gdy go obudzisz.
      </p>
    </div>
  );
}
