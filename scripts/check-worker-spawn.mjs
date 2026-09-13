/**
 * Proves that a page can still start the worker.
 *
 *   node scripts/check-worker-spawn.mjs
 *
 * This one is from the field. Deleting a photo left the gallery saying
 * "przygotowuję" forever, while uploads were fine — and the difference was
 * where `wake.js` was *running from*. Astro bundles `server/wake.js` into
 * `dist/server/chunks/<hash>.mjs`, so in a page `import.meta.url` points inside
 * the bundle, and the worker path it built —
 * `dist/server/chunks/worker.js` — did not exist. `app.js` imports the same
 * file straight off disk, where `worker.js` really is the neighbour, so the
 * upload path never noticed. The spawn failed silently on every delete.
 *
 * So this reproduces the bundled situation exactly: a copy of `server/` with
 * `worker.js` taken out of it, imported from there, with the working directory
 * still the app root. `resolveWorkerPath()` has to find the real one anyway —
 * and then it actually spawns it, because a path that merely exists is not the
 * same as a worker that starts.
 *
 * The spawned run has no database, so it fails at `migrate()` and says so in
 * its log. That is fine and is in fact the proof: it got far enough to write
 * the log at all, which is something only a process that really started does.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(path.join(os.tmpdir(), 'awfoto-spawn-'));

// A copy standing in for the Astro bundle: wake.js lives here, worker.js does
// not, and neither does anything else it could reach by looking next to itself.
const bundled = path.join(root, 'chunks');
await cp(path.join(repo, 'server'), bundled, { recursive: true });
await rm(path.join(bundled, 'worker.js'));

process.env.STORAGE_ROOT = path.join(root, 'storage');
delete process.env.WORKER_PATH;
delete process.env.DB_NAME;

const wake = await import(pathToFileURL(path.join(bundled, 'wake.js')).href);

const checks = [];
const check = (name, body) => checks.push([name, body]);

check('a bundled wake.js still finds the real worker', async () => {
  const found = wake.resolveWorkerPath();
  assert.equal(
    found,
    path.join(repo, 'server', 'worker.js'),
    `resolved to ${found}, which is not the worker that ships`,
  );
  assert.equal(fs.existsSync(found), true);
});

check('and the worker it finds actually starts', async () => {
  const log = path.join(process.env.STORAGE_ROOT, 'worker.log');
  await rm(log, { force: true });

  wake.wakeWorker('check');

  // Node's own startup, then the first line the run writes.
  const deadline = Date.now() + 20_000;
  let text = '';
  while (Date.now() < deadline) {
    text = await readFile(log, 'utf8').catch(() => '');
    if (text.includes('[worker]')) break;
    await delay(200);
  }

  assert.match(text, /\[worker\] run started/, `worker.log said: ${text || '(nothing at all)'}`);
});

check('the wake is recorded before the spawn, so a busy run still sees it', async () => {
  const wakeFile = path.join(process.env.STORAGE_ROOT, 'worker.wake');
  assert.equal(fs.existsSync(wakeFile), true);
});

check('nothing to spawn is said out loud rather than passed over', async () => {
  const said = [];
  const error = console.error;
  console.error = (...args) => said.push(args.join(' '));
  process.env.WORKER_PATH = path.join(root, 'nowhere', 'worker.js');
  try {
    // With WORKER_PATH pointing at nothing and cwd moved somewhere without a
    // server/ directory, there is genuinely nothing to run.
    const cwd = process.cwd();
    process.chdir(root);
    try {
      wake.wakeWorker('check');
    } finally {
      process.chdir(cwd);
    }
  } finally {
    console.error = error;
    delete process.env.WORKER_PATH;
  }

  assert.match(said.join('\n'), /cannot find worker\.js/);
});

let failed = 0;
for (const [name, body] of checks) {
  try {
    await body();
    console.log(`[check] ok — ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`[check] FAILED — ${name}`);
    console.error(`        ${String(err.message).split('\n').join('\n        ')}`);
  }
}

await rm(root, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n[check] ${failed} spawn check(s) failed — a page could not start the worker.`);
  process.exit(1);
}
console.log(`\n[check] a page can start the worker from anywhere it is bundled (${checks.length} checks).`);
