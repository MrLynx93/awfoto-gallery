/**
 * Password hashing on `node:crypto`'s scrypt.
 *
 * scrypt because it is a real memory-hard KDF and it is *built in*: bcrypt and
 * argon2 are both native modules, and on this FreeBSD host a native module is
 * the difference between a deploy that works and one that throws at import.
 * See CLAUDE.md, "Image resizing", for the same argument in another costume.
 *
 * One helper serves both the admin password and each gallery's password.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { sessionSecret } from './config.js';

const scrypt = promisify(scryptCb);

// N=16384 is the classic interactive-login setting: ~16 MB and a few tens of
// milliseconds per attempt. Deliberately modest — the memory cost is paid on a
// host with a 3 GB account-wide cap, and the gallery gate is rate-limited in
// the database rather than relying on the KDF alone to make guessing slow.
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** `scrypt$N$r$p$salt$hash`, all base64url — one self-describing string. */
export async function hash(plain) {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(plain.normalize('NFKC'), salt, KEY_LENGTH, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Never throws on a malformed stored value — a corrupt row should read as "wrong
 * password", not as a 500 that tells an attacker the record exists.
 */
export async function verify(plain, stored) {
  try {
    const [scheme, N, r, p, salt, expected] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;

    const expectedKey = Buffer.from(expected, 'base64url');
    // The parameters come from the stored string, so hashes written under
    // older settings keep verifying after these constants change.
    const actual = await scrypt(plain.normalize('NFKC'), Buffer.from(salt, 'base64url'), expectedKey.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return timingSafeEqual(actual, expectedKey);
  } catch {
    return false;
  }
}

/**
 * The password a client is given. Unambiguous by construction: no O/0, no I/l/1.
 * She reads these over the phone and types them on a laptop; a password that is
 * secure but gets mistyped twice is a support call, and this is the same
 * trade-off the upload screen's "big obvious finish line" is making.
 *
 * 8 characters from a 31-symbol alphabet is ~40 bits, which is far past what
 * the DB-backed attempt limiter allows anyone to explore.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generatePassword(length = 8) {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length; i++) {
    // Reject above the largest whole multiple, so no character is likelier
    // than another. With 31 symbols an unbiased byte is easy to come by.
    const b = bytes[i % bytes.length];
    if (b < 248) out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

/**
 * A gallery's password, kept so the panel can show it again.
 *
 * This is the one place the project stores something it can read back, and it
 * is a deliberate exception rather than a lapse. A gallery password is not an
 * account credential: it is a short code she reads out over the phone and
 * pastes into a message, alongside a link that is itself most of the secret.
 * The alternative -- what this replaced -- was that the password existed for
 * one screen and then only a new one could be issued, which means telling a
 * client "the code I sent you last week is dead now" because she reopened the
 * panel. That is a worse outcome than the risk below.
 *
 * **The admin password is not stored this way and must never be.** It stays
 * scrypt-only, one-way, in .env. Only per-gallery codes are sealed here.
 *
 * Sealed rather than plain, so a database dump on its own reveals nothing: the
 * key is derived from SESSION_SECRET, which lives in .env and never in MySQL.
 * An attacker needs both. `password_hash` stays the authority for verifying a
 * client's attempt, so losing or rotating the secret costs the *display* of old
 * passwords and nothing else -- galleries keep opening, and unseal() answers
 * null so the screen offers a new password exactly as it did before.
 */
const SEAL_VERSION = 'v1';
const IV_LENGTH = 12;

/**
 * HKDF, so the encryption key is a distinct value from the one signing cookies
 * even though both descend from SESSION_SECRET. Derived per call: the secret is
 * read through a function that throws when it is missing, and this module is
 * imported by code paths that must not fail merely for existing.
 */
function sealKey() {
  return Buffer.from(
    hkdfSync('sha256', sessionSecret(), Buffer.from('awfoto-gallery-password'), Buffer.from(SEAL_VERSION), 32),
  );
}

/** `v1$iv$tag$ciphertext`, base64url, in one VARCHAR column. */
export function seal(plain) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', sealKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [
    SEAL_VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('$');
}

/**
 * Returns null for anything it cannot open: a gallery from before this column
 * existed, a row written under a different SESSION_SECRET, a tampered value.
 * Every caller treats null as "no password to show", which is a state the panel
 * already had to handle.
 */
export function unseal(sealed) {
  try {
    const [version, iv, tag, ciphertext] = String(sealed).split('$');
    if (version !== SEAL_VERSION) return null;

    const decipher = createDecipheriv('aes-256-gcm', sealKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
