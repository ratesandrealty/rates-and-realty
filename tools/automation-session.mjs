#!/usr/bin/env node
/* Mint an access token for the automation account, unattended.
 *
 *   node tools/automation-session.mjs              # print a fresh access token
 *   node tools/automation-session.mjs --out tok.txt
 *   node tools/automation-session.mjs --whoami     # token + decoded claims + role
 *
 * WHY THIS EXISTS
 * Three sessions in a row stalled on a hand-pasted access token that expires in
 * 60 minutes. This opens a session the tooling OWNS.
 *
 * IT MUST NEVER TOUCH RENE'S SESSION, and that is not a style preference.
 * Refresh tokens rotate here: measured on session 40e08e70, 54 issued, 53
 * revoked, exactly 1 live at any instant. Two holders of one refresh token means
 * whoever refreshes second presents a revoked one, GoTrue's reuse detection
 * kills the family, and the browser is bounced to login. That surfaces as "the
 * app logs me out when I reload" -- a symptom this project already has a written
 * history for, from an unrelated cause, so it would be misdiagnosed. Hence: a
 * separate account, a separate session, a separate refresh chain.
 *
 * THE PASSWORD IS NEVER IN THIS REPO, IN A SHELL HISTORY, OR IN A TRANSCRIPT.
 * It lives in a DPAPI-encrypted PSCredential, decryptable only by this Windows
 * user on this machine. This script shells out to PowerShell to read it and
 * never writes it anywhere.
 *
 * Falls back password -> refresh only when it has to: a rotated refresh token is
 * used when present, and the password is the recovery path when that chain is
 * broken or absent.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const URL_  = 'https://ljywhvbmsibwnssxpesh.supabase.co';
/* Public, and printed in every page's source. Not a secret; it only identifies
   the project. verify_jwt = true accepts it, which is why it is not access
   control -- see CLAUDE.md. */
const ANON  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqeXdodmJtc2lid25zc3hwZXNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNjE2NTUsImV4cCI6MjA4OTYzNzY1NX0.QaewUhTWdATj35VewvmfQcHB_b3I9FhhwXSRuqNBKvw';

const STORE   = join(homedir(), '.rr-automation');
const CRED    = join(STORE, 'automation.cred.xml');   // DPAPI PSCredential
const REFRESH = join(STORE, 'refresh.token');          // rotated, plaintext-in-userprofile

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const whoami = args.includes('--whoami');

function die(msg, code = 2) { console.error(msg); process.exit(code); }

/* ── credential, via DPAPI ────────────────────────────────────────────────── */
function readCredential() {
  if (!existsSync(CRED)) {
    die(`No stored credential at ${CRED}\n\n` +
        `Create it once, in a PowerShell running as this Windows user:\n\n` +
        `  New-Item -ItemType Directory -Force "${STORE}" | Out-Null\n` +
        `  Get-Credential -UserName "automation@ratesandrealty.com" -Message "RR automation account" |\n` +
        `    Export-Clixml "${CRED}"\n\n` +
        `Export-Clixml encrypts the password with DPAPI: only this Windows\n` +
        `account on this machine can read it back. Nothing else can.`);
  }
  /* -NoProfile so a user profile cannot inject anything into the read path. */
  const ps = `$c = Import-Clixml '${CRED}';` +
             `$p = [Runtime.InteropServices.Marshal]::PtrToStringAuto(` +
             `[Runtime.InteropServices.Marshal]::SecureStringToBSTR($c.Password));` +
             `[Console]::Out.Write($c.UserName + "\`n" + $p)`;
  let out;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
                       { encoding: 'utf8', windowsHide: true });
  } catch (e) {
    die(`Could not decrypt ${CRED}.\nDPAPI refuses if the file was created by a different\n` +
        `Windows user or copied from another machine. Re-create it here.\n${e.message}`);
  }
  const nl = out.indexOf('\n');
  if (nl < 0) die('Unexpected credential format from PowerShell.');
  return { email: out.slice(0, nl).trim(), password: out.slice(nl + 1) };
}

/* ── GoTrue ───────────────────────────────────────────────────────────────── */
async function token(grant, body) {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

async function getSession() {
  /* Prefer the chain we already own; only fall back to the password. */
  if (existsSync(REFRESH)) {
    const rt = readFileSync(REFRESH, 'utf8').trim();
    if (rt) {
      const r = await token('refresh_token', { refresh_token: rt });
      if (r.ok && r.json.access_token) return { ...r.json, how: 'refresh' };
      console.error(`refresh failed (${r.status}: ${r.json.error_description || r.json.msg || 'unknown'}) — falling back to password`);
    }
  }
  const { email, password } = readCredential();
  const r = await token('password', { email, password });
  if (!r.ok || !r.json.access_token) {
    die(`Sign-in failed (${r.status}): ${r.json.error_description || r.json.msg || JSON.stringify(r.json)}`);
  }
  return { ...r.json, how: 'password' };
}

const s = await getSession();

/* Persist the ROTATED refresh token immediately. Losing it costs only a
   password sign-in, but keeping a stale one guarantees a wasted round trip. */
if (s.refresh_token) {
  mkdirSync(STORE, { recursive: true });
  writeFileSync(REFRESH, s.refresh_token, 'utf8');
}

const claims = JSON.parse(Buffer.from(s.access_token.split('.')[1], 'base64').toString());
const minsLeft = Math.round((claims.exp * 1000 - Date.now()) / 60000);

if (outFile) {
  writeFileSync(outFile, s.access_token, 'utf8');
  console.error(`wrote ${outFile} — ${claims.email}, ${minsLeft} min left, via ${s.how}`);
} else if (!whoami) {
  process.stdout.write(s.access_token);
}

if (whoami) {
  const res = await fetch(`${URL_}/rest/v1/rpc/current_app_role`, {
    method: 'POST',
    headers: { apikey: ANON, authorization: `Bearer ${s.access_token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const role = await res.text();
  console.log(JSON.stringify({
    via: s.how, email: claims.email, sub: claims.sub,
    session_id: claims.session_id, minutes_left: minsLeft,
    current_app_role: role.replace(/"/g, ''),
    refresh_token_stored: existsSync(REFRESH),
  }, null, 1));
}
