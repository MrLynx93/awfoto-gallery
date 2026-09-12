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
 *
 * Every photo is addressed by its id (server/photos.js), which is what makes
 * this safe to re-run at any moment: the work it skips is "this photo already
 * has its derivatives", a question about the photograph itself rather than
 * about a position that another photo may have moved into since.
 */
import { mkdir, readdir, writeFile, stat, rm } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { migrate, close } from './db.js';
import { findBySlug, markReady, needingWork } from './galleries.js';
import { makeDerivatives, dimensions } from './images.js';
import { buildArchive, verifyArchive } from './archive.js';
import { canFit } from './disk.js';
import {
  listPhotos,
  originalPath,
  previewsDir,
  previewPath,
  archivePath,
  manifestPath,
  readManifest,
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

/**
 * How long after the last file lands a gallery is considered finished.
 *
 * Uploads arrive one at a time, so "no files for a while" is the only signal
 * available that she has stopped. Long enough to bridge a slow file on a
 * domestic connection; short enough that she is not left watching
 * "przygotowuję" after the last photo.
 */
const QUIET_PERIOD_MS = 45_000;

/** How long a single run will keep waiting for an upload batch to settle. */
const MAX_WAIT_MS = 20 * 60_000;
const POLL_MS = 10_000;

/**
 * The grid reads this, in the order it draws. Written at the end of every run,
 * not only the run that finishes the gallery: it is what the pages render
 * from, and a batch that is still arriving should still show what is ready.
 */
const writeManifest = (slug, photos) =>
  writeFile(manifestPath(slug), JSON.stringify({ slug, photos }, null, 2) + '\n');

/** A manifest entry the grid can lay out without guessing. */
const measured = (photo) => Number(photo?.width) > 0 && Number(photo?.height) > 0;

const PREVIEW_PATTERN = /^(.+)-(thumb|large)\.jpg$/;

/**
 * Previews belonging to no photo this gallery still has.
 *
 * Nothing routine produces these -- a delete takes its own four files with it
 * -- so this is for the half-finished ones: a delete interrupted between two
 * unlinks, or an original removed from under the application. Left alone they
 * would cost disk and nothing else. They cannot be served (no manifest entry
 * names them) and they cannot be mistaken for another photo's, which is the
 * part that used to hurt.
 */
async function sweepOrphanPreviews(slug, photos, log) {
  const live = new Set(photos.map((photo) => photo.id));

  let swept = 0;
  for (const name of await readdir(previewsDir(slug)).catch(() => [])) {
    const match = PREVIEW_PATTERN.exec(name);
    if (!match || live.has(match[1])) continue;
    await rm(path.join(previewsDir(slug), name), { force: true });
    swept += 1;
  }

  if (swept > 0) log(`[worker] ${slug}: removed ${swept} preview(s) with no photo behind them`);
}

/**
 * Brings one gallery up to date.
 *
 * Returns 'done' when the gallery is finished, 'waiting' when photos are still
 * arriving and it should be revisited, or 'idle' when there was nothing to do.
 *
 * Derivatives are made incrementally -- only for photos that do not have them
 * yet -- so this is safe to run repeatedly while an upload is in progress, and
 * previews appear as photos land rather than all at the end.
 */
async function processGallery(slug, { log = console.log } = {}) {
  const gallery = await findBySlug(slug);
  if (!gallery) return 'idle';

  // Disk is the truth, and one record per photo is what it says. A record
  // whose bytes never arrived is named rather than silently skipped: it is the
  // only trace of an upload hook that died mid-move.
  const uploaded = await listPhotos(slug, {
    onIncomplete: (record) =>
      log(`[worker] ${slug}: no bytes for ${record.filename ?? record.id} — upload interrupted`),
  });
  if (uploaded.length === 0) return 'idle';

  // What the last run recorded, keyed by id: it carries the proportions the
  // grid needs, which are cheap to carry forward and a subprocess each to
  // measure again.
  const previous = await readManifest(slug).catch(() => null);
  const before = new Map((previous?.photos ?? []).map((photo) => [photo.id, photo]));

  // Still arriving? Generate derivatives for what is here, but do not finalise:
  // building the archive now would only mean rebuilding it for the next photo,
  // and marking the gallery ready would hide the ones still to come.
  const lastUpload = gallery.lastUploadAt ? new Date(gallery.lastUploadAt).getTime() : 0;
  const quiet = Date.now() - lastUpload > QUIET_PERIOD_MS;

  // Nothing new since the last run, and already finished.
  if (quiet && gallery.status !== 'preparing' && gallery.photoCount === uploaded.length) {
    return 'idle';
  }

  await mkdir(previewsDir(slug), { recursive: true });

  const photos = [];
  let derivativeBytes = 0;
  let originalBytes = 0;

  // Strictly one at a time. Not only for memory: the account allows 40
  // processes in total, shared with Passenger and cron, so fanning out would
  // starve the web server that still has to answer clients.
  let made = 0;
  for (const record of uploaded) {
    const src = originalPath(slug, record.id, record.ext);
    try {
      // Already has both derivatives from an earlier run: count it, skip the
      // work. The question is about this photo, so the answer stays right no
      // matter what has been added or removed around it.
      const thumb = previewPath(slug, record.id, 'thumb');
      const large = previewPath(slug, record.id, 'large');
      const existing = await Promise.all([
        stat(thumb).catch(() => null),
        stat(large).catch(() => null),
      ]);

      const bytes = (await stat(src)).size;
      let size;

      if (existing[0] && existing[1]) {
        derivativeBytes += existing[0].size + existing[1].size;

        // Proportions come from the last manifest when it has them, and from
        // the thumbnail when it does not -- the thumbnail rather than the
        // original because it is the orientation the grid will draw, and
        // because measuring a 500 px JPEG costs nothing next to a 45 MP one.
        const known = before.get(record.id);
        size = measured(known)
          ? { width: known.width, height: known.height }
          : await dimensions(thumb).catch(() => ({ width: null, height: null }));
      } else {
        made += 1;
        const result = await makeDerivatives(src, (which) => previewPath(slug, record.id, which));
        derivativeBytes += result.bytes;
        size = { width: result.width, height: result.height };
      }

      originalBytes += bytes;
      photos.push({
        id: record.id,
        filename: record.filename,
        ext: record.ext,
        width: size.width,
        height: size.height,
        bytes,
      });
    } catch (error) {
      // One unreadable file should not cost the client the other 799.
      log(`[worker] ${slug}: skipping ${record.filename ?? record.id} — ${error.message.split('\n')[0]}`);
    }
  }

  if (made > 0) log(`[worker] ${slug}: prepared ${made} of ${uploaded.length} photos`);

  if (photos.length === 0) {
    await markReady(slug, { photoCount: 0, bytesTotal: 0, status: 'failed' });
    log(`[worker] ${slug}: no photo could be processed — marked failed`);
    return 'done';
  }

  await sweepOrphanPreviews(slug, photos, log);
  await writeManifest(slug, photos);

  // Photos are still landing. Leave the gallery preparing and come back.
  if (!quiet) return 'waiting';

  let status = 'ready';
  let archiveBytes = 0;

  if (await canFit(originalBytes)) {
    try {
      // Entry names are the filenames she exported, not the ids the bytes are
      // stored under -- the client's downloads folder is the whole point of
      // keeping those names at all.
      const archive = await buildArchive(
        photos.map((photo) => ({
          path: originalPath(slug, photo.id, photo.ext),
          name: photo.filename,
        })),
        archivePath(slug),
      );
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

  await markReady(slug, {
    photoCount: photos.length,
    bytesTotal: originalBytes + derivativeBytes + archiveBytes,
    status,
  });

  log(`[worker] ${slug}: ${status}, ${photos.length} photos`);
  return 'done';
}


export async function runOnce({ log = console.log } = {}) {
  if (!(await acquireLock())) {
    log('[worker] another worker holds the lock');
    return 0;
  }

  try {
    await migrate({ log: () => {} });

    // Keeps working until every gallery has settled. A batch of 800 photos
    // arrives over many minutes, and each completed upload spawns a worker that
    // finds this one holding the lock and exits -- so this run has to be the one
    // that waits, rather than relying on a spawn that will not happen again
    // after the last file.
    const deadline = Date.now() + MAX_WAIT_MS;
    let finished = 0;

    for (;;) {
      let waiting = 0;

      for (const gallery of await needingWork()) {
        const outcome = await processGallery(gallery.slug, { log });
        if (outcome === 'waiting') waiting += 1;
        if (outcome === 'done') finished += 1;
      }

      if (waiting === 0) break;

      if (Date.now() > deadline) {
        log('[worker] gave up waiting for uploads to settle; cron will finish');
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    return finished;
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
