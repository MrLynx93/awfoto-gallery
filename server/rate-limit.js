/**
 * The gallery password gate's attempt limiter.
 *
 * In the database, not in memory: Passenger runs several app processes, and a
 * per-process counter would let anyone reconnect their way around it. This is
 * also the only thing standing between an 8-character password and someone
 * with a script — scrypt makes each guess cost ~60 ms, which is not on its own
 * enough.
 */
import { createHmac } from 'node:crypto';
import { db } from './db.js';
import { sessionSecret } from './config.js';

const WINDOW_MINUTES = 15;
const MAX_ATTEMPTS = 10;

/**
 * A truncated keyed hash, never the address. Enough to count repeats from one
 * source; not a log of who opened which gallery, which this application has no
 * reason to keep — and if the database leaked, an unsalted IP list would be
 * personal data we chose to store for no benefit.
 */
function hashIp(ip) {
  return createHmac('sha256', sessionSecret())
    .update(String(ip ?? ''))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Counts attempts in the window and, past the limit, reports how long to wait.
 * Counting happens against the slug even when no such gallery exists, because
 * a scan across invented slugs is exactly what this should notice.
 */
export async function check(slug, ip) {
  const [rows] = await db().query(
    `SELECT COUNT(*) AS attempts, MIN(attempted_at) AS oldest
       FROM access_attempts
      WHERE slug = :slug AND ip_hash = :ipHash
        AND attempted_at > DATE_SUB(NOW(), INTERVAL :minutes MINUTE)`,
    { slug, ipHash: hashIp(ip), minutes: WINDOW_MINUTES },
  );

  const { attempts, oldest } = rows[0];
  if (attempts < MAX_ATTEMPTS) return { allowed: true, remaining: MAX_ATTEMPTS - attempts };

  // The window slides: the wait is until the oldest attempt ages out, not a
  // flat penalty, so someone who mistyped a few times early is not held for the
  // full window once those attempts expire.
  const retryAfterMs =
    new Date(oldest).getTime() + WINDOW_MINUTES * 60_000 - Date.now();

  return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil(retryAfterMs / 60_000)) };
}

export async function record(slug, ip) {
  await db().query(
    'INSERT INTO access_attempts (slug, ip_hash) VALUES (:slug, :ipHash)',
    { slug, ipHash: hashIp(ip) },
  );
}

/** A correct password clears the slate, so one bad day does not lock a client out. */
export async function clear(slug, ip) {
  await db().query(
    'DELETE FROM access_attempts WHERE slug = :slug AND ip_hash = :ipHash',
    { slug, ipHash: hashIp(ip) },
  );
}

/** Housekeeping for the nightly cron — the table is write-heavy and never read old. */
export async function prune() {
  const [result] = await db().query(
    'DELETE FROM access_attempts WHERE attempted_at < DATE_SUB(NOW(), INTERVAL 1 DAY)',
  );
  return result.affectedRows;
}

export const limits = { WINDOW_MINUTES, MAX_ATTEMPTS };
