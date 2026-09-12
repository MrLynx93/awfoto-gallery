/**
 * Proves the one rule everything else here rests on: **a photo is its id.**
 *
 * Two bugs are being kept out, and both were live:
 *
 * - Identity by *position*. Previews were named `<n>-thumb.jpg`, so a photo
 *   added ahead of others moved every position after it and each preview then
 *   belonged to the photo next door -- the grid showed every tile shifted by
 *   one, the last photo twice, the new one nowhere, each drawn at another
 *   frame's proportions. Silent: nothing failed, the gallery was just wrong.
 * - Identity by *filename*. Stable under insertion, but it makes two photos
 *   with the same name one photo -- and two cards in one camera bag both hold
 *   a DSC_0001.jpg.
 *
 * Runs against a throwaway STORAGE_ROOT, with text files standing in for
 * JPEGs: what is being checked is which bytes are reachable under which name,
 * and no resizing is involved in getting that right. No database either -- the
 * identity of a photograph is a question about files.
 *
 *   node scripts/check-photo-identity.mjs
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

const run = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'awfoto-photos-'));
process.env.STORAGE_ROOT = root;

// After STORAGE_ROOT is set: config.js resolves it at import.
const storage = await import('../server/storage.js');
const { newPhotoId, removePhoto } = await import('../server/photos.js');
const { buildArchive } = await import('../server/archive.js');

const SLUG = 'test-gallery';

/** What the tus hook does when an upload finishes: bytes first, record after. */
async function upload(filename, { ext = '.jpg', body } = {}) {
  const id = newPhotoId();
  await mkdir(storage.originalsDir(SLUG), { recursive: true });
  await writeFile(storage.originalPath(SLUG, id, ext), body ?? `bytes of ${filename}#${id}`);
  await writeFile(
    storage.photoRecordPath(SLUG, id),
    JSON.stringify({ id, filename, ext, uploadedAt: new Date().toISOString() }),
  );
  return id;
}

/** What the worker writes once a photo has both derivatives. */
async function derive(id) {
  await mkdir(storage.previewsDir(SLUG), { recursive: true });
  for (const size of ['thumb', 'large']) {
    await writeFile(storage.previewPath(SLUG, id, size), `${size} of ${id}`);
  }
}

const fresh = async () => rm(path.join(root, 'galleries', SLUG), { recursive: true, force: true });

const checks = [];
const check = (name, body) => checks.push([name, body]);

check('the same filename uploaded twice is two photographs', async () => {
  await fresh();
  const first = await upload('DSC_0001.jpg');
  // A couple of milliseconds apart, as two real uploads are: with the name
  // tied, the earlier upload is what settles the order.
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await upload('DSC_0001.jpg');

  assert.notEqual(first, second);

  const photos = await storage.listPhotos(SLUG);
  assert.equal(photos.length, 2, 'both uploads should survive as separate photos');
  assert.deepEqual(photos.map((photo) => photo.filename), ['DSC_0001.jpg', 'DSC_0001.jpg']);

  // Two files on disk, neither overwritten by the other.
  const bytes = await Promise.all(
    photos.map((photo) => readFile(storage.originalPath(SLUG, photo.id, photo.ext), 'utf8')),
  );
  assert.notEqual(bytes[0], bytes[1], 'the second upload must not overwrite the first');

  // And the earlier upload sorts first, so the order does not wander between
  // runs -- a gallery that reshuffles itself on every worker run would be its
  // own kind of wrong.
  assert.equal(photos[0].id, first);
  assert.deepEqual((await storage.listPhotos(SLUG)).map((p) => p.id), [first, second]);
});

check('adding a photo that sorts first changes nothing about the others', async () => {
  await fresh();
  const existing = [await upload('b.jpg'), await upload('c.jpg')];
  for (const id of existing) await derive(id);

  const paths = existing.map((id) => storage.previewPath(SLUG, id, 'thumb'));
  const contents = await Promise.all(paths.map((file) => readFile(file, 'utf8')));

  await upload('a.jpg');

  const photos = await storage.listPhotos(SLUG);
  assert.deepEqual(photos.map((photo) => photo.filename), ['a.jpg', 'b.jpg', 'c.jpg']);

  // The new photo took first place in the running order and nothing else moved:
  // same paths, same bytes, and no preview for the newcomer to inherit.
  assert.deepEqual(
    existing.map((id) => storage.previewPath(SLUG, id, 'thumb')),
    paths,
  );
  assert.deepEqual(await Promise.all(paths.map((file) => readFile(file, 'utf8'))), contents);
  await assert.rejects(readFile(storage.previewPath(SLUG, photos[0].id, 'thumb')));
});

