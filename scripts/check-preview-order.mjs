/**
 * Proves that previews stay under the photos they were made from.
 *
 * The bug this guards against: a photo's identity is its position, previews are
 * named `<n>-thumb.jpg`, and adding a file that sorts early moves every photo
 * after it. The worker's reuse check ("that position already has both
 * derivatives") then kept each preview where it was, so the grid showed every
 * photo one place out, the last one twice, and each tile at another frame's
 * proportions. It is silent -- nothing fails, the gallery just comes out wrong
 * -- so it needs a check rather than a careful reading.
 *
 * Runs against a throwaway STORAGE_ROOT with text files standing in for JPEGs:
 * what matters is which bytes end up at which position, and no resizing is
 * involved in getting that right.
 *
 *   node scripts/check-preview-order.mjs
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'awfoto-previews-'));
process.env.STORAGE_ROOT = root;

// After STORAGE_ROOT is set: config.js resolves it at import.
const { reconcilePreviews, compactPreviews } = await import('../server/previews.js');
const { previewsDir, previewPath, manifestPath, readManifest } = await import(
  '../server/storage.js'
);

const SLUG = 'test-gallery';
const quiet = () => {};

/** A gallery whose previews and manifest agree: photo `n` of `names` at index n. */
async function given(names, { manifest = true } = {}) {
  await rm(path.join(root, 'galleries', SLUG), { recursive: true, force: true });
  await mkdir(previewsDir(SLUG), { recursive: true });

  const photos = names.map((filename, index) => ({
    index,
    filename,
    // Distinct on purpose: a photo drawn at another photo's proportions is the
    // "stretched" half of the bug, and it travels with the manifest entry.
    width: 1000 + index,
    height: 600 + index,
    bytes: 100 + index,
  }));

  for (const { index, filename } of photos) {
    for (const size of ['thumb', 'large']) {
      await writeFile(previewPath(SLUG, index, size), `${filename}:${size}`);
    }
  }
  if (manifest) {
    await writeFile(manifestPath(SLUG), JSON.stringify({ slug: SLUG, photos }, null, 2));
  }
  return photos;
}

/** Which original each numbered preview was made from, read off the bytes. */
async function previewsOnDisk() {
  const found = {};
  for (const name of (await readdir(previewsDir(SLUG))).sort()) {
    const match = /^(\d+)-thumb\.jpg$/.exec(name);
    if (match) found[Number(match[1])] = (await readFile(previewPath(SLUG, Number(match[1]), 'thumb'), 'utf8')).replace(':thumb', '');
  }
  return found;
}

const checks = [];
const check = (name, body) => checks.push([name, body]);

check('a photo added in front moves the others up instead of stealing their previews', async () => {
  const previous = { slug: SLUG, photos: await given(['b.jpg', 'c.jpg', 'd.jpg']) };
  const files = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'];

  await reconcilePreviews(SLUG, files, previous, { log: quiet });

  assert.deepEqual(await previewsOnDisk(), { 1: 'b.jpg', 2: 'c.jpg', 3: 'd.jpg' });

  // Position 0 is left empty for the new photo rather than holding b.jpg's
  // preview: an occupied position is exactly what the worker would reuse.
  await assert.rejects(readFile(previewPath(SLUG, 0, 'thumb')));

  const manifest = await readManifest(SLUG);
  assert.deepEqual(
    manifest.photos.map((photo) => [photo.index, photo.filename]),
    [[1, 'b.jpg'], [2, 'c.jpg'], [3, 'd.jpg']],
  );
  // The proportions travel with the photo, not with the position.
  assert.equal(manifest.photos.find((p) => p.filename === 'b.jpg').width, 1000);
});

check('a photo added in the middle only moves what comes after it', async () => {
  const previous = { slug: SLUG, photos: await given(['a.jpg', 'c.jpg']) };

  await reconcilePreviews(SLUG, ['a.jpg', 'b.jpg', 'c.jpg'], previous, { log: quiet });

  assert.deepEqual(await previewsOnDisk(), { 0: 'a.jpg', 2: 'c.jpg' });
});

check('a photo added at the end leaves every preview alone', async () => {
  const previous = { slug: SLUG, photos: await given(['a.jpg', 'b.jpg']) };

  await reconcilePreviews(SLUG, ['a.jpg', 'b.jpg', 'c.jpg'], previous, { log: quiet });

  assert.deepEqual(await previewsOnDisk(), { 0: 'a.jpg', 1: 'b.jpg' });
});

check('an unchanged gallery is not touched at all', async () => {
  const previous = { slug: SLUG, photos: await given(['a.jpg', 'b.jpg', 'c.jpg']) };

  const result = await reconcilePreviews(SLUG, ['a.jpg', 'b.jpg', 'c.jpg'], previous, {
    log: quiet,
  });

  assert.deepEqual(await previewsOnDisk(), { 0: 'a.jpg', 1: 'b.jpg', 2: 'c.jpg' });
  assert.deepEqual(
    result.photos.map((photo) => photo.filename),
    ['a.jpg', 'b.jpg', 'c.jpg'],
  );
});

check('an original that vanished takes its preview with it', async () => {
  const previous = { slug: SLUG, photos: await given(['a.jpg', 'b.jpg', 'c.jpg']) };

  await reconcilePreviews(SLUG, ['a.jpg', 'c.jpg'], previous, { log: quiet });

  assert.deepEqual(await previewsOnDisk(), { 0: 'a.jpg', 1: 'c.jpg' });
});

check('previews with no manifest to place them are remade, not guessed at', async () => {
  await given(['a.jpg', 'b.jpg'], { manifest: false });

  const result = await reconcilePreviews(SLUG, ['new.jpg', 'a.jpg', 'b.jpg'], null, { log: quiet });

  assert.equal(result, null);
  assert.deepEqual(await previewsOnDisk(), {});
});

check('a preview left mid-move by a killed run is cleared', async () => {
  const previous = { slug: SLUG, photos: await given(['a.jpg']) };
  await writeFile(path.join(previewsDir(SLUG), '.moving-7-thumb.jpg.part'), 'orphan');

  await reconcilePreviews(SLUG, ['a.jpg'], previous, { log: quiet });

  assert.deepEqual(await readdir(previewsDir(SLUG)), ['0-large.jpg', '0-thumb.jpg']);
});

check('a skipped file leaves no gap between the manifest and the previews', async () => {
  await given(['a.jpg', 'broken.jpg', 'c.jpg']);
  // What the worker collects when it cannot read the middle file.
  const photos = [
    { index: 0, filename: 'a.jpg' },
    { index: 2, filename: 'c.jpg' },
  ];

  await compactPreviews(SLUG, photos);

  assert.deepEqual(await previewsOnDisk(), { 0: 'a.jpg', 1: 'c.jpg' });
  assert.deepEqual(photos.map((photo) => photo.index), [0, 1]);
});

let failed = 0;
for (const [name, body] of checks) {
  try {
    await body();
    console.log(`[check] ok — ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[check] FAILED — ${name}`);
    console.error(`        ${error.message.split('\n').join('\n        ')}`);
  }
}

await rm(root, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n[check] ${failed} preview-order check(s) failed.`);
  process.exit(1);
}
console.log(`\n[check] previews stay under their photos (${checks.length} checks).`);
