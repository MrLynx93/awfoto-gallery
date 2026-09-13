/**
 * Nudges the background worker.
 *
 * Detached and `unref`'d, so nothing waits on it and this process can exit
 * without killing it. The worker's own lockfile makes a duplicate spawn
 * harmless, which is what lets every completed upload -- and every deleted
 * photo -- call this without coordinating.
 *
 * **The touch is not decoration.** When a worker is already running, the spawn
 * below finds the lock held and exits without doing anything -- so this file's
 * timestamp is all that is left of the request, and the running worker reads it
 * before it finishes rather than leaving the work to the next cron. Deleting a
 * photo moments after an upload settles is exactly that case, and without this
 * the panel's progress banner stayed up for the five minutes until cron.
 *
 * Failure is survivable by design: the five-minute cron runs the same worker,
 * so a spawn that does not happen delays a gallery rather than losing one.
 * (Written out rather than as the cron expression: a slash-star inside a block
 * comment ends it, and this file would not parse.)
 */
import { spawn } from 'node:child_process';
import { mkdirSync, utimesSync, closeSync, openSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STORAGE_ROOT } from './config.js';

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');
const wakePath = path.join(STORAGE_ROOT, 'worker.wake');
const logPath = path.join(STORAGE_ROOT, 'worker.log');

/** Enough for the last few runs. This is a breadcrumb trail, not an archive. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/**
 * Where the worker's own account of itself goes.
 *
 * It used to go to `stdio: 'ignore'` -- so when a gallery sat in "przygotowuję"
 * there was nothing at all to look at, and the only way to find out why was to
 * reason about code that had already run. Every line the worker prints is
 * stamped with the time (see the bottom of worker.js), because the question is
 * always when it started and where it stopped.
 */
function openLog() {
  try {
    mkdirSync(STORAGE_ROOT, { recursive: true });
    if (statSync(logPath, { throwIfNoEntry: false })?.size > MAX_LOG_BYTES) {
      rmSync(logPath, { force: true });
    }
    return openSync(logPath, 'a');
  } catch {
    // A log that cannot be opened must not stop the work it describes.
    return 'ignore';
  }
}

/** Synchronous on purpose: it has to land before the spawn it explains. */
function markWake() {
  mkdirSync(STORAGE_ROOT, { recursive: true });
  const now = new Date();
  try {
    utimesSync(wakePath, now, now);
  } catch {
    closeSync(openSync(wakePath, 'w'));
  }
}

export function wakeWorker(reason = 'worker') {
  try {
    markWake();
  } catch (error) {
    console.error(`[${reason}] could not record the wake:`, error.message);
  }

  const out = openLog();
  try {
    const child = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    });
    child.unref();
  } catch (error) {
    console.error(`[${reason}] could not spawn worker:`, error.message);
  } finally {
    // The child has its own copy; holding this one open would leak a
    // descriptor per upload.
    if (out !== 'ignore') closeSync(out);
  }
}
