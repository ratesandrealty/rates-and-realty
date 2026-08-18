#!/usr/bin/env node
/* Does a scan use the extraction template that matches the document?
 *
 *   node tools/prove-doctype-template.mjs
 *
 * WHAT WENT WRONG, AND WHY IT NEEDED A LIVE CALL TO SEE.
 * textract-ocr picked its extraction template from `docTypeKey`, which is set
 * ONLY from the request's doc_type. The filename heuristic set a different
 * variable -- the prose label pasted into the prompt sentence. The main
 * "Scan Doc -> Auto-fill" button and the batch Doc Scan Picker send no doc_type,
 * so both asked for DRIVER'S LICENCE fields while the sentence read "Extract
 * fields from this Bank Statement".
 *
 * Nothing errored, and that is the point: a bank statement came back with
 * first_name/date_of_birth and no bank fields, which reads as a document the
 * model could not parse. The wrong question had been asked, and the response
 * looked like a bad document rather than a bug. Only the KEYS that come back
 * reveal which template ran, so the assertion has to be made on a real
 * response from the deployed function.
 *
 * THE FIXTURE IS SYNTHETIC, generated below -- never a borrower's statement.
 * Probes do not touch a borrower's things, and a real statement would put
 * account data through an OCR round trip for no reason.
 *
 * The four cases are chosen to isolate the filename as the cause:
 *   - a filename with the token       -> bank template
 *   - a filename whose name contains "id" (davids-bank-stmt) -> STILL bank.
 *     Before the fix, includes('id') was tested first and would have claimed it.
 *   - a filename with no token        -> bank template does NOT run (unchanged
 *     fallback: a licence template on a bank statement returns nothing at all,
 *     because every DL field is empty and empties are filtered out)
 *   - an explicit doc_type            -> still wins over the filename
 *
 * Exit 1 = a scan used the wrong template. Exit 2 = could not run.
 * process.exitCode, never process.exit(): a Windows teardown crash with sockets
 * open replaces the code with 0, so a real failure would report success.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FIXTURE = 'aa74cc5e-2186-4b40-8608-3d2aa033b9ca';   // ZZ-TEST Fixture Borrower
const URL = 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/textract-ocr';

/* A minimal one-page PDF. Hand-built rather than pulled from anywhere: it must
   be legible to a vision model but contain no real account. */
function makeStatementPdf() {
  const lines = [
    'FIRST NATIONAL TEST BANK',
    'Personal Checking Statement',
    'Statement Period: 01/01/2026 through 01/31/2026',
    'Account Holder: Jordan Testfixture',
    'Account Number: ****4417',
    'Ending Balance: $4,321.58',
  ];
  let content = 'BT\n/F1 14 Tf\n72 720 Td\n18 TL\n';
  for (const l of lines) content += `(${l.replace(/([()\\])/g, '\\$1')}) Tj\nT*\n`;
  content += 'ET\n';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}

/* Keys unique to one template. first_name/last_name are in BOTH, so they cannot
   discriminate; the bank template names the holder account_holder_*. */
const BANK_ONLY = ['bank_name', 'account_type', 'account_number', 'total_balance',
                   'statement_start_date', 'statement_end_date',
                   'account_holder_first_name', 'account_holder_last_name'];
const DL_ONLY = ['driver_license_number', 'dl_state', 'id_expiration_date', 'middle_name'];

const CASES = [
  ['filename says bank, no doc_type',          'bank-statement.pdf',   null,             'bank'],
  ['name contains "id" (davids), no doc_type', 'davids-bank-stmt.pdf', null,             'bank'],
  ['no type token at all, no doc_type',        'scan-0012.pdf',        null,             'none'],
  ['explicit doc_type still wins',             'scan-0012.pdf',        'bank_statement', 'bank'],
];

let ran = 0, wrong = 0, unrunnable = 0;

async function main() {
  let token, anon;
  try { token = execFileSync('node', ['tools/automation-session.mjs'], { encoding: 'utf8' }).trim(); }
  catch { console.error('\nREFUSED TO RUN: could not mint an automation session token'); process.exitCode = 2; return; }
  try {
    const src = readFileSync('assets/js/utils.js', 'utf8');
    anon = (src.match(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9[A-Za-z0-9._-]*/) || [])[0];
  } catch { /* fall through */ }
  if (!token || !anon) { console.error('\nREFUSED TO RUN: missing token or anon key'); process.exitCode = 2; return; }

  const b64 = makeStatementPdf();
  console.log('\ntextract-ocr — which extraction template ran, read off the returned keys\n');

  for (const [name, fileName, docType, expect] of CASES) {
    ran++;
    let data;
    try {
      const body = { action: 'start', file_base64: b64, file_name: fileName,
                     file_type: 'application/pdf', contact_id: FIXTURE };
      if (docType) body.doc_type = docType;
      const r = await fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: anon },
        body: JSON.stringify(body),
      });
      data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    } catch (e) { console.log(`  ????  ${name}: HARNESS ${e.message}`); unrunnable++; continue; }

    const keys = Object.keys(data.fields || {});
    const bank = BANK_ONLY.filter(k => keys.includes(k));
    const dl = DL_ONLY.filter(k => keys.includes(k));
    const got = bank.length && !dl.length ? 'bank'
              : dl.length && !bank.length ? 'default'
              : !bank.length && !dl.length ? 'none' : 'mixed';
    const ok = got === expect;
    if (!ok) wrong++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(42)} template=${got.padEnd(8)} label=${JSON.stringify(data.doc_type)}`);
    console.log(`           bank-only keys: ${bank.join(', ') || '(none)'}`);
    if (dl.length) console.log(`           DL-only keys:   ${dl.join(', ')}`);
  }

  console.log(`\n${ran - wrong - unrunnable}/${ran} scan(s) used the right extraction template.`);
  if (unrunnable) console.log(`${unrunnable} COULD NOT BE READ (harness, not a verdict).`);
  if (wrong) console.log(`${wrong} USED THE WRONG TEMPLATE.`);
  console.log('\nThis writes ocr_jobs rows against the ZZ-TEST fixture. Clean up with:');
  console.log("  delete from ocr_jobs where contact_id = '" + FIXTURE + "';");
  if (wrong) process.exitCode = 1;
  else if (unrunnable) process.exitCode = 2;
}

main().catch(e => { console.error('\nREFUSED TO RUN: ' + e.message); process.exitCode = 2; });
