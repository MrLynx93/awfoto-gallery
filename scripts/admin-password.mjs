/**
 * Prints the ADMIN_PASSWORD_HASH line for the server's .env.
 *
 *   node scripts/admin-password.mjs            # generates a strong password
 *   node scripts/admin-password.mjs 'my haslo' # hashes one you chose
 *
 * The hash is printed, never the plaintext-in-a-file: run this, copy the line
 * into .env, and keep the password itself in a password manager. Passing one as
 * an argument puts it in your shell history — fine for a throwaway dev value,
 * not for the real one.
 */
import { hash, generatePassword } from '../server/passwords.js';

const supplied = process.argv[2];
const password = supplied || generatePassword(14);

console.log('\nADMIN_PASSWORD_HASH=' + (await hash(password)));

if (!supplied) {
  console.log(`\nHasło (zapisz je teraz, nie da się go odtworzyć z hasha):\n\n    ${password}\n`);
}
