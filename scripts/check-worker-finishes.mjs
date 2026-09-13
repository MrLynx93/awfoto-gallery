/**
 * Proves the worker always leaves a gallery in a state the panel can stop
 * waiting on.
 *
 *   node scripts/check-worker-finishes.mjs
 *
 * Every bug this guards against looks identical from the outside: the progress
 * banner never goes away. `preparing` is the row's way of saying "a worker owes
 * this gallery a run", and nothing else ever clears it — so a run that returns
 * early, or a request that arrives while another run holds the lock, leaves the
 * bar on screen with nothing coming to take it down. Both happened:
 *
 * - Deleting the **last** photo left `preparing` set forever. The worker found
 *   no photos, returned "nothing to do", and the panel polled that gallery for
 *   as long as the tab stayed open.
 * - Deleting a photo while a worker was still running lost the request: the
 *   spawn found the lock held and exited, and the run holding it had already
 *   passed that gallery. Only the five-minute cron picked it up — where there
 *   is a cron.
 *
 * This runs **the real worker**, with the database swapped for one JSON file:
 * `server/` is copied to a temp directory and only `db.js` and `galleries.js`
 * are replaced, so worker.js, photos.js, storage.js and archive.js are exactly
 * the files that ship. Every photo starts with its derivatives already on disk,
 * which is what a delete leaves behind — so no ImageMagick is needed, and the
 * archive is rebuilt by the same `zip` the host runs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const SLUG = 'sesja';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(path.join(os.tmpdir(), 'awfoto-worker-'));
const server = path.join(root, 'server');

await cp(path.join(repo, 'server'), server, { recursive: true });

// The two seams. Everything else under server/ is the real thing.
await writeFile(
  path.join(server, 'db.js'),
  `export const db = () => { throw new Error('no database here'); };
   export const migrate = async () => {};
   export const close = async () => {};\n`,
);
await writeFile(
  path.join(server, 'galleries.js'),
  `import { readFileSync, writeFileSync } from 'node:fs';
   const ROW = process.env.ROW_PATH;
   const read = () => JSON.parse(readFileSync(ROW, 'utf8'));
   const write = (row) => writeFileSync(ROW, JSON.stringify(row, null, 2));
   export async function findBySlug(slug) {
     const row = read();
     return row.slug === slug ? row : null;
   }
   export async function needingWork() {
     const row = read();
     return row.status === 'failed' ? [] : [row];
   }
   export async function markReady(slug, { photoCount, bytesTotal, status = 'ready' }) {
     write({ ...read(), photoCount, bytesTotal, status });
   }
   export async function markPhotosChanged(slug, photoCount) {
     const row = read();
     write({ ...row, photoCount, bytesTotal: photoCount === 0 ? 0 : row.bytesTotal, status: 'preparing' });
   }
   export async function totalBytes() { return Number(read().bytesTotal) || 0; }
   export const isExpired = () => false;\n`,
);

process.env.STORAGE_ROOT = path.join(root, 'storage');
process.env.ROW_PATH = path.join(root, 'row.json');
process.env.DISK_BUDGET_GB = '12';

const load = (file) => import(pathToFileURL(path.join(server, file)).href);
const S = await load('storage.js');
const { newPhotoId, removePhoto } = await load('photos.js');
const { markPhotosChanged } = await load('galleries.js');
const { runOnce, WAKE_PATH } = await load('worker.js');

const readRow = async () => JSON.parse(await readFile(process.env.ROW_PATH, 'utf8'));

/** The row as the panel would have it, with the last upload safely in the past. */
const setRow = (patch) =>
  writeFile(
    process.env.ROW_PATH,
    JSON.stringify(
      {
        id: 1,
        slug: SLUG,
        status: 'ready',
        photoCount: 0,
        bytesTotal: 0,
        lastUploadAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        ...patch,
      },
      null,
      2,
    ),
  );

/** A finished gallery on disk: originals, their records, previews, manifest. */
async function gallery(n) {
  await rm(path.join(process.env.STORAGE_ROOT, 'galleries', SLUG), { recursive: true, force: true });
  await mkdir(S.originalsDir(SLUG), { recursive: true });
  await mkdir(S.previewsDir(SLUG), { recursive: true });

  const photos = [];
  for (let i = 0; i < n; i += 1) {
    const id = newPhotoId();
    const filename = `DSC_000${i + 1}.jpg`;
    await writeFile(S.originalPath(SLUG, id, '.jpg'), `pixels ${id}`);
    await writeFile(
      S.photoRecordPath(SLUG, id),
      JSON.stringify({ id, filename, ext: '.jpg', uploadedAt: new Date(Date.now() - 600_000).toISOString() }),
    );
    for (const size of ['thumb', 'large']) {
      await writeFile(S.previewPath(SLUG, id, size), `${size} ${id}`);
    }
    // Dimensions included, as a real manifest has them: without they would send
    // the worker to `identify`, which is not the thing under test here.
    photos.push({ id, filename, ext: '.jpg', width: 3000, height: 2000, bytes: 11 });
  }
  await writeFile(S.manifestPath(SLUG), JSON.stringify({ slug: SLUG, photos }, null, 2));
  return photos;
}

