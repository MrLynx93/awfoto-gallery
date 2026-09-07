/**
 * Node entry point.
 *
 * Lives at the repo root because mydevil's Passenger looks for `app.js` at the
 * top of the domain's `public_nodejs/` directory, and the deploy rsyncs this
 * repo there. Locally it runs the real production path:
 *
 *   npm run build && npm run serve
 *
 * Modelled on awfoto-site/app.js, which is proven on this host. The difference:
 * there, nginx serves the photos and Node only handles the panel. Here **Node
 * serves every byte** — see CLAUDE.md, "Download path" — so this process is in
 * the path of every download, and the streaming test below exists to prove
 * Passenger can cope with that before any feature depends on it.
 */
// Must come first: it populates process.env before anything below reads it.
import './load-env.mjs';

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler as astroHandler } from './dist/server/entry.mjs';
import { filesRouter } from './server/routes/files.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(root, 'dist', 'client');

const app = express();
app.disable('x-powered-by');

// Nothing here should ever appear in a search result: not the admin screen, and
// certainly not a client's gallery.
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

/**
 * Milestone 1 streaming check — the open risk that outranks the others.
 *
 * If Passenger buffers responses or times out long requests, multi-GB downloads
 * break in a way that looks mysterious much later. This route proves the real
 * production mechanism (`res.sendFile`, which also brings Range support) end to
 * end on the real host.
 *
 * It serves exactly one operator-named file and nothing else: enabled only when
 * STREAM_TEST_FILE is set, and the path comes from the environment rather than
 * the request, so it can never be pointed at something by a caller. Unset the
 * variable once the check passes.
 */
if (process.env.STREAM_TEST_FILE) {
  const testFile = path.resolve(process.env.STREAM_TEST_FILE);
  app.get('/__streamtest', (req, res) => {
    // `dotfiles: 'allow'` because send(1) otherwise 404s any path containing a
    // dot-segment — which silently breaks a STORAGE_ROOT like ~/.galeria. That
    // guard exists to stop a docroot leaking .git or .env; here the path comes
    // from the environment and never from the request, so it protects nothing
    // and only surprises whoever picked a hidden directory.
    res.sendFile(testFile, { dotfiles: 'allow' }, (err) => {
      // An aborted download is the normal case, not an error worth logging:
      // every cancelled click and every Range probe ends this way.
      if (err && !res.headersSent) {
        console.error('[streamtest]', err.message);
        res.status(500).end();
      }
    });
  });
}

// Photos, previews and archives. Mounted before the static handlers and the
// Astro handler, because these paths are not files in any docroot -- they are
// authorised reads from outside the web root.
app.use(filesRouter);

// Hashed build assets never change under the same name, so they cache hard.
app.use(
  '/_astro',
  express.static(path.join(clientDir, '_astro'), { immutable: true, maxAge: '1y' }),
);
app.use(
  '/fonts',
  express.static(path.join(clientDir, 'fonts'), { immutable: true, maxAge: '1y' }),
);
app.use(express.static(clientDir, { maxAge: '1h' }));

app.use(astroHandler);

// Passenger supplies the socket; the port only matters when running locally.
const port = Number(process.env.PORT) || 4322;
app.listen(port, () => {
  console.log(`galeria.aw-foto.pl — http://localhost:${port}`);
});
