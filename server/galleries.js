/**
 * Every query about a gallery. The database is the index — which galleries
 * exist, who may open one, when it dies — while per-photo detail stays in the
 * manifest the worker writes (see server/storage.js).
 */
import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { hash, seal, unseal } from './passwords.js';

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
            password_hash AS passwordHash, password_enc AS passwordEnc,
            status, photo_count AS photoCount,
            bytes_total AS bytesTotal, last_upload_at AS lastUploadAt,
            expires_at AS expiresAt, created_at AS createdAt
       FROM galleries
      WHERE slug = :slug AND deleted_at IS NULL`,
    { slug },
  );
  return rows[0] ?? null;
}

export async function create({ clientName, shootDate, password, expiryDays = 30 }) {
  const passwordHash = await hash(password);
  // Both, always: the hash decides whether a client gets in, the sealed copy is
  // what the panel shows her afterwards. See server/passwords.js.
  const passwordEnc = seal(password);

  // Retry on the unique index rather than checking first: two uploads starting
  // together would both pass a check-then-insert, and the index is the only
  // thing that actually decides.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = makeSlug();
    try {
      const [result] = await db().query(
        `INSERT INTO galleries
           (slug, client_name, shoot_date, password_hash, password_enc, expires_at)
         VALUES (:slug, :clientName, :shootDate, :passwordHash, :passwordEnc,
                 DATE_ADD(NOW(), INTERVAL :expiryDays DAY))`,
        { slug, clientName, shootDate: shootDate || null, passwordHash, passwordEnc, expiryDays },
      );
      return { id: result.insertId, slug };
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
    }
  }
  throw new Error('Could not allocate a unique slug after 5 attempts');
}

/**
 * Changes a gallery's details after the fact, from the same screen that created
 * it. Only the fields actually passed are written.
 *
 * The expiry is the one that has to be partial. `expires_at` is an absolute
 * moment, and the only thing stored -- the dropdown she chose from is not kept
 * -- so there is no way to re-apply "30 days" without deciding what it counts
 * from. So the editor leaves the key out unless she actually picked a new
 * term, and a new term counts from now: "this gallery disappears in 30 days",
 * which is the question she is answering when she touches that control.
 */
export async function update(slug, { clientName, shootDate, expiryDays } = {}) {
  const assignments = [];
  const params = { slug };

  if (clientName !== undefined) {
    assignments.push('client_name = :clientName');
    params.clientName = clientName;
  }
  if (shootDate !== undefined) {
    assignments.push('shoot_date = :shootDate');
    params.shootDate = shootDate || null;
  }
  if (expiryDays !== undefined) {
    assignments.push('expires_at = DATE_ADD(NOW(), INTERVAL :expiryDays DAY)');
    params.expiryDays = expiryDays;
  }

  if (assignments.length === 0) return;

  // `deleted_at IS NULL` for the same reason every read carries it: a gallery
  // the nightly sweep has condemned must not come back to life because this
  // screen was still open in a tab.
  await db().query(
    `UPDATE galleries SET ${assignments.join(', ')}
      WHERE slug = :slug AND deleted_at IS NULL`,
    params,
  );
}

/** Called as each upload lands, so the worker can tell when they have stopped. */
export async function touchUpload(slug) {
  await db().query(
    'UPDATE galleries SET last_upload_at = NOW() WHERE slug = :slug',
    { slug },
  );
}

/**
 * Every gallery the worker should look at.
 *
 * Deliberately not "status = preparing". A gallery that has already been marked
 * ready can still gain photos -- she uploads a second batch, or a file arrives
 * after the worker finished -- and the old query skipped exactly those, which
 * is how a multi-photo upload ended up showing one photo. processGallery works
 * out for itself whether there is anything to do.
 */
export async function needingWork() {
  const [rows] = await db().query(
    `SELECT slug, status, photo_count AS photoCount, last_upload_at AS lastUploadAt
       FROM galleries
      WHERE deleted_at IS NULL AND status <> 'failed'
      ORDER BY created_at ASC`,
  );
  return rows;
}

/**
 * Replaces a gallery's password.
 *
 * Rarely needed now that the panel can show the existing one, but still the
 * answer when a client forwards the message to someone she would rather not
 * have let in -- and the only way back for a gallery sealed under a secret that
 * has since been rotated.
 */
export async function setPassword(slug, password) {
  await db().query(
    'UPDATE galleries SET password_hash = :hash, password_enc = :enc WHERE slug = :slug',
    { slug, hash: await hash(password), enc: seal(password) },
  );
}

/**
 * The password to show her, or null when there is nothing to show: a gallery
 * from before the column existed, or one sealed under a secret that has since
 * changed. Callers offer a new password in that case.
 */
export const readPassword = (gallery) =>
  gallery?.passwordEnc ? unseal(gallery.passwordEnc) : null;

/**
 * After a photo is deleted: the count is known here, everything else is the
 * worker's to recompute. `preparing` is what sends it back -- the archive still
 * contains the deleted photo and has to be rebuilt, and that status is the only
 * thing that stops the worker deciding it has nothing to do.
 */
export async function markPhotosChanged(slug, photoCount) {
  await db().query(
    `UPDATE galleries
        SET photo_count = :photoCount,
            -- The worker retallies on its next run. Zeroing matters only for a
            -- gallery that just lost its last photo, which the worker will find
            -- empty and leave alone.
            bytes_total = IF(:photoCount = 0, 0, bytes_total),
            status = 'preparing'
      WHERE slug = :slug`,
    { slug, photoCount },
  );
}

export async function markReady(slug, { photoCount, bytesTotal, status = 'ready' }) {
  await db().query(
    `UPDATE galleries
        SET status = :status, photo_count = :photoCount, bytes_total = :bytesTotal
      WHERE slug = :slug`,
    { slug, status, photoCount, bytesTotal },
  );
}

/**
 * One row as the dashboard uses it. Written out because the templates that
 * consume it are typechecked and mysql2 hands back `any` -- without this every
 * `gallery.clientName` in an .astro file is an implicit-any error.
 *
 * @typedef {object} GalleryRow
 * @property {string} slug
 * @property {string} clientName
 * @property {string|null} shootDate
 * @property {string} status
 * @property {number} photoCount
 * @property {number} bytesTotal
 * @property {string} expiresAt
 * @property {string} createdAt
 * @property {boolean} expired
 * @property {string|null} password
 */

/**
 * Newest first — the dashboard is almost always about the last shoot.
 *
 * @returns {Promise<GalleryRow[]>}
 */
export async function list() {
  const [rows] = await db().query(
    `SELECT slug, client_name AS clientName, shoot_date AS shootDate, status,
            photo_count AS photoCount, bytes_total AS bytesTotal,
            password_enc AS passwordEnc,
            expires_at AS expiresAt, created_at AS createdAt,
            (expires_at < NOW()) AS expired
       FROM galleries
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC`,
  );
  // MySQL returns a boolean expression as 1/0; the templates want a boolean.
  // The password is unsealed here rather than in the template: the dashboard
  // shows every gallery's code at a glance, which is the point of it.
  // The ciphertext itself does not leave this function -- the dashboard wants
  // the code, and nothing downstream has any use for the sealed form.
  return rows.map(({ passwordEnc, ...row }) => ({
    ...row,
    expired: Boolean(row.expired),
    password: readPassword({ passwordEnc }),
  }));
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