const checks = [];
const check = (name, body) => checks.push([name, body]);

check('deleting one photo of three leaves the gallery ready', async () => {
  const photos = await gallery(3);
  await setRow({ status: 'ready', photoCount: 3, bytesTotal: 1000 });

  await removePhoto(SLUG, photos[1].id);
  await markPhotosChanged(SLUG, 2);
  await runOnce({ log: () => {} });

  const row = await readRow();
  assert.equal(row.status, 'ready');
  assert.equal(row.photoCount, 2);
  assert.equal((await S.readManifest(SLUG)).photos.length, 2);
});

check('deleting the last photo does not leave it preparing forever', async () => {
  const photos = await gallery(1);
  await setRow({ status: 'ready', photoCount: 1, bytesTotal: 1000 });

  await removePhoto(SLUG, photos[0].id);
  await markPhotosChanged(SLUG, 0);
  await runOnce({ log: () => {} });

  const row = await readRow();
  assert.notEqual(row.status, 'preparing', 'the banner would never go away');
  assert.equal(row.photoCount, 0);
});

check('an emptied gallery is finished once, then left alone', async () => {
  const photos = await gallery(1);
  await setRow({ status: 'ready', photoCount: 1, bytesTotal: 1000 });
  await removePhoto(SLUG, photos[0].id);
  await markPhotosChanged(SLUG, 0);
  await runOnce({ log: () => {} });

  const said = [];
  await runOnce({ log: (message) => said.push(message) });
  assert.deepEqual(said, [], 'a settled empty gallery is not work');
});

check('a gallery with nothing in it yet is not declared ready', async () => {
  await rm(path.join(process.env.STORAGE_ROOT, 'galleries', SLUG), { recursive: true, force: true });
  await setRow({ status: 'preparing', photoCount: 0, bytesTotal: 0 });

  await runOnce({ log: () => {} });

  // She has created the gallery and is about to drop a folder into it. Nothing
  // has been written for it, and nothing should be decided about it either.
  assert.equal((await readRow()).status, 'preparing');
});

check('a delete during a run is picked up by that same run', async () => {
  const photos = await gallery(3);
  await setRow({ status: 'preparing', photoCount: 3, bytesTotal: 1000 });

  let interrupted = false;
  const said = [];

  await runOnce({
    log: (message) => {
      said.push(message);
      if (interrupted || !message.includes('ready, 3 photos')) return;
      interrupted = true;

      // What the page does when she presses "Tak, usuń zdjęcie" while this run
      // is still going -- written synchronously because the worker does not
      // await its logger, and the worker it would spawn exits on the held lock
      // anyway, leaving only the wake file behind.
      const doomed = photos[2];
      fs.unlinkSync(S.originalPath(SLUG, doomed.id, '.jpg'));
      fs.unlinkSync(S.photoRecordPath(SLUG, doomed.id));
      for (const size of ['thumb', 'large']) fs.unlinkSync(S.previewPath(SLUG, doomed.id, size));
      fs.rmSync(S.archivePath(SLUG), { force: true });
      fs.writeFileSync(
        S.manifestPath(SLUG),
        JSON.stringify({ slug: SLUG, photos: photos.slice(0, 2) }, null, 2),
      );
      fs.writeFileSync(
        process.env.ROW_PATH,
        JSON.stringify({
          ...JSON.parse(fs.readFileSync(process.env.ROW_PATH, 'utf8')),
          photoCount: 2,
          status: 'preparing',
        }),
      );
      const now = new Date();
      try {
        fs.utimesSync(WAKE_PATH, now, now);
      } catch {
        fs.closeSync(fs.openSync(WAKE_PATH, 'w'));
      }
    },
  });

  const row = await readRow();
  assert.equal(interrupted, true, 'the run never reached the point being tested');
  assert.equal(row.status, 'ready', `left ${row.status}; log: ${said.join(' | ')}`);
  assert.equal(row.photoCount, 2);
});

let failed = 0;
for (const [name, body] of checks) {
  try {
    await body();
    console.log(`[check] ok — ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[check] FAILED — ${name}`);
    console.error(`        ${String(error.message).split('\n').join('\n        ')}`);
  }
}

await rm(root, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n[check] ${failed} worker check(s) failed.`);
  process.exit(1);
}
console.log(`\n[check] the worker always stops the panel waiting (${checks.length} checks).`);
