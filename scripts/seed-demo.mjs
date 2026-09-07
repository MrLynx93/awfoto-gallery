/**
 * Lays out one example session under STORAGE_ROOT, in exactly the shape the
 * worker will produce, so the client gallery can be looked at before the upload
 * and worker milestones exist.
 *
 *   node scripts/seed-demo.mjs [source-directory]
 *
 * The default source is the placeholder set from the awfoto-site content
 * template — generated gradients, not anyone's photographs, which is what makes
 * them safe to use for a demo.
 *
 * Derivatives go through the same two sizes the worker uses. If an image CLI is
 * on this machine it is used; otherwise the sources are copied and the script
 * says so, because a demo that silently ships full-size files as "thumbnails"
 * would misrepresent how the grid performs.
 */
import { mkdir, copyFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { generatePassword } from '../server/passwords.js';
import { create, markReady, findBySlug } from '../server/galleries.js';
import { close } from '../server/db.js';
import {
  galleryDir,
  originalsDir,
  previewsDir,
  previewPath,
  manifestPath,
} from '../server/storage.js';

const run = promisify(execFile);

const GALLERY_ID = process.env.DEMO_GALLERY_ID || 'demo';
const DEFAULT_SOURCE =
  '/home/user/mrlynx93/awfoto-site/content-template/images/sessions';
const source = process.argv[2] || DEFAULT_SOURCE;

// Same numbers as the worker, from CLAUDE.md's "Preview sizes".
const THUMB = { edge: 500, quality: 78 };
const LARGE = { edge: 2048, quality: 82 };

async function findImageCli() {
  for (const bin of ['magick', 'vipsthumbnail']) {
    try {
      await run(bin, ['--version']);
      return bin;
    } catch {
      // Not installed here. The server has both; a laptop may have neither.
    }
  }
  return null;
}

async function collect(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collect(full)));
    else if (/\.(jpe?g|png)$/i.test(entry.name)) found.push(full);
  }
  return found;
}

async function derive(cli, src, dest, { edge, quality }) {
  if (cli === 'magick') {
    // -auto-orient before resizing, -colorspace sRGB rather than -strip: see
    // CLAUDE.md on why stripping the profile flattens an Adobe RGB export.
    await run('magick', [
      src, '-auto-orient', '-colorspace', 'sRGB',
      '-resize', `${edge}x${edge}>`, '-quality', String(quality), dest,
    ]);
  } else if (cli === 'vipsthumbnail') {
    await run('vipsthumbnail', [
      src, '--size', `${edge}x${edge}>`, '--export-profile', 'srgb',
      '-o', `${dest}[Q=${quality}]`,
    ]);
  } else {
    await copyFile(src, dest);
  }
}

const cli = await findImageCli();
const sources = (await collect(source)).sort();
if (!sources.length) {
  console.error(`No images under ${source}`);
process.exit(1);
}

// Start clean, so re-running does not leave stale photos from a longer run.
await rm(galleryDir(GALLERY_ID), { recursive: true, force: true });
await mkdir(originalsDir(GALLERY_ID), { recursive: true });
await mkdir(previewsDir(GALLERY_ID), { recursive: true });

const photos = [];
for (const [index, src] of sources.entries()) {
  // The name the client will see in their downloads folder. The demo invents
  // one that looks like a camera export, since the placeholders are all
  // called image.jpg and would collide.
  const filename = `AWF_${String(index + 1).padStart(4, '0')}.jpg`;
  await copyFile(src, path.join(originalsDir(GALLERY_ID), filename));
  await derive(cli, src, previewPath(GALLERY_ID, index, 'thumb'), THUMB);
  await derive(cli, src, previewPath(GALLERY_ID, index, 'large'), LARGE);
  photos.push({ index, filename, bytes: (await stat(src)).size });
}

// A real password, and a real row. The demo exercises the actual gate rather
// than a bypass, so what is being looked at is what ships.
const password = generatePassword();
const { slug } = await create({
  clientName: 'Zuzia i Marek',
  shootDate: '2026-09-19',
  password,
  expiryDays: 30,
});

// The manifest carries per-photo detail; the row carries everything the
// gallery is authorised against.
await writeFile(
  manifestPath(GALLERY_ID),
  JSON.stringify({ id: GALLERY_ID, slug, photos }, null, 2) + '\n',
);

const bytesTotal = photos.reduce((sum, photo) => sum + photo.bytes, 0);
await markReady(slug, { photoCount: photos.length, bytesTotal });

console.log(`Seeded ${photos.length} photos into ${galleryDir(GALLERY_ID)}`);
console.log(cli ? `Derivatives via ${cli}.` : 'No image CLI here — originals copied as previews.');
console.log(`\n  Link:     /g/${slug}\n  Password: ${password}\n`);

// The gallery directory is named by the slug the database issued, so the two
// cannot drift apart.
if (slug !== GALLERY_ID) {
  const { rename } = await import('node:fs/promises');
  await rm(galleryDir(slug), { recursive: true, force: true });
  await rename(galleryDir(GALLERY_ID), galleryDir(slug));
}

await close();
