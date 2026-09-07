# CLAUDE.md

## What this is

A self-hosted client photo gallery for a photography business in Poland. Clients
receive a link, view their photos, and download the originals. Replaces WeTransfer.

Scope is deliberately small: one gallery, one password, view, download all, expire.
This is not a photo archive or a CMS. Resist feature creep — Piwigo and Nextcloud
were both evaluated and rejected because they solve the archive problem, not the
delivery problem.

## Users

Two, with very different skill levels:

- **Client** — receives a link. Sees a branded gallery, browses previews, downloads
  a ZIP of originals. Never logs in, never creates an account.
- **Photographer's partner** — uploads the photos. **Non-technical.** The upload UI
  must be usable by someone who does not know what a file path is. This constraint
  outranks elegance everywhere it applies. Interface copy in Polish.

## Hosting: mydevil.net

Everything runs here. Key facts that shape the architecture:

Measured on `s88.mydevil.net`, FreeBSD 14.3-RELEASE-p18, by
`scripts/probe-host.sh`. Re-run it if anything below looks stale.

- **FreeBSD**, not Linux. This is the single biggest source of gotchas.
- Servers in Poland (good for latency and GDPR).
- **Unlimited transfer** — no bandwidth concerns, which is why self-hosting won over
  Cloudflare R2.
- SSH access, cron, long-running processes allowed.
- nginx in front, with **Passenger** for `nodejs` site types.
- MySQL / PostgreSQL / MongoDB available. `mysql` client present; **no database
  exists yet**.
- ~15 GB disk. **This is the real constraint** — roughly two weddings live at once.
- **40 concurrent processes** and a **3 GB memory cap**, account-wide. Earlier
  drafts of this file said 70 and 2 GB; both were wrong. The process cap is the
  one that bites — Passenger workers, the background worker, cron and every
  `magick`/`zip` subprocess all draw on the same 40.
- `hw.physmem` (128 GB) and `hw.ncpu` (16) describe the **shared machine**, not
  this account. Ignore them when sizing anything.
- **`df` cannot see the account quota.** It reports the shared ZFS pool — 1.7 TB,
  1.1 TB available. Any free-space check built on `df` will read "terabytes free"
  and then fail with `ENOSPC`. See "Storage and the disk budget".
- **The locale is `C`**, and `LANG` is unset. UTF-8 filenames round-trip fine at
  the byte level, but set `LANG=pl_PL.UTF-8` in the app environment and pass
  `-UN=UTF8` to `zip`, or Polish filenames inside an archive open as mojibake on
  the client's Windows machine.
- **There is no `static` site type.** `devil www` offers php, python, ruby,
  nodejs, proxy, pointer — and `aw-foto.pl` is in fact a **php** site serving the
  static build. awfoto-site's README is wrong about this.

The sibling repo `MrLynx93/awfoto-site` runs on this same host and is the reference
for everything deployment-shaped: `app.js` under Passenger, `devil www add`, and the
rsync-over-SSH GitHub Actions workflow.

## Stack decisions (and why)

| Choice | Reason |
|---|---|
| **Node.js** backend | Java was rejected: a JVM idling at hundreds of MB inside a 2 GB shared cap is a bad trade. Node is the right size. |
| **Astro + React islands** | React was the original call and React stays — but as islands inside Astro, matching awfoto-site. That makes `Lightbox.astro`, `tokens.css`, the self-hosted fonts and the Passenger entry point directly reusable. |
| **An image CLI** for resizing | **Do not use `sharp` as a normal dependency.** See below — this is the most misunderstood constraint in the project. |
| **`zip` CLI** for archives | Same reasoning — shell out, don't use a native npm module. `archiver` (pure JS) is the fallback where the CLI can't be used. |
| **Uppy + tus** for uploads | Resumable chunked upload is the one genuinely hard part. Use `tus-node-server` (pure JS, no native deps — matters on FreeBSD). |
| **Node serves every byte** | The files must not be browsable. No public docroot; `res.sendFile()` from outside the web root, with `Range` support. See "Download path". |
| **MySQL** via `mysql2` | Pure JS driver, no native deps. The schema is three tables; nothing here wants Postgres. |
| **`node:crypto` scrypt** for passwords | A real KDF, built into Node. Avoids `bcrypt` and `argon2`, both native. |

## Image resizing: why a CLI, not a library

The short version: **a subprocess gives memory isolation that no in-process
JavaScript library can.** ImageMagick's peak allocation lives and dies outside the
Node heap and can be capped with `-limit`. Inside a 2 GB cap shared across 70
processes, that is the whole argument.

The JS options and why each one loses:

