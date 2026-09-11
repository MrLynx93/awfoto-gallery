/**
 * One gallery, shaped for a screen.
 *
 * The editor gets this from the page it is rendered on *and* from the endpoint
 * it saves through, so the two have to agree on the shape down to the empty
 * string for "no shoot date". Describing a row in one place is how they do.
 */
import { daysUntil } from './gallery-form.js';
import { isExpired } from './galleries.js';
import { galleryAdminPath, galleryShareUrl } from './paths.js';

export function describeGallery(gallery) {
  return {
    slug: gallery.slug,
    sessionName: gallery.sessionName,
    // `null` would reach an <input type="date"> as the string "null"; the editor
    // treats '' as "she never set one".
    sessionDate: gallery.sessionDate ?? '',
    status: gallery.status,
    photoCount: Number(gallery.photoCount),
    daysLeft: daysUntil(gallery.expiresAt),
    expired: isExpired(gallery),
    shareUrl: galleryShareUrl(gallery.slug),
    path: galleryAdminPath(gallery.slug),
  };
}
