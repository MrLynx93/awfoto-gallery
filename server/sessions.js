/**
 * Signed, stateless session cookies on `node:crypto`.
 *
 * Stateless because Passenger may run several processes: an in-memory session
 * store would log people out at random as requests land on different workers,
 * and a shared store is a database table this project does not need. The cookie
 * carries its own expiry and an HMAC over the payload, so any worker can verify
 * it without coordination.
 *
 * Two kinds, deliberately separate:
 *   admin   — the photographer's partner, ~30 days
 *   gallery — one client's access to one gallery, after the password gate
 *
 * A gallery cookie names the gallery it is for, so it cannot be replayed
 * against a different one.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { sessionSecret } from './config.js';

const ADMIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GALLERY_TTL_MS = 12 * 60 * 60 * 1000;

export const ADMIN_COOKIE = 'awf_admin';
export const galleryCookieName = (galleryId) => `awf_g_${galleryId}`;

function sign(payload) {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

/** `<payload>.<signature>`, where payload is base64url JSON. */
export function issue(data, ttlMs) {
  const payload = Buffer.from(
    JSON.stringify({ ...data, exp: Date.now() + ttlMs }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Returns the payload, or null. Never throws, and never tells the caller why. */
export function read(token) {
  if (typeof token !== 'string') return null;

  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;

  const payload = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(payload), 'base64url');

  // Compare lengths first: timingSafeEqual throws on a mismatch, and a thrown
  // error is itself a signal.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    // The signature covers the expiry, so this cannot be edited without
    // invalidating the token.
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export const issueAdmin = () => issue({ kind: 'admin', jti: randomBytes(8).toString('hex') }, ADMIN_TTL_MS);

export const issueGallery = (galleryId) =>
  issue({ kind: 'gallery', gid: galleryId }, GALLERY_TTL_MS);

/** True only for a live cookie issued for *this* gallery. */
export function hasGalleryAccess(token, galleryId) {
  const data = read(token);
  return Boolean(data && data.kind === 'gallery' && data.gid === galleryId);
}

export function isAdmin(token) {
  const data = read(token);
  return Boolean(data && data.kind === 'admin');
}

/**
 * httpOnly and SameSite=Lax: a gallery link arrives from a message app.
 *
 * `path` narrows a cookie to the one page that needs it. The default is the
 * whole site, which is right for the admin and gallery sessions; the
 * new-gallery password below is the exception, and scoping it means it is not
 * attached to every upload chunk and every photo request.
 */
export function cookieOptions(maxAgeMs, path = '/') {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    // Set-Cookie counts Max-Age in *seconds*; every TTL in this file is in
    // milliseconds, so without the divide the browser is told to keep an admin
    // cookie for eighty years. The signature's own `exp` was still enforcing
    // the real 30 days, so this showed up as a dead cookie lingering in the
    // jar rather than as a way in.
    maxAge: Math.floor(maxAgeMs / 1000),
    path,
  };
}

/**
 * Carries a freshly created gallery's password from the POST that made it to
 * the page that displays it.
 *
 * It has to survive a redirect, and it cannot come from the database -- only
 * the scrypt hash is stored, deliberately. So it rides in a signed, httpOnly
 * cookie scoped to that one gallery's page: readable by no script, sent to no
 * other path, and gone within the day. The value is a password the photographer
 * is about to send to a client in a message anyway, and this keeps it out of
 * the URL, where it would sit in browser history.
 */
export const newGalleryCookieName = (slug) => `awf_new_${slug}`;

/** The only path the cookie above is ever sent to. */
export const newGalleryCookiePath = (slug) => `/admin/wyslij/${slug}`;

export const issueNewGalleryPassword = (slug, password) =>
  issue({ kind: 'new-gallery', gid: slug, password }, GALLERY_TTL_MS);

export function readNewGalleryPassword(token, slug) {
  const data = read(token);
  if (!data || data.kind !== 'new-gallery' || data.gid !== slug) return null;
  return data.password ?? null;
}

export const GALLERY_TTL = GALLERY_TTL_MS;
export const ADMIN_TTL = ADMIN_TTL_MS;
