/**
 * PATCH — changes a gallery's details.
 *
 * The same three fields the create endpoint takes, and the same validation, so
 * editing an existing gallery is the identical screen rather than a second one
 * with its own rules. Only the keys the editor sends are written: it sends the
 * expiry only when she actually chose a new term, because "30 days" has no
 * meaning for a gallery that already has a date (see galleries.update).
 */
import type { APIRoute } from 'astro';
import { findBySlug, update } from '../../../../../server/galleries.js';
import { describeGallery } from '../../../../../server/gallery-view.js';
import { readGalleryDetails } from '../../../../../server/gallery-form.js';
import { json, readJsonBody, refuseUnlessAdmin } from '../_admin-api';

export const PATCH: APIRoute = async (context) => {
  const refusal = refuseUnlessAdmin(context);
  if (refusal) return refusal;

  const slug = String(context.params.slug ?? '');
  if (!(await findBySlug(slug))) {
    return json({ error: 'Tej galerii już nie ma. Odśwież panel.' }, 404);
  }

  const { values, error } = readGalleryDetails(await readJsonBody(context.request), {
    requireName: false,
  });
  if (error) return json({ error }, 400);

  await update(slug, values);

  // Re-read rather than echoing what was sent: the new expiry date is computed
  // by MySQL, and this screen displays it.
  return json({ gallery: describeGallery(await findBySlug(slug)) });
};
