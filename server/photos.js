/**
 * A photo's identity, and removing one from a gallery.
 *
 * **Every photo gets an id the moment its bytes land**, and that id is the only
 * thing anything else ever names it by: the files on disk, the preview and
 * download URLs, the delete button, the manifest. It is minted once and never
 * derived from anything that can change afterwards.
 *
 * Both of the obvious alternatives were tried and are wrong:
 *
 * - **Its position.** The worker used to sort the originals by name and write
 *   previews as `<n>-thumb.jpg`, which meant a photo added ahead of others
 *   moved every position after it. Every preview then belonged to the photo
 *   next door: the grid showed each tile shifted by one, the last photo twice,
 *   the new one nowhere, and every frame drawn at another's proportions. It
 *   cost a rename-the-tail dance on delete and a second one on insert, and it
 *   was silent when it went wrong.
 * - **Its filename.** Stable under insertion, but it makes two photos with the
 *   same name one photo — and she is allowed to send `DSC_0001.jpg` from two
 *   different cards in one session. Under a name-keyed scheme the second
 *   overwrites the first, or worse, inherits its preview.
 *
 * A random id has neither problem, and it costs one line at upload time. The
 * exported filename travels with the photo as metadata — it decides what the
 * client's downloads folder shows, and nothing else.
 *
 * Removing a photo is then what it should be: delete four files, drop one entry
 * from the manifest, and leave every other photo untouched. The archive still
 * holds the deleted photo, so it goes too and the gallery returns to
 * `preparing` for the worker to rebuild -- the client sees the "preparing" page
 * for as long as that ZIP takes.
 */
import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';

import {
  archivePath,
  manifestPath,
  originalPath,
  photoRecordPath,
  previewPath,
  readManifest,
  readPhotoRecord,
} from './storage.js';

/**
 * 72 bits, base64url — 12 characters of the same alphabet slugs use, so it
 * lands in a URL and a filename without encoding either. Collisions are the
 * only failure mode and 2^72 is not a number a wedding reaches.
 */
export const newPhotoId = () => randomBytes(9).toString('base64url');

/** Everything on disk that belongs to one photo, and nothing that does not. */
export async function removePhotoFiles(slug, record) {
  await rm(originalPath(slug, record.id, record.ext), { force: true });
  await rm(photoRecordPath(slug, record.id), { force: true });
  for (const size of ['thumb', 'large']) {
    await rm(previewPath(slug, record.id, size), { force: true });
  }
}

/**
 * @returns the removed photo and how many are left, or null when the gallery
 *   has no such photo -- a double submit, or a page left open since.
 */
export async function removePhoto(slug, photoId) {
  let manifest;
  try {
    manifest = await readManifest(slug);
  } catch {
    return null;
  }

  const photos = manifest.photos ?? [];
  const photo = photos.find((entry) => entry.id === photoId);
  if (!photo) return null;

  // The record carries the extension the bytes are stored under. Falling back
  // to the manifest's copy covers a record already gone -- a half-finished
  // delete, retried.
  const record = await readPhotoRecord(slug, photoId).catch(() => photo);
  await removePhotoFiles(slug, { id: photoId, ext: record.ext ?? photo.ext ?? '.jpg' });

  const remaining = photos.filter((entry) => entry.id !== photoId);
  await writeFile(
    manifestPath(slug),
    JSON.stringify({ ...manifest, photos: remaining }, null, 2) + '\n',
  );
  await rm(archivePath(slug), { force: true });

  return { photo, remaining: remaining.length };
}
