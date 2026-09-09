/**
 * Fails the build if app.js cannot be loaded the way Passenger loads it.
 *
 * mydevil's Passenger uses `require()` on app.js, and Node refuses to
 * `require()` an ESM graph containing top-level await. This is invisible in
 * development: `node app.js` loads the same file as an ESM entry point, where
 * top-level await is perfectly legal. So the app runs locally, passes every
 * test, deploys — and then never starts, with ERR_REQUIRE_ASYNC_MODULE buried
 * in a Passenger log.
 *
 * That happened once. This makes it impossible to happen quietly again.
 *
 * Run in a child process because a successful require() starts the server.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const appPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app.js');

const probe = `
  process.env.PORT = '0';           // any free port; we exit immediately
  process.env.SKIP_MIGRATIONS = '1';
  try {
    require(${JSON.stringify(appPath)});
    console.log('PASSENGER_REQUIRE_OK');
  } catch (error) {
    console.error('PASSENGER_REQUIRE_FAILED:' + (error.code || error.message));
  }
  setTimeout(() => process.exit(0), 500);
`;

let stdout = '';
let stderr = '';
try {
  ({ stdout, stderr } = await run(process.execPath, ['--input-type=commonjs', '-e', probe], {
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  }));
} catch (error) {
  stdout = error.stdout ?? '';
  stderr = error.stderr ?? '';
}

if (stdout.includes('PASSENGER_REQUIRE_OK')) {
  console.log('[check] app.js loads under require() — Passenger can start it.');
  process.exit(0);
}

const detail = (stderr + stdout).split('\n').find((line) => line.includes('PASSENGER_REQUIRE_FAILED'));

console.error('\n[check] app.js CANNOT be loaded the way Passenger loads it.\n');
if (detail?.includes('ERR_REQUIRE_ASYNC_MODULE')) {
  console.error('[check] Cause: top-level await somewhere in the module graph.');
  console.error('[check] Note that `await` inside a top-level try/catch still counts.');
  console.error('[check] Start the work in a promise and await it inside a handler instead.');
  console.error('[check] To find it: node --experimental-print-required-tla ...\n');
} else {
  console.error(`[check] ${detail ?? stderr.split('\n').slice(0, 5).join('\n')}\n`);
}
process.exit(1);
