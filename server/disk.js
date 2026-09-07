/**
 * The disk budget.
 *
 * `df` is useless here: on this host it reports the shared ZFS pool (1.7 TB,
 * over a terabyte free) rather than the account's ~15 GB quota, so a guard
 * built on it would read "plenty of room" every time and then fail with
 * ENOSPC mid-archive. The budget is therefore explicit and the tally is ours.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { totalBytes } from './galleries.js';
import { diskBudgetBytes, STORAGE_ROOT } from './config.js';

const run = promisify(execFile);

export async function usage() {
  const used = await totalBytes();
  return {
    used,
    budget: diskBudgetBytes,
    free: Math.max(0, diskBudgetBytes - used),
    fraction: diskBudgetBytes > 0 ? used / diskBudgetBytes : 1,
  };
}

/**
 * Whether an archive of roughly this size would fit.
 *
 * A store-mode ZIP is about the size of what goes into it, so the originals'
 * total is a good estimate. The margin covers the archive's own overhead and
 * leaves the account room to breathe rather than filling it exactly.
 */
export async function canFit(bytes, { marginBytes = 512 * 1024 * 1024 } = {}) {
  const { free } = await usage();
  return free > bytes + marginBytes;
}

/**
 * The truth, for reconciliation. Walks the whole storage tree, so it belongs in
 * the nightly cron and nowhere near an upload.
 */
export async function measureOnDisk() {
  try {
    const { stdout } = await run('du', ['-sk', STORAGE_ROOT], { timeout: 120_000 });
    return Number(stdout.trim().split(/\s+/)[0]) * 1024;
  } catch {
    return null;
  }
}

/**
 * Compares the tally against the disk and reports drift. Does not correct it:
 * a mismatch means something wrote or deleted outside the application, and
 * that is worth a human looking rather than a silent adjustment.
 */
export async function reconcile({ log = console.log } = {}) {
  const onDisk = await measureOnDisk();
  if (onDisk === null) return null;

  const { used } = await usage();
  const drift = onDisk - used;

  if (Math.abs(drift) > 256 * 1024 * 1024) {
    log(
      `[disk] tally ${(used / 1024 ** 3).toFixed(2)} GB vs on-disk ` +
        `${(onDisk / 1024 ** 3).toFixed(2)} GB — drift ${(drift / 1024 ** 3).toFixed(2)} GB`,
    );
  }
  return { used, onDisk, drift };
}
