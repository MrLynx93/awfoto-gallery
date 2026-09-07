/**
 * Reads the server-side `.env` into process.env before anything else runs.
 *
 * Same approach as awfoto-site: Passenger does not read a .env file, and the
 * file must not be committed, so it is parsed here rather than baked into the
 * build. Values already present in the real environment win, which is what
 * makes `DB_PASSWORD=… npm run serve` work for a one-off local check.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');

let raw = '';
try {
  raw = readFileSync(envPath, 'utf8');
} catch {
  // No .env is normal in development and in CI. Missing *required* values are
  // reported by server/config.js, which can say which one and why.
}

for (const line of raw.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;

  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;

  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();

  // Quoted values keep any trailing whitespace or '#' that would otherwise be
  // stripped as a comment. A password is exactly the kind of value that has one.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  if (!(key in process.env)) process.env[key] = value;
}
