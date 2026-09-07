# galeria.aw-foto.pl

A self-hosted client photo gallery for AW Fotografia. A client receives a link
and a password, browses a branded gallery, and downloads a single photo or a ZIP
of everything. Replaces WeTransfer.

Scope is deliberately small: **one gallery, one password, view, download,
expire.** Not a photo archive, not a CMS.

See `CLAUDE.md` for the architecture and the reasoning behind the stack.

## Status

**Milestone 0 complete.** The host has been probed; results and the four findings
that changed the design are in [`docs/host-facts.md`](docs/host-facts.md).
Nothing is deployed yet.

Next: Milestone 1 — scaffold, both vhosts, and the deploy pipeline.

## Milestone 0: probe the host

Everything downstream depends on facts about the mydevil FreeBSD box that cannot
be established from a laptop: which image CLI exists, what a resize costs in
memory, whether the lock primitive is `lockf` or `flock`, how much disk is
genuinely free, and whether Polish filenames survive the filesystem.

Run this, with nothing installed on the server:

```sh
ssh you@host 'sh -s' < scripts/probe-host.sh
```

Better, if you can put one real Lightroom export on the server first — the
resize is then measured on a representative file rather than a synthetic
gradient:

```sh
scp DSC_1234.jpg you@host:probe.jpg
ssh you@host 'sh -s -- probe.jpg' < scripts/probe-host.sh
```

The script is read-only apart from a scratch directory under `$HOME` that it
removes on exit. Paste the whole output into the pull request.

## Milestone 1: host setup

One vhost, not two. The files are never web-served, so there is no files site:

```sh
devil www add galeria.aw-foto.pl nodejs /usr/local/bin/node22 production
devil ssl www add <IP> le le galeria.aw-foto.pl
devil www options galeria.aw-foto.pl sslonly on
devil www options galeria.aw-foto.pl processes 2   # against the 40-process cap

devil mysql db add galeria galeria --collate=utf8mb4_unicode_ci
devil mysql passwd galeria      # prompts; this is DB_PASSWORD
devil mysql list -v             # read back the REAL names — mydevil prefixes them
```

Then copy `MYDEVIL_HOST`, `MYDEVIL_USER` and `MYDEVIL_SSH_KEY` into this repo's
Actions secrets, and put `.env` (from `.env.example`) at
`~/domains/galeria.aw-foto.pl/public_nodejs/.env`, mode 600.

### The two checks the Milestone 0 script does not do

Both create state on the host, which is why the probe skips them.

**1. Colour** — the one quality bug a photographer spots instantly and a client
can never describe. If the ICC profile is dropped rather than converted to sRGB,
saturated reds and greens go visibly flat.

```sh
scp DSC_1234.jpg you@host:probe.jpg
ssh you@host 'sh -s -- probe.jpg' < scripts/colour-check.sh
scp -r you@host:colour-check ./     # then look at them
```

**2. Streaming through Passenger** — this replaced the autoindex check when the
download design changed, and it is the more important of the two. Everything is
served by Node from outside the web root, so if Passenger buffers responses or
times out a long request, large downloads break confusingly.

```sh
# a throwaway route doing res.sendFile() on a ~5 GB file under STORAGE_ROOT
curl -o /dev/null https://galeria.aw-foto.pl/__streamtest   # completes? memory flat?
curl -s -o /dev/null -w '%{http_code}\n' -r 0-100 \
     https://galeria.aw-foto.pl/__streamtest                # expect 206
```

If that fails, the fallback is capability URLs on a `php` vhost — which was
rejected on purpose, so it is a conversation rather than a silent switch.

### What the answers decided (see docs/host-facts.md for the results)

| Probe result | Consequence |
|---|---|
| `magick` present | ImageMagick 7 — CLAUDE.md's `convert` invocation needs updating |
| only `convert` | ImageMagick 6 — invoke as documented |
| `vipsthumbnail` present | Prefer it: faster, lighter, colour-correct |
| no image CLI at all | Fall back to `npm install --cpu=wasm32 sharp`; only `server/images.js` changes |
| peak RSS from the resize | Sets the `-limit memory` / `-limit map` values for the worker |
| `lockf` vs `flock` | Picks the worker's single-instance guard (FreeBSD has `lockf`) |
| ZIP64 unsupported | Weddings over 4 GB must use `archiver` instead of the `zip` CLI |
