/**
 * Which browsers are still sending photos into a gallery, said out loud.
 *
 * The worker has to know when a batch is finished, and until now it could only
 * *guess*: nothing had landed for 15 seconds and nothing was being written into
 * `incoming/`, so probably she is done. That guess costs 15 seconds of every
 * upload, spent with the progress bar already full.
 *
 * The browser does not have to guess. Uppy knows the exact moment its queue
 * empties, so it says so — and the worker can finalise immediately instead of
 * idling out a window that exists only because nobody asked.
 *
 * **One record per page-load, not per gallery**, which is the part that makes
 * it safe. A single "the upload is finished" flag would be a lie the moment a
 * second device is uploading into the same gallery: the first one to finish
 * would speak for both, and the worker would build the archive around half the
 * photographs. Here each uploader has its own id and its own record, and the
 * shortcut is taken only when *every* browser that announced itself has also
 * announced that it finished.
 *
 * The state is the filename's suffix rather than its contents, the same trick
 * `<id>.skipped` uses in server/storage.js: the worker asks this on every pass
 * of a poll loop, and a directory listing answers it with no file reads at all.
 *
 * **A record can never make the wait longer.** An uploader that says it is
 * still going only withholds the shortcut; the old timing window still decides,
 * exactly as it did before this existed. That matters because the tab holding
 * an `uploading` record can be closed at 80% and never say anything again — and
 * "preparing" is the one state nothing but a finished run ever clears (see
 * scripts/check-worker-finishes.mjs, which is a list of ways that went wrong).
 * So the worst a stuck record can do is cost this batch its shortcut.
 */
import path from 'node:path';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';

import { uploaderMarkPath, uploadersDir } from './storage.js';

const STATES = ['uploading', 'done'];

/**
 * Record where one uploader has got to. Writing the new state removes the old
 * one, so a client is only ever in one of them.
 */
export async function noteUploader(slug, clientId, state) {
  await mkdir(uploadersDir(slug), { recursive: true });
  await writeFile(uploaderMarkPath(slug, clientId, state), '');
  for (const other of STATES) {
    if (other !== state) await rm(uploaderMarkPath(slug, clientId, other), { force: true });
  }
}

/**
 * What the uploaders currently say about this gallery.
 *
 * `settled` — somebody announced a batch and nobody is still sending — is the
 * only thing that shortens a wait. `seen` is handed back so the run that
 * finalises can forget exactly the records it read, rather than the directory
 * as it stands afterwards: a browser that started uploading while the archive
 * was being built must keep its record.
 */
export async function uploaderState(slug) {
  const seen = await readdir(uploadersDir(slug)).catch(() => []);
  const active = seen.some((entry) => entry.endsWith('.uploading'));
  const announced = seen.some((entry) => entry.endsWith('.done'));
  return { active, announced, settled: announced && !active, seen };
}

/** Clears a finished batch, so the next one is judged on its own records. */
export async function forgetUploaders(slug, seen = []) {
  for (const entry of seen) {
    await rm(path.join(uploadersDir(slug), entry), { force: true });
  }
}