- **`sharp`** — the platform packages cover darwin, linux, linuxmusl, win32 and
  wasm32. **There is no `@img/sharp-freebsd-*`.** On FreeBSD `npm ci` succeeds and
  `import sharp` throws at runtime. (awfoto-site has sharp in `dependencies` and
  deploys fine only because nothing on the server ever imports it — the resize
  scripts run in GitHub Actions on Ubuntu.)
- **`jimp`** — pure JS, installs anywhere, but decodes to a raw RGBA buffer in the
  Node heap: ~180 MB for a 45 MP photo before GC. Also ~10× slower, and it ignores
  ICC profiles, so Adobe RGB exports come out visibly flat.
- **`@jsquash/*`** (WASM mozjpeg) — good encoder, no native build, same raw-buffer
  memory profile, and EXIF orientation and ICC are yours to implement.
- **`node-canvas`** — native bindings on cairo/pango. Strictly worse than sharp here.

What is actually on the host (probed, not assumed):

- **ImageMagick 7.1.1-45 Q16-HDRI**, with `lcms` among its delegates — so ICC
  handling works and Adobe RGB → sRGB is available. **Invoke `magick`.** A
  `convert` shim also exists, so IM6 syntax would have silently worked while
  being wrong.
- **`vipsthumbnail` 8.17.1** is also installed. It is the alternate
  implementation behind `makeDerivatives()` — one file away — and is worth
  switching to if memory or speed ever argues for it.
- **Measured: 438 MB peak RSS, 0.94 s** for one 24 MP resize. Q16-HDRI holds 16
  bits per channel, which is where the memory goes. A 45 MP file extrapolates to
  ~800 MB, so run `-limit memory 512MiB -limit map 1GiB` and strictly one at a
  time. Never fork a second converter — see the 40-process cap.
- **Convert to sRGB, don't strip.** `-strip` removes the ICC profile, which turns an
  Adobe RGB export flat. This is the one quality bug the photographer notices
  instantly and the client can never describe.
- `sharp`'s wasm32 build stays documented as a fallback, but is not needed.

All of this lives behind one module, `server/images.js`, exporting
`makeDerivatives()`. Swapping implementations is a one-file change.

## Architecture

```
Upload (Uppy + tus)
  → files land on disk
  → tus "upload complete" hook enqueues a job, returns the link IMMEDIATELY
  → background worker:
      the image CLI generates web-size previews, one photo at a time
      zip packs the originals into one archive
      gallery flips from "preparing" to "ready"
```

**Never process during the upload request.** She should not watch a spinner while
800 photos are resized. Return the share link the moment bytes are received; show
the gallery as "preparing" until the worker finishes.

