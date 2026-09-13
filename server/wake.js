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
import { mkdirSync, utimesSync, closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STORAGE_ROOT } from './config.js';

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');
const wakePath = path.join(STORAGE_ROOT, 'worker.wake');

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

  try {
    const child = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch (error) {
    console.error(`[${reason}] could not spawn worker:`, error.message);
  }
}
