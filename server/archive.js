/**
 * Builds the one ZIP a client downloads.
 *
 * The `zip` CLI rather than a native npm module, for the same reason as the
 * image work: no native dependency survives contact with this FreeBSD host.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, open } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);

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
 * `-r` from inside the originals directory, so entries are bare filenames
 * rather than a chain of parent directories the client has to click through.
 */
export async function buildArchive(originalsDir, destination) {
  // Resolved before `cwd` moves underneath it: `zip` runs from inside the
  // originals directory, so a relative destination would land there (or fail)
  // rather than where the caller meant.
  const target = path.resolve(destination);

  await run(
    'zip',
    ['-0', '-r', '-q', target, '.'],
    {
      cwd: originalsDir,
      // A wedding is thousands of files; store-mode is I/O-bound, not CPU-bound,
      // but this is still generous rather than optimistic.
      timeout: 30 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LANG: process.env.LANG || 'pl_PL.UTF-8' },
    },
  );

  return { path: target, bytes: (await stat(target)).size };
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
