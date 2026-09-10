/**
 * The URLs more than one module has to agree on.
 *
 * There used to be two admin URLs for a gallery -- an editor and a view -- and
 * the panel spent its time sending her between them. There is one now: the
 * photographer's gallery page, which is the editor and the photos together.
 * The dashboard, the API responses and the pages themselves all build these,
 * so writing each one here keeps a rename from becoming a hunt through
 * templates.
 */
import { baseUrl } from './config.js';

/** The photographer's page for a gallery: details, link, drop zone, photos. */
export const galleryAdminPath = (slug) => `/admin/g/${slug}`;

/** The confirmation screen, one level under it. */
export const galleryDeletePath = (slug) => `${galleryAdminPath(slug)}/usun`;

/** What the client is sent. Absolute, because she pastes it into a message. */
export const galleryShareUrl = (slug) => `${baseUrl.replace(/\/+$/, '')}/g/${slug}`;
