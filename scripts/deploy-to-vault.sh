#!/usr/bin/env bash
# Build the plugin and install it into a local Obsidian vault for manual testing.
#
# Usage:
#   scripts/deploy-to-vault.sh              # build + deploy to VAULT_PATH
#   scripts/deploy-to-vault.sh --no-build    # skip the build, just copy existing main.js
#   VAULT_PATH=/path/to/other/vault scripts/deploy-to-vault.sh
#
# VAULT_PATH is read from (in priority order): an already-exported env var,
# then a .env file in the repo root (see .env.example). Copy .env.example to
# .env and set your own vault path there - .env is gitignored.
#
# After running, reload the plugin in Obsidian:
#   Settings -> Community plugins -> toggle "Yet Another Memos Sync" off, then on.
# (Obsidian does not hot-reload plugin JS, so this step is required every time.)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PLUGIN_ID="$(python3 -c "import json; print(json.load(open('manifest.json'))['id'])")"

if [[ -z "${VAULT_PATH:-}" ]]; then
  echo "Error: VAULT_PATH is not set. Either export it, or copy .env.example to .env and set it there." >&2
  exit 1
fi

PLUGIN_DEST="$VAULT_PATH/.obsidian/plugins/$PLUGIN_ID"

DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$VAULT_PATH/.obsidian" ]]; then
  echo "Error: $VAULT_PATH doesn't look like an Obsidian vault (.obsidian not found)." >&2
  exit 1
fi

if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "Building..."
  npm run build
fi

for f in main.js manifest.json; do
  if [[ ! -f "$f" ]]; then
    echo "Error: $f not found in $REPO_DIR - run without --no-build first." >&2
    exit 1
  fi
done

mkdir -p "$PLUGIN_DEST"
cp main.js manifest.json "$PLUGIN_DEST/"
if [[ -f styles.css ]]; then
  cp styles.css "$PLUGIN_DEST/"
fi

echo "Deployed to: $PLUGIN_DEST"
echo "Now reload the plugin in Obsidian (Settings -> Community plugins -> toggle it off/on)."
