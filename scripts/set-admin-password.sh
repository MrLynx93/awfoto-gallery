#!/bin/sh
#
# Changes the panel password, in place, on the server.
#
#   cd ~/domains/galeria.aw-foto.pl/public_nodejs
#   sh scripts/set-admin-password.sh
#   devil www restart galeria.aw-foto.pl
#
# The stored value is a scrypt hash, so a forgotten password cannot be read back
# out of .env -- it can only be replaced. That is the point of hashing it, and
# also why this script exists.

set -u

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"

die() { printf '\n  %s\n\n' "$1" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "No .env at $ENV_FILE — run scripts/setup-env.sh first."

printf '\n  Nowe hasło do panelu.\n'
printf '  Zostaw puste, żeby wygenerować mocne hasło.\n\n'
printf '  Hasło (nie będzie widoczne): '
stty -echo 2>/dev/null
read -r NEW_PASSWORD
stty echo 2>/dev/null
printf '\n'

if [ -n "$NEW_PASSWORD" ]; then
  HASH_OUTPUT=$(node "$APP_DIR/scripts/admin-password.mjs" "$NEW_PASSWORD")
else
  HASH_OUTPUT=$(node "$APP_DIR/scripts/admin-password.mjs")
fi

HASH=$(printf '%s\n' "$HASH_OUTPUT" | sed -n 's/^ADMIN_PASSWORD_HASH=//p')
[ -n "$HASH" ] || die "Could not generate the hash."

# Rewritten through a temporary file and moved into place, so an interrupted
# run cannot leave a half-written .env that stops the app from starting.
TMP="$ENV_FILE.new.$$"
umask 077
if grep -q '^ADMIN_PASSWORD_HASH=' "$ENV_FILE"; then
  # awk rather than sed -i: the hash contains / and $, which would need escaping
  # in a sed replacement, and BSD sed differs from GNU sed on -i anyway.
  awk -v hash="$HASH" '
    /^ADMIN_PASSWORD_HASH=/ { print "ADMIN_PASSWORD_HASH=" hash; next }
    { print }
  ' "$ENV_FILE" > "$TMP"
else
  cp "$ENV_FILE" "$TMP"
  printf 'ADMIN_PASSWORD_HASH=%s\n' "$HASH" >> "$TMP"
fi

# Refuse to install a file that lost the other settings.
if [ "$(grep -c '=' "$TMP")" -lt "$(grep -c '=' "$ENV_FILE")" ]; then
  rm -f "$TMP"
  die "Refusing to write: the new .env has fewer settings than the old one."
fi

mv "$TMP" "$ENV_FILE"
chmod 600 "$ENV_FILE"

printf '  Zapisano nowe hasło w %s\n' "$ENV_FILE"
printf '%s\n' "$HASH_OUTPUT" | sed -n '/^Hasło/,$p' | sed 's/^/  /'
printf '\n  Zrestartuj aplikację, żeby zaczęło działać:\n\n      devil www restart %s\n\n' \
  "$(basename "$(dirname "$APP_DIR")")"
