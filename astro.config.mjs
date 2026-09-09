// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';

/**
 * Server-rendered throughout. Unlike awfoto-site — which is a static build with
 * one dynamic subdomain — every page here depends on request state: a session
 * cookie, a gallery's expiry, a worker's progress. There is nothing to
 * pre-render.
 */
export default defineConfig({
  site: process.env.PUBLIC_BASE_URL || 'https://galeria.aw-foto.pl',
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  integrations: [react()],
  // The client never sees a URL it did not get from us, and trailing-slash
  // drift breaks the session cookie's path matching.
  trailingSlash: 'never',

  /**
   * Astro's own origin check is off, and replaced by one in app.js.
   *
   * Not a relaxation -- a correction. Astro compares the browser's Origin
   * against the origin it infers from the request, and behind nginx and
   * Passenger it infers plain HTTP on an internal hostname. That never matches
   * https://galeria.aw-foto.pl, so every form POST was refused with
   * "Cross-site POST form submissions are forbidden". It passed locally only
   * because there was no proxy in front.
   *
   * app.js does the same check against PUBLIC_BASE_URL, which is the origin the
   * browser actually sees, and covers the tus endpoint too -- which Astro never
   * saw, since it is mounted in Express.
   */
  security: { checkOrigin: false },
  server: { port: 4322 },
});
