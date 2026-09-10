/**
 * The resumable upload endpoint.
 *
 * tus rather than a hand-rolled chunked upload, because rolling your own is
 * what kills self-built galleries: 800 files over a domestic connection will be
 * interrupted, and losing an hour of transfer to a dropped Wi-Fi link is the
 * failure that makes someone go back to WeTransfer.
 *
 * `@tus/server` is pure JavaScript — like every other dependency here, because
 * a native module does not survive contact with this FreeBSD host.
 *
 * Nothing is processed in this path. The bytes land, the response returns, and
 * the worker catches up afterwards.
 */
import path from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';

import express from 'express';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';

import { STORAGE_ROOT, baseUrl } from '../config.js';
import { wakeWorker } from '../wake.js';
import { originalsDir, galleryDir } from '../storage.js';
import { findBySlug, touchUpload } from '../galleries.js';
import { ADMIN_COOKIE, cookieFromHeader, isAdmin } from '../sessions.js';

export const uploadRouter = express.Router();

/** Partial uploads live apart from finished originals, and are swept with them. */
const incomingDir = path.join(STORAGE_ROOT, 'incoming');

// Created synchronously, before FileStore is constructed below. The store binds
// to this directory at construction, so creating it later -- in a request hook,
// as an earlier version did -- is already too late on a fresh install.
mkdirSync(incomingDir, { recursive: true });

function adminOnly(req, res, next) {
  if (!isAdmin(cookieFromHeader(req.headers.cookie, ADMIN_COOKIE))) {
    return res.status(403).json({ error: 'Zaloguj się ponownie.' });
  }
  next();
}

const tus = new Server({
  path: '/admin/upload',
  datastore: new FileStore({ directory: incomingDir }),

  /**
   * The `Location` the client is told to PATCH to, built from PUBLIC_BASE_URL.
   *
   * This is the third attempt at this one line, so the reasoning is worth
   * keeping. tus answers a creation request with a Location. Left to itself it
   * builds one from what this process sees -- plain HTTP on an internal
   * hostname -- and the browser, on an https:// page, refuses it as mixed
   * content before a byte moves.
   *
   * `relativeLocation: true` was the obvious fix and was not enough: the
   * observed failure was still an absolute `http://galeria.aw-foto.pl/...`,
   * which a relative Location cannot produce on its own. Something between here
   * and the browser -- nginx rewriting a relative Location against the internal
   * http upstream -- was absolutising it with the wrong scheme.
   *
   * So the URL is stated outright, from the one origin we know the browser
   * used. There is nothing relative left to rewrite and no proxy header that
   * has to be correct. `generateUrl` is consulted before both other options, so
   * this is the only rule in play.
   *
   * If uploads ever break again with a wrong scheme or host, check
   * PUBLIC_BASE_URL in .env first -- it is now the single source of this URL.
   */
  generateUrl(req, { path, id }) {
    return `${baseUrl.replace(/\/+$/, '')}${path}/${id}`;
  },

  // Still declared: it feeds the proto/host handed to generateUrl above, and
  // costs nothing even though generateUrl ignores them.
  respectForwardedHeaders: true,

  /**
   * Surfaces the cause in the log. A failed upload otherwise shows as a bare
   * red row in the Uppy dashboard, and the operator has nothing to go on.
   */
  onResponseError(req, error) {
    console.error(`[upload] ${req.method} ${req.url} — ${error?.body || error?.message || error}`);
    return undefined;
  },

  /**
   * Moves the finished upload into its gallery under the name she exported it
   * as, then wakes the worker.
   *
   * The filename is the one caller-influenced value in this whole path, so it
   * is reduced to a basename and re-checked against the gallery directory —
   * `originalPath` would reject a traversal, and this never gets the chance to
   * construct one.
   */
  async onUploadFinish(req, upload) {
    const slug = upload.metadata?.slug;
    const rawName = upload.metadata?.filename || `${upload.id}.jpg`;

    const gallery = slug ? await findBySlug(slug) : null;
    if (!gallery) {
      // Nothing to attach it to. Drop the bytes rather than leaving them to be
      // swept later from a directory nobody looks at.
      await rm(path.join(incomingDir, upload.id), { force: true });
      await rm(path.join(incomingDir, `${upload.id}.json`), { force: true });
      throw { status_code: 404, body: 'Nie ma takiej galerii.' };
    }

    const filename = path.basename(rawName).replace(/[/\\]/g, '_');
    const destination = path.join(originalsDir(slug), filename);

    await mkdir(originalsDir(slug), { recursive: true });
    await rename(path.join(incomingDir, upload.id), destination);
    await rm(path.join(incomingDir, `${upload.id}.json`), { force: true });

    // Recorded before the worker is woken: it uses this to decide whether the
    // batch has finished or another file is still on its way.
    await touchUpload(slug);

    wakeWorker('upload');
    return {};
  },
});

uploadRouter.all(/^\/admin\/upload(\/.*)?$/, adminOnly, (req, res) => {
  tus.handle(req, res);
});

export { galleryDir };
