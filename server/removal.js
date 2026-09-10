/**
 * Taking a gallery away: the row and every byte behind it.
 *
 * The order is the point, and it is the same order the nightly expiry sweep
 * will want, which is why this lives here rather than inside the page that
 * calls it. Condemn the row first: `deleted_at` makes every read miss it, so
 * from that moment the client's link is dead, the download routes refuse, and
 * an upload still in flight is dropped by the tus hook instead of recreating
 * the directory this is about to remove. Only then do the files go, and only
 * then does the row itself.
 *
 * Interrupted halfway, the result is a gallery nobody can reach with some files
 * still on disk -- which the next run cleans up. The other order would leave a
 * reachable gallery with half its photos missing, which is the failure a client
 * would see.
 */
import { rm } from 'node:fs/promises';
import { galleryDir } from './storage.js';
import { markDeleted, purge } from './galleries.js';

export async function removeGallery({ id, slug }) {
  await markDeleted(id);

  // `force` so a gallery whose files never arrived -- created, then deleted the
  // same afternoon -- is not a missing-directory error.
  await rm(galleryDir(slug), { recursive: true, force: true });

  // Partial tus uploads live in a shared `incoming/` directory keyed by upload
  // id, not by gallery, so there is nothing to remove for them here: the hook
  // that would have filed them finds no gallery and drops them.
  await purge(id);
}
