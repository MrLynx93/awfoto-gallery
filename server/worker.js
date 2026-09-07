/**
 * Turns uploaded originals into a gallery a client can open.
 *
 *   node server/worker.js
 *
 * Never runs inside a request. She should not watch a spinner while 800 photos
 * resize — the upload returns the link the moment the bytes land, the gallery
 * reads "przygotowuję", and this catches up in the background.
 *
 * Started two ways, both needed: the tus completion hook spawns it detached,
 * and a five-minute cron re-runs it after a crash or a restart.
 */
import { mkdir, readdir, writeFile, stat, rm } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { db, migrate, close } from './db.js';
import { findBySlug, markReady } from './galleries.js';
import { makeDerivatives } from './images.js';
import { buildArchive, verifyArchive } from './archive.js';
import { canFit } from './disk.js';
import {
  galleryDir,
  originalsDir,
  previewsDir,
  previewPath,
  archivePath,
  manifestPath,
} from './storage.js';
import { STORAGE_ROOT } from './config.js';

const LOCK_PATH = path.join(STORAGE_ROOT, 'worker.lock');

/**
 * One worker at a time, enforced by an exclusive create.
 *
 * `wx` fails if the file exists, which is atomic on every filesystem that
 * matters — no `lockf(1)` subprocess to keep alive, and no second process
 * competing for the account's 40. A stale lock from a killed worker is cleared
 * on age rather than trusted forever.
 */
async function acquireLock({ staleAfterMs = 60 * 60_000 } = {}) {
  await mkdir(STORAGE_ROOT, { recursive: true });

  try {
    const handle = await open(LOCK_PATH, 'wx');
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const { mtimeMs } = await stat(LOCK_PATH);
  if (Date.now() - mtimeMs > staleAfterMs) {
    console.warn('[worker] clearing a stale lock');
    await rm(LOCK_PATH, { force: true });
    return acquireLock({ staleAfterMs });
  }

  return false;
}

const releaseLock = () => rm(LOCK_PATH, { force: true });

/** Galleries whose files have landed but which are not yet ready. */
async function pending() {
  const [rows] = await db().query(
    `SELECT slug FROM galleries
      WHERE deleted_at IS NULL AND status = 'preparing'
      ORDER BY created_at ASC`,
  );
  return rows.map((row) => row.slug);
}

async function processGallery(slug, { log = console.log } = {}) {
  const gallery = await findBySlug(slug);
  if (!gallery) return;

  const originals = originalsDir(slug);
  let files;
  try {
    files = (await readdir(originals)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  } catch {
    log(`[worker] ${slug}: no originals directory yet, skipping`);
    return;
  }
  if (files.length === 0) {
    log(`[worker] ${slug}: no photos yet, skipping`);
    return;
  }

  await mkdir(previewsDir(slug), { recursive: true });
  log(`[worker] ${slug}: ${files.length} photos`);

  const photos = [];
  let derivativeBytes = 0;
  let originalBytes = 0;

  // Strictly one at a time. Not only for memory: the account allows 40
  // processes in total, shared with Passenger and cron, so fanning out would
  // starve the web server that still has to answer clients.
  for (const [index, filename] of files.entries()) {
    const src = path.join(originals, filename);
    try {
      const result = await makeDerivatives(src, (size) => previewPath(slug, index, size));
      originalBytes += (await stat(src)).size;
      derivativeBytes += result.bytes;
      photos.push({
        index,
        filename,
        width: result.width,
        height: result.height,
        bytes: (await stat(src)).size,
      });
    } catch (error) {
      // One unreadable file should not cost the client the other 799.
      log(`[worker] ${slug}: skipping ${filename} — ${error.message.split('\n')[0]}`);
    }
  }

  if (photos.length === 0) {
    await markReady(slug, { photoCount: 0, bytesTotal: 0, status: 'failed' });
    log(`[worker] ${slug}: no photo could be processed — marked failed`);
    return;
  }

  // Re-index so the manifest is dense: a skipped file must not leave a gap the
  // grid would render as a broken image.
  photos.forEach((photo, position) => {
    photo.index = position;
  });

  let status = 'ready';
  let archiveBytes = 0;

  if (await canFit(originalBytes)) {
    try {
      const archive = await buildArchive(originals, archivePath(slug));
      archiveBytes = archive.bytes;

      // Names stored as raw UTF-8 without the flag reach Windows as mojibake.
      // Rare with camera exports, and worth saying out loud when it happens
      // rather than letting a client puzzle over it.
      const { unflagged } = await verifyArchive(archive.path);
      if (unflagged.length > 0) {
        log(
          `[worker] ${slug}: ${unflagged.length} filename(s) may show incorrectly ` +
            `on Windows, e.g. ${unflagged[0]}`,
        );
      }
    } catch (error) {
      log(`[worker] ${slug}: archive failed — ${error.message.split('\n')[0]}`);
      status = 'zip_unavailable';
    }
  } else {
    // The gallery still works; only the download-everything button changes,
    // and that path streams on demand instead.
    log(`[worker] ${slug}: over the disk budget — serving without a prebuilt archive`);
    status = 'zip_unavailable';
  }

  await writeFile(
    manifestPath(slug),
    JSON.stringify({ slug, photos }, null, 2) + '\n',
  );

  await markReady(slug, {
    photoCount: photos.length,
    bytesTotal: originalBytes + derivativeBytes + archiveBytes,
    status,
  });

  log(`[worker] ${slug}: ${status}, ${photos.length} photos`);
}

export async function runOnce({ log = console.log } = {}) {
  if (!(await acquireLock())) {
    log('[worker] another worker holds the lock');
    return 0;
  }

  try {
    await migrate({ log: () => {} });
    const slugs = await pending();
    for (const slug of slugs) await processGallery(slug, { log });
    return slugs.length;
  } finally {
    await releaseLock();
  }
}

// Only when run directly, so importing this module for a test does no work.
if (process.argv[1] && process.argv[1].endsWith('worker.js')) {
  try {
    const count = await runOnce();
    console.log(`[worker] done (${count} galleries)`);
  } finally {
    await close();
  }
}
