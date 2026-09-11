/**
 * GET — how far the worker has gotten on this gallery, right now.
 *
 * Polled from the gallery's own page (see the script in
 * src/pages/admin/g/[slug].astro) so the progress bar moves without a reload,
 * and the page can reload itself the one time it actually needs to: the
 * moment this reports there is nothing left to do.
 *
 * `done`/`total` come straight from disk (server/storage.js, progress()) and
 * drive the bar's own fill -- but `working`, the signal that decides whether
 * to reload, is deliberately not "done reached total". `done` is how many
 * previews already exist, and every photo can have its derivatives finished
 * while the worker is still idling out its 45s quiet window (QUIET_PERIOD_MS
 * in worker.js) in case more files are still arriving. `photoCount` only
 * moves once, when `markReady()` finally runs at the end of that wait --
 * archive rebuilt, manifest rewritten -- so it is the one number that tells
 * this route a reload is actually safe. Reloading on `done >= total` instead
 * was tried and shows a manifest and a photo count still missing the new
 * photos, confirmed by watching it happen.
 */
import type { APIRoute } from 'astro';
import { findBySlug } from '../../../../../../server/galleries.js';
import { progress } from '../../../../../../server/storage.js';
import { json, refuseUnlessAdmin } from '../../_admin-api';

export const GET: APIRoute = async (context) => {
  const refusal = refuseUnlessAdmin(context);
  if (refusal) return refusal;

  const slug = String(context.params.slug ?? '');
  const gallery = await findBySlug(slug);
  if (!gallery) {
    return json({ error: 'Tej galerii już nie ma.' }, 404);
  }

  const { done, total } = await progress(slug);

  // 'failed' means the worker already gave up on every original it had --
  // photoCount stays 0 there permanently, not a batch in progress, so it is
  // the one status this ignores the disk count for. A fresh upload
  // afterwards still shows as finished until that new run completes; rare
  // enough, and honest enough in the meantime, to accept rather than solve
  // here.
  const working =
    gallery.status === 'preparing' ||
    (gallery.status !== 'failed' && Number(gallery.photoCount) < total);

  return json({ status: gallery.status, done, total, working });
};
