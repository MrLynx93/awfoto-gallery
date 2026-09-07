#!/bin/sh
#
# Host probe for galeria.aw-foto.pl — Milestone 0.
#
# Answers the questions the implementation plan cannot answer from a laptop:
# which image CLI the FreeBSD host actually has, what a resize really costs in
# memory, whether the lock primitive is `lockf` or `flock`, how much disk is
# genuinely free, and whether Polish filenames survive the filesystem.
#
# Read-only. The only thing it writes is a scratch directory under $HOME, which
# it removes on exit — including if it is interrupted.
#
# Usage, from a laptop, with nothing installed on the server:
#
#     ssh you@host 'sh -s' < scripts/probe-host.sh
#
# Better: point it at one real Lightroom export already on the server, so the
# resize is measured on a representative file instead of a synthetic gradient:
#
#     ssh you@host 'sh -s -- domains/tmp/DSC_1234.jpg' < scripts/probe-host.sh
#
# Paste the whole output into the pull request.

set -u

PROBE_IMAGE="${1:-${PROBE_IMAGE:-}}"
TMP="$HOME/.probe-tmp.$$"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP" || { echo "FATAL: cannot create $TMP"; exit 1; }

section() { printf '\n== %s %s\n' "$1" "$(echo '=========================================' | cut -c1-$((60 - ${#1})))"; }
have()    { command -v "$1" >/dev/null 2>&1; }
report()  { if have "$1"; then printf '  %-16s yes  (%s)\n' "$1" "$(command -v "$1")"; else printf '  %-16s NO\n' "$1"; fi; }

printf 'probe-host.sh — %s\n' "$(date 2>/dev/null || echo 'date unavailable')"

# ---------------------------------------------------------------- base system
section 'BASE SYSTEM'
uname -a 2>/dev/null || echo '  uname failed'
have freebsd-version && printf '  freebsd-version: %s\n' "$(freebsd-version 2>/dev/null)"
for k in hw.ncpu hw.physmem hw.usermem kern.maxproc; do
  have sysctl && printf '  %-14s %s\n' "$k" "$(sysctl -n "$k" 2>/dev/null || echo '?')"
done

section 'PROCESS LIMITS'
# The 2 GB / 70-process account cap is the constraint the worker is designed
# around; this is where it becomes a real number rather than a doc claim.
ulimit -a 2>/dev/null || echo '  ulimit unavailable'

# ------------------------------------------------------------------ node/npm
section 'NODE'
ls -1 /usr/local/bin/node* 2>/dev/null || echo '  no /usr/local/bin/node*'
for n in node node22 node24 node20; do
  if have "$n"; then printf '  %-8s %s  -> %s\n' "$n" "$("$n" -v 2>/dev/null)" "$(command -v "$n")"; fi
done
have npm && printf '  npm      %s\n' "$(npm -v 2>/dev/null)"

# -------------------------------------------------------------- image tooling
section 'IMAGE CLI  (decides server/images.js)'
for c in magick convert vipsthumbnail vips gm exiftool jpegtran; do report "$c"; done

IM=''
if have magick; then IM='magick'; elif have convert; then IM='convert'; fi
if [ -n "$IM" ]; then
  printf '\n  ImageMagick generation: %s\n' "$IM"
  printf '  '; "$IM" -version 2>/dev/null | head -1
  # IM7 is `magick in.jpg ... out.jpg`; IM6 is `convert`. The plan needs to know
  # which, because CLAUDE.md hardcodes `convert`.
  printf '  delegates (jpeg/png/lcms): '
  "$IM" -version 2>/dev/null | grep -i '^Delegates' | sed 's/^Delegates[^:]*: //' || echo '?'
fi
if have vipsthumbnail; then
  printf '\n  vipsthumbnail: %s\n' "$(vipsthumbnail --version 2>&1 | head -1)"
  printf '  (preferred over ImageMagick if present — faster, lighter, colour-correct)\n'
fi

# ---------------------------------------------------------- resize + peak RSS
section 'RESIZE COST  (peak RSS decides the -limit values)'
SRC=''
if [ -n "$PROBE_IMAGE" ] && [ -f "$PROBE_IMAGE" ]; then
  SRC="$PROBE_IMAGE"
  printf '  source: %s (real photo)\n' "$SRC"
elif [ -n "$IM" ]; then
  # 24 MP synthetic stand-in. Pixel count is representative; colour behaviour
  # is not, which is why the ICC check below needs a real export.
  if "$IM" -size 6000x4000 gradient:red-blue "$TMP/synth.jpg" 2>/dev/null; then
    SRC="$TMP/synth.jpg"
    printf '  source: synthetic 6000x4000 gradient (no real photo given)\n'
  fi
fi

