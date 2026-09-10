/**
 * The URLs more than one module has to agree on.
 *
 * Three screens name a gallery -- the editor, the photographer's own view of it,
 * and the link the client is sent -- and the dashboard, the API responses and
 * the pages themselves all build those URLs. Writing each one here keeps a
 * rename from becoming a hunt through templates.
 */
import { baseUrl } from './config.js';

/** The editor — one page, used both to create a gallery and to change it. */
export const galleryEditPath = (slug) => `/admin/galeria/${slug}`;

/**
 * The photographer's own view of a gallery: the same grid the client sees, with
 * no password gate in front of it. Deliberately a different URL from the
 * client's -- /g/<slug> stays exactly what she hands out, so she can always open
 * it in a private window and see what they see.
 */
export const galleryViewPath = (slug) => `/admin/g/${slug}`;

/** What the client is sent. Absolute, because she pastes it into a message. */
export const galleryShareUrl = (slug) => `${baseUrl.replace(/\/+$/, '')}/g/${slug}`;
