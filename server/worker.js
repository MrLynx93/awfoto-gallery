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
import { setPhotoAside } from './photos.js';
import { forgetUploaders, uploaderState } from './uploaders.js';
import {
  incomingDir,
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
 * Touched by `wakeWorker()` every time something asks for a run.
 *
 * The spawn it makes alongside is usually the worker; when one is already
 * holding the lock, the spawn exits immediately and this file is all that is
 * left of the request. Reading it before finishing is what keeps that request
 * from being dropped -- see the loop in runOnce().
 */
export const WAKE_PATH = path.join(STORAGE_ROOT, 'worker.wake');

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

/** When the last request for a run came in, or 0 if none ever has. */
const wakeMark = () => stat(WAKE_PATH).then((s) => s.mtimeMs).catch(() => 0);

/** A tuning knob, overridable on the host without a deploy. */
const tuning = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * How long after the last sign of an upload a gallery is considered finished.
 *
 * This is the **fallback** now: when the uploader says a batch is finished
 * (server/uploaders.js) there is nothing left to wait for and none of this is
 * consulted. It still decides for everything that cannot say so — a delete, a
 * cron run picking up a tab that was closed at 80%, a browser whose announcement
 * never arrived.
 *
 * It was 45 seconds, and every one of those seconds was spent with the bar
 * already full and nothing visibly happening. 15 is enough because the wait no
 * longer rests on completed files alone: `sinceIncomingActivity()` also watches
 * the bytes still being written. A session here is ~20 photos of ~15 MB, and one
 * of those can take longer to arrive than this window — on the old signal that
 * would have finalised the gallery between two photos and rebuilt the whole
 * 300 MB archive for each one that followed.
 */
const QUIET_PERIOD_MS = tuning('WORKER_QUIET_MS', 15_000);

/** How long a single run will keep waiting for an upload batch to settle. */
const MAX_WAIT_MS = tuning('WORKER_MAX_WAIT_MS', 20 * 60_000);

/**
 * How soon a waiting run looks again. Was 10s, which is up to 10s of dead time
 * after the quiet window finally passes; a pass over a settled gallery is a
 * directory listing and a few stats, so asking more often costs nothing worth
 * measuring.
 */
const POLL_MS = tuning('WORKER_POLL_MS', 3_000);

/**
 * The grid reads this, in the order it draws. Written at the end of every run,
 * not only the run that finishes the gallery: it is what the pages render
 * from, and a batch that is still arriving should still show what is ready.
 */
const writeManifest = (slug, photos) =>
  writeFile(manifestPath(slug), JSON.stringify({ slug, photos }, null, 2) + '\n');

/**
 * Seconds since anything was last written into the upload staging area.
 *
 * The other half of "is she still uploading", and the half that lets the quiet
 * window be short. `last_upload_at` only moves when a file *finishes*, so a
 * 15 MB photo crawling up a domestic line looks exactly like a photographer
 * who has walked away — until it lands, and the gallery that was declared
 * finished has to rebuild its archive around it. A tus upload in flight is
 * being written to `incoming/` the whole time, so its mtime is the signal that
 * the row cannot give.
 *
 * Both sides of this subtraction come off the same clock, which is the local
 * filesystem's; nothing here compares a database time to a Node one.
 */
async function sinceIncomingActivity() {
  const entries = await readdir(incomingDir).catch(() => []);

  let newest = 0;
  for (const entry of entries) {
    const info = await stat(path.join(incomingDir, entry)).catch(() => null);
    if (info) newest = Math.max(newest, info.mtimeMs);
  }

  return newest === 0 ? Number.POSITIVE_INFINITY : (Date.now() - newest) / 1000;
}

/**
 * Seconds since the last file landed, measured by the database against its own
 * clock (`secondsSinceUpload`, see server/galleries.js).
 *
 * Never recomputed here from `lastUploadAt`. That column arrives as a bare
 * string with no zone, and reading it with `new Date()` puts it in whatever
 * zone the *Node* process happens to run in -- which, against a database
 * keeping local time, can place the last upload hours in the future. Every
 * gallery then looks like one that is still receiving files: nothing is ever
 * finalised, the row stays `preparing`, and the panel's progress banner stays
 * up for as long as the offset lasts. A row that has never seen an upload
 * reports nothing at all, and that is as settled as a gallery gets.
 */
function sinceLastUpload(gallery) {
  const seconds = Number(gallery?.secondsSinceUpload);
  return gallery?.secondsSinceUpload == null || !Number.isFinite(seconds)
    ? Number.POSITIVE_INFINITY
    : seconds;
}

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

  // Read before anything is decided, and carried through to the end: the run
  // that finalises forgets exactly these records, so a browser that started
  // uploading somewhere in between keeps its own.
  const uploaders = await uploaderState(slug);

  // Disk is the truth, and one record per photo is what it says. A record
  // whose bytes never arrived is named rather than silently skipped: it is the
  // only trace of an upload hook that died mid-move.
  const uploaded = await listPhotos(slug, {
    onIncomplete: (record) =>
      log(`[worker] ${slug}: no bytes for ${record.filename ?? record.id} — upload interrupted`),
  });

  if (uploaded.length === 0) {
    // Two very different galleries look like this, and the manifest tells them
    // apart. One she has only just created and not dropped anything into yet:
    // nothing has ever been written for it, and there is nothing to do.
    //
    // The other just lost its last photo. `removePhoto` rewrote the manifest
    // and `markPhotosChanged` put the row back to `preparing` for this run to
    // clear -- and returning 'idle' there left it preparing *forever*: the
    // panel's banner never went away, the bar sat at nothing, and the client's
    // gallery said "przygotowuję" for a gallery that was simply empty. So an
    // emptied gallery is finished here rather than skipped.
    const written = await readManifest(slug).then(() => true).catch(() => false);
    const settled = gallery.status === 'ready' && Number(gallery.photoCount) === 0;
    if (!written || settled) return 'idle';

    // The archive still holds the photos that were deleted, and there is now
    // nothing for it to hold.
    await rm(archivePath(slug), { force: true });
    await writeManifest(slug, []);
    await markReady(slug, { photoCount: 0, bytesTotal: 0, status: 'ready' });
    await forgetUploaders(slug, uploaders.seen);
    log(`[worker] ${slug}: no photos left — nothing to prepare`);
    return 'done';
  }

  // What the last run recorded, keyed by id: it carries the proportions the
  // grid needs, which are cheap to carry forward and a subprocess each to
  // measure again.
  const previous = await readManifest(slug).catch(() => null);
  const before = new Map((previous?.photos ?? []).map((photo) => [photo.id, photo]));

  // Still arriving? Generate derivatives for what is here, but do not finalise:
  // building the archive now would only mean rebuilding it for the next photo,
  // and marking the gallery ready would hide the ones still to come.
  //
  // `settled` is the browser's own word for it -- every uploader that
  // announced this batch has announced that it finished -- and it is worth
  // trusting because it is the one signal here that is not an inference from
  // mtimes. The timing window below is what answers when nobody said anything.
  const window = QUIET_PERIOD_MS / 1000;
  const quiet =
    uploaders.settled ||
    (sinceLastUpload(gallery) > window && (await sinceIncomingActivity()) > window);

  // Nothing new since the last run, and already finished.
  if (quiet && gallery.status !== 'preparing' && gallery.photoCount === uploaded.length) {
    // The one path where records can outlive the batch that wrote them: a
    // browser announced it had finished and there was nothing left to finalise
    // (every file in that batch failed, say). Left lying about, a `.done` from
    // a closed tab would speak for the *next* batch, whose own announcement may
    // never arrive -- and the shortcut would be taken while photos were still
    // coming. Only when nothing claims to be uploading, so a live batch waiting
    // on its first file to land is never swept out from under itself.
    if (!uploaders.active) await forgetUploaders(slug, uploaders.seen);
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
      // One unreadable file should not cost the client the other 799 -- and it
      // must not hold the gallery open either, which is what leaving it in the
      // count did: the row's photo_count could never catch up with a disk that
      // included a photo no run would ever produce, so the panel waited on it
      // forever. Set aside, named in the log, bytes untouched.
      const why = error.message.split('\n')[0];
      await setPhotoAside(slug, record, why).catch(() => {});
      log(`[worker] ${slug}: set aside ${record.filename ?? record.id} — ${why}`);
    }
  }

  if (made > 0) log(`[worker] ${slug}: prepared ${made} of ${uploaded.length} photos`);

  if (photos.length === 0) {
    await markReady(slug, { photoCount: 0, bytesTotal: 0, status: 'failed' });
    await forgetUploaders(slug, uploaders.seen);
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
  await forgetUploaders(slug, uploaders.seen);

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

    // Where the wake file stood when this run began. Anything that asks for a
    // run while this one is working moves it, and the spawn it made alongside
    // found the lock held and exited -- so this run is the only one left that
    // can honour the request. She deletes a photo seconds after an upload
    // settles, and without this it waits on the five-minute cron instead, with
    // the progress banner on screen for all of it.
    let seenWake = await wakeMark();

    for (;;) {
      let waiting = 0;

      for (const gallery of await needingWork()) {
        const outcome = await processGallery(gallery.slug, { log });
        if (outcome === 'waiting') waiting += 1;
        if (outcome === 'done') finished += 1;
      }

      if (waiting === 0) {
        const wake = await wakeMark();
        // Compared rather than tested against the clock: one more pass per
        // request that arrived, and a file that somehow carries a future
        // timestamp still cannot spin this forever.
        if (wake !== seenWake) {
          seenWake = wake;
          continue;
        }
        break;
      }

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
  // Stamped, because the question asked of this log is always "how long did
  // that take, and when did it give up" -- and because wake.js now keeps the
  // output instead of discarding it, which is the only way anyone sees a run
  // that went wrong.
  const stamp = (message) => console.log(`${new Date().toISOString()} ${message}`);
  try {
    stamp('[worker] run started');
    const count = await runOnce({ log: stamp });
    stamp(`[worker] done (${count} galleries)`);
  } catch (error) {
    stamp(`[worker] run failed — ${error?.stack ?? error}`);
    process.exitCode = 1;
  } finally {
    await close();
  }
}