if [ -n "$SRC" ] && [ -n "$IM" ]; then
  printf '  input size: %s\n' "$(ls -lh "$SRC" 2>/dev/null | awk '{print $5}')"
  printf '  input ICC : %s\n' "$("$IM" identify -format '%[profile:icc]' "$SRC" 2>/dev/null | head -c 60 || echo 'none')"
  printf '  input dims: %s\n' "$("$IM" identify -format '%wx%h' "$SRC" 2>/dev/null || echo '?')"

  # The exact shape the worker will use for the lightbox derivative.
  CMD_DESC='-auto-orient -resize 2048x2048 -quality 82'
  printf '\n  running: %s %s\n' "$IM" "$CMD_DESC"
  if have /usr/bin/time; then
    # FreeBSD /usr/bin/time -l reports maximum resident set size, on stderr.
    /usr/bin/time -l "$IM" "$SRC" -auto-orient -resize 2048x2048 -quality 82 \
      "$TMP/out.jpg" 2>"$TMP/time.txt"
    grep -iE 'real|maximum resident' "$TMP/time.txt" | sed 's/^/    /'
  else
    "$IM" "$SRC" -auto-orient -resize 2048x2048 -quality 82 "$TMP/out.jpg" 2>/dev/null
    echo '    (/usr/bin/time absent — no RSS measurement)'
  fi
  if [ -f "$TMP/out.jpg" ]; then
    printf '  output size: %s\n' "$(ls -lh "$TMP/out.jpg" | awk '{print $5}')"
    printf '  output ICC : %s\n' "$("$IM" identify -format '%[profile:icc]' "$TMP/out.jpg" 2>/dev/null | head -c 60 || echo 'none')"
  else
    echo '  RESIZE FAILED'
  fi
else
  echo '  skipped — no image CLI, or no source image'
fi

# ----------------------------------------------------------------- archiving
section 'ARCHIVING'
for c in zip unzip tar; do report "$c"; done
if have zip; then
  printf '  zip version: %s\n' "$(zip -v 2>/dev/null | grep -i 'This is Zip' | head -1)"
  # >4 GB galleries need ZIP64; without it the worker must fall back to archiver.
  if zip -v 2>/dev/null | grep -qi 'ZIP64_SUPPORT'; then
    echo '  ZIP64: yes (galleries over 4 GB are fine)'
  else
    echo '  ZIP64: NOT ADVERTISED — check before trusting a >4 GB wedding'
  fi
fi

# ------------------------------------------------------------ lock primitive
section 'LOCK PRIMITIVE  (worker single-instance guard)'
# FreeBSD ships lockf(1); flock(1) is a Linux-ism. The worker's guard depends
# on which one exists, so this is not a detail.
for c in lockf flock; do report "$c"; done

# -------------------------------------------------------------- db + devil
section 'DATABASE'
for c in mysql mysqldump psql; do report "$c"; done
have devil && { echo '  devil mysql list:'; devil mysql list 2>&1 | sed 's/^/    /' | head -20; }

section 'DEVIL / VHOSTS'
if have devil; then
  echo '  devil www list:'; devil www list 2>&1 | sed 's/^/    /' | head -30
  echo '  devil www (usage — shows available site types):'
  devil www 2>&1 | sed 's/^/    /' | head -25
  echo '  devil cron list:'; devil cron list 2>&1 | sed 's/^/    /' | head -20
else
  echo '  devil NOT FOUND — wrong host?'
fi

# ----------------------------------------------------------------- capacity
section 'DISK  (15 GB is the real constraint)'
df -h "$HOME" 2>/dev/null | sed 's/^/  /'
if [ -d "$HOME/domains" ]; then
  echo '  per-domain usage:'
  du -sh "$HOME"/domains/* 2>/dev/null | sed 's/^/    /'
else
  echo '  per-domain usage: no ~/domains directory'
fi
printf '  $HOME total: %s\n' "$(du -sh "$HOME" 2>/dev/null | awk '{print $1}')"

# ------------------------------------------------------- polish filenames
section 'POLISH FILENAMES + LOCALE'
printf '  LANG=%s LC_ALL=%s\n' "${LANG:-unset}" "${LC_ALL:-unset}"
have locale && locale 2>/dev/null | head -3 | sed 's/^/  /'
# Client names and ZIP entries carry ą ć ę ł ń ó ś ź ż. If the filesystem
# mangles them here, it will mangle them in every gallery.
PL='Zażółć-gęślą-jaźń.jpg'
if : > "$TMP/$PL" 2>/dev/null && [ -f "$TMP/$PL" ]; then
  ROUNDTRIP=$(ls "$TMP" 2>/dev/null | grep -c 'Zażółć')
  if [ "${ROUNDTRIP:-0}" -ge 1 ] 2>/dev/null; then
    echo '  UTF-8 filenames: OK (created and listed back intact)'
  else
    echo '  UTF-8 filenames: WRITTEN BUT LISTED BACK MANGLED — investigate'
  fi
  ls -b "$TMP" | grep -i 'ja' | sed 's/^/    as stored: /'
else
  echo '  UTF-8 filenames: FAILED TO CREATE'
fi

# ------------------------------------------------------------ deploy tooling
section 'DEPLOY TOOLING'
for c in rsync ssh git openssl; do report "$c"; done

section 'DONE'
echo 'Paste everything above into the pull request.'
echo
echo 'Two checks this script deliberately does NOT do, because they create things:'
echo '  1. Colour: resize one real Adobe RGB Lightroom export and compare it'
echo '     side by side with the original. A stripped profile shows up as'
echo '     visibly flat reds and greens.'
echo '  2. devil www add pliki.aw-foto.pl static — then confirm a directory'
echo '     under it does not list its own contents (autoindex off).'
