#!/usr/bin/env bash
# Deploy the site, with the cache-pin guarantee built in.
#
#   bash tools/deploy.sh [https://host-to-verify]
#
# Use this instead of a bare `wrangler deploy`. The three steps exist because a bare
# deploy silently shipped a changed admin/js/inbox.js while every browser kept loading
# the previous copy — the file was current, the HTML still pointed at the old ?v=.
#
#   1. --check   refuse to deploy while any pin disagrees with its asset's content
#                hash. Stale pins are a source change, so they belong in the commit,
#                not in a deploy-time mutation — hence check-and-stop, not auto-fix.
#   2. deploy
#   3. verify    fetch the LIVE html, read the pins it actually asks for, fetch the
#                asset at each pinned URL, and compare to what was shipped. Curl-ing
#                the asset path directly does NOT catch this class of bug.
#
# Exits non-zero at the first failure.
set -euo pipefail

HOST="${1:-https://admin.ratesandrealty.com}"
cd "$(dirname "$0")/.."

echo "── 1/3 cache pins ───────────────────────────────────────"
if ! node tools/stamp-assets.mjs --check; then
  echo
  echo "Pins are stale. Fix and commit them, then re-run:"
  echo "    node tools/stamp-assets.mjs"
  echo "    git add -A && git commit -m 'Restamp asset cache pins'"
  exit 1
fi

echo
echo "── 2/3 wrangler deploy ──────────────────────────────────"
npx wrangler deploy

echo
echo "── 3/3 verify live ──────────────────────────────────────"
node tools/verify-deploy.mjs "$HOST"
