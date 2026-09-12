/**
 * Empties the application: every gallery row, and every byte under
 * STORAGE_ROOT.
 *
 *   node scripts/reset.mjs --yes
 *
 * This exists because the photo layout changed. Galleries created before it
 * kept their originals under the name she exported and their previews under a
 * photo's *position* (`4-thumb.jpg`); a photo is an id now, on disk and in
 * every URL, and nothing reads the old shape. There is no migration for it on
 * purpose — this is a delivery tool holding at most a few weeks of sessions,
 * and rewriting a live layout in place is a far worse risk than re-uploading
 * what is still current.
 *
 * **The originals go too, and they are the only copy the server has.** Anything
 * a client has not downloaded yet is gone. Check what is live first (`/admin`
 * lists it), tell whoever is still waiting, and re-upload afterwards.
 *
 * Tables are dropped rather than emptied, so the next boot runs every migration
 * from the top and the schema is exactly what server/migrations says it is.
 */
import { rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { db, close } from '../server/db.js';
import { STORAGE_ROOT } from '../server/config.js';

const confirmed = process.argv.includes('--yes');

const galleriesRoot = path.join(STORAGE_ROOT, 'galleries');
const incoming = path.join(STORAGE_ROOT, 'incoming');

const count = async (dir) => (await readdir(dir).catch(() => [])).length;

console.log('[reset] This will permanently delete:');
console.log(`[reset]   every table in the database (${process.env.DB_NAME ?? 'DB_NAME'})`);
console.log(`[reset]   ${await count(galleriesRoot)} gallery directory/ies under ${galleriesRoot}`);
console.log(`[reset]   every partial upload under ${incoming}`);
console.log('[reset] The originals are the only copy on this server. There is no undo.\n');

if (!confirmed) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('[reset] Type "usun wszystko" to continue: ');
  rl.close();
  if (answer.trim() !== 'usun wszystko') {
    console.log('[reset] Nothing was changed.');
    process.exit(1);
  }
}

try {
  const [tables] = await db().query(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
  );

  if (tables.length > 0) {
    // The foreign-key check is off for this, so the order the tables come back
    // in cannot matter.
    await db().query('SET FOREIGN_KEY_CHECKS = 0');
    for (const { name } of tables) {
      await db().query(`DROP TABLE IF EXISTS \`${String(name).replace(/`/g, '')}\``);
    }
    await db().query('SET FOREIGN_KEY_CHECKS = 1');
  }
  console.log(`[reset] dropped ${tables.length} table(s) — the next boot re-runs every migration`);
} finally {
  await close();
}

await rm(galleriesRoot, { recursive: true, force: true });
await rm(incoming, { recursive: true, force: true });
await rm(path.join(STORAGE_ROOT, 'worker.lock'), { force: true });
console.log(`[reset] removed every file under ${STORAGE_ROOT}`);
console.log('[reset] Done. Restart the app, then upload a gallery.');
