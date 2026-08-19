#!/usr/bin/env node
/* Does a generated 1003 tick the RIGHT loan-purpose box?
 *
 *   node tools/prove-1003-purpose.mjs
 *
 * WHY THIS EXISTS RATHER THAN A CODE REVIEW OF THE MAPPING.
 * The bug being fixed was invisible in review for months: generate-1003
 * compared `v(d.loan_purpose,'Purchase') === 'Purchase'` case-sensitively while
 * the CRM writes lowercase, so a real purchase ticked NEITHER box, and a blank
 * purpose defaulted to Purchase and ticked one nobody had chosen. Both faults
 * live in a rendered document, so the assertion has to be made against a
 * rendered document.
 *
 * ONE generator now, not two. This suite used to cover `generate-1003` as well,
 * reading X positions out of inflated PDF content streams. That function was
 * UNDEPLOYED AND DELETED on 2026-08-19: it had held no caller since 2026-04-13,
 * when 0d1b06c repointed lead-detail at generate-1003-pdf, and it carried both
 * of the loan-purpose defects above uncorrected. Its half of this file went with
 * it rather than being left to rot green against a 404 -- see the note on three
 * outcomes below, which is exactly what an unreachable function would have hit.
 *
 *   generate-1003-pdf  -> an HTML form whose boxes are ticked by embedded
 *                         BROWSER javascript at render time. The served HTML
 *                         always contains empty boxes, so reading the response
 *                         body proves nothing about what the form shows. It is
 *                         loaded in headless Chromium and the glyph is read off
 *                         the live DOM: U+2611 ticked, U+2610 empty.
 *
 * Exit 1 = a document ticked the wrong thing. Exit 2 = the harness could not
 * run (no token, no browser, function unreachable) -- NEVER conflated with a
 * pass, because "could not check" is not "correct".
 * process.exitCode, never process.exit(): on Windows an exit with sockets open
 * aborts teardown and the crash REPLACES the code with 0, so a run that found a
 * wrong box would report success.
 */
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PROJECT = 'ljywhvbmsibwnssxpesh';
const BASE = `https://${PROJECT}.supabase.co/functions/v1`;

const CHROME_CANDIDATES = [
  'C:\\Users\\rened\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const ok = (b) => (b ? 'ticked' : 'empty');
let failures = 0, ran = 0, unrunnable = 0;

function die(msg) {
  console.error(`\nREFUSED TO RUN: ${msg}`);
  process.exitCode = 2;
}
/* ── the browser extractor ────────────────────────────────────────────────── */
function chromePath() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  return null;
}

