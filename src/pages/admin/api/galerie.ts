/**
 * POST — creates a gallery and answers with its link and password.
 *
 * Called by the editor at the moment there is something worth creating: she
 * pressed "save", or she dropped a folder in and the gallery has to exist
 * before a single byte can be attached to it. The page does not reload; the
 * finish card appears in place and the URL becomes this gallery's own, so a
 * refresh lands on the editor rather than re-running this.
 */
import type { APIRoute } from 'astro';
import { create, findBySlug } from '../../../../server/galleries.js';
import { describeGallery } from '../../../../server/gallery-view.js';
import { readGalleryDetails, DEFAULT_EXPIRY_DAYS } from '../../../../server/gallery-form.js';
import { generatePassword } from '../../../../server/passwords.js';
import {
  cookieOptions,
  issueNewGalleryPassword,
  newGalleryCookieName,
  newGalleryCookiePath,
  GALLERY_TTL,
} from '../../../../server/sessions.js';
import { json, readJsonBody, refuseUnlessAdmin } from './_admin-api';

export const POST: APIRoute = async (context) => {
  const refusal = refuseUnlessAdmin(context);
  if (refusal) return refusal;

  const details = readGalleryDetails(await readJsonBody(context.request));
  if (details.error) return json({ error: details.error }, 400);
  const values = details.values ?? {};

  const password = generatePassword();
  const { slug } = await create({
    // readGalleryDetails insists on a name unless told otherwise, so this is
    // present; spelling the arguments out keeps that obvious in both directions.
    clientName: String(values.clientName),
    shootDate: values.shootDate ?? '',
    expiryDays: values.expiryDays ?? DEFAULT_EXPIRY_DAYS,
    password,
  });

  // The plaintext is returned below so the screen can show it immediately, and
  // also set here so a refresh of the editor still has it. The database keeps
  // only the scrypt hash, so this cookie is the only copy that outlives the
  // response.
  context.cookies.set(
    newGalleryCookieName(slug),
    issueNewGalleryPassword(slug, password),
    cookieOptions(GALLERY_TTL, newGalleryCookiePath(slug)),
  );

  const gallery = await findBySlug(slug);
  return json({ gallery: describeGallery(gallery), password }, 201);
};
