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
  the byte level. Set `LANG=pl_PL.UTF-8` in the app environment anyway — but note
  that **it does not fix ZIP entry names**, and neither does `-UN=UTF8` (not a
  valid value for that option; it takes Quit|Warn|Ignore|No|Escape). Info-ZIP
  stores names as raw UTF-8 with bit 11 clear under every locale tried, so
  Windows shows mojibake. `verifyArchive` reports affected entries instead of
  pretending this is solved. See "Storage and the disk budget" and
  `server/archive.js`.
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
- **Convert with `-profile`, not `-colorspace`, and never `-strip`.** Measured on
  a wide-gamut source: `-strip` and `-colorspace sRGB` produced *identical*
  pixels (mean RGB 127.6/119.1/34.0), while `-profile srgb.icc` actually
  remapped them (95.9/69.5/0.5). **`-colorspace sRGB` does not convert an
  ICC-tagged image** — it is close to a no-op, and an earlier draft of
  `images.js` used it believing otherwise. Only `-profile` runs the transform
  through lcms.

  `server/images.js` looks for an sRGB profile on the host (override with
  `SRGB_PROFILE`) and converts when it finds one. With no profile it
  deliberately does nothing and warns, leaving the source profile embedded —
  correct in every colour-managed browser. It never falls back to `-strip`,
  which leaves wide-gamut pixels labelled sRGB: the flat, desaturated result
  the photographer notices instantly and the client can never describe.
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

The admin session is the second key to all four. She uploaded these photos;
making her type a client's code to look at her own work is a lock with no
threat behind it. It also ignores `expires_at`, because an expired gallery is
closed to the client and still on disk until the sweep, and the panel is where
she decides which it should be.

Both pages wear the site's bar — the mark from awfoto-site's `SiteHeader`, and
nothing else on the client's, whose wordmark leads to aw-foto.pl rather than to
a login screen. The client's gallery also says how long it has: "jeszcze 28 dni
— do 8 października", above the grid rather than under it, because it is the
reason to press the download button.

Her own page for a gallery is a **separate page**, `/admin/g/:slug`, not a
bypass inside the client's. `/g/:slug` keeps exactly one behaviour — gate, then
grid — so it stays openable in a private window to see precisely what the client
sees, and no branch can show the wrong page to the wrong person. Both render the
same `GalleryGrid` and `Lightbox` off the same preview routes.

### On "Node must never stream multi-GB files"

Earlier drafts of this file said that. It is **half true, and the half that is
false matters here.**

What is true: never *buffer* a file into memory, and never load one into a
`Buffer` before sending.

What is false: that streaming itself is expensive. Node's file streaming is
asynchronous I/O with backpressure, and one process serves many concurrent
downloads without blocking its event loop. A download does not occupy a process
the way a CPU-bound task does — against the 40-process cap, ten simultaneous
downloads are ten sockets in one process, not ten processes.

**Measured, not assumed:** ten concurrent 200 MB downloads through
`res.sendFile()` moved RSS from 120.3 MB to 122.7 MB — about 240 KB per stream,
and flat for the duration. Re-run it with the `/__streamtest` route in `app.js`
if this is ever doubted.

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

A single photo can go too, from the gallery's own page: a small × on each tile,
handled by `server/photos.js`. The subtlety worth knowing before touching that
file is that **a photo's identity is its position**. The worker lists the
originals in name order and writes previews as `<n>-thumb.jpg`, so removing one
from the middle shifts everything after it — and the next worker run, finding a
preview already at every index, would reuse them and hand the client a grid
where each photo after the deleted one shows its neighbour. So the previews are
*renamed* down one place, which is exactly the shift the worker's own numbering
performs, and a few renames replace re-encoding the tail of a wedding. The
archive still holds the deleted photo, so it is removed and the gallery goes
back to `preparing` for the worker to rebuild — the client sees the "preparing"
page for as long as that ZIP takes.

A whole gallery can go too, for the session that is finished before its term or
the one uploaded twice. It goes through `server/removal.js`, in the order the
nightly sweep will want: condemn the row, then the files, then the row itself —
so a run that dies halfway leaves a gallery nobody can reach rather than one
that is reachable with half its photos gone. It is always behind a confirmation
that names the client and counts the photos, because the originals go with it
and, if the card is already cleared, nothing anywhere can bring them back.

That confirmation has two frames around one body (`DeleteGalleryConfirm.astro`).
From the gallery's own page it is a `<dialog>`: she is already looking at the
thing, and a separate screen that takes her away and then lands her on the list
whether she says yes or no loses her place for nothing. From the dashboard's bin
it is a page, because there she is looking at a list of nine similar rows rather
than at the gallery, and being shown which one she picked is the point. The
dialog needs no script beyond `showModal()` — Escape and the backdrop close it,
and "no" is a `formmethod="dialog"` submit — and the button that opens it is a
real link to the page version, so the question still gets asked with JavaScript
off.

## Upload UI requirements

One screen. Nothing else on it.

- Client name, shoot date, expiry dropdown (30 days preselected).
- One large drop zone. She drags the **whole exported Lightroom folder** in — Uppy
  handles directory drops.
- Per-file progress via the Uppy Dashboard.
- On completion: a big "Copy link" button and the password in large text. This is the
  finish line; make it unmistakable that she is done.
- Errors in plain Polish with a retry button. Never surface a stack trace.

The same screen is also the edit screen, and the gallery's own page.
`/admin/galeria` opens it empty; `/admin/g/<slug>` is it for a gallery that
exists — details filled in, link and password above the drop zone, the photos
below, more welcome. There is no separate edit form and no view/edit pair: she
is the only person who opens either, she is always allowed to change what she is
looking at, and "which of the two am I on?" is not a question the panel should
ask. Nothing on that page is a second gallery for the client she says she forgot
a few photos for, which is what the alternative kept producing.

Nothing is created by opening the page. The row appears at the first moment
there is something to create — she saves, or she drops a folder in — which is
what lets the details and the drop zone share one screen: the upload needs a
gallery to attach to and gets one just in time, without a wizard step to walk
through first. Saving after that never reloads the page, because a reload
would empty the queue mid-upload.

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

  A **gallery** password is additionally kept in a form the panel can read back:
  AES-256-GCM under a key derived from `SESSION_SECRET` by HKDF, in
  `galleries.password_enc` (`seal()` / `unseal()` in `server/passwords.js`). The
  hash stays the authority at the gate; the sealed copy exists so the admin can
  see the code any time instead of only on the screen that created it — the old
  behaviour meant reopening the panel a week later left her unable to tell a
  client how to get in, with "issue a new password" as the only remedy, which
  silently kills the code she already sent. A database dump alone reveals
  nothing, since the key lives in `.env`; a rotated secret costs the *display* of
  old passwords and nothing else, and those galleries fall back to offering a new
  one. **The admin password is never stored this way** — it stays one-way, in
  `.env`, and nothing in the app can read it back.
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
