#!/usr/bin/env bash
# Deploy the site, with the cache-pin guarantee built in.
#
#   bash tools/deploy.sh [https://host-to-verify]
#
# Use this instead of a bare `wrangler deploy`. The three steps exist because a bare
# deploy silently shipped a changed admin/js/inbox.js while every browser kept loading
# the previous copy — the file was current, the HTML still pointed at the old ?v=.
#
#   0. check-js  refuse to deploy if a guarded JS file is empty/truncated
#   1. typecheck refuse to deploy on any NEW edge-function type error, and on any
#                undefined identifier at all. gdrive-sync shipped a call to an
#                unimported function; every borrower document stopped reaching
#                Drive for two and a half days and `deno check` would have caught
#                it in under a second.
#   2. --check   refuse to deploy while any pin disagrees with its asset's content
#                hash. Stale pins are a source change, so they belong in the commit,
#                not in a deploy-time mutation — hence check-and-stop, not auto-fix.
#   3. deploy
#   4. verify    fetch the LIVE html, read the pins it actually asks for, fetch the
#                asset at each pinned URL, and compare to what was shipped. Curl-ing
#                the asset path directly does NOT catch this class of bug.
#
# NOTE: this script deploys the SITE. Edge functions ship via
# `supabase functions deploy`, which does not pass through here — so run
# `node tools/check-functions.mjs` before that command too. The gate is only
# as good as the paths that call it.
#
# Exits non-zero at the first failure.
set -euo pipefail

HOST="${1:-https://admin.ratesandrealty.com}"
cd "$(dirname "$0")/.."

echo "── 1/5 file integrity ───────────────────────────────────"
# Before anything is hashed or shipped. stamp-assets happily mints a content
# hash for a truncated file and verify-deploy happily confirms the live page
# asks for exactly those bytes — both check CONSISTENCY, neither checks that
# the file is whole. This does.
if ! node tools/check-js.mjs --baseline; then
  echo
  echo "A guarded JS file is empty, truncated, or missing its tail. Nothing was deployed."
  exit 1
fi

echo
echo "── 2/5 edge function types ──────────────────────────────"
# Non-zero exit blocks the deploy, same as the pin check. Undefined identifiers
# are always fatal and cannot be baselined — they are ReferenceErrors the moment
# the line runs, which is exactly how the Drive mirror died silently.
if ! node tools/check-functions.mjs; then
  echo
  echo "Edge function type errors. Nothing was deployed."
  exit 1
fi

echo
echo "── 3/5 cache pins ───────────────────────────────────────"
if ! node tools/stamp-assets.mjs --check; then
  echo
  echo "Pins are stale. Fix and commit them, then re-run:"
  echo "    node tools/stamp-assets.mjs"
  echo "    git add -A && git commit -m 'Restamp asset cache pins'"
  exit 1
fi

echo
echo "── 4/5 wrangler deploy ──────────────────────────────────"
npx wrangler deploy

echo
echo "── 5/5 verify live ──────────────────────────────────────"
node tools/verify-deploy.mjs "$HOST"
