/**
 * Every query about a gallery. The database is the index — which galleries
 * exist, who may open one, when it dies — while per-photo detail stays in the
 * manifest the worker writes (see server/storage.js).
 */
import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { hash } from './passwords.js';

/**
 * Slugs are read aloud and typed by hand, so they avoid the characters people
 * confuse. 10 characters of this alphabet is ~50 bits — but the slug is not the
 * secret, the password is. This only has to be unguessable enough that nobody
 * stumbles onto a real gallery, and short enough to fit in a message.
 */
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function makeSlug(length = 10) {
  const bytes = randomBytes(length * 2);
  let slug = '';
  for (let i = 0; slug.length < length; i++) {
    const b = bytes[i % bytes.length];
    if (b < 248) slug += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  }
  return slug;
}

/**
 * `deleted_at IS NULL` everywhere: the nightly sweep marks a row deleted before
 * the files are actually gone, so a gallery must stop being reachable the
 * moment it is condemned rather than when the last byte is unlinked.
 */
export async function findBySlug(slug) {
  const [rows] = await db().query(
    `SELECT id, slug, client_name AS clientName, shoot_date AS shootDate,
            password_hash AS passwordHash, status, photo_count AS photoCount,
            bytes_total AS bytesTotal, expires_at AS expiresAt, created_at AS createdAt
       FROM galleries
      WHERE slug = :slug AND deleted_at IS NULL`,
    { slug },
  );
  return rows[0] ?? null;
}

export async function create({ clientName, shootDate, password, expiryDays = 30 }) {
  const passwordHash = await hash(password);

  // Retry on the unique index rather than checking first: two uploads starting
  // together would both pass a check-then-insert, and the index is the only
  // thing that actually decides.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = makeSlug();
    try {
      const [result] = await db().query(
        `INSERT INTO galleries (slug, client_name, shoot_date, password_hash, expires_at)
         VALUES (:slug, :clientName, :shootDate, :passwordHash,
                 DATE_ADD(NOW(), INTERVAL :expiryDays DAY))`,
        { slug, clientName, shootDate: shootDate || null, passwordHash, expiryDays },
      );
      return { id: result.insertId, slug };
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
    }
  }
  throw new Error('Could not allocate a unique slug after 5 attempts');
}

export async function markReady(slug, { photoCount, bytesTotal, status = 'ready' }) {
  await db().query(
    `UPDATE galleries
        SET status = :status, photo_count = :photoCount, bytes_total = :bytesTotal
      WHERE slug = :slug`,
    { slug, status, photoCount, bytesTotal },
  );
}

/** Newest first — the dashboard is almost always about the last shoot. */
export async function list() {
  const [rows] = await db().query(
    `SELECT slug, client_name AS clientName, shoot_date AS shootDate, status,
            photo_count AS photoCount, bytes_total AS bytesTotal,
            expires_at AS expiresAt, created_at AS createdAt,
            (expires_at < NOW()) AS expired
       FROM galleries
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC`,
  );
  // MySQL returns a boolean expression as 1/0; the templates want a boolean.
  return rows.map((row) => ({ ...row, expired: Boolean(row.expired) }));
}

/** What the disk budget is measured against. */
export async function totalBytes() {
  const [rows] = await db().query(
    'SELECT COALESCE(SUM(bytes_total), 0) AS total FROM galleries WHERE deleted_at IS NULL',
  );
  return Number(rows[0].total);
}

/** The nightly sweep's worklist. */
export async function findExpired() {
  const [rows] = await db().query(
    `SELECT id, slug FROM galleries
      WHERE deleted_at IS NULL AND expires_at < NOW()`,
  );
  return rows;
}

/**
 * Condemn first, delete files after. The row stops serving immediately, so a
 * sweep that dies halfway leaves a gallery that is unreachable rather than one
 * that is reachable with half its photos missing.
 */
export async function markDeleted(id) {
  await db().query('UPDATE galleries SET deleted_at = NOW() WHERE id = :id', { id });
}

export async function purge(id) {
  await db().query('DELETE FROM galleries WHERE id = :id', { id });
}

export const isExpired = (gallery) =>
  Boolean(gallery?.expiresAt && new Date(gallery.expiresAt).getTime() < Date.now());
