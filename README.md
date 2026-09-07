# galeria.aw-foto.pl

A self-hosted client photo gallery for AW Fotografia. A client receives a link
and a password, browses a branded gallery, and downloads a single photo or a ZIP
of everything. Replaces WeTransfer.

Scope is deliberately small: **one gallery, one password, view, download,
expire.** Not a photo archive, not a CMS.

See `CLAUDE.md` for the architecture and the reasoning behind the stack.

## Status

Milestone 0 — host probe. Nothing is deployed yet.

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

### Two checks the script does not do

It deliberately skips anything that creates state on the host:

1. **Colour.** Resize one real Adobe RGB Lightroom export and compare it side by
   side with the original. If the ICC profile is dropped rather than converted
   to sRGB, saturated reds and greens go visibly flat. This is the one quality
   bug a photographer spots instantly and a client can never describe.
2. **Static vhost autoindex.** `devil www add pliki.aw-foto.pl static`, put a
   file at a deep path, and confirm the directory does not list its own
   contents. If autoindex cannot be turned off, every capability-token directory
   needs an empty `index.html`.

### What the answers decide

| Probe result | Consequence |
|---|---|
| `magick` present | ImageMagick 7 — CLAUDE.md's `convert` invocation needs updating |
| only `convert` | ImageMagick 6 — invoke as documented |
| `vipsthumbnail` present | Prefer it: faster, lighter, colour-correct |
| no image CLI at all | Fall back to `npm install --cpu=wasm32 sharp`; only `server/images.js` changes |
| peak RSS from the resize | Sets the `-limit memory` / `-limit map` values for the worker |
| `lockf` vs `flock` | Picks the worker's single-instance guard (FreeBSD has `lockf`) |
| ZIP64 unsupported | Weddings over 4 GB must use `archiver` instead of the `zip` CLI |
