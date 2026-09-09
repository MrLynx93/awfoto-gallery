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
import { uploadRouter } from './server/routes/upload.js';
import { migrate } from './server/db.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(root, 'dist', 'client');

/**
 * Migrations, started but NOT awaited here.
 *
 * Passenger loads this file with `require()`, and Node refuses to `require()`
 * an ESM graph that contains top-level await -- ERR_REQUIRE_ASYNC_MODULE, with
 * the app never starting at all. An earlier version awaited migrate() inside a
 * try block at module scope, which is still top-level await however it is
 * indented, and that took the whole site down.
 *
 * So the promise is created here and awaited inside a request handler instead.
 * The first request waits for the schema; every later one finds it settled.
 */
let startupError = null;

const migrating = migrate().catch((error) => {
  startupError = error;
  console.error('\n[start] The application could not reach its database.\n');
  console.error(`[start] ${error.message}\n`);

  const missing = ['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'SESSION_SECRET', 'ADMIN_PASSWORD_HASH']
    .filter((name) => !process.env[name]);

  if (missing.length > 0) {
    console.error(`[start] Missing from .env: ${missing.join(', ')}`);
    console.error('[start] Expected at ~/domains/<domain>/public_nodejs/.env (chmod 600).');
    console.error('[start] Run: sh scripts/setup-env.sh\n');
  } else {
    console.error('[start] All required variables are set, so this is the database');
    console.error('[start] itself: check the name, user and password against');
    console.error('[start] `devil mysql list -v` -- mydevil prefixes both names');
    console.error('[start] with the account login.\n');
  }
});

const app = express();
app.disable('x-powered-by');

// Nothing here should ever appear in a search result: not the admin screen, and
// certainly not a client's gallery.
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

/**
 * With no database there is no gallery, no login and no upload, so rather than
 * let every route fail in its own way this answers everything with one honest
 * page. A client who followed a link is told it is temporary and not their
 * fault; the detail stays in the log where the operator will look.
 *
 * Awaiting inside a handler is fine -- it is only *top-level* await that
 * Passenger's require() cannot load.
 */
app.use(async (req, res, next) => {
  await migrating;
  if (!startupError) return next();

  res.status(503).type('html').send(`<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Chwilowa przerwa — AW Fotografia</title>
    <style>
      body { margin:0; min-height:100vh; display:grid; place-items:center;
             background:#fdfbf7; color:#4a4038; font-family:'Jost',system-ui,sans-serif;
             font-weight:300; line-height:1.75; padding:2rem; }
      main { max-width:30rem; text-align:center; }
      h1 { font-family:Georgia,serif; font-weight:400; margin:0 0 0.6em; }
      a { color:#8e6b4f; }
    </style>
  </head>
  <body>
    <main>
      <h1>Chwilowa przerwa techniczna</h1>
      <p>Galeria jest teraz niedostępna. To nie jest problem z Twoim linkiem —
         zadziała ponownie, gdy usterka zostanie usunięta.</p>
      <p><a href="https://aw-foto.pl/kontakt">aw-foto.pl/kontakt</a></p>
    </main>
  </body>
</html>`);
});

// Photos, previews and archives. Mounted before the static handlers and the
// Astro handler, because these paths are not files in any docroot -- they are
// authorised reads from outside the web root.
app.use(filesRouter);

// The tus endpoint. Mounted before the Astro handler and before any body
// parser: tus needs the raw request stream, and a parser that consumed it
// would break every upload in a way that looks like a network fault.
app.use(uploadRouter);

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
