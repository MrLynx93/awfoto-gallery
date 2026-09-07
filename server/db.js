/**
 * The MySQL pool, and the migrations that shape it.
 *
 * mysql2 because it is pure JavaScript. On this FreeBSD host a native module is
 * the difference between a deploy that works and one that throws at import —
 * the same argument that keeps `sharp` out of the dependencies.
 *
 * Migrations run at startup rather than from a separate deploy step: the deploy
 * is an rsync and a restart, so there is no natural place to hang a migrate
 * command, and a schema that lags the code it is deployed with is a worse
 * problem than a slightly slower boot.
 */
import mysql from 'mysql2/promise';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dbConfig } from './config.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

let pool;

export function db() {
  if (!pool) {
    pool = mysql.createPool({
      ...dbConfig(),
      waitForConnections: true,
      // Small on purpose. The account allows 40 processes and Passenger may run
      // several app workers, each with its own pool — a generous per-pool limit
      // multiplies into far more MySQL connections than this workload needs.
      connectionLimit: 4,
      charset: 'utf8mb4_unicode_ci',
      // DATETIME columns come back as strings rather than Date objects built in
      // the server's local zone. Expiry comparisons are done in SQL, and a
      // silent timezone conversion at the driver boundary is a good way to
      // delete a gallery a day early.
      dateStrings: true,
      namedPlaceholders: true,
    });
  }
  return pool;
}

export async function close() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Applies any migration file not yet recorded, in filename order, each in its
 * own transaction. MySQL commits DDL implicitly, so a half-applied file cannot
 * be rolled back — hence one statement's worth of intent per file, and a record
 * written only after the file completes.
 */
export async function migrate({ log = console.log } = {}) {
  const connection = await db().getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [rows] = await connection.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.filename));

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    let count = 0;
    for (const filename of files) {
      if (applied.has(filename)) continue;

      const sql = await readFile(path.join(migrationsDir, filename), 'utf8');

      // Split on `;` at end of line -- enough for schema files, and it keeps
      // migrations readable as plain SQL instead of JS string arrays. Comment
      // lines are stripped from each statement rather than used to discard it:
      // a chunk that *starts* with a comment still ends in real DDL, and
      // dropping it silently applied nothing while recording success.
      const statements = sql
        .split(/;\s*$/m)
        .map((chunk) =>
          chunk
            .split('\n')
            .filter((line) => !/^\s*--/.test(line))
            .join('\n')
            .trim(),
        )
        .filter(Boolean);

      // A migration file that parses to nothing is a bug in the file or in the
      // splitting above, and recording it as applied would hide that until the
      // first query against the table it was supposed to create.
      if (statements.length === 0) {
        throw new Error(`Migration ${filename} contains no statements`);
      }

      for (const statement of statements) {
        await connection.query(statement);
      }

      await connection.query('INSERT INTO schema_migrations (filename) VALUES (?)', [filename]);
      log(`[migrate] applied ${filename}`);
      count += 1;
    }

    if (count === 0) log('[migrate] schema up to date');
    return count;
  } finally {
    connection.release();
  }
}
