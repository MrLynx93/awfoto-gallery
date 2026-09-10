/**
 * The two URLs that more than one module has to agree on.
 *
 * The admin link and the cookie that carries a new gallery's password must name
 * the *same* path, or the password is set for a page the browser never sends it
 * to — and that failure is invisible: the screen simply shows "no password" as
 * though the cookie had expired. Writing the path once removes the possibility.
 */
import { baseUrl } from './config.js';

/** The editor — one page, used both to create a gallery and to change it. */
export const galleryEditPath = (slug) => `/admin/galeria/${slug}`;

/** What the client is sent. Absolute, because she pastes it into a message. */
export const galleryShareUrl = (slug) => `${baseUrl.replace(/\/+$/, '')}/g/${slug}`;
