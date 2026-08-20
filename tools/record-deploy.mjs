#!/usr/bin/env node
/**
 * record-deploy — stamp `system_state:deploy:last_success` after a verified deploy.
 *
 * WHY THIS EXISTS
 * On 2026-08-20 it emerged that `stamp-assets --check` had been FAILING on the
 * committed tree since 2026-08-15. Both gates were in the path and both worked —
 * wrangler.toml's [build] hook and deploy.sh step 4/6 — so every deploy attempt
 * aborted exactly as designed. The consequence was that **52 commits of site
 * changes sat undeployed for five days and nothing said so**.
 *
 * A gate that refuses is only as loud as the person running it. Nobody ran a
 * deploy, so nobody heard the refusal. What was missing was not a stricter gate
 * but a WATCHER — and a watcher needs something to watch.
 *
 * This is that something: the deploy's own heartbeat. It records that a deploy
 * COMPLETED AND VERIFIED, with the commit it shipped, so `deploy_watch_run()`
 * can alert on the age of the marker rather than on anything it would have to
 * infer from the outside.
 *
 * Written LAST and NON-BLOCKING, the same discipline as observe-db-functions
 * below it in deploy.sh: it runs only after verify-deploy has already passed, and
 * a failure here can never fail a deploy that worked. A missing heartbeat makes
 * the watcher noisier, never a deploy break.
 *
 * IT ONLY KNOWS ABOUT DEPLOYS THAT GO THROUGH deploy.sh. A bare `wrangler deploy`
 * leaves the marker stale and the watcher will eventually say so — which is the
 * right direction, because a bare deploy is already the thing CLAUDE.md tells you
 * not to do. The false alarm is the nudge.
 */
import { execFileSync } from 'node:child_process';

const REF = 'ljywhvbmsibwnssxpesh';
/* Same pin, same reason as recapture-db-functions: `projects api-keys` is broken
 * in 2.112.0 and works in 2.111.0. Do not "upgrade" it. */
const SUPABASE_CLI = 'supabase@2.111.0';

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true }).trim();
  } catch { return ''; }
}

function serviceKey() {
  const out = sh('npx', ['-y', SUPABASE_CLI, 'projects', 'api-keys', '--project-ref', REF, '--output', 'json']);
  if (!out) throw new Error('could not read project API keys');
  const k = JSON.parse(out).find((r) => r.name === 'service_role');
  if (!k) throw new Error('service_role key not returned by the CLI');
  return k.api_key;
}

async function main() {
  const key = serviceKey();
  const payload = {
    at: new Date().toISOString(),
    commit: sh('git', ['rev-parse', '--short', 'HEAD']) || null,
    branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || null,
    subject: sh('git', ['log', '-1', '--format=%s']) || null,
    host: process.argv[2] || null,
    /* Recorded so a later reader can tell a deploy of a clean tree from one that
       shipped uncommitted edits — the second is legitimate but worth seeing. */
    dirty: sh('git', ['status', '--porcelain']) ? true : false,
  };

  const r = await fetch(`https://${REF}.supabase.co/rest/v1/system_state`, {
    method: 'POST',
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ key: 'deploy:last_success', value: payload, updated_at: payload.at }),
  });
  if (!r.ok) throw new Error(`system_state write returned HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  console.log(`[deploy-heartbeat] recorded ${payload.commit || '(no commit)'}${payload.dirty ? ' (working tree dirty)' : ''}`);
}

/* process.exitCode, never process.exit(): on Windows an exit with sockets still
 * open aborts teardown and REPLACES the code with 0. Recorded in CLAUDE.md. */
main().catch((e) => { console.error('[deploy-heartbeat]', e.message); process.exitCode = 1; });
