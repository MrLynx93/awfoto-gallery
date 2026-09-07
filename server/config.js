/**
 * Every environment value the app reads, in one place, validated at boot.
 *
 * The point is failing loudly at startup rather than at 2am when the worker
 * finally reaches a code path that needed DB_PASSWORD. Passenger surfaces a
 * startup crash clearly; a runtime one just looks like a broken page.
 */
import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Brak zmiennej ${name} w .env — skopiuj .env.example i uzupełnij. ` +
        `(missing required environment variable ${name})`,
    );
  }
  return value;
}

function optional(name, fallback) {
  return process.env[name] || fallback;
}

export const isProduction = process.env.NODE_ENV === 'production';

/**
 * Where every byte lives. This must NOT be under ~/domains/ — nothing here is
 * web-served, and a path inside a vhost's docroot would silently undo that.
 * The check is cheap and the mistake is invisible until someone finds a photo
 * by guessing a URL.
 */
export const STORAGE_ROOT = path.resolve(
  optional('STORAGE_ROOT', path.join(process.cwd(), 'storage')),
);

if (/\/domains\/[^/]+\/(public_html|public_nodejs)/.test(STORAGE_ROOT)) {
  throw new Error(
    `STORAGE_ROOT (${STORAGE_ROOT}) is inside a web-served directory. ` +
      'Move it outside ~/domains/ — these files must not be reachable by URL.',
  );
}

/*
 * Secrets are read through functions, not constants, so that importing this
 * module never throws. The skeleton deploys and serves a page before a database
 * exists; only the code that actually needs a credential should fail without
 * one, and it should fail naming the variable it wanted.
 */
export function dbConfig() {
  return {
    host: optional('DB_HOST', 'localhost'),
    port: Number(optional('DB_PORT', '3306')),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
  };
}

export function sessionSecret() {
  return required('SESSION_SECRET');
}

export function adminPasswordHash() {
  return required('ADMIN_PASSWORD_HASH');
}

/** See CLAUDE.md, "Storage and the disk budget": df cannot see the quota. */
export const diskBudgetBytes =
  Number(optional('DISK_BUDGET_GB', '12')) * 1024 * 1024 * 1024;

export const baseUrl = optional('PUBLIC_BASE_URL', 'https://galeria.aw-foto.pl');
