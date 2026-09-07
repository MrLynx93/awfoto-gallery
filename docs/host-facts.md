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
   static`. This drove a files-vhost design that has since been dropped in
   favour of serving every byte through Node — see "Web-serving findings" below
   for what that vhost turned out to be like. It still matters for the app
   vhost, and for knowing that awfoto-site's README is wrong about itself.

3. **`df` cannot see the account quota.** It reports the shared ZFS pool
   (`zroot/root/usr/home`, 1.7 TB, 1.1 TB available). A free-space guard built
   on it would never fire. Replaced with `DISK_BUDGET_GB` plus the DB tally.

4. **The locale is `C`.** UTF-8 filenames round-trip at the byte level, but
   `zip` needs `-UN=UTF8` and the app needs `LANG=pl_PL.UTF-8`, or Polish
   filenames in an archive open as mojibake on Windows.

## Still outstanding

Milestone 1 tasks. The probe skips them because they create state on the host.

- **Colour.** Resize a real Adobe RGB Lightroom export with the exact `magick`
  command `images.js` will use and compare side by side. `lcms` being present
  proves it *can* be done right, not that it *is*. `scripts/colour-check.sh`
  does the mechanical part.
- **Streaming through Passenger.** Put a ~5 GB file under `STORAGE_ROOT`, serve
  it from a throwaway route with `res.sendFile()`, and confirm it completes,
  memory stays flat, and `curl -r 0-100` returns `206`. If Passenger buffers
  responses or imposes a request timeout, the download design needs rethinking —
  and it is much cheaper to learn that here than after the client gallery is
  built on it.

## Web-serving findings — recorded, no longer live

These were all measured on an experimental `pliki.aw-foto.pl` php vhost, back
when previews and archives were going to be served by nginx from a docroot. That
design was dropped: **no file is web-served at all now**, so none of this is a
live concern. It is kept because it is true of the host, and because anyone
proposing a docroot again should read it first.

- **Autoindex is on, and cannot be turned off.** A token directory listed its
  contents, and so did `/f/` — the serious case, since it would have made every
  gallery enumerable without knowing any token. `.htaccess` is no remedy:
  mydevil's php sites are nginx, which ignores it, and `devil www options` has no
  autoindex switch. The fix would have been `index.html` files written by the
  worker into every directory.
- **PHP executes there.** `<?php echo 42;` returned `42`. Path-info is enabled
  too, so `x.php/foo.jpg` runs `x.php` — ordinary nginx
  `fastcgi_split_path_info` behaviour, and it still needs a real `.php` file on
  disk to target.
- **The `.php` match is anchored.** `y.php.zip` returned its own source rather
  than executing, so a file named with an extension chosen by the application
  could not be routed to PHP whatever preceded it. The docroot design was
  therefore salvageable — it was rejected on product grounds, not because it was
  unsafe.

## `devil www options` — no autoindex switch, but five settings that matter

The full usage (the Milestone 0 probe truncated it) offers: `gzip`, `sslonly`,
`plnet`, `php_eval`, `php_exec`, `php_openbasedir`, `cache`, `cache_cookie`,
`cache_debug`, `waf`, `blacklist`, `stats_anonymize`, `stats_exclude`,
`processes`, `tls_min`.

**There is no autoindex option.** That was decisive while a files vhost was on
the table; it is now just a recorded fact, since nothing is web-served.

Five worth setting deliberately:

| Option | Why |
|---|---|
| `processes 1+` | Caps Passenger workers on the app vhost. Directly relevant — the account allows only 40 processes total and the worker plus its `magick`/`zip` children compete for them. |
| `cache` | Leave **off**. Responses are per-session and authorised; a cached archive outliving its deletion would quietly break the expiry promise, which is a day-one feature. |
| `sslonly on` | Both vhosts. Gallery links go out by message and get clicked on phones. |
| `php_openbasedir` | Only relevant if a php vhost ever returns. Not used by the current design. |
| `waf 0-5` | **Suspect this first if tus uploads misbehave**, and second if large downloads do. A WAF inspecting big `PATCH` bodies or buffering big responses breaks both in confusing ways. |

`php_eval` / `php_exec` most likely disable PHP's `eval()` and `exec()` families
rather than PHP itself — worth one test, because if `php_exec off` turns PHP off
wholesale, the files vhost becomes effectively static and the whole class of
problem disappears.
