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

**"Preparing" has a real progress bar on the admin page**, not just a spinner,
and it updates live rather than by reloading the whole page on a timer.

`server/storage.js` exports `progress(slug)`, which reads the *bar's* numbers
straight off disk: `*-large.jpg` files in `previews/` against image files in
`originals/` — `large.jpg` is the second and last file `makeDerivatives()`
writes per photo, so a count of those is a count of *finished* photos, never
one mid-resize. `src/pages/admin/api/galerie/[slug]/postep.ts` serves this as
JSON, and the admin page polls it every 2s via a plain inline script (no
framework, matching how this codebase always reaches for the least JS that
works) that patches the bar's width, the count text, and its percentage in
place — an animated count-up over the numbers rather than a jump, and a
diagonal stripe sliding across the fill so "still going" survives even while
the count itself briefly sits still between two polls.

**The bar's numbers are not what decides when to reload, and that distinction
is load-bearing.** `done` (previews on disk) reaches `total` (originals on
disk) as soon as every photo's derivatives are finished — but the worker does
not finalise there. It waits out a 45s quiet window first (`QUIET_PERIOD_MS`,
in case more files are still arriving), then rebuilds the archive, and only
*then* does `markReady()` update `photo_count`. Reloading as soon as
`done >= total` was the first version of this and it was wrong: confirmed by
watching it happen, a reload at that point lands on a photo count and an
archive still missing the photos that just finished. (The manifest is no
longer one of them — the worker writes it at the end of every run now, not
only the finishing one, because it is also what the pages render the grid
from; see "A photo is an id".) So the poll's `working` flag compares
`gallery.photoCount` (the database row) against `total` (disk) instead — the
one comparison that is only ever satisfied once a finalised run has actually
caught up — and only then does the page reload, exactly once, to reveal the
grid a live patch was never going to build.

That comparison is also what makes the banner appear for a gallery that was
already `ready`. The row's `status` only ever says `preparing` for a first
batch or right after a delete (`markPhotosChanged`); dropping a few more
photos into a finished gallery leaves `status = 'ready'` for the entire
run, including the 45s wait, so `status` alone cannot be trusted to say
"still working" — `photoCount < total` is what actually catches it. The
banner does not wait for the next poll to show, either: `PhotoUploader.tsx`
dispatches a `zdjecia-wyslane` `CustomEvent` on `window` the moment one file
finishes uploading (its tus hook has already moved it server-side by then),
and the admin page's script listens for that and reveals the banner
immediately, polling for real numbers a moment later — the two live in
separate Astro islands with no shared state otherwise, so a DOM event is what
crosses that gap. `status === 'failed'` is excluded from all of this: a hard
failure leaves `photoCount` at 0 permanently, and treating that as "still
working" would show a bar stuck at 0% forever instead of the actual failure
message. A retry after a failure has the same small, accepted gap as before:
no live progress shows until that new run's own `markReady()` lands.

## A photo is an id

Every photo is given a random 12-character id the moment its bytes land
(`newPhotoId()` in `server/photos.js`, called from the tus completion hook),
and that id is what everything names it by:

```
STORAGE_ROOT/galleries/<slug>/
  originals/<id>.jpg       the uploaded bytes
  originals/<id>.json      {id, filename, ext, uploadedAt}
  previews/<id>-thumb.jpg  grid
  previews/<id>-large.jpg  lightbox
```

— and `/g/:slug/p/<id>/thumb.jpg`, `/g/:slug/photo/<id>`, the manifest entry,
the delete button. Nothing anywhere is derived from something that can change
afterwards.

Both of the obvious alternatives were tried in this codebase, and both are
wrong:

- **Its position.** Previews used to be `<n>-thumb.jpg` with `n` the photo's
  place in the sorted directory listing. Adding a photo that sorts ahead of
  others then moved every position after it, and the worker's incremental check
  ("position 4 already has derivatives, skip it") kept each preview where it
  was: the grid showed every tile shifted by one, the last photo twice, the new
  photo nowhere, and each frame drawn at the proportions of a different one.
  Nothing failed — the gallery was simply wrong. It also cost a rename-the-tail
  pass on delete and another on insert, and a compaction step whenever the
  worker skipped an unreadable file.
