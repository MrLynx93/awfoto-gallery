/**
 * Proves every SQL statement this app sends still binds its own parameters.
 *
 *   node scripts/check-queries.mjs
 *
 * This exists because of an outage. A comment was added inside a query —
 *
 *     SELECT ...
 *            -- read in the Node process's zone, e.g. 14:45:00
 *       FROM galleries
 *      WHERE slug = :slug
 *
 * — and every gallery page started answering 500. `named-placeholders`, the
 * package mysql2 uses to turn `:slug` into a `?`, **does not understand SQL
 * comments**: it scans the whole string for quotes and colons. The apostrophe
 * in "process's" opened a string literal that swallowed the rest of the
 * statement, so `:slug` was never seen and nothing was bound; the `14:45:00`
 * added two placeholders named `45` and `00` for good measure. MySQL is never
 * even reached, and nothing about the failure points at the comment.
 *
 * So the rule is: **no comments inside query text.** The explanation goes in a
 * JSDoc above the function, where it is more readable anyway and where the
 * driver will never read it. This checks both halves — the rule, and the
 * invariant the rule protects.
 *
 * It parses the source rather than calling the functions, because binding
 * happens before any connection does: a broken query fails identically with or
 * without a database, and this needs no database at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import namedPlaceholders from 'named-placeholders';

const compile = namedPlaceholders();
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.join(repo, 'server');

/** Every `.query(`...`)` template literal under server/, with where it lives. */
function queries() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.js')) {
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(/query\(\s*`([\s\S]*?)`/g)) {
          const line = source.slice(0, match.index).split('\n').length;
          found.push({ where: `${path.relative(repo, file)}:${line}`, sql: match[1] });
        }
      }
    }
  };
  walk(serverDir);
  return found;
}

const problems = [];
const statements = queries();

for (const { where, sql } of statements) {
  if (/--|\/\*/.test(sql)) {
    problems.push(`${where}: a comment inside the query text — move it above the function`);
    continue;
  }

  // What the statement asks to have bound, in the order it asks.
  const names = [...sql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]);
  const values = Object.fromEntries(names.map((name) => [name, `<${name}>`]));

  let bound;
  try {
    [, bound] = compile(sql, values);
  } catch (error) {
    problems.push(`${where}: the driver refused it — ${error.message}`);
    continue;
  }

  if (bound.length !== names.length) {
    problems.push(
      `${where}: names ${names.length} parameter(s) but the driver binds ${bound.length}` +
        ` — ${JSON.stringify(bound)}`,
    );
    continue;
  }
  const stray = bound.findIndex((value, index) => value !== `<${names[index]}>`);
  if (stray !== -1) {
    problems.push(`${where}: parameter ${stray + 1} binds ${JSON.stringify(bound[stray])}`);
  }
}

if (statements.length === 0) {
  console.error('[check] found no queries at all — has server/ moved?');
  process.exit(1);
}

for (const problem of problems) console.error(`[check] FAILED — ${problem}`);

if (problems.length > 0) {
  console.error(`\n[check] ${problems.length} quer${problems.length === 1 ? 'y' : 'ies'} would fail at runtime.`);
  process.exit(1);
}
console.log(`[check] all ${statements.length} queries bind exactly what they name.`);
