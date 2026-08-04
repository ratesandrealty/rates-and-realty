#!/usr/bin/env bash
# Deploy ONE edge function, with the checks deploy.sh has for the site.
#
#   bash tools/deploy-function.sh <slug>
#
# Use this instead of a bare `supabase functions deploy`. deploy.sh gates the
# SITE; edge functions ship through the Supabase CLI, which passes through none
# of it. That gap is not theoretical — both of the following happened:
#
#   * gdrive-sync v82 shipped calling an unimported function. Every borrower
#     document stopped reaching Drive for two and a half days. `deno check`
#     finds it in under a second and nothing was running it.  -> step 1
#   * the repo copy of email-service was 85 days behind production. A deploy
#     from this checkout would have silently rolled back link tracking, bulk
#     send and the action alias table, and reported success.  -> step 2
#   * a routine `supabase functions deploy --no-verify-jwt` flipped sms-service
#     to false, leaving an open SMS relay on the business line. Deploying an
#     UNPINNED function flips it the other way: send-scheduled-sms went to
#     verify_jwt=true and every cron run returned UNAUTHORIZED for days, with
#     nothing alerting.                                        -> steps 3 and 5
#
#   1. types    no NEW edge-function type error, no undefined identifier
#   2. drift    refuse if production holds source this repo has never committed
#   3. pin      refuse if the slug is not pinned in supabase/config.toml
#   4. deploy   config.toml decides verify_jwt. NEVER pass --no-verify-jwt.
#   5. assert   re-read what is actually live: the deployed source is now the
#               repo's, and verify_jwt matches the pin. Checking that the deploy
#               command exited 0 is not the same as looking at what it left.
#
# Exits non-zero at the first failure.
set -euo pipefail

PROJECT_REF=ljywhvbmsibwnssxpesh
cd "$(dirname "$0")/.."

SLUG="${1:-}"
if [ -z "$SLUG" ]; then
  echo "usage: bash tools/deploy-function.sh <slug>"
  echo
  echo "One slug, deliberately. A bare \`supabase functions deploy\` with no name"
  echo "deploys EVERY function in supabase/functions — 128 of them — rewriting"
  echo "verify_jwt on all the unpinned ones in a single command."
  exit 2
fi

if [ ! -f "supabase/functions/$SLUG/index.ts" ]; then
  echo "No such function in this repo: supabase/functions/$SLUG/index.ts"
  exit 1
fi

echo "── 1/5 edge function types ──────────────────────────────"
if ! node tools/check-functions.mjs; then
  echo; echo "Edge function type errors. Nothing was deployed."; exit 1
fi

echo
echo "── 2/5 production drift ─────────────────────────────────"
if ! node tools/check-function-drift.mjs "$SLUG"; then
  echo; echo "Deploying would destroy source this repo has no record of. Nothing was deployed."; exit 1
fi

echo
echo "── 3/5 verify_jwt pin ───────────────────────────────────"
# The CLI defaults an unpinned function to verify_jwt=true. For anything with an
# unauthenticated caller — a Twilio webhook, a cron post, a borrower page — that
# is a silent outage. Pin the CURRENT value if you do not want to change it;
# supabase/config.toml is where that intent is recorded.
if ! grep -q "^\[functions\.$SLUG\]" supabase/config.toml; then
  cat <<EOF

$SLUG is not pinned in supabase/config.toml.

Deploying it would set verify_jwt from the CLI default (true), not from any
recorded intent. If that is wrong for this function, every unauthenticated
caller starts getting 401 and nothing will alert you.

Add a block first — at its CURRENT value if you are not trying to change it:

    [functions.$SLUG]
    # why this value
    verify_jwt = $(node -e "
      const {execFileSync}=require('node:child_process');
      const l=JSON.parse(execFileSync('supabase',['functions','list','--project-ref','$PROJECT_REF','-o','json'],{encoding:'utf8',maxBuffer:1<<26}));
      const f=l.find(x=>x.slug==='$SLUG');
      // A slug with nothing deployed has no current value to preserve. Say so
      // rather than printing the CLI default as though it were an observation —
      // an unpinned new function silently taking that default is the same bug
      // this block exists to prevent.
      process.stdout.write(f?String(f.verify_jwt)+'   # what is live right now'
                            :'true|false   # NEW: nothing is live, so this is a decision, not a default');
    " 2>/dev/null || echo "<current value>")
EOF
  exit 1
fi
PINNED=$(awk -v s="[functions.$SLUG]" '$0==s{f=1;next} f&&/^verify_jwt/{print $3; exit} f&&/^\[/{exit}' supabase/config.toml)
echo "  config.toml pins verify_jwt = $PINNED"

echo
echo "── 4/5 deploy ───────────────────────────────────────────"
# No --no-verify-jwt. That flag overrides config.toml from the command line,
# which is how the pin gets bypassed by whoever last copy-pasted the command.
supabase functions deploy "$SLUG" --project-ref "$PROJECT_REF"

echo
echo "── 5/5 verify live ──────────────────────────────────────"
LIVE=$(node -e "
  const {execFileSync}=require('node:child_process');
  const l=JSON.parse(execFileSync('supabase',['functions','list','--project-ref','$PROJECT_REF','-o','json'],{encoding:'utf8',maxBuffer:1<<26}));
  const f=l.find(x=>x.slug==='$SLUG');
  process.stdout.write(f?String(f.verify_jwt):'MISSING');
")
if [ "$LIVE" != "$PINNED" ]; then
  echo "  verify_jwt is $LIVE live but config.toml pins $PINNED."
  echo "  The deploy changed the gateway contract. Fix before walking away."
  exit 1
fi
echo "  verify_jwt live = $LIVE, matches the pin"

if ! node tools/check-function-drift.mjs "$SLUG"; then
  echo; echo "Deployed source does not match the repo AFTER deploying. Investigate."; exit 1
fi
echo
echo "OK: $SLUG is live, its source matches this repo, and verify_jwt matches its pin."
