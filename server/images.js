/**
 * The one place an image is resized. Everything else calls makeDerivatives().
 *
 * A CLI rather than a library, and the reason is memory isolation, not
 * capability: the peak allocation lives and dies in a subprocess outside the
 * Node heap and can be capped with `-limit`. Inside a 3 GB account-wide cap
 * shared with Passenger, the worker and cron, that is the whole argument. See
 * CLAUDE.md, "Image resizing", for why every JavaScript option loses.
 *
 * Two derivatives per photo:
 *   thumb  500 px long edge, q78 — the grid
 *   large 2048 px long edge, q82 — the lightbox
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, access } from 'node:fs/promises';

const run = promisify(execFile);

export const SIZES = {
  thumb: { edge: 500, quality: 78 },
  large: { edge: 2048, quality: 82 },
};

/**
 * Sized from the measured 438 MB peak for a 24 MP resize on the host's
 * Q16-HDRI build. A 45 MP file extrapolates to ~800 MB, so this caps a runaway
 * file rather than letting one image take the whole account down.
 */
const LIMITS = ['-limit', 'memory', '512MiB', '-limit', 'map', '1GiB'];

let cached;

/**
 * ImageMagick 7 renamed `convert` to `magick`, and keeps a `convert` shim — so
 * probing for `convert` first would silently use IM6 syntax on an IM7 host.
 * `magick` is checked first for that reason. vipsthumbnail is recorded when
 * present but not preferred: switching to it is a deliberate change, not
 * something that should vary with whatever a host happens to have installed.
 */
export async function detectTool() {
  if (cached) return cached;

  for (const [bin, args] of [
    ['magick', ['-version']],
    ['convert', ['-version']],
  ]) {
    try {
      const { stdout } = await run(bin, args);
      const version = stdout.split('\n')[0];
      cached = { bin, kind: 'imagemagick', version };
      return cached;
    } catch {
      // Not on this machine.
    }
  }

  throw new Error(
    'No ImageMagick found (looked for `magick`, then `convert`). ' +
      'Install it, or switch server/images.js to the vipsthumbnail implementation.',
  );
}

/**
 * Where an sRGB profile might live. Overridable, because this is the one input
 * that decides whether colour conversion actually happens.
 */
const SRGB_CANDIDATES = [
  process.env.SRGB_PROFILE,
  '/usr/local/share/ImageMagick-7/sRGB.icc',
  '/usr/local/share/color/icc/sRGB.icc',
  '/usr/share/color/icc/sRGB.icc',
  '/usr/share/color/icc/colord/sRGB.icc',
  '/usr/share/color/icc/ghostscript/srgb.icc',
].filter(Boolean);

let srgbProfile;

/**
 * **`-colorspace sRGB` does not convert an ICC-tagged image.** Measured: a
 * wide-gamut source came out of `-colorspace sRGB` with pixel values identical
 * to `-strip` (mean RGB 127.6/119.1/34.0 either way), while `-profile
 * srgb.icc` actually remapped them (95.9/69.5/0.5). Only `-profile` runs the
 * transform through lcms.
 *
 * So: convert with `-profile` when a target profile exists on the host. When
 * none does, deliberately do nothing rather than reach for `-colorspace` —
 * leaving the source profile embedded is correct in every colour-managed
 * browser, whereas `-strip` would leave wide-gamut pixels labelled as sRGB,
 * which is the flat, desaturated failure this whole section exists to avoid.
 */
async function findSrgbProfile() {
  if (srgbProfile !== undefined) return srgbProfile;

  for (const candidate of SRGB_CANDIDATES) {
    try {
      await access(candidate);
      srgbProfile = candidate;
      return srgbProfile;
    } catch {
      // Not on this host.
    }
  }

  srgbProfile = null;
  console.warn(
    '[images] No sRGB ICC profile found — previews will keep the source ' +
      'profile instead of being converted. Set SRGB_PROFILE to a .icc path ' +
      'to enable conversion. (Never fixed by -strip: that is the flat-colour bug.)',
  );
  return srgbProfile;
}

/**
 * `-auto-orient` first, so a portrait frame is not resized as a landscape one.
 * `>` on the geometry means never enlarge — a photo already smaller than the
 * target is left alone rather than upscaled into softness.
 */
function resizeArgs(src, dest, { edge, quality }, profile) {
  return [
    ...LIMITS,
    src,
    '-auto-orient',
    ...(profile ? ['-profile', profile] : []),
    '-resize', `${edge}x${edge}>`,
    '-quality', String(quality),
    dest,
  ];
}

export async function makeDerivative(src, dest, size) {
  const spec = SIZES[size];
  if (!spec) throw new Error(`Unknown size: ${size}`);

  const tool = await detectTool();
  const profile = await findSrgbProfile();
  await run(tool.bin, resizeArgs(src, dest, spec, profile), {
    // A single image should never take this long. If one does, it is pathological
    // input and the worker should move on rather than stall the whole queue.
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });

  return { size, path: dest, bytes: (await stat(dest)).size };
}

/** Width and height of the source, for the grid's aspect ratios. */
export async function dimensions(src) {
  const tool = await detectTool();
  const args = tool.bin === 'magick'
    ? ['identify', '-format', '%w %h', src]
    : ['-format', '%w %h', src];
  const bin = tool.bin === 'magick' ? 'magick' : 'identify';

  const { stdout } = await run(bin, args, { timeout: 30_000 });
  const [width, height] = stdout.trim().split(/\s+/).map(Number);
  return { width, height };
}

/**
 * Both derivatives for one photo, strictly in sequence.
 *
 * Never parallelised, and not only for memory: the account allows 40 processes
 * in total, shared with Passenger and cron, so a worker that fanned out would
 * be competing with the web server that has to keep answering.
 */
export async function makeDerivatives(src, destFor) {
  const thumb = await makeDerivative(src, destFor('thumb'), 'thumb');
  const large = await makeDerivative(src, destFor('large'), 'large');

  /**
   * Measured on the thumbnail rather than on the original, and deliberately:
   * the resize has already applied `-auto-orient`, so a portrait frame stored
   * landscape with an EXIF rotation reports the shape the grid will actually
   * draw -- which `identify` on the original would get backwards, tilting every
   * such photo in a justified row. It is also far cheaper than reading a 45 MP
   * file a second time, and 500 px is ample precision for a ratio.
   */
  const { width, height } = await dimensions(thumb.path);

  return { width, height, bytes: thumb.bytes + large.bytes };
}
