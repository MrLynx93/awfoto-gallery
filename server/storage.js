/**
 * Where a gallery's files live on disk, and the only place that layout is
 * spelled out.
 *
 * Everything sits under STORAGE_ROOT, which is outside every vhost's web root
 * (server/config.js refuses a path inside one). Nothing here is reachable by
 * URL — see CLAUDE.md, "Download path".
 *
 *   STORAGE_ROOT/galleries/<id>/
 *     originals/            the uploaded files, under their original names
 *     previews/<n>-thumb.jpg   grid, 500px long edge
 *     previews/<n>-large.jpg   lightbox, 2048px long edge
 *     archive.zip           built once by the worker
 *     manifest.json         photo list, written by the worker
 *
 * The manifest exists so a gallery page can render its grid from one read
 * instead of a row per photo. The database stays the index — who may see this
 * gallery, when it expires — and the manifest carries the per-photo detail.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
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

export function galleryDir(id) {
  return path.join(galleriesRoot, safeId(id));
}

export const originalsDir = (id) => path.join(galleryDir(id), 'originals');
export const previewsDir = (id) => path.join(galleryDir(id), 'previews');
export const archivePath = (id) => path.join(galleryDir(id), 'archive.zip');
export const manifestPath = (id) => path.join(galleryDir(id), 'manifest.json');

/** Preview names are generated from the photo's index, never from its filename. */
export function previewPath(id, index, size) {
  if (size !== 'thumb' && size !== 'large') throw new Error(`Unknown size: ${size}`);
  if (!Number.isInteger(index) || index < 0) throw new Error(`Bad index: ${index}`);
  return path.join(previewsDir(id), `${index}-${size}.jpg`);
}

/**
 * An original keeps the name she exported from Lightroom, because that is what
 * the client expects to see in their downloads folder. That makes it the one
 * caller-influenced path here, so it is resolved and then checked to be inside
 * the gallery's own directory — a name like `../../.env` resolves out, and this
 * is where that is caught.
 */
export function originalPath(id, filename) {
  const dir = originalsDir(id);
  const resolved = path.resolve(dir, filename);
  if (resolved !== path.join(dir, path.basename(resolved))) {
    throw new Error(`Path traversal rejected: ${filename}`);
  }
  return resolved;
}

export async function readManifest(id) {
  return JSON.parse(await readFile(manifestPath(id), 'utf8'));
}
