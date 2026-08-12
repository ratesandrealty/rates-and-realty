/**
 * test-bridge-suppression — hiding the bridge must not move a borrower's number.
 *
 *   node tools/test-bridge-suppression.mjs
 *
 * THE RULE THIS PINS. A section toggle may suppress a LINE; it must never change
 * arithmetic. Lender credits is the worked example in public/fee.html: the credit
 * stays inside cashToClose and only its row is hidden, because dropping it from
 * the maths would RAISE the borrower's cash to close by the credit amount.
 *
 * The bridge is supposed to be safe by a stronger property — it is purely
 * ADDITIVE, reading each option's totalMonthly and writing nothing back — so
 * removing it should leave everything else byte-identical. "Supposed to be" is
 * exactly why this exists: that property is easy to break later by having the
 * addendum feed a total, and nothing else would notice.
 */
import fs from 'fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync('public/fee.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
let code = m[1];
const cut = code.indexOf('// ── init ──');
code = cut > 0 ? code.slice(0, cut) : code.slice(0, code.lastIndexOf('(async function(){'));

const SNAP = {
  created_at: '2026-08-12T00:00:00Z',
  borrower_name: 'ZZ Probe Borrower',
  data: {
    mode: 'rate',
    common: { purchasePrice: '$750,000', downPct: '20', loanProduct: 'Conv 30yr Fixed',
              state: 'CA', county: 'Orange', annualInsurance: '$1,800', creditScore: '760-779',
              propertyType: 'SFR', lockPeriod: '30 days' },
    scenarios: [
      { id: 'A', label: 'Option A', rate: 6.875, points: 0,  origComp: 1.5, lenderCredits: 0,    recommended: true },
      { id: 'B', label: 'Option B', rate: 6.625, points: 1,  origComp: 1.5, lenderCredits: 0,    recommended: false },
      { id: 'C', label: 'Option C', rate: 7.125, points: -1, origComp: 1.5, lenderCredits: 2500, recommended: false },
    ],
    bridge: { on: true, value: '$800,000', balance: '$450,000', cltv: '80', rate: '10.5',
              months: '9', points: '2', fees: '$1,495', mode: 'io',
              payoff: '123 Departing St', note: 'Covers the down payment until Elm St closes.' },
  },
};

function renderDom(sections, snap) {
  const dom = new JSDOM('<div id="app"></div>', { runScripts: 'outside-only' });
  dom.window.eval('window.__SEC=' + JSON.stringify(sections) + ';\n'
    + code + '\n;renderRate(' + JSON.stringify(snap || SNAP) + ');');
  return dom.window.document.getElementById('app');
}
const render = (sections, snap) => renderDom(sections, snap).innerHTML;

/* The opted-in render with EXACTLY the addendum node removed. Comparing THAT to
   the opted-out render is the real question — "does anything else move?".
   Truncating at the addendum instead would also drop the disclaimer and footer
   that follow it and report a difference that is only the slicing. */
function renderWithoutAddendum(sections) {
  const app = renderDom(sections);
  const node = app.querySelector('#bridgeAddendumPub');
  if (node) node.remove();
  return app.innerHTML;
}

let pass = 0, fail = 0;
function t(label, ok, detail) {
  ok ? pass++ : fail++;
  console.log((ok ? '  OK   ' : '  FAIL ') + label);
  if (!ok && detail) console.log('        ' + detail);
}

const BASE = { lender_credits: false, fee_schedule: false, people: false };
const off = render({ ...BASE, bridge: false });
const on  = render({ ...BASE, bridge: true });

console.log('the bridge section is opt-in');
t('hidden by default (bridge:false)', !/Bridge Loan Addendum/.test(off));
t('shown when opted in (bridge:true)', /Bridge Loan Addendum/.test(on));

console.log('\nhiding it changes NOTHING else');
t('addendum node present when opted in', /id="bridgeAddendumPub"/.test(on));
const onMinus = renderWithoutAddendum({ ...BASE, bridge: true });
t('remove the addendum and the rest is byte-identical', onMinus === off,
  'lengths ' + onMinus.length + ' vs ' + off.length);

console.log('\nthe figures a borrower reads are untouched');
const grab = (h, label) => {
  const re = new RegExp('<span class="rl">' + label + '<\\/span><span class="rv">([^<]+)<');
  const x = h.match(re); return x ? x[1] : null;
};
for (const label of ['Estimated Cash to Close', 'Total Closing Costs', 'Down Payment']) {
  const a = grab(off, label), b = grab(on, label);
  t(label + ' unchanged  (' + (a || 'n/a') + ')', a === b, a + ' vs ' + b);
}

console.log('\nthe addendum reads the permanent payment rather than replacing it');
t('a "Both, monthly" column exists', /Both, monthly/.test(on));
t('the free-text note reaches the link', /Covers the down payment until Elm St closes\./.test(on));
t('the payoff property is printed', /123 Departing St/.test(on));

console.log('\nan unusable bridge renders nothing rather than "not finished yet"');
const broken = JSON.parse(JSON.stringify(SNAP));
broken.data.bridge.rate = '';
const brokenOut = render({ ...BASE, bridge: true }, broken);
t('no addendum when the bridge has no rate', !/Bridge Loan Addendum/.test(brokenOut));
t('and no "not finished" text on a borrower page', !/not finished/i.test(brokenOut));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
