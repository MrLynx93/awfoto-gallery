/**
 * Builds the one ZIP a client downloads.
 *
 * The `zip` CLI rather than a native npm module, for the same reason as the
 * image work: no native dependency survives contact with this FreeBSD host.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, open, mkdir, rm, link, symlink, copyFile } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);

/**
 * The name this photo should have inside the archive.
 *
 * Reduced to a bare filename here as well as at upload, because this is the
 * one place it becomes a path again -- and shortened to fit, since a filename
 * over 255 bytes is a failed archive rather than a long name.
 */
function entryName(name) {
  const bare = path.basename(String(name ?? '')).replace(/[/\\]/g, '_').trim();
  if (!bare || bare === '.' || bare === '..') return null;

  const ext = path.extname(bare).slice(0, 12);
  const stem = bare.slice(0, bare.length - ext.length);
  return stem.slice(0, 180) + ext;
}

/**
 * Two photographs in one gallery may carry the same exported name -- two cards
 * in one camera bag, both starting at DSC_0001 -- and inside a ZIP that is a
 * client whose extraction silently keeps one of them. So the second one is
 * numbered, the way every file manager does it.
 *
 * Matched case-insensitively on purpose: the client extracting this is usually
 * on Windows, where `DSC_0001.JPG` and `dsc_0001.jpg` are the same file even
 * though they are two files on the host that built the archive.
 */
function disambiguate(name, taken) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);

  let candidate = name;
  let n = 1;
  while (taken.has(candidate.toLowerCase())) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Puts one original into the staging directory under the name the client
 * should see.
 *
 * A hard link, so a 12 GB wedding is staged for free and instantly -- the
 * alternative is copying every original next to itself, which is exactly the
 * doubling the disk budget exists to prevent. The fallbacks are there because
 * a link can be refused (a filesystem without them); `zip` follows a symlink
 * and stores what it points at, and a copy is the last resort.
 */
async function stageEntry(source, destination) {
  try {
    await link(source, destination);
    return;
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
  }
  try {
    await symlink(source, destination);
  } catch {
    await copyFile(source, destination);
  }
}

/**
 * `-0` stores without compressing. JPEGs are already compressed, so deflate
 * spends minutes of CPU to save a percent or two — and CPU here competes with
 * the web server for a 40-process account.
 *
 * **On Polish filenames.** An earlier version passed `-UN=UTF8` believing it
 * flagged entry names as UTF-8. It does not: `-UN=` accepts only
 * Quit|Warn|Ignore|No|Escape, so that value was silently meaningless. Measured
 * with Info-ZIP 3.0: entry names are stored as raw UTF-8 bytes but bit 11 of
 * the general-purpose flag stays clear and no Unicode Path extra field is
 * written — under any locale, including C.UTF-8. Windows Explorer then decodes
 * those bytes with the OEM codepage and shows mojibake.
 *
 * Left as-is rather than worked around, for now, because the exposure is small:
 * Lightroom exports are named like DSC_1234.jpg, and the archive's *own*
 * filename is ASCII-folded where Content-Disposition is set. `verifyArchive`
 * reports any entry that would be affected, so this becomes visible rather than
 * silent. Whether FreeBSD's zip behaves the same is a question for the host.
 *
 * `-r` from inside the staging directory, so entries are bare filenames rather
 * than a chain of parent directories the client has to click through.
 *
 * **The staging directory is why this takes entries rather than a directory.**
 * Originals are stored under their photo's id, not under the name she exported
 * -- two photos in one gallery are allowed to share that name, so it cannot be
 * a filename (see server/photos.js). `zip` has no way to rename an entry, so
 * the archive is built from a directory of hard links that carry the right
 * names and cost nothing.
 *
 * @param entries [{ path, name }] -- the file, and what the client should see
 */
export async function buildArchive(entries, destination) {
  // Resolved before `cwd` moves underneath it: `zip` runs from inside the
  // staging directory, so a relative destination would land there (or fail)
  // rather than where the caller meant.
  const target = path.resolve(destination);
  const staging = `${target}.entries`;

  // `zip` *updates* an archive that already exists, which would carry entries
  // from the last build -- including photos since deleted -- into this one.
  await rm(target, { force: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  try {
    const taken = new Set();
    for (const entry of entries) {
      const name = entryName(entry.name) ?? path.basename(entry.path);
      await stageEntry(entry.path, path.join(staging, disambiguate(name, taken)));
    }

    await run('zip', ['-0', '-r', '-q', target, '.'], {
      cwd: staging,
      // A wedding is thousands of files; store-mode is I/O-bound, not CPU-bound,
      // but this is still generous rather than optimistic.
      timeout: 30 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LANG: process.env.LANG || 'pl_PL.UTF-8' },
    });

    return { path: target, bytes: (await stat(target)).size };
  } finally {
    // Links only, so this frees no photograph -- but a directory of thousands
    // of them left behind would confuse the nightly `du` reconciliation.
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Confirms the archive is readable, and reports entries whose names will not
 * survive the trip to a Windows machine.
 *
 * Reading the central directory directly rather than shelling out to `unzip`:
 * the flag bit is the thing being checked, and `unzip -l` does not show it.
 */
export async function verifyArchive(destination) {
  const handle = await open(destination, 'r');
  try {
    const { size } = await handle.stat();

    // The end-of-central-directory record is at the end, after a comment of
    // unknown length; scanning the last 64 KB finds it in every archive this
    // application produces.
    const tailSize = Math.min(size, 65_536 + 22);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);

    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd === -1) throw new Error('Not a ZIP archive (no end-of-central-directory)');

    const entries = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);

    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);

    // Walk the central directory headers, collecting names stored as non-ASCII
    // bytes without the UTF-8 flag (bit 11) set.
    const unflagged = [];
    let offset = 0;
    while (offset + 46 <= directory.length) {
      if (directory.readUInt32LE(offset) !== 0x02014b50) break;

      const flags = directory.readUInt16LE(offset + 8);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const nameBytes = directory.subarray(offset + 46, offset + 46 + nameLength);

      if (!(flags & 0x800) && nameBytes.some((byte) => byte > 0x7f)) {
        unflagged.push(nameBytes.toString('utf8'));
      }

      offset += 46 + nameLength + extraLength + commentLength;
    }

    return { entries, unflagged };
  } finally {
    await handle.close();
  }
}

export const archiveName = (dir) => path.join(dir, 'archive.zip');
