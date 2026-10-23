#!/usr/bin/env bash
# Upload the sample 「雲朵科技」 documents to the default KB workspace and trigger an AI Search sync.
# Usage: scripts/seed-kb/upload.sh [name.md ...]   (default: every *.md in this directory)
# Needs wrangler to be logged in to the Neo-Cloudflare account, and CF_API_TOKEN in .dev.vars (or the environment).
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
ACCOUNT_ID="5efa272dc28e4e3933324c44165b6dbe"
BUCKET="cf-demo-kb"
INSTANCE="cf-demo-kb"

# Resolve the API token first so a missing token fails before anything is uploaded.
TOKEN="${CF_API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$ROOT/.dev.vars" ]; then
  TOKEN="$(grep -E '^CF_API_TOKEN=' "$ROOT/.dev.vars" | head -1 | cut -d= -f2- | tr -d '"' || true)"
fi
if [ -z "$TOKEN" ]; then
  echo "error: CF_API_TOKEN is not set (export it or add it to $ROOT/.dev.vars); nothing was uploaded." >&2
  exit 1
fi

FILES=()
if [ "$#" -gt 0 ]; then
  for name in "$@"; do
    case "$name" in
      */* | *..*) echo "error: invalid file name '$name' (no '/' or '..' allowed)" >&2; exit 1 ;;
    esac
    [ -f "$DIR/$name" ] || { echo "error: $DIR/$name does not exist" >&2; exit 1; }
    FILES+=("$name")
  done
else
  for f in "$DIR"/*.md; do
    [ -e "$f" ] || { echo "error: no *.md files in $DIR" >&2; exit 1; }
    FILES+=("$(basename "$f")")
  done
fi

for name in "${FILES[@]}"; do
  echo "uploading default/$name"
  (cd "$ROOT" && npx wrangler r2 object put "$BUCKET/default/$name" --file "$DIR/$name" --content-type text/markdown --remote)
done

echo "triggering AI Search sync"
# The bearer token goes in through a curl config on stdin, so it never shows up in the process list.
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -fsS --config - \
  -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai-search/instances/$INSTANCE/jobs" \
  -H "Content-Type: application/json" -d '{}'
echo
