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
  server: { port: 4322 },
});
