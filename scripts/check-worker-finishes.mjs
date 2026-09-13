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
// Read once, at import. A run that decides a gallery is still receiving files
// would otherwise sit in its poll loop for twenty minutes; here it should
// answer "not yet" and end, which is the thing being checked.
process.env.WORKER_MAX_WAIT_MS = '1';
process.env.WORKER_POLL_MS = '1';

const load = (file) => import(pathToFileURL(path.join(server, file)).href);
const S = await load('storage.js');
const { newPhotoId, removePhoto } = await load('photos.js');
const { markPhotosChanged } = await load('galleries.js');
const { runOnce, WAKE_PATH } = await load('worker.js');

const readRow = async () => JSON.parse(await readFile(process.env.ROW_PATH, 'utf8'));

/**
 * The row as the panel would have it, with the last upload safely in the past.
 *
 * `secondsSinceUpload` is what the real query computes in SQL; `lastUploadAt`
 * rides along exactly as it does in production, and the worker is expected to
 * ignore it.
 */
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
        secondsSinceUpload: 600,
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

check('a photo that cannot be converted does not hold the gallery open', async () => {
  const photos = await gallery(2);

  // A third upload whose bytes are not an image, and with no previews: the
  // worker has to convert it and cannot. (ImageMagick missing fails here the
  // same way, so this check does not depend on the host having it.)
  const doomed = newPhotoId();
  await writeFile(S.originalPath(SLUG, doomed, '.jpg'), 'not an image at all');
  await writeFile(
    S.photoRecordPath(SLUG, doomed),
    JSON.stringify({ id: doomed, filename: 'zepsute.jpg', ext: '.jpg', uploadedAt: new Date().toISOString() }),
  );
  await setRow({ status: 'preparing', photoCount: 2, bytesTotal: 1000 });

  await runOnce({ log: () => {} });

  // The two good photos are ready, and the count the panel compares against
  // disk agrees with the row -- which is what lets the banner go away.
  const row = await readRow();
  assert.equal(row.status, 'ready');
  assert.equal(row.photoCount, 2);
  assert.deepEqual(await S.progress(SLUG), { done: 2, total: 2 });

  // Set aside, not deleted: the bytes and what was known about them stay.
  assert.equal(fs.existsSync(S.originalPath(SLUG, doomed, '.jpg')), true);
  assert.equal(fs.existsSync(S.photoSkippedPath(SLUG, doomed)), true);
  assert.equal(fs.existsSync(S.photoRecordPath(SLUG, doomed)), false);
  assert.equal(photos.length, 2);

  // And it is not tried again on the next run.
  const said = [];
  await runOnce({ log: (message) => said.push(message) });
  assert.deepEqual(said, []);
});

check('a photo still arriving holds the gallery back', async () => {
  await gallery(2);
  // The row says the last *completed* upload was ten minutes ago, which is
  // what a 15 MB photo halfway up a domestic line looks like from the database.
  await setRow({ status: 'preparing', photoCount: 2, bytesTotal: 1000, secondsSinceUpload: 600 });

  const incoming = path.join(process.env.STORAGE_ROOT, 'incoming');
  fs.mkdirSync(incoming, { recursive: true });
  const partial = path.join(incoming, 'a1b2c3d4e5f6');
  fs.writeFileSync(partial, 'half a photograph');

  await runOnce({ log: () => {} });

  // Finalising here would build the archive without the photo that is still
  // coming, and then build it again when it lands.
  assert.equal((await readRow()).status, 'preparing', 'finalised mid-upload');

  // Once nothing has been written for a while, it finishes.
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(partial, old, old);
  await runOnce({ log: () => {} });

  const row = await readRow();
  assert.equal(row.status, 'ready');
  assert.equal(row.photoCount, 2);
  fs.rmSync(incoming, { recursive: true, force: true });
});

check('a clock the app does not share cannot stall a gallery', async () => {
  await gallery(2);
  // What a database keeping local time hands an app process running in UTC:
  // a last upload stamped two hours from now. Read with `new Date()` that is
  // "files are still arriving", and the worker used to answer 'waiting' to it
  // on every run -- for the whole two hours, with the banner up throughout.
  // The number beside it is the one the database actually measured.
  await setRow({
    status: 'preparing',
    photoCount: 2,
    bytesTotal: 1000,
    lastUploadAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' '),
    secondsSinceUpload: 600,
  });

  await runOnce({ log: () => {} });

  const row = await readRow();
  assert.equal(row.status, 'ready', 'the future-looking timestamp was believed');
  assert.equal(row.photoCount, 2);
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
