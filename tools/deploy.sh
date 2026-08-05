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
#   0b test-composer  refuse to deploy if the composer's sanitizer behaviour moved
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

echo "── 1/6 file integrity ───────────────────────────────────"
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
echo "── 2/6 composer behaviour ───────────────────────────────"
# The sanitizer is the one place in this repo where a silent divergence is a
# security bug rather than drift. check-js proves inbox.js arrived whole; this
# proves it still does what it did. Mutation-tested: disabling the style hook,
# widening ALLOWED_TAGS, dropping the table attrs, or making sanitize degrade
# instead of throwing each fail at least one assertion.
if ! node tools/test-composer.mjs; then
  echo
  echo "Composer behaviour changed. Nothing was deployed."
  exit 1
fi

echo
echo "── 3/6 edge function types ──────────────────────────────"
# Non-zero exit blocks the deploy, same as the pin check. Undefined identifiers
# are always fatal and cannot be baselined — they are ReferenceErrors the moment
# the line runs, which is exactly how the Drive mirror died silently.
if ! node tools/check-functions.mjs; then
  echo
  echo "Edge function type errors. Nothing was deployed."
  exit 1
fi

echo
echo "── 4/6 cache pins ───────────────────────────────────────"
if ! node tools/stamp-assets.mjs --check; then
  echo
  echo "Pins are stale. Fix and commit them, then re-run:"
  echo "    node tools/stamp-assets.mjs"
  echo "    git add -A && git commit -m 'Restamp asset cache pins'"
  exit 1
fi

echo
echo "── 5/6 wrangler deploy ──────────────────────────────────"
npx wrangler deploy

echo
echo "── 6/6 verify live ──────────────────────────────────────"
node tools/verify-deploy.mjs "$HOST"

# ── observation, not a gate ──────────────────────────────────
# Postgres functions have no drift check. This records what the function layer
# looked like at each deploy, into a gitignored scratch dir, so a week of real
# use tells us how noisy a diff would be before anything is gated on it.
#
# Deliberately LAST, deliberately non-blocking: it runs only after the deploy
# has already succeeded, and `|| true` means a network hiccup here can never
# fail a deploy that worked. It is also why this is durable — it rides on real
# activity rather than a scheduler that dies with a session.
node tools/observe-db-functions.mjs 2>/dev/null | grep -E '^\[observe\]' || true