async function readHtmlBoxes(html, tag) {
  const exe = chromePath();
  if (!exe) return { harness_ok: false, why: 'no chromium binary found' };
  const dir = join(tmpdir(), `rr-1003-${tag}-${Math.abs(hashCode(tag))}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'form.html');
  writeFileSync(file, html, 'utf8');
  const port = 9500 + (Math.abs(hashCode(tag)) % 300);
  const proc = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${port}`, '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${join(dir, 'profile')}`,
    '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    const ws = await waitForWs(port);
    const res = await cdpEval(ws, `file:///${file.replace(/\\/g, '/')}`);
    return res;
  } catch (e) {
    return { harness_ok: false, why: String(e.message || e) };
  } finally {
    try { proc.kill(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function hashCode(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

async function waitForWs(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('chromium never opened its debugging port');
}

async function cdpEval(wsUrl, fileUrl) {
  const { WebSocket } = await import('node:worker_threads').then(() => ({ WebSocket: globalThis.WebSocket }));
  if (!WebSocket) throw new Error('no WebSocket in this node');
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp connect failed')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
  });
  const { result: t } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: a } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const sid = a.sessionId;
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Page.navigate', { url: fileUrl }, sid);
  await new Promise((r) => setTimeout(r, 2500));
  const expr = `(function(){
    var g = function(id){ var e=document.getElementById(id); return e ? e.textContent.trim() : null; };
    return JSON.stringify({
      purchase:  g('cb-purchase'),
      refinance: g('cb-refinance'),
      other:     g('cb-purpose-other'),
      found: !!document.getElementById('cb-purchase')
    });
  })()`;
  const { result: r } = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
  ws.close();
  const v = r && r.result && r.result.value ? JSON.parse(r.result.value) : null;
  if (!v || !v.found) return { harness_ok: false, why: 'checkbox spans not present in the rendered form' };
  const TICK = '\u2611';
  return { harness_ok: true, purchase: v.purchase === TICK, refinance: v.refinance === TICK, other: v.other === TICK };
}

/* ── the runs ─────────────────────────────────────────────────────────────── */
/* BREAK TEST. RR_BREAK_TEST=1 inverts every expectation, so a run that is
   really reading the documents must report all of them WRONG. Without it this
   suite has only ever passed — and a comparator stuck on true, or an extractor
   that always answers "empty" for boxes it never located, would look identical
   to a correct one. */
const BREAK = process.env.RR_BREAK_TEST === '1';

function expect(name, got, want) {
  if (BREAK) want = { purchase: !want.purchase, refinance: !want.refinance };
  ran++;
  const good = got.purchase === want.purchase && got.refinance === want.refinance;
  if (!good) failures++;
  console.log(`  ${good ? 'ok  ' : 'FAIL'}  ${name}`);
  console.log(`          Purchase ${ok(got.purchase)} · Refinance ${ok(got.refinance)}`
            + `   (expected Purchase ${ok(want.purchase)} · Refinance ${ok(want.refinance)})`);
}

async function main() {
  let token = '';
  try {
    token = execFileSync('node', ['tools/automation-session.mjs'], { encoding: 'utf8' }).trim();
  } catch (e) {
    return die('could not mint an automation session token');
  }
  if (!token) return die('automation session returned an empty token');

  console.log('\ngenerate-1003-pdf — the HTML form, boxes read from the rendered DOM');
  const CONTACTS = [
    ['Tania Monje Flores (purchase)', 'd99ff546-7ba6-4035-88c4-12a2daae1295', { purchase: true,  refinance: false }],
    ['Josue Ramos (refi_rate_term)',  'ca12b9b5-38bb-4f64-861f-acf0c78569a0', { purchase: false, refinance: true  }],
  ];
  const blank = process.env.RR_BLANK_CONTACT_ID;
  if (blank) CONTACTS.push(['a contact with NO purpose', blank, { purchase: false, refinance: false }]);
  for (const [name, cid, want] of CONTACTS) {
    let html;
    try {
      const r = await fetch(`${BASE}/generate-1003-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ contact_id: cid }),
      });
      const raw = await r.text();
      if (!r.ok) { console.log(`  ????  ${name}: HTTP ${r.status} ${raw.slice(0, 120)}`); unrunnable++; ran++; continue; }
      /* The body is JSON carrying BASE64 html, not html. Reading it as markup
         finds no checkbox spans and looks like a broken form. */
      const j = JSON.parse(raw);
      if (!j.html) { console.log(`  ????  ${name}: no html in response`); unrunnable++; ran++; continue; }
      html = Buffer.from(j.html, 'base64').toString('utf8');
    } catch (e) { console.log(`  ????  ${name}: ${e.message}`); unrunnable++; ran++; continue; }
    const got = await readHtmlBoxes(html, cid.slice(0, 8));
    if (!got.harness_ok) { console.log(`  ????  ${name}: HARNESS ${got.why}`); unrunnable++; ran++; continue; }
    expect(name, got, want);
  }

  /* THREE OUTCOMES, NOT TWO. A document that could not be read is reported in
     its own words and exits 2 — it is not a pass, and it is not a wrong box
     either. Folding "could not check" into either is how a harness starts
     lying in the reassuring direction. */
  const passed = ran - failures - unrunnable;
  console.log(`\n${passed}/${ran} document(s) ticked the right box.`);
  if (unrunnable) console.log(`${unrunnable} COULD NOT BE READ (harness, not a verdict).`);
  if (failures)   console.log(`${failures} TICKED THE WRONG BOX.`);
  if (failures) process.exitCode = 1;
  else if (unrunnable) process.exitCode = 2;
}

main().catch((e) => die(e.message));
