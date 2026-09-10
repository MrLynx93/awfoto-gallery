/**
 * Nudges the background worker.
 *
 * Detached and `unref`'d, so nothing waits on it and this process can exit
 * without killing it. The worker's own lockfile makes a duplicate spawn
 * harmless, which is what lets every completed upload -- and now every deleted
 * photo -- call this without coordinating.
 *
 * Failure is survivable by design: the five-minute cron runs the same worker,
 * so a spawn that does not happen delays a gallery rather than losing one.
 * (Written out rather than as the cron expression: a slash-star inside a block
 * comment ends it, and this file would not parse.)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');

export function wakeWorker(reason = 'worker') {
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
