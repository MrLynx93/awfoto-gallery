/**
 * Every byte a client receives passes through here.
 *
 * These files live outside any web root, so this router is the only way to
 * reach them — and each route checks the gallery's session cookie and its
 * expiry before opening a file descriptor. See CLAUDE.md, "Download path", for
 * why there is no nginx shortcut.
 *
 * `res.sendFile` rather than a hand-rolled stream: it brings Range support,
 * conditional requests and correct Content-Length, and it is asynchronous I/O
 * throughout. Measured at ~240 KB of RSS per concurrent stream.
 */
import express from 'express';
import path from 'node:path';

import {
  readManifest,
  previewPath,
  originalPath,
  archivePath,
} from '../storage.js';
import { findBySlug, isExpired } from '../galleries.js';
import {
  ADMIN_COOKIE,
  cookieFromHeader,
  galleryCookieName,
  hasGalleryAccess,
  isAdmin,
} from '../sessions.js';

export const filesRouter = express.Router();

/**
 * Resolves the gallery and checks authorisation in one place, so no route can
 * accidentally skip half of it. Answers 404 for "no such gallery", "expired"
 * and "not authorised" alike: a client who has not passed the gate should not
 * be able to tell which galleries exist.
 *
 * Two ways in. A client holds a gallery cookie, minted by the password gate and
 * naming this one gallery. The photographer holds the admin session, and it
 * opens every gallery without a password -- she uploaded these photos, and
 * making her type the client's code to check her own work (or worse, keeping a
 * password she can no longer read) is a lock with no threat behind it. The
 * expiry is hers to ignore too: an expired gallery is closed to the client and
 * still on disk until the sweep, and the panel is where she decides which.
 */
async function authorise(req, res) {
  const { slug } = req.params;

  // The database decides existence and expiry, not the files on disk. A gallery
  // is condemned by its row before the sweep unlinks anything, so checking the
  // manifest here would keep serving photos for a gallery already marked dead.
  const gallery = await findBySlug(slug);
  if (!gallery) {
    res.status(404).end();
    return null;
  }

  if (isAdmin(cookieFromHeader(req.headers.cookie, ADMIN_COOKIE))) {
    return gallery;
  }

  if (isExpired(gallery)) {
    res.status(404).end();
    return null;
  }

  const cookie = cookieFromHeader(req.headers.cookie, galleryCookieName(slug));
  if (!hasGalleryAccess(cookie, slug)) {
    res.status(404).end();
    return null;
  }

  return gallery;
}

function send(res, file, { download } = {}) {
  const options = {
    dotfiles: 'allow',
    // Previews are immutable per gallery and private to one client. `private`
    // keeps them out of any shared cache while still letting the client's own
    // browser reuse them while scrolling the grid.
    headers: { 'Cache-Control': 'private, max-age=3600' },
  };

  const done = (err) => {
    // An aborted download is ordinary — every cancelled click and every Range
    // probe ends this way, and the response is already gone.
    if (err && !res.headersSent) res.status(404).end();
  };

  if (download) {
    res.download(file, download, options, done);
  } else {
    res.sendFile(file, options, done);
  }
}

// `:file` rather than `:size(thumb|large).jpg`: Express 5 moved to
// path-to-regexp v8, which dropped inline regex in parameters. Validating here
// is equivalent and the allowlist is visible at the point of use.
filesRouter.get('/g/:slug/p/:index/:file', async (req, res) => {
  if (!(await authorise(req, res))) return;

  const size = { 'thumb.jpg': 'thumb', 'large.jpg': 'large' }[req.params.file];
  const index = Number(req.params.index);
  if (!size || !Number.isInteger(index)) return res.status(404).end();

  send(res, previewPath(req.params.slug, index, size));
});

filesRouter.get('/g/:slug/photo/:index', async (req, res) => {
  if (!(await authorise(req, res))) return;

  // The filename comes from the manifest, so a caller cannot name the file it
  // wants -- only its position in the gallery.
  let photo;
  try {
    photo = (await readManifest(req.params.slug)).photos?.[Number(req.params.index)];
  } catch {
    return res.status(404).end();
  }
  if (!photo) return res.status(404).end();

  // The filename she exported from Lightroom is what the client expects to see
  // in their downloads folder, so it is preserved rather than machine-named.
  send(res, originalPath(req.params.slug, photo.filename), {
    download: photo.filename,
  });
});

filesRouter.get('/g/:slug/zip', async (req, res) => {
  const gallery = await authorise(req, res);
  if (!gallery) return;

  // ASCII-folded, because the download name crosses Content-Disposition and
  // lands on the client's filesystem — the archive's *contents* keep their
  // Polish names, flagged UTF-8 by `zip -UN=UTF8`.
  const stem = `${gallery.sessionName} ${gallery.sessionDate ?? ''}`
    .normalize('NFKD')
    .replace(/[̀-ͯłŁ]/g, (c) => (c === 'ł' ? 'l' : c === 'Ł' ? 'L' : ''))
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'galeria';

  send(res, archivePath(req.params.slug), { download: `${stem}.zip` });
});