- **Its filename.** Stable under insertion, but it makes two photographs with
  the same name one photograph — and two cards in one camera bag both hold a
  `DSC_0001.jpg`. Under a name-keyed scheme the second upload overwrites the
  first, or worse, inherits its preview. **Two files with the same name are two
  photos here**, both shown, both downloadable.

So the name she exported is *metadata*: it decides what the client's downloads
folder shows and nothing else. It never reaches the filesystem, which is also
why `originalPath()` no longer has to defend against `../../.env` — that string
has nowhere to be constructed rather than somewhere to be caught.

**The record is `originals/<id>.json`**, written by the upload hook immediately
after the bytes are renamed into place. Bytes first, record second, and the
order matters: `listPhotos()` counts records, so a process killed between the
two leaves a file nothing claims — named in the worker's log — rather than a
photo promising bytes that are not there. tus only reports success once both
have landed, so she sees a failed file and retries.

**Order is not identity.** `listPhotos()` sorts by the exported filename, which
for a Lightroom export is chronological, then by upload time, then by id — so
two photos sharing a name still have one stable order rather than whatever the
directory hands back that run. Adding a photo changes where the others are
drawn; it changes nothing about what any of them *is*.

The ZIP is the one place the display name has to come back. `zip` cannot rename
an entry, so `buildArchive()` stages a directory of **hard links** carrying the
exported names and zips that instead — free and instant for a 12 GB wedding,
where a copy would be exactly the doubling the disk budget exists to prevent.
A repeated name is numbered there, `DSC_0001 (2).jpg`, because two identical
entry names in one archive is a client who silently ends up with one of them.
The archive is also removed before it is rebuilt: `zip` *updates* an existing
file, which would carry entries from the last build, deleted photos included.

What this removes, rather than adds: the rename-the-tail dance on delete, the
reconcile pass on insert, the compaction after a skipped file, and
`backfillDimensions()`. Deleting a photo is four unlinks and one manifest entry
gone; every other photo keeps its own files, untouched. The worker's only
remaining sweep is for previews whose photo no longer exists — which nothing
routine produces, and which can no longer be mistaken for another photo's.

**There is no migration from the old layout, and `npm run reset` is the
upgrade.** It drops every table and removes every file under `STORAGE_ROOT`,
and the next boot re-runs the migrations from the top. That is a deliberate
trade: this is a delivery tool holding a few weeks of sessions, and rewriting a
live layout in place is a worse risk than re-uploading what is still current.
The originals are the only copy on the server, so whatever a client has not
downloaded is gone — check `/admin` first.

`scripts/check-photo-identity.mjs` (`npm run check:photos`) holds the whole
contract down: the same filename twice is two photographs, adding a photo
leaves every other photo's files exactly where they were, deleting one touches
only its own, an id can never name a file outside its gallery, and the archive
round-trips through real `zip`/`unzip` with the duplicate numbered.

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

The download icon in `Lightbox.astro` is the only thing in the UI that reaches
`/g/:slug/photo/:photo` — it existed as a route with no way to trigger it from
either page until a download button was added there, mirroring the close
button at the opposite corner. It is a plain `<a>`, not a click handler, so the
route's own `Content-Disposition` header does the work, the way `Pobierz
wszystkie` already does for the ZIP; `GalleryGrid.astro` puts the slug on
`#photo-grid` as `data-slug` so the lightbox's script has something to build
the href from.

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
handled by `server/photos.js`. It is four unlinks — the original, its record,
its two previews — and one entry dropped from the manifest, because a photo is
an id and nothing else is named after where it sat (see "A photo is an id",
which is also the history of why this used to be harder). The × posts that id
rather than a position, so a page left open while another tab deleted something
cannot remove the photograph beside the one she meant. The archive still holds
the deleted photo, so it is removed and the gallery goes back to `preparing`
for the worker to rebuild — the client sees the "preparing" page for as long as
that ZIP takes.

