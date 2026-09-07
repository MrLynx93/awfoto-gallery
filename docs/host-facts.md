# Host facts

Measured on **s88.mydevil.net**, **2026-09-07**, by `scripts/probe-host.sh`.

Re-run the probe if anything here looks stale — mydevil upgrades packages, and
the numbers below are the ones the architecture is sized against.

## Summary

| | Value |
|---|---|
| OS | FreeBSD 14.3-RELEASE-p18, amd64 |
| Node | v22.22.2 at `/usr/local/bin/node22` (also 16/18/20/23/24), npm 11.14.1 |
| **Max user processes** | **40** |
| **Max memory size** | **3 GB** (`ulimit -m` 3072000 KB) |
| Open files | 2000 |
| ImageMagick | 7.1.1-45 Q16-HDRI, delegates include `lcms`, `raw`, `heic`, `jxl` |
| libvips | `vipsthumbnail` 8.17.1 |
| Resize cost | **438 MB peak RSS, 0.94 s** for 24 MP (synthetic 6000×4000) |
| Archiving | `zip` 3.0 with ZIP64, `unzip`, `tar` |
| Lock primitive | `lockf` (base) and `flock` (port) both present |
| Locale | **`C`** — `LANG` unset, `LC_CTYPE="C"` |
| Site types | php, python, ruby, nodejs, proxy, pointer — **no `static`** |
| Existing sites | aw-foto.pl (php), panel.aw-foto.pl (nodejs), mrlynx93.usermd.net (php) |
| Databases | none yet |
| Cron jobs | none yet |
| Disk in use | 278 MB total (aw-foto.pl 6 MB, panel 199 MB) |

## The four findings that changed the design

1. **40 processes, not 70; 3 GB, not 2 GB.** Both numbers in the original
   CLAUDE.md were wrong. The process cap is the binding one: Passenger workers,
   the background worker, cron and every `magick`/`zip` subprocess share it.
   `hw.physmem` (128 GB) and `hw.ncpu` (16) describe the shared machine and are
   irrelevant to sizing.

2. **There is no `static` site type.** `devil www list` shows `aw-foto.pl` as
   **php**, despite awfoto-site's README documenting `devil www add aw-foto.pl
   static`. The files vhost is therefore a php site — which serves existing
   files straight from nginx, but *does* execute `.php`. Hence: originals live
   outside the docroot, and ZIP names are sanitised with `.zip` forced.

3. **`df` cannot see the account quota.** It reports the shared ZFS pool
   (`zroot/root/usr/home`, 1.7 TB, 1.1 TB available). A free-space guard built
   on it would never fire. Replaced with `DISK_BUDGET_GB` plus the DB tally.

4. **The locale is `C`.** UTF-8 filenames round-trip at the byte level, but
   `zip` needs `-UN=UTF8` and the app needs `LANG=pl_PL.UTF-8`, or Polish
   filenames in an archive open as mojibake on Windows.

## Still outstanding

Both create state on the host, so the probe skips them. They are Milestone 1
tasks:

- **Colour.** Resize a real Adobe RGB Lightroom export with the exact `magick`
  command `images.js` will use and compare side by side. `lcms` being present
  proves it *can* be done right, not that it *is*.
- ~~**Autoindex**~~ — **CONFIRMED ON.** `curl https://pliki.aw-foto.pl/f/<token>/`
  lists the directory contents. `.htaccess` is not a remedy: mydevil's php sites
  are nginx, which ignores it. Still to determine: whether `/` and `/f/` also
  list (that is the serious case — it would make every gallery enumerable
  without a token), and whether `devil www` exposes an autoindex toggle.

  **Severity note.** A listing at `/f/<token>/` is close to harmless: reaching it
  requires the 32-character token, and whoever holds that is the client, who is
  entitled to every file in the directory anyway. It leaks original filenames,
  which the ZIP would reveal regardless. A listing at `/f/` or `/` is the real
  problem.

  **Mitigation:** the worker writes an empty `index.html` into the docroot, into
  `f/`, and into every token directory it creates.

- **PHP executes in that docroot — CONFIRMED.** `<?php echo 42;` served from a
  token directory returns `42`. So any attacker-controlled bytes landing there
  under a `.php` name would be remote code execution on the account.

  **The rule this forces:** every file the worker writes into the files docroot
  gets an extension *we* append from a fixed allowlist — `.jpg`, `.zip`,
  `.html` — never one taken from user input. nginx routes to PHP on
  `location ~ \.php$`, anchored at the end, so a name ending in `.zip` cannot
  execute regardless of what precedes it, and `evil.php.zip` is inert. That
  closes the hole structurally instead of relying on a sanitiser being correct.

  **The anchor is confirmed present.** `y.php.zip` returns its own source text
  rather than executing, so a name ending in an extension we chose cannot run,
  whatever precedes it. The construction rule above therefore holds and the
  sanitiser is belt-and-braces rather than the only line of defence.

  **Path-info is enabled**: `x.php/foo.jpg` executes `x.php`. Standard nginx
  `fastcgi_split_path_info` behaviour, and harmless here — it still requires a
  real `.php` file on disk, and we never write one. It does not give `.zip` or
  `.jpg` files a route to execution.

  Net: **the files docroot is safe as long as no `.php` file ever exists in it**,
  which the design guarantees by never writing a caller-supplied extension.

## `devil www options` — no autoindex switch, but five settings that matter

The full usage (the Milestone 0 probe truncated it) offers: `gzip`, `sslonly`,
`plnet`, `php_eval`, `php_exec`, `php_openbasedir`, `cache`, `cache_cookie`,
`cache_debug`, `waf`, `blacklist`, `stats_anonymize`, `stats_exclude`,
`processes`, `tls_min`.

**There is no autoindex option**, which settles it: directory listings are
suppressed with `index.html` files written by the worker, at the docroot, at
`f/`, and in every token directory.

Five worth setting deliberately:

| Option | Why |
|---|---|
| `processes 1+` | Caps Passenger workers on the app vhost. Directly relevant — the account allows only 40 processes total and the worker plus its `magick`/`zip` children compete for them. |
| `cache` | Leave **off** on the files vhost. Token-addressed files are immutable, so caching looks attractive, but a cached ZIP outliving its deletion would quietly break the expiry promise, which is a day-one feature. |
| `sslonly on` | Both vhosts. Gallery links go out by message and get clicked on phones. |
| `php_openbasedir` | Defence in depth on the files vhost: confine PHP to that docroot, so even an unforeseen `.php` there cannot read the rest of the account. |
| `waf 0-5` | **Suspect this first if tus uploads misbehave in M4.** A WAF inspecting large `PATCH` bodies is exactly the kind of thing that breaks resumable upload in a confusing way. |

`php_eval` / `php_exec` most likely disable PHP's `eval()` and `exec()` families
rather than PHP itself — worth one test, because if `php_exec off` turns PHP off
wholesale, the files vhost becomes effectively static and the whole class of
problem disappears.
