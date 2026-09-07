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
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

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