A whole gallery can go too, for the session that is finished before its term or
the one uploaded twice. It goes through `server/removal.js`, in the order the
nightly sweep will want: condemn the row, then the files, then the row itself —
so a run that dies halfway leaves a gallery nobody can reach rather than one
that is reachable with half its photos gone. It is always behind a confirmation
that names the client and counts the photos, because the originals go with it
and, if the card is already cleared, nothing anywhere can bring them back.

That confirmation is one body (`DeleteGalleryConfirm.astro`) in either of two
frames. Both screens that already show the gallery — its own page and the
dashboard — ask in a `<dialog>`, because she is looking at the thing and a
separate screen that takes her away and then lands her on the list whether she
says yes or no loses her place for nothing. What makes a modal safe on a list of
nine similar rows is that it names the client and counts the photos, so it
repeats which one she picked rather than asking "are you sure?" about nothing in
particular; the dashboard renders one per row, after the table, since a dialog
is in the top layer wherever it is declared and a table cell is a poor place to
nest one.

The standalone page is the other frame, and it is the path taken with no
JavaScript: every button that opens a dialog is a real link to it, so the
question is still asked. Reached that way from a gallery it carries
`?wroc=galeria` and its "no" goes back there rather than to the list. The dialog
itself needs no script beyond `showModal()` — Escape and the backdrop close it,
and "no" is a `formmethod="dialog"` submit.

## The grid is masonry, not square — and not justified rows either

Both grids — the client's and the panel's — are `GalleryGrid.astro`, and no
photograph in either is cropped to a square. A square tile is the one shape a
photographer never delivers: it cuts a portrait off at the top and bottom and
takes the ends off a panorama. Every photo keeps its own proportions.

This used to mean **justified rows** — Flickr/Google Photos style, every line
filling the width at one shared height. That made photos bigger than a plain
square grid, but a row is still a row: the whole line was capped by whichever
photo fit last, and asking for photos to be bigger still, with no requirement
that they share a height, is asking for the row itself to go. So this is now a
**CSS multi-column layout** — `columns` plus `break-inside: avoid` on each
tile, nothing else. The browser decides how many fixed-width columns fit and
stacks each photo under the shortest one, the same way it used to decide line
breaks: no measuring, nothing recomputed on resize, no JavaScript.

**No cropping at all**, for the same reason: there is no row left for an
extreme ratio to break, so nothing forces `object-fit: cover` anymore. A photo
renders at its own true `width/height`, unclamped — MIN_RATIO/MAX_RATIO existed
under justified rows to stop one extreme ratio from dominating a line; a
masonry column has no line to dominate, so the clamp is gone and every photo
is shown exactly as shot.

