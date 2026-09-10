/**
 * Removing one photo from a gallery.
 *
 * The awkward part is that a photo's *identity* is its position. The worker
 * lists the originals in name order and writes previews as `<n>-thumb.jpg`, so
 * "photo 3" means the third file, and taking one out of the middle shifts
 * everything after it. Left alone, the next worker run would find a preview
 * already sitting at every index, reuse it, and hand the client a grid where
 * each photo after the deleted one shows its neighbour.
 *
 * So the previews are renamed down one place, which is exactly the shift the
 * worker's own numbering will do the next time it reads the directory. That
 * costs a few renames rather than re-encoding the tail of a wedding.
 *
 * The archive goes, because it still contains the photo. Rebuilding it is the
 * worker's job, which is why the caller marks the gallery `preparing` and wakes
 * it: the previews are all present by then, so the run is a ZIP and nothing
 * else.
 *
 * Not guarded against a worker mid-run on the same gallery. That would mean
 * deleting a photo seconds after uploading it, and the worst case is a preview
 * that the next run corrects.
 */
import { rename, rm, writeFile } from 'node:fs/promises';
import {
  archivePath,
  manifestPath,
  originalPath,
  previewPath,
  readManifest,
} from './storage.js';

const SIZES = ['thumb', 'large'];

/** Renames, tolerating a preview that was never made (a file the worker skipped). */
async function move(from, to) {
  try {
    await rename(from, to);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * @returns the removed photo and how many are left, or null when that position
 *   holds nothing -- a double submit, or a stale page.
 */
export async function removePhoto(slug, index) {
  let manifest;
  try {
    manifest = await readManifest(slug);
  } catch {
    return null;
  }

  const photos = manifest.photos ?? [];
  const photo = photos[index];
  if (!photo) return null;

  await rm(originalPath(slug, photo.filename), { force: true });
  for (const size of SIZES) {
    await rm(previewPath(slug, index, size), { force: true });
  }

  for (let position = index + 1; position < photos.length; position += 1) {
    for (const size of SIZES) {
      await move(previewPath(slug, position, size), previewPath(slug, position - 1, size));
    }
  }

  const remaining = photos
    .filter((_, position) => position !== index)
    .map((entry, position) => ({ ...entry, index: position }));

  await writeFile(manifestPath(slug), JSON.stringify({ ...manifest, photos: remaining }));
  await rm(archivePath(slug), { force: true });

  return { photo, remaining: remaining.length };
}
