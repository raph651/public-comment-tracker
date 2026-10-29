#!/usr/bin/env bash
#
# Push the tracker's API keys to GitHub Actions secrets without ever printing
# or echoing them.
#
#   1. Put the keys in a file OUTSIDE the repo (see README "API keys"):
#        mkdir -p ~/.config/uscis-tracker
#        cat > ~/.config/uscis-tracker/keys.env <<'EOF'
#        REGULATIONS_API_KEY=...
#        GEMINI_API_KEY=...
#        EOF
#        chmod 600 ~/.config/uscis-tracker/keys.env
#
#   2. ./scripts/set-secrets.sh --dry-run    # check what would happen
#      ./scripts/set-secrets.sh              # actually set the secrets
#
# Values are piped to `gh secret set` on stdin, so they never appear in argv,
# shell history, or this script's output. GitHub stores them write-only: nobody
# (including this tooling) can read them back afterwards.

set -euo pipefail

DRY_RUN=0
KEY_FILE="${HOME}/.config/uscis-tracker/keys.env"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) KEY_FILE="$1"; shift ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${REPO:-}"
if [ -z "$REPO" ]; then
  REPO="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null | sed -E 's#^.*github\.com[:/]##; s#\.git$##' || true)"
fi

if [ ! -f "$KEY_FILE" ]; then
  echo "error: no key file at $KEY_FILE" >&2
  echo "Create it first — see the README section \"API keys\"." >&2
  exit 1
fi

# Never let a key file live inside the repository, where it could be committed.
KEY_DIR="$(cd "$(dirname "$KEY_FILE")" && pwd)"
case "$KEY_DIR/" in
  "$REPO_ROOT"/*)
    echo "error: refusing to read a key file inside the repository ($KEY_FILE)." >&2
    echo "Move it outside the repo, e.g. ~/.config/uscis-tracker/keys.env" >&2
    exit 1
    ;;
esac

if [ ! -s "$KEY_FILE" ]; then
  echo "error: $KEY_FILE is empty" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$KEY_FILE"
set +a

missing=0
for name in REGULATIONS_API_KEY GEMINI_API_KEY; do
  if [ -z "${!name:-}" ]; then
    echo "missing: $name is unset or empty in $KEY_FILE" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

echo "repo:     ${REPO:-<unresolved>}"
echo "key file: $KEY_FILE"
echo

for name in REGULATIONS_API_KEY GEMINI_API_KEY; do
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would set $name (${#name} char name, value redacted)"
    continue
  fi
  if [ -z "${REPO:-}" ]; then
    echo "error: could not resolve the GitHub repo; set REPO=owner/name" >&2
    exit 1
  fi
  printf '%s' "${!name}" | gh secret set "$name" --repo "$REPO" >/dev/null
  echo "set $name"
done

echo
if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry run only — nothing was written."
else
  gh secret list --repo "$REPO"
fi