`column-width: clamp(11rem, 26cqw, 24rem)` on `.photo-grid` is the whole
sizing lever, on the same reasoning `--row` used to carry: a quarter of the
grid's own width lands on three or four columns at a laptop and one or two on
a phone, each noticeably bigger than a justified row's tiles were, since a
column does not also have to leave room for whatever else shared its line. At
the narrowest phones the floor forces a single, full-width column — the
biggest a photo can be shown. The `.grid-frame` wrapper and its `cqw` units are
unchanged from before: the panel's grid sits inside a card and the client's
fills the page, so the same viewport gives them different room, which is why
this is a container query and not `vw`. `width="photos"` on the client's
`BaseLayout` (1800px, not the site's 1240px) is still the other half of
"bigger" — more columns of room to be generous with.

`sizes` is one shared estimate now rather than one per photo: every tile in a
masonry layout renders at the same width (its column's), only the height
varies, so there is no per-ratio case to cover the way a justified row's
mixed-width line needed. `(max-width: 700px) 100vw, (max-width: 1000px) 50vw,
min(26vw, 24rem)` tracks the `column-width` clamp closely enough that erring
high, same as before, costs a larger file rather than a soft photograph.

**The trade every masonry layout makes, including this one:** reading order
runs down one column before starting the next, not left-to-right across a
row. A justified row kept a wedding's photos in strict chronological order;
a column layout does not. That is the cost of letting heights differ instead
of matching them, and it is the trade that was asked for.

**The proportions still come from the manifest**, so `width` and `height` in
`manifest.json` stay load-bearing. Two things about them still apply:

- They are measured **on the thumbnail, not on the original**. The resize has
  already applied `-auto-orient`, so a portrait frame stored landscape with an
  EXIF rotation reports the shape the grid will actually draw — which
  `identify` on the original gets backwards, tilting every such photo. It is
  also cheaper than reading a 45 MP file twice.
- `null` for both is what a photo the worker could not measure carries, and
  the grid assumes 3:2 there. It is close to unreachable now: the worker
  measures every thumbnail it writes, and re-measures one it reuses whenever
  the last manifest has no dimensions for that id — `backfillDimensions()`, a
  repair pass for manifests written before dimensions were tracked, went with
  the layout those manifests belonged to.

## The galleries list gives the name column the room

`table-layout: fixed` with a `<colgroup>`, not the auto layout the table had
before. Auto layout distributes a table's spare width across columns in
proportion to their own content, and a session name is the one column with no
natural ceiling on that -- so whether it actually got more room than a numeral
or a button depended on whatever the browser's heuristic did with the row's
other content that day. `fixed` makes it deliberate instead: every column but
the first is given a width sized to what it ever has to hold (a date, a count,
a size, a day count, one button), and the name -- the only column left
unspecified -- absorbs whatever the row's total width leaves over.

**Measured, not assumed: a `display: none` cell breaks this.** The hidden
second column (`.summary`, the phone-only sentence) used to be hidden exactly
that way, and under `table-layout: fixed` it made Chromium misassign every
`<col>` width one column to the left -- as if the hidden cell's slot had been
removed from the row rather than just hidden, so "Data" silently rendered at
the width meant for the empty column beside it, and so on down the row.
Confirmed in isolation with a two-line repro before it was believed. The fix
is not to hide that cell at all: it stays a real, empty table-cell -- zero
width from the `<col>` already accounts for it, `overflow: hidden` clips the
sentence it always holds so it cannot spill into the column beside it, and
none of this touches the phone layout, where the table stops being a table
before `<colgroup>` ever applies.

## Upload UI requirements

One screen. Nothing else on it.

- Session name, shoot date, expiry dropdown (30 days preselected).
- One large drop zone. She drags the **whole exported Lightroom folder** in — Uppy
  handles directory drops.
- Per-file progress via the Uppy Dashboard.
- On completion: a big "Copy link" button and the password in large text. This is the
  finish line; make it unmistakable that she is done.
- Errors in plain Polish with a retry button. Never surface a stack trace.

The same screen is also the edit screen, and the gallery's own page.
`/admin/galeria` opens it empty; `/admin/g/<slug>` is it for a gallery that
exists. There the order is what she came for: the **link and the password
first**, in two columns with a copy button each — never one button for both,
which would put the key in the same message as the door — then the details, then
the photos. The drop zone is the **first card in the photo grid**, the same size
as the photographs beside it, because adding photos belongs among the photos;
`PhotoUploader.tsx` is that card here and the tall panel on the empty screen,
where dropping a folder is one of the two ways a gallery gets created.

Uploading to an existing gallery has no on-page confirmation beyond "Wysłano N
zdjęć. Odśwież stronę, żeby je zobaczyć" — the same message the empty screen's
panel shows, just **portalled** out of the card. A card is sized like the
photographs beside it, with no room for that sentence at wedding scale or for a
list of failed files, so `PhotoUploader.tsx` renders that text into a plain
`#uploader-feedback` div the admin page places right after the grid, via
`createPortal`, rather than inside its own DOM position. This replaces a
version that hid the same text outright with `display: none` and rendered
nothing in its place — the upload itself worked (the tus route, the worker
spawn, all of it), but she had no way to tell, since the one thing on the
screen that would have told her had no visible form. If the target div is ever
missing, the text renders inline in the card instead of vanishing again — a
message in a slightly wrong place beats the bug this replaced.

There is no separate edit form and no view/edit pair: she
is the only person who opens either, she is always allowed to change what she is
looking at, and "which of the two am I on?" is not a question the panel should
ask. Nothing on that page is a second gallery for the client she says she forgot
a few photos for, which is what the alternative kept producing.

Nothing is created by opening the page. The row appears at the first moment
there is something to create — she presses "Zapisz i pokaż link", or she drops a
folder in — which is what lets the details and the drop zone share one screen:
the upload needs a gallery to attach to and gets one just in time, without a
wizard step to walk through first.

**After that the fields save themselves.** Every edit to a gallery that exists is
a correction to something already stored, and a button that holds those changes
hostage is a button that loses them when she navigates away — so a moment after
she stops typing, or the instant she leaves a field, it saves. The create button
disappears once there is something to correct rather than create. Saving never
reloads the page, because a reload would empty the upload queue; and dropping
photos into a gallery that exists does not save the details either, because
choosing a photo should not feel like pressing save.

### Uppy's own skin, retinted

The Dashboard plugin ships one look — grey panels, a system-font stack, and a
blue/green Google-Material palette that has nothing to do with this app's
warm serif-and-clay design. Uppy 6 defines no CSS custom properties, so there
is no theme variable to redirect: `src/styles/editor.css` overrides Uppy's
own selectors directly, one for one, rather than hooking into a token that
does not exist.

`.uploader` is the selector both variants share, so one block of rules dresses
the tall panel on the empty screen and the card in the grid alike: Uppy's
grey backgrounds (`#f4f4f4`/`#fafafa`/`#eaeaea`) become this app's cream tones
(`--bez`/`--kremowy`/`--piaskowy`), its blue (`#1269cf`, on the "+ Dodaj
więcej" button, the browse link, and the "Ukończono" status button alike)
becomes `--glina-ciemna`, and its green (`#1bb240`, on the per-file progress
ring and the completed status bar) becomes `--szalwia` — the same sage the
disk-usage bar already uses for "fine", rather than introducing a second
green. Its error red (`#e32437`) maps to this app's own `--czerwien`, already
the delete button's color. `font-family: var(--body)` overrides Uppy's system
stack throughout.

Two colors resist a plain `color` override because Uppy bakes them into an
SVG rather than reading a CSS property: the per-file progress ring and
checkmark are an inline `<circle>`/`<path fill="...">`, overridden by
targeting `circle { fill: ... }` directly; the "drop files here" hint shown
while dragging a file over the window has its arrow baked into a data-URI
`background-image`, which is dropped (`background-image: none`) rather than
fought, since there is no property that recolors a data URI.

Verified against the live DOM during an actual upload, not just against the
source stylesheet: the completed checkmark, the "Ukończono" status button,
and the status bar's fill all measured back as the exact hex values above
(`getComputedStyle`), in both the panel and the card, at rest and mid-upload.

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

- **Database** — MySQL, via `mysql2`. The gallery's name column is
  `session_name` and its date column is `session_date`: what she types is a
  session — often a couple, sometimes "Chrzciny Zosi" — and only sometimes
  anybody's name, and the date is the session's, not necessarily a shoot in the
  old studio sense.

  They were `client_name` and `shoot_date`, and the renames are worth knowing
  about because each left two shapes of database in the world: `001_initial.sql`
  was rewritten in place to say the new names, so anything created since has
  them, while the deployed database still had the old ones. `004_session_name.sql`
  and `005_session_date.sql` each rename their column with a `CHANGE` guarded on
  `information_schema` — a no-op wherever 001 already did it. Nothing has to be
  dropped, and no data moves: a `CHANGE` renames the column under the rows it
  already has.

  **`migrate()` in `server/db.js` also checksums every applied file**, which is
  what those two renames exposed the need for: editing `001_initial.sql` after a
  database had already run it is exactly the mistake a checksum catches. Every
  file's hash is recorded in `schema_migrations.checksum` when it is applied; on
  every later boot the file on disk is re-hashed and compared, and a mismatch is
  a boot failure naming the file, not a silent divergence to debug later. A row
  with no recorded checksum — every migration applied before this guard existed
  — is backfilled from the file as it stands now rather than failed, since there
  is no historical hash to compare it against; the rule this exists to enforce
  is about the *next* edit. The practical upshot: once a migration file has run
  anywhere, it is frozen — fix a mistake in it with a new file, never by editing
  the one that ran.
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
