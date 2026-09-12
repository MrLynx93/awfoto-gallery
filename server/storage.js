/**
 * Where a gallery's files live on disk, and the only place that layout is
 * spelled out.
 *
 * Everything sits under STORAGE_ROOT, which is outside every vhost's web root
 * (server/config.js refuses a path inside one). Nothing here is reachable by
 * URL — see CLAUDE.md, "Download path".
 *
 *   STORAGE_ROOT/galleries/<slug>/
 *     originals/<id>.jpg       the uploaded bytes, under the photo's id
 *     originals/<id>.json      {id, filename, ext, uploadedAt}, written at upload
 *     previews/<id>-thumb.jpg  grid, 500px long edge
 *     previews/<id>-large.jpg  lightbox, 2048px long edge
 *     archive.zip              built by the worker
 *     manifest.json            photo list in display order, written by the worker
 *
 * **Every one of those names is the photo's id, and nothing else.** Not its
 * position, which moves whenever a photo is added or removed, and not the name
 * she exported it under, because two files in one gallery are allowed to share
 * a name — see CLAUDE.md, "A photo is an id". The exported name is metadata
 * carried alongside: it decides what the client's downloads folder shows, and
 * nothing about where anything lives.
 *
 * The manifest exists so a gallery page can render its grid from one read
 * instead of a row per photo. The database stays the index — which galleries
 * exist, who may open one, when it dies — and the per-photo detail is here.
 */
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { STORAGE_ROOT } from './config.js';

export const galleriesRoot = path.join(STORAGE_ROOT, 'galleries');

/**
 * Gallery ids are ours, never a caller's, but this is the join that would turn
 * a bad one into an arbitrary file read. Rejecting anything but the character
 * set we generate costs nothing and closes the question.
 */
function safeId(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) {
    throw new Error(`Unsafe gallery id: ${id}`);
  }
  return id;
}

/**
 * The same guarantee for a photo id, which *does* arrive from a caller: it is
 * the `:photo` segment of every preview and download URL. Ours are 12
 * base64url characters (server/photos.js), and nothing outside that shape has
 * ever named a file here.
 */
function safePhotoId(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) {
    throw new Error(`Unsafe photo id: ${id}`);
  }
  return id;
}

/**
 * Extensions come off an uploaded filename, so they are caller-influenced too.
 * `.jpg`, `.jpeg`, `.png` in practice; the shape is what matters — a dot and a
 * few alphanumerics can neither traverse nor hide a second extension.
 */
function safeExt(ext) {
  if (!/^\.[A-Za-z0-9]{1,8}$/.test(String(ext))) {
    throw new Error(`Unsafe extension: ${ext}`);
  }
  return String(ext).toLowerCase();
}

export function galleryDir(id) {
  return path.join(galleriesRoot, safeId(id));
}

export const originalsDir = (id) => path.join(galleryDir(id), 'originals');
export const previewsDir = (id) => path.join(galleryDir(id), 'previews');
export const archivePath = (id) => path.join(galleryDir(id), 'archive.zip');
export const manifestPath = (id) => path.join(galleryDir(id), 'manifest.json');

/** The two derivatives, named for the photo they were made from. */
export function previewPath(id, photoId, size) {
  if (size !== 'thumb' && size !== 'large') throw new Error(`Unknown size: ${size}`);
  return path.join(previewsDir(id), `${safePhotoId(photoId)}-${size}.jpg`);
}

/**
 * The uploaded bytes. The name she exported never reaches the filesystem — it
 * is the one caller-supplied string in this whole path, and keeping it out
 * means `../../.env` has nowhere to be constructed rather than somewhere to be
 * caught.
 */
export function originalPath(id, photoId, ext) {
  return path.join(originalsDir(id), `${safePhotoId(photoId)}${safeExt(ext)}`);
}

/** What the upload knew and the filesystem cannot hold: her name for the file. */
export function photoRecordPath(id, photoId) {
  return path.join(originalsDir(id), `${safePhotoId(photoId)}.json`);
}

export async function readPhotoRecord(id, photoId) {
  return JSON.parse(await readFile(photoRecordPath(id, photoId), 'utf8'));
}

/**
 * Every photo the gallery actually has, in the order it should be shown.
 *
 * Disk is the truth here, not the manifest and not the database: the worker is
 * safe to re-run at any moment precisely because it re-reads this rather than
 * trusting what a previous run wrote. A record whose bytes never arrived (a
 * process killed between the two writes in the tus hook) is left out and
 * reported, not guessed at.
 *
 * Ordered by the exported filename, which for a Lightroom export is
 * chronological — the order she and the client both expect. Two photos are
 * allowed to share that name, so upload time and then the id break the tie,
 * which keeps the order stable across runs rather than leaving it to whatever
 * the directory hands back.
 */
export async function listPhotos(id, { onIncomplete } = {}) {
  let entries;
  try {
    entries = await readdir(originalsDir(id));
  } catch {
    // Created by the first completed upload; nothing has landed yet.
    return [];
  }

  const present = new Set(entries);

  const photos = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;

    let record;
    try {
      record = JSON.parse(await readFile(path.join(originalsDir(id), entry), 'utf8'));
    } catch {
      continue;
    }
    if (!record?.id || !record?.ext) continue;

    // The bytes are renamed into place before this record is written, so a
    // record without them means the upload hook died in between.
    if (!present.has(`${record.id}${record.ext}`)) {
      onIncomplete?.(record);
      continue;
    }
    photos.push(record);
  }

  return photos.sort(
    (a, b) =>
      String(a.filename).localeCompare(String(b.filename), 'pl') ||
      String(a.uploadedAt ?? '').localeCompare(String(b.uploadedAt ?? '')) ||
      a.id.localeCompare(b.id),
  );
}

export async function readManifest(id) {
  return JSON.parse(await readFile(manifestPath(id), 'utf8'));
}

/**
 * How far the worker has gotten on a gallery that has not finished yet.
 *
 * Read straight off disk rather than the database, because the worker only
 * writes `photo_count` once the whole batch is done -- there is nowhere else
 * this number lives while `preparing` is still true. `large.jpg` is the second
 * and last file `makeDerivatives()` writes for a photo, so counting those
 * counts photos it has actually finished, not ones still mid-resize with only
 * a `thumb.jpg` on disk.
 *
 * `total` can undercount briefly while files are still uploading -- there is
 * no way to tell "800 more are coming" from "that's all of them" by looking
 * at a directory -- so this is a lower bound on progress, not a promise.
 */
export async function progress(id) {
  const [originals, previews] = await Promise.all([
    readdir(originalsDir(id)).catch(() => []),
    readdir(previewsDir(id)).catch(() => []),
  ]);
  // One record per photo, written last of the two files an upload leaves.
  const total = originals.filter((f) => f.endsWith('.json')).length;
  const done = previews.filter((f) => f.endsWith('-large.jpg')).length;
  return { done: Math.min(done, total), total };
}
