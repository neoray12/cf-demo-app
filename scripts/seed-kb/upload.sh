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

if [ "$#" -gt 0 ]; then FILES=("$@"); else FILES=($(cd "$DIR" && ls *.md)); fi

for name in "${FILES[@]}"; do
  echo "uploading default/$name"
  (cd "$ROOT" && npx wrangler r2 object put "$BUCKET/default/$name" --file "$DIR/$name" --content-type text/markdown --remote)
done

TOKEN="${CF_API_TOKEN:-$(grep -E '^CF_API_TOKEN=' "$ROOT/.dev.vars" | head -1 | cut -d= -f2- | tr -d '"')}"
echo "triggering AI Search sync"
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai-search/instances/$INSTANCE/jobs" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
echo
