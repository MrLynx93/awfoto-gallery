/**
 * One gallery, shaped for a screen.
 *
 * The editor gets this from the page it is rendered on *and* from the endpoint
 * it saves through, so the two have to agree on the shape down to the empty
 * string for "no shoot date". Describing a row in one place is how they do.
 */
import { daysUntil } from './gallery-form.js';
import { isExpired } from './galleries.js';
import { galleryEditPath, galleryShareUrl } from './paths.js';

export function describeGallery(gallery) {
  return {
    slug: gallery.slug,
    clientName: gallery.clientName,
    // `null` would reach an <input type="date"> as the string "null"; the editor
    // treats '' as "she never set one".
    shootDate: gallery.shootDate ?? '',
    status: gallery.status,
    photoCount: Number(gallery.photoCount),
    daysLeft: daysUntil(gallery.expiresAt),
    expired: isExpired(gallery),
    shareUrl: galleryShareUrl(gallery.slug),
    editPath: galleryEditPath(gallery.slug),
  };
}
