#!/bin/sh
#
# Writes the server's .env, on the server.
#
#   cd ~/domains/galeria.aw-foto.pl/public_nodejs
#   sh scripts/setup-env.sh
#
# Reads the database name and user out of `devil mysql list` rather than asking
# you to remember them. That is the point: mydevil prefixes both with the
# account login, so a .env written from what you *asked* for -- `galeria` --
# silently fails against what it *created* -- `m1234_galeria`. Every value is
# shown for confirmation before anything is written.
#
# Passwords are read without echo and never appear in shell history.
# The file is written with umask 077 and ends up mode 600.

set -u

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
FORCE="${1:-}"

die() { printf '\n  %s\n\n' "$1" >&2; exit 1; }

[ -f "$APP_DIR/app.js" ] || die "Run this from the app directory (no app.js next to $APP_DIR)."

if [ -f "$ENV_FILE" ] && [ "$FORCE" != "--force" ]; then
  die ".env already exists. Back it up and re-run with --force to replace it."
fi

command -v node >/dev/null 2>&1 || die "node is not on PATH here."

printf '\n=== Baza danych ===\n\n'

if command -v devil >/dev/null 2>&1; then
  devil mysql list 2>/dev/null | sed 's/^/  /'
else
  printf '  (devil not found -- fill these in by hand)\n'
fi

# Offer the first database row as the default. The listing is a table with
# Polish headers and blank lines, so anything that is not a header or a notice
# and has at least two columns is a candidate.
DEFAULT_DB=$(devil mysql list 2>/dev/null \
  | awk 'NF >= 2 && $1 !~ /^(Lista|Nazwa|Uwaga|Login|Użytkownicy)/ { print $1; exit }')

printf '\n'
printf '  Nazwa bazy [%s]: ' "${DEFAULT_DB:-}"
read -r DB_NAME
[ -n "$DB_NAME" ] || DB_NAME="$DEFAULT_DB"
[ -n "$DB_NAME" ] || die "Database name is required."

printf '  Użytkownik  [%s]: ' "$DB_NAME"
read -r DB_USER
[ -n "$DB_USER" ] || DB_USER="$DB_NAME"

# stty rather than `read -s`: this is /bin/sh on FreeBSD, not bash.
printf '  Hasło do bazy (nie będzie widoczne): '
stty -echo 2>/dev/null
read -r DB_PASSWORD
stty echo 2>/dev/null
printf '\n'
[ -n "$DB_PASSWORD" ] || die "Database password is required."

printf '\n=== Hasło do panelu ===\n\n'
printf '  Zostaw puste, żeby wygenerować mocne hasło.\n'
printf '  Hasło (nie będzie widoczne): '
stty -echo 2>/dev/null
read -r ADMIN_PASSWORD
stty echo 2>/dev/null
printf '\n'

# The generator prints the password when it invents one, so it has to be shown.
if [ -n "$ADMIN_PASSWORD" ]; then
  HASH_OUTPUT=$(node "$APP_DIR/scripts/admin-password.mjs" "$ADMIN_PASSWORD")
else
  HASH_OUTPUT=$(node "$APP_DIR/scripts/admin-password.mjs")
fi

ADMIN_PASSWORD_HASH=$(printf '%s\n' "$HASH_OUTPUT" | sed -n 's/^ADMIN_PASSWORD_HASH=//p')
[ -n "$ADMIN_PASSWORD_HASH" ] || die "Could not generate the admin password hash."

# Signs the session cookie. Only has to be stable and unguessable.
if command -v openssl >/dev/null 2>&1; then
  SESSION_SECRET=$(openssl rand -hex 32)
else
  SESSION_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
fi

STORAGE_ROOT="$HOME/galeria-storage"
DOMAIN=$(basename "$(dirname "$APP_DIR")")

printf '\n=== Do zapisania ===\n\n'
printf '  DB_NAME              %s\n' "$DB_NAME"
printf '  DB_USER              %s\n' "$DB_USER"
printf '  DB_PASSWORD          (ukryte, %s znaków)\n' "$(printf '%s' "$DB_PASSWORD" | wc -c | tr -d ' ')"
printf '  SESSION_SECRET       (wygenerowane)\n'
printf '  ADMIN_PASSWORD_HASH  (wygenerowane)\n'
printf '  STORAGE_ROOT         %s\n' "$STORAGE_ROOT"
printf '  PUBLIC_BASE_URL      https://%s\n' "$DOMAIN"
printf '\n  Zapisać do %s? [t/N] ' "$ENV_FILE"
read -r CONFIRM
case "$CONFIRM" in
  t|T|y|Y|tak|TAK) ;;
  *) die "Anulowane. Nic nie zapisano." ;;
esac

# printf line by line, never a heredoc: a password containing $ or a backtick
# stays literal data rather than something the shell re-reads.
umask 077
{
  printf '# Wygenerowane przez scripts/setup-env.sh — %s\n' "$(date 2>/dev/null || echo '')"
  printf 'DB_HOST=localhost\n'
  printf 'DB_NAME=%s\n' "$DB_NAME"
  printf 'DB_USER=%s\n' "$DB_USER"
  printf 'DB_PASSWORD=%s\n' "$DB_PASSWORD"
  printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET"
  printf 'ADMIN_PASSWORD_HASH=%s\n' "$ADMIN_PASSWORD_HASH"
  printf 'DISK_BUDGET_GB=12\n'
  printf 'STORAGE_ROOT=%s\n' "$STORAGE_ROOT"
  printf 'PUBLIC_BASE_URL=https://%s\n' "$DOMAIN"
  printf 'LANG=pl_PL.UTF-8\n'
  printf 'NODE_ENV=production\n'
} > "$ENV_FILE"

chmod 600 "$ENV_FILE"
mkdir -p "$STORAGE_ROOT"

printf '\n  Zapisano %s (mode 600).\n' "$ENV_FILE"
printf '  Katalog na zdjęcia: %s\n' "$STORAGE_ROOT"

# Only meaningful when the generator invented one; otherwise it prints nothing.
printf '%s\n' "$HASH_OUTPUT" | sed -n '/^Hasło/,$p' | sed 's/^/  /'

printf '\n  Teraz zrestartuj aplikację:\n\n      devil www restart %s\n\n' "$DOMAIN"
