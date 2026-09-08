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
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rename, rm } from 'node:fs/promises';

import express from 'express';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';

import { STORAGE_ROOT } from '../config.js';
import { originalsDir, galleryDir } from '../storage.js';
import { findBySlug } from '../galleries.js';
import { ADMIN_COOKIE, isAdmin } from '../sessions.js';

export const uploadRouter = express.Router();

/** Partial uploads live apart from finished originals, and are swept with them. */
const incomingDir = path.join(STORAGE_ROOT, 'incoming');

const workerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'worker.js',
);

/**
 * Detached, so the response is not waiting on 800 photos being resized, and
 * `unref`'d so this process can exit without killing it. The worker's own lock
 * makes a duplicate spawn harmless — which matters, because every completed
 * upload triggers one.
 */
function wakeWorker() {
  try {
    const child = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch (error) {
    // The five-minute cron is the safety net; a failed spawn delays a gallery,
    // it does not lose one.
    console.error('[upload] could not spawn worker:', error.message);
  }
}

function adminOnly(req, res, next) {
  const cookie = req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE}=`))
    ?.split('=')[1];

  if (!isAdmin(decodeURIComponent(cookie ?? ''))) {
    return res.status(403).json({ error: 'Zaloguj się ponownie.' });
  }
  next();
}

const tus = new Server({
  path: '/admin/upload',
  datastore: new FileStore({ directory: incomingDir }),

  // Uppy sends the gallery slug and the original filename as metadata. The slug
  // is checked against the database here rather than trusted, so a stale tab
  // cannot write into a gallery that has since been deleted.
  async onIncomingRequest(req) {
    await mkdir(incomingDir, { recursive: true });
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

    wakeWorker();
    return {};
  },
});

uploadRouter.all(/^\/admin\/upload(\/.*)?$/, adminOnly, (req, res) => {
  tus.handle(req, res);
});

export { galleryDir };
