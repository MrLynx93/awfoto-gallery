/**
 * Keeping the previews under the photos they were made from.
 *
 * A photo's identity is its position: the worker lists the originals in name
 * order and writes previews as `<n>-thumb.jpg`, so "photo 3" means the third
 * file. That is cheap and it is what every route and the grid already assume --
 * but it means the numbering is only stable while the *set* of originals is.
 *
 * It is not. Two things move it:
 *
 * - She adds the few photos she forgot. `DSC_0100.jpg` sorts ahead of half a
 *   wedding, so every photo after it moves up one place.
 * - A first batch lands in whatever order the uploads finish, which is not the
 *   order the names sort in. Each worker run re-reads the directory and sorts
 *   it again, so a file that arrives late but sorts early shifts the rest the
 *   same way.
 *
 * Left alone, the worker's reuse check ("index 4 already has both derivatives,
 * skip the work") would find a preview sitting at every one of those positions
 * and keep it -- handing the client a grid where each photo shows its
 * neighbour, the last one appears twice, and every tile is drawn at a ratio
 * belonging to a different frame. That is the bug this file exists to stop.
 *
 * The fix is the one `server/photos.js` already uses for a delete: *rename* the
 * previews into their new positions rather than re-encode them. A few renames
 * replace the tail of a wedding going back through ImageMagick.
 *
 * Which photo a numbered preview belongs to is not written on the file, so the
 * manifest is the record -- and the manifest is rewritten here in the same
 * breath as the renames, so a run that dies in between leaves the two still
 * agreeing with each other.
 */
import path from 'node:path';
import { readdir, rename, rm, writeFile } from 'node:fs/promises';

import { manifestPath, previewPath, previewsDir } from './storage.js';

const SIZES = ['thumb', 'large'];

/** What `previewPath` produces, and the only names that claim a position. */
const PREVIEW_PATTERN = /^(\d+)-(thumb|large)\.jpg$/;

/**
 * Where a preview waits while the previews around it are also moving.
 *
 * Deliberately matches neither `PREVIEW_PATTERN` nor the `-large.jpg` suffix
 * `storage.js` counts for the progress bar: a file in mid-move belongs to no
 * position yet and must not be read as one.
 */
const stagingPath = (slug, index, size) =>
  path.join(previewsDir(slug), `.moving-${index}-${size}.jpg.part`);

/** Renames, tolerating a preview that was never made (a file the worker skipped). */
async function move(from, to) {
  try {
    await rename(from, to);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const remove = (slug, name) => rm(path.join(previewsDir(slug), name), { force: true });

/**
 * A shift is a permutation, so one move's source is very often another move's
 * target: renaming straight into place would overwrite a preview that has not
 * been picked up yet. Everything that moves goes to a staging name first and
 * lands afterwards, which costs a second rename and nothing else.
 */
const stage = async (slug, moves) => {
  for (const { from } of moves) {
    for (const size of SIZES) await move(previewPath(slug, from, size), stagingPath(slug, from, size));
  }
};

const unstage = async (slug, moves) => {
  for (const { from, to } of moves) {
    for (const size of SIZES) await move(stagingPath(slug, from, size), previewPath(slug, to, size));
  }
};

const listPreviews = async (slug) => {
  try {
    return await readdir(previewsDir(slug));
  } catch {
    // Made by the first run that has a photo to resize; nothing to reconcile.
    return null;
  }
};

/**
 * Moves the previews of `previous` onto the positions `files` now gives them,
 * and drops every preview that no current photo claims.
 *
 * @param slug     the gallery
 * @param files    the originals, in the order the worker is about to number them
 * @param previous the last manifest, or null if there is none
 * @returns the manifest as it now stands on disk, or null when nothing on disk
 *   can be trusted to describe a photo anymore.
 */
export async function reconcilePreviews(slug, files, previous, { log = console.log } = {}) {
  const entries = await listPreviews(slug);
  if (entries === null) return previous;

  // A run killed mid-move. The previews it was carrying are unreachable now --
  // they name a position they had already left -- so they go and are remade.
  await Promise.all(
    entries.filter((name) => name.endsWith('.jpg.part')).map((name) => remove(slug, name)),
  );

  const previews = entries.filter((name) => PREVIEW_PATTERN.test(name));
  if (previews.length === 0) return previous;

  // Nothing says which photo each of these was made from. A preview attributed
  // to the wrong photo is worse than no preview at all -- it is exactly the
  // duplicate-and-stretched grid this file exists to prevent -- so they are
  // remade rather than guessed at. Only reachable for a batch interrupted
  // before it ever wrote a manifest; a settled gallery always has one.
  if (!previous) {
    log(`[worker] ${slug}: ${previews.length} preview file(s) with no manifest to place them — remaking`);
    await Promise.all(previews.map((name) => remove(slug, name)));
    return null;
  }

  const position = new Map(files.map((filename, index) => [filename, index]));

  const moves = [];
  const inPlace = new Set();
  const kept = [];

  for (const photo of previous.photos ?? []) {
    const to = position.get(photo.filename);
    // Its original is gone (deleted, or swept). Its preview is left unclaimed
    // below and removed with the rest.
    if (to === undefined || !Number.isInteger(photo.index)) continue;

    if (photo.index === to) inPlace.add(to);
    else moves.push({ from: photo.index, to });
    kept.push({ ...photo, index: to });
  }

  await stage(slug, moves);

  // With everything that moves held aside, a numbered preview still sitting
  // here is one nothing claims: the leftovers of a deleted original, or one
  // made for a position that now holds a different photo. Reusing either is
  // how the wrong photograph ends up on the tile.
  for (const name of await readdir(previewsDir(slug))) {
    const match = PREVIEW_PATTERN.exec(name);
    if (match && !inPlace.has(Number(match[1]))) await remove(slug, name);
  }

  await unstage(slug, moves);

  kept.sort((a, b) => a.index - b.index);
  await writeManifest(slug, kept);

  if (moves.length > 0) {
    log(`[worker] ${slug}: moved ${moves.length} preview(s) to the positions the new order gives them`);
  }

  return { slug, photos: kept };
}

/**
 * Closes the gap a skipped file leaves.
 *
 * The worker numbers previews by a photo's position in the directory listing,
 * then drops any file it could not read -- so the manifest it is about to write
 * counts from 0 with no gaps while the previews after the skipped one are still
 * one place higher. Every route reads a photo's index as both, so they have to
 * mean the same thing. Mutates `photos` to its final numbering.
 */
export async function compactPreviews(slug, photos) {
  const moves = [];
  photos.forEach((photo, position) => {
    if (photo.index !== position) moves.push({ from: photo.index, to: position });
    photo.index = position;
  });

  if (moves.length > 0) {
    await stage(slug, moves);
    await unstage(slug, moves);
  }

  // Whatever the shift left beyond the last photo, plus the skipped file's own
  // previews if it got as far as making them.
  const entries = (await listPreviews(slug)) ?? [];
  for (const name of entries) {
    const match = PREVIEW_PATTERN.exec(name);
    if (match && Number(match[1]) >= photos.length) await remove(slug, name);
  }
}

/**
 * The manifest, written from whatever the previews on disk now say.
 *
 * Shape and formatting match what the worker writes at the end of a run: this
 * is the same file, brought up to date earlier so that it never describes an
 * arrangement of previews that no longer exists.
 */
const writeManifest = (slug, photos) =>
  writeFile(manifestPath(slug), JSON.stringify({ slug, photos }, null, 2) + '\n');
