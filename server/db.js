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
import { createHash } from 'node:crypto';
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

const checksumOf = (sql) => createHash('sha256').update(sql).digest('hex');

/**
 * Applies any migration file not yet recorded, in filename order, each in its
 * own transaction. MySQL commits DDL implicitly, so a half-applied file cannot
 * be rolled back — hence one statement's worth of intent per file, and a record
 * written only after the file completes.
 *
 * Every applied file is also checksummed. `session_name` and `session_date`
 * both needed a guarded `ALTER` rather than a plain rename, because a database
 * that had already run 001 kept the column the old `001_initial.sql` created,
 * even after the file on disk was rewritten to say something else -- the file
 * changed under a migration that had already run. A checksum turns the next
 * such edit into a boot failure instead of a puzzle: the rule is to add a new
 * migration, never edit one that might already be applied, and this is what
 * enforces it rather than trusting everyone to remember it.
 */
export async function migrate({ log = console.log } = {}) {
  const connection = await db().getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) NOT NULL PRIMARY KEY,
        checksum VARCHAR(64) NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // A database that ran migrate() before this guard existed has the table
    // without this column. It is added here, imperatively, rather than as a
    // numbered file in migrations/ -- schema_migrations is this function's own
    // bookkeeping, not schema the numbered files should have to know about.
    const [[{ hasChecksum }]] = await connection.query(`
      SELECT COUNT(*) AS hasChecksum FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'
         AND COLUMN_NAME = 'checksum'
    `);
    if (!hasChecksum) {
      await connection.query(
        'ALTER TABLE schema_migrations ADD COLUMN checksum VARCHAR(64) NULL AFTER filename',
      );
    }

    const [rows] = await connection.query('SELECT filename, checksum FROM schema_migrations');
    const applied = new Map(rows.map((row) => [row.filename, row.checksum]));

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    let count = 0;
    for (const filename of files) {
      const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
      const checksum = checksumOf(sql);

      if (applied.has(filename)) {
        const recorded = applied.get(filename);

        // No checksum on record: this file was applied before the guard
        // existed. There is no historical checksum to compare against, so the
        // file as it stands now becomes the baseline -- it is the next edit
        // this is meant to catch, not the past one.
        if (recorded === null) {
          await connection.query('UPDATE schema_migrations SET checksum = ? WHERE filename = ?', [
            checksum,
            filename,
          ]);
        } else if (recorded !== checksum) {
          throw new Error(
            `Migration ${filename} has changed since it was applied ` +
              `(recorded ${recorded.slice(0, 12)}…, now ${checksum.slice(0, 12)}…). ` +
              'Add a new migration instead of editing one that may already be applied.',
          );
        }
        continue;
      }

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

      await connection.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)',
        [filename, checksum],
      );
      log(`[migrate] applied ${filename}`);
      count += 1;
    }

    if (count === 0) log('[migrate] schema up to date');
    return count;
  } finally {
    connection.release();
  }
}