check('deleting a photo touches that photo and nothing else', async () => {
  await fresh();
  const ids = [await upload('a.jpg'), await upload('b.jpg'), await upload('c.jpg')];
  for (const id of ids) await derive(id);

  const photos = await storage.listPhotos(SLUG);
  await writeFile(
    storage.manifestPath(SLUG),
    JSON.stringify({ slug: SLUG, photos: photos.map((p) => ({ ...p, width: 3, height: 2 })) }),
  );

  const removed = await removePhoto(SLUG, ids[1]);
  assert.equal(removed.remaining, 2);

  assert.deepEqual(
    (await storage.listPhotos(SLUG)).map((photo) => photo.id),
    [ids[0], ids[2]],
  );
  // The survivors keep their own previews, unrenamed: nothing shifts down.
  assert.equal(await readFile(storage.previewPath(SLUG, ids[2], 'thumb'), 'utf8'), `thumb of ${ids[2]}`);
  await assert.rejects(readFile(storage.previewPath(SLUG, ids[1], 'thumb')));
  await assert.rejects(readFile(storage.photoRecordPath(SLUG, ids[1]), 'utf8'));
});

check('an upload whose bytes never landed is reported, not counted', async () => {
  await fresh();
  const good = await upload('a.jpg');
  await mkdir(storage.originalsDir(SLUG), { recursive: true });
  await writeFile(
    storage.photoRecordPath(SLUG, 'orphanrecord'),
    JSON.stringify({ id: 'orphanrecord', filename: 'b.jpg', ext: '.jpg' }),
  );

  const seen = [];
  const photos = await storage.listPhotos(SLUG, { onIncomplete: (r) => seen.push(r.filename) });

  assert.deepEqual(photos.map((photo) => photo.id), [good]);
  assert.deepEqual(seen, ['b.jpg']);
});

check('a photo id can never name a file outside its gallery', async () => {
  for (const bad of ['../../../etc/passwd', 'a/b', '', '.', 'a.jpg\0']) {
    assert.throws(() => storage.previewPath(SLUG, bad, 'thumb'), /Unsafe photo id/);
    assert.throws(() => storage.originalPath(SLUG, bad, '.jpg'), /Unsafe photo id/);
  }
  for (const bad of ['.jp/g', '..', '.jpg.exe', 'jpg']) {
    assert.throws(() => storage.originalPath(SLUG, 'abc', bad), /Unsafe extension/);
  }
});

check('the archive carries her filenames, and numbers a repeated one', async () => {
  await fresh();
  const ids = [
    await upload('DSC_0001.jpg', { body: 'first card' }),
    await upload('DSC_0001.jpg', { body: 'second card' }),
    await upload('Zosia i Marek.jpg', { body: 'third' }),
  ];

  const photos = await storage.listPhotos(SLUG);
  const archive = await buildArchive(
    photos.map((photo) => ({
      path: storage.originalPath(SLUG, photo.id, photo.ext),
      name: photo.filename,
    })),
    storage.archivePath(SLUG),
  );

  const { stdout } = await run('unzip', ['-Z', '-1', archive.path]);
  const names = stdout.trim().split('\n').sort();
  assert.deepEqual(names, ['DSC_0001 (2).jpg', 'DSC_0001.jpg', 'Zosia i Marek.jpg']);

  // Both copies are in there, with their own bytes -- the numbering is what
  // stops the second from replacing the first on the client's machine.
  const extracted = path.join(root, 'extracted');
  await run('unzip', ['-qq', '-o', archive.path, '-d', extracted]);
  const bodies = await Promise.all(
    names.map((name) => readFile(path.join(extracted, name), 'utf8')),
  );
  assert.deepEqual(bodies.sort(), ['first card', 'second card', 'third']);

  // Nothing of the staging directory is left behind.
  assert.deepEqual(
    (await readdir(path.dirname(archive.path))).filter((n) => n.includes('.entries')),
    [],
  );
  assert.equal(ids.length, 3);
});

check('rebuilding an archive does not keep entries from the last one', async () => {
  await fresh();
  const id = await upload('a.jpg');
  const first = await storage.listPhotos(SLUG);
  const entries = (photos) =>
    photos.map((photo) => ({
      path: storage.originalPath(SLUG, photo.id, photo.ext),
      name: photo.filename,
    }));

  await buildArchive(entries(first), storage.archivePath(SLUG));
  await removePhoto(SLUG, id).catch(() => {});
  await rm(storage.originalPath(SLUG, id, '.jpg'), { force: true });
  await rm(storage.photoRecordPath(SLUG, id), { force: true });
  await upload('b.jpg');

  const archive = await buildArchive(entries(await storage.listPhotos(SLUG)), storage.archivePath(SLUG));
  const { stdout } = await run('unzip', ['-Z', '-1', archive.path]);
  assert.deepEqual(stdout.trim().split('\n'), ['b.jpg']);
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
  console.error(`\n[check] ${failed} photo-identity check(s) failed.`);
  process.exit(1);
}
console.log(`\n[check] a photo is its id, and stays its own (${checks.length} checks).`);
