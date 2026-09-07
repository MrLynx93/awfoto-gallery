#!/bin/sh
#
# Colour check — Milestone 1.
#
# The probe confirmed ImageMagick has `lcms` among its delegates, which proves
# correct colour handling is POSSIBLE. It does not prove our command is right.
# This script settles it on a real photo.
#
# Give it one real Adobe RGB export from the actual Lightroom workflow:
#
#     scp DSC_1234.jpg you@host:probe.jpg
#     ssh you@host 'sh -s -- probe.jpg' < scripts/colour-check.sh
#
# It writes three variants into ~/colour-check/ and prints their profile and
# mean saturation. Then LOOK at them — download the directory and compare against
# the original. Numbers narrow it down; eyes decide.

set -u

SRC="${1:-}"
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "usage: sh colour-check.sh <path-to-real-lightroom-export.jpg>" >&2
  exit 1
fi

IM=$(command -v magick || command -v convert) || { echo "no ImageMagick" >&2; exit 1; }
OUT="$HOME/colour-check"
mkdir -p "$OUT"

# Mean saturation in HSL. A stripped Adobe RGB file reinterpreted as sRGB shifts
# measurably here, which is the failure this check exists to catch.
sat() { "$IM" "$1" -colorspace HSL -format '%[fx:mean.g]' info: 2>/dev/null; }
icc() { "$IM" "$1" -format '%[profile:icc]' info: 2>/dev/null | head -c 40; }
dims() { "$IM" "$1" -format '%wx%h' info: 2>/dev/null; }

printf '\nSOURCE  %s\n' "$SRC"
printf '  dims       %s\n' "$(dims "$SRC")"
printf '  icc        %s\n' "$(icc "$SRC" || echo '(none)')"
printf '  mean sat   %s\n' "$(sat "$SRC")"

if [ -z "$(icc "$SRC")" ]; then
  printf '\n  !! This file has NO embedded ICC profile.\n'
  printf '     Either Lightroom exported sRGB already (fine, but then this test\n'
  printf '     proves nothing), or the profile was stripped in transit. Re-export\n'
  printf '     as Adobe RGB and copy it over without touching it.\n'
fi

# A — strips the profile. What a naive `-strip` pipeline does, and the bug.
"$IM" "$SRC" -auto-orient -resize 2048x2048 -strip -quality 82 "$OUT/a-strip.jpg" 2>/dev/null
# B — keeps whatever profile came in. Right in colour-managed browsers, wrong in
#     anything that assumes sRGB.
"$IM" "$SRC" -auto-orient -resize 2048x2048 -quality 82 "$OUT/b-keep.jpg" 2>/dev/null
# C — converts to sRGB and keeps a profile. The candidate for production.
"$IM" "$SRC" -auto-orient -colorspace sRGB -resize 2048x2048 -quality 82 "$OUT/c-srgb.jpg" 2>/dev/null

printf '\nVARIANTS in %s\n' "$OUT"
for f in a-strip b-keep c-srgb; do
  [ -f "$OUT/$f.jpg" ] || { printf '  %-8s FAILED TO PRODUCE\n' "$f"; continue; }
  printf '  %-8s sat=%-20s size=%-7s icc=%s\n' \
    "$f" "$(sat "$OUT/$f.jpg")" \
    "$(ls -lh "$OUT/$f.jpg" | awk '{print $5}')" \
    "$(icc "$OUT/$f.jpg" || echo '(none)')"
done

cat <<'NOTE'

HOW TO READ THIS
  If the source has an Adobe RGB profile, a-strip's mean saturation should differ
  noticeably from c-srgb's. If all three are identical, the source was
  already sRGB and the test is inconclusive -- get a real Adobe RGB export.

  Then download them and LOOK:
      scp -r you@host:colour-check ./
  Open the original and c-srgb side by side. Reds and greens are where a
  botched conversion shows first.

  Expected outcome: c-srgb matches the original, a-strip looks flat or oddly
  shifted. If so, production uses the c-srgb command and we are done.
NOTE