The worker is started two ways, both needed: the tus completion hook spawns it
detached if a lockfile says it isn't already running, and a `*/5` cron re-runs it as
a safety net after a crash or a restart. Use **`lockf(1)`** — it is base system,
so it cannot vanish under a package change. (`flock` also happens to be
installed here, from a port; don't depend on it.)

## Download path

**Nothing is reachable without going through Node.** There is no public file
docroot. Originals, previews and ZIPs all live under `STORAGE_ROOT`, outside
every vhost's web root, so no URL reaches them at all except an authorised
application route. This is a product requirement, not an optimisation: the files
must not be browsable.

Two earlier designs were tried and dropped:

- **`X-Accel-Redirect`** — unavailable. mydevil's `nodejs` sites run behind
  Passenger with no way to add an `internal` nginx location.
- **Capability URLs on a second `php` vhost** — technically sound (a 32-char
  token is unguessable, and the probe confirmed `.php` matching is anchored so a
  `.zip` cannot execute), but rejected deliberately. An unguessable URL is still
  a URL: it is bearer-authority, it leaks through referrers, browser history and
  forwarded messages, and it cannot be revoked per-viewer. The `pliki` vhost is
  not part of the design.

Every route checks the gallery session cookie and `expires_at` before a byte
moves:

| Route | Serves |
|---|---|
| `/g/:slug/p/:photo/thumb.jpg` | grid preview |
| `/g/:slug/p/:photo/large.jpg` | lightbox preview |
| `/g/:slug/photo/:photo` | one original, `Content-Disposition: attachment` |
| `/g/:slug/zip` | the whole archive, as an attachment |

### On "Node must never stream multi-GB files"

Earlier drafts of this file said that. It is **half true, and the half that is
false matters here.**

What is true: never *buffer* a file into memory, and never load one into a
`Buffer` before sending.

What is false: that streaming itself is expensive. Node's file streaming is
asynchronous I/O with backpressure — roughly a 64 KB buffer per connection, and
one process serves many concurrent downloads without blocking its event loop. A
download does not occupy a process the way a CPU-bound task does. Against the
40-process cap, ten simultaneous client downloads are ten sockets in one
process, not ten processes.

So use `res.sendFile()`, which also gives **`Range` support for free** — and
that genuinely matters: a client on a phone whose 6 GB wedding download drops at
80% can resume rather than restart.

**The real risk is not memory, it is Passenger.** If Passenger buffers responses
or imposes a request timeout, a large download breaks in a way that looks
mysterious. That is why a large-file streaming test is a Milestone 1 task,
before any feature depends on it — not a Milestone 5 surprise. Keep the fallback
in mind until it passes: capability URLs on a `php` vhost would work, at the
cost of the browsability the photographer explicitly does not want.

## Storage and the disk budget

A normal session is ~30 photos: ~240 MB of originals plus a ~240 MB ZIP is nothing.
The doubling only bites at wedding scale (~800 photos ≈ 12.8 GB of ~15 GB).

**Do not use `df` for this.** It reports the shared ZFS pool, not the account
quota — it will say a terabyte is free right up until the write fails. The budget
is explicit instead:

- `DISK_BUDGET_GB` in `.env` (start at 12).
- `server/disk.js` sums `galleries.bytes_total` for live galleries and refuses a
  ZIP that would cross the budget.
- Over budget, the gallery is marked `zip_unavailable` and streams a store-mode
  ZIP on demand via `archiver` for that gallery only.
- A nightly `du -s ~` reconciles the tally and logs drift. Once a night, not per
  upload.
- The admin dashboard shows usage against the budget, so it is visible early.

This is testable without filling a disk: set the budget to 1 GB in dev and the
whole path exercises in seconds.

## Expiry is a day-one feature, not a later one

15 GB only works if galleries delete themselves. Build this first:

- `expires_at` column on the gallery table, default 30 days.
- Nightly cron: delete expired originals, previews, ZIP, and the DB row.
- Expiry is a dropdown in the upload form, "30 days" preselected.

A gallery that has expired should show a friendly "this gallery has expired, contact
the photographer" page — not a 404.

## Upload UI requirements

One screen. Nothing else on it.

- Client name, shoot date, expiry dropdown (30 days preselected).
- One large drop zone. She drags the **whole exported Lightroom folder** in — Uppy
  handles directory drops.
- Per-file progress via the Uppy Dashboard.
- On completion: a big "Copy link" button and the password in large text. This is the
  finish line; make it unmistakable that she is done.
- Errors in plain Polish with a retry button. Never surface a stack trace.

### Resumability — get this right

tus means **no progress is lost**, but it does **not** mean background upload. Nothing
transfers while the tab is closed. Closing at 80% pauses it; it does not destroy it.
She reopens the page, drags the same files in, Uppy fingerprints them, asks the server
for the offset, and continues.

- Set `storeFingerprintForResuming: true` explicitly.
- Fingerprints live in localStorage: same browser, same machine, not incognito.
- Add a `beforeunload` handler warning on close mid-upload.
- Screen sleep pauses the upload. Worth a note in the UI.
- Test the resume path by hand before shipping: close the tab mid-upload, reopen,
  re-add, confirm it continues rather than restarting.

Background Fetch API would give true background uploads but is Chromium-only and not
worth the complexity here.

## Resolved (was: open questions)

- **Database** — MySQL, via `mysql2`.
- **Password storage** — `node:crypto` scrypt, `N=16384, r=8, p=1`, 16-byte salt,
  `timingSafeEqual` on compare. Same helper for the gallery password and the admin
  password.
- **Admin auth** — a single admin password plus a signed `httpOnly` session cookie
  (~30 days), not an obscure URL. The browser's Basic-auth dialog can't be written in
  Polish and is awkward on a phone.
- **Preview sizes** — grid thumbnail 500 px long edge at q78, lightbox 2048 px at q82.
  For reference, awfoto-site's build-time resizer uses 2400 px at q82.

## Things already ruled out

- **Cloudflare R2** — a good fallback if transfer ever became a problem. It isn't,
  since mydevil transfer is unlimited.
- **Nextcloud** — works, but the client lands in a file manager. Heavy tenant inside
  a 3 GB RAM cap, and on-demand preview generation makes the first client wait.
- **Piwigo** — an archive with albums and tags. Per-client access is admin-panel
  clicking, batch download is a fragile plugin, and expiry isn't a concept it has.
- **Pixieset / Pic-Time** — the sensible SaaS answer at $7–8/mo. Rejected in favour of
  owning it. (Note: Pixieset's free tier does not include full-resolution download.)
- **Writing chunked upload by hand** — this is what kills self-built galleries. Uppy.
- **Client favourites / photo selection** — useful, but it is per-client state and a
  second admin view. Out of scope for v1.
