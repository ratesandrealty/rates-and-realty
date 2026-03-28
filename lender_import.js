#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');

// ============================================================
// CONFIG
// ============================================================
const CLICKUP_API_KEY = 'pk_60118693_M63VVQGUKXC2SIXFTZCPWSPSG1241023';

const LISTS = {
  SPECIALTY:  '901712246597', // Only Reverse / HELOC / HELOAN / SBA
  NON_QM:     '901712246253', // Only Non-QM / Hard Money / Commercial (no Jumbo)
  JUMBO_COMM: '901712246260', // Has Jumbo or Commercial, but NO Conv/FHA/VA/USDA
  AGENCY:     '901712246241', // Has Conventional / FHA / VA / USDA
};

// Lenders already in ClickUp — skip these (prefix match, case-insensitive)
const SKIP_PREFIXES = [
  'uwm',
  "click n' close",
  'aaa lendings',
  'kind lending',
  'newrez',
  'pennymac',
  'sun west',
  'the loan store',
  'forward lending',
  'loanunited',
  'figure lending',
  'spring eq',
  'angel oak',
  'acra',
  'finance of america',
  '5th street',
  'lendingone',
  'icecap',
  'anchor loans',
  'asset based lending',
  'axos bank',
  'carlyle capital',
  'american pride bank',
  'symmetry lending',
];

// ============================================================
// CSV PARSER  (handles quoted fields with embedded commas/newlines)
// ============================================================
function parseCSV(raw) {
  const rows = [];
  let current = [];
  let field = '';
  let inQ = false;
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQ = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQ = true;
      } else if (ch === ',') {
        current.push(field); field = '';
      } else if (ch === '\n') {
        current.push(field); field = '';
        rows.push(current);
        current = [];
      } else {
        field += ch;
      }
    }
  }
  if (field !== '' || current.length > 0) { current.push(field); rows.push(current); }
  return rows;
}

// ============================================================
// SKIP CHECK
// ============================================================
function shouldSkip(name) {
  const n = name.toLowerCase().trim();
  return SKIP_PREFIXES.some(p =>
    n === p ||
    n.startsWith(p + ' ') ||
    n.startsWith(p + ',') ||
    n.startsWith(p + '.') ||
    n.startsWith(p + '-')
  );
}

// ============================================================
// LIST ASSIGNMENT
// ============================================================
const SPECIALTY_SET  = new Set(['reverse', 'heloc', 'heloan', 'sba']);
const AGENCY_SET     = new Set(['conventional', 'fha', 'va', 'usda']);
const JUMBO_COMM_SET = new Set(['jumbo', 'commercial', 'commercial - residential']);

function getListId(loanTypesStr) {
  if (!loanTypesStr || !loanTypesStr.trim()) return LISTS.AGENCY;
  const types = loanTypesStr.split(',').map(t => t.trim().toLowerCase());
  if (types.every(t => SPECIALTY_SET.has(t)))     return LISTS.SPECIALTY;
  if (types.some(t => AGENCY_SET.has(t)))          return LISTS.AGENCY;
  if (types.some(t => JUMBO_COMM_SET.has(t)))      return LISTS.JUMBO_COMM;
  return LISTS.NON_QM;
}

// ============================================================
// TAGS
// ============================================================
const TAG_MAP = {
  'conventional': 'conventional', 'fha': 'fha', 'va': 'va', 'usda': 'usda',
  'non-qm': 'non-qm', 'jumbo': 'jumbo', 'heloc': 'heloc', 'heloan': 'heloan',
  'hard money': 'hard-money', 'commercial': 'commercial',
  'commercial - residential': 'commercial',
  'reverse': 'reverse', 'sba': 'sba',
};

function getTags(str) {
  if (!str) return [];
  return [...new Set(str.split(',').map(t => TAG_MAP[t.trim().toLowerCase()]).filter(Boolean))];
}

// ============================================================
// PRIORITY
// ============================================================
function getPriority(preferred, rating) {
  if (preferred && preferred.includes('✓')) return 1; // urgent
  const r = parseFloat(rating);
  if (!isNaN(r)) {
    if (r >= 4.5) return 2; // high
    if (r >= 3.0) return 3; // normal
    return 3;
  }
  return 4; // low — no rating
}

// ============================================================
// DOMAIN GUESSING
// ============================================================
function guessDomains(name) {
  const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const strip = (s, extra = '') =>
    s.replace(new RegExp(`,?\\s*(llc|inc\\.?|corp\\.?|ltd\\.?|tpo|company|corporation${extra})(\\s+|$)`, 'gi'), ' ').trim();

  const v1 = clean(name.replace(/\s+/g, ''));
  const v2 = clean(strip(name).replace(/\s+/g, ''));
  const v3 = clean(strip(name, '|mortgage|lending|financial|bank|capital|funding|group|services|solutions|wholesale').replace(/\s+/g, ''));

  return [...new Set([v1, v2, v3].filter(Boolean).map(s => s + '.com'))];
}

// ============================================================
// HTTP HELPERS
// ============================================================
function req(options, body = null) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    r.setTimeout(8000, () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

async function checkClearbit(domain) {
  try {
    const r = await req({ hostname: 'logo.clearbit.com', path: `/${domain}`, method: 'HEAD' });
    if (r.status === 200) return `https://logo.clearbit.com/${domain}`;
  } catch (_) {}
  return null;
}

async function findWebsite(name) {
  for (const domain of guessDomains(name)) {
    const logo = await checkClearbit(domain);
    if (logo) return { domain, logo };
  }
  // Return first guess with no logo
  const domains = guessDomains(name);
  return { domain: domains[0] || null, logo: null };
}

// ============================================================
// CLICKUP API
// ============================================================
async function clickupPost(path, body) {
  const s = JSON.stringify(body);
  return req({
    hostname: 'api.clickup.com',
    path: `/api/v2${path}`,
    method: 'POST',
    headers: {
      'Authorization': CLICKUP_API_KEY,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(s),
    },
  }, s);
}

// ============================================================
// DESCRIPTION BUILDER
// ============================================================
function buildDescription(row, logo, domain) {
  const [investor, loanTypes, loanChannels, minCredit, executive, avgAppToFund, preferred, rating, , , revenueNotes, fees] = row;
  const logoLine    = logo   ? `![Logo](${logo})\n\n`                              : '🏦\n\n';
  const websiteLine = domain ? `[https://${domain}](https://${domain})`            : 'N/A';
  const prefText    = (preferred && preferred.includes('✓')) ? 'Yes'              : 'No';
  const ratingText  = (rating && rating.trim())              ? rating.trim()       : 'N/A';
  const feesText    = (fees   && fees.trim())                ? fees.trim()         : 'N/A';
  const compText    = (revenueNotes && revenueNotes.trim())  ? revenueNotes.trim() : 'N/A';

  return `${logoLine}## ${investor}
**🌐 Website:** ${websiteLine}
**💳 Loan Types:** ${loanTypes  || 'N/A'}
**📡 Channel:** ${loanChannels  || 'N/A'}
**📊 Min Credit:** ${minCredit  || 'N/A'}
**⏱️ Avg App to Fund:** ${avgAppToFund || 'N/A'}
**⭐ Rating:** ${ratingText}
**✅ Preferred:** ${prefText}

## 👤 Account Executive
**Name:** ${executive || 'N/A'}

## 💰 Compensation
${compText}

## 🧾 Fees
${feesText}

## 📝 Notes
N/A`;
}

// ============================================================
// MAIN
// ============================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('📂 Reading CSV...\n');
  const content = fs.readFileSync('C:\\AI\\test\\export.csv', 'utf8');
  const rows    = parseCSV(content);
  const data    = rows.slice(1).filter(r => r[0] && r[0].trim());
  console.log(`Total lenders in CSV: ${data.length}\n`);

  let added = 0, skipped = 0, failed = 0;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    while (row.length < 12) row.push('');

    const investor = row[0].trim();
    if (!investor) continue;

    // — SKIP CHECK —
    if (shouldSkip(investor)) {
      console.log(`⏭️  Skip (already in ClickUp): ${investor}`);
      skipped++;
      continue;
    }

    const loanTypes = row[1].trim();
    const preferred = row[6].trim();
    const rating    = row[7].trim();

    const listId   = getListId(loanTypes);
    const priority = getPriority(preferred, rating);
    const tags     = getTags(loanTypes);

    // — FIND WEBSITE / LOGO —
    const { domain, logo } = await findWebsite(investor);

    // — BUILD TASK —
    const taskName    = (preferred.includes('✓')) ? `${investor} ⭐ PREFERRED` : investor;
    const description = buildDescription(row, logo, domain);

    const taskBody = {
      name: taskName,
      markdown_description: description,
      priority,
      tags,
    };

    try {
      const res = await clickupPost(`/list/${listId}/task`, taskBody);

      if (res.status === 200 || res.status === 201) {
        console.log(`✅ Added [${i+1}/${data.length}]: ${investor}${logo ? ' 🖼️' : ''}  →  list ${listId}`);
        added++;
      } else if (res.status === 429) {
        console.log(`⏳ Rate-limited on "${investor}" — waiting 3 s...`);
        await sleep(3000);
        const r2 = await clickupPost(`/list/${listId}/task`, taskBody);
        if (r2.status === 200 || r2.status === 201) {
          console.log(`✅ Added (retry): ${investor}`);
          added++;
        } else {
          console.log(`❌ Failed: ${investor} — ${r2.status}: ${r2.data.slice(0, 120)}`);
          failed++;
        }
      } else {
        console.log(`❌ Failed: ${investor} — ${res.status}: ${res.data.slice(0, 120)}`);
        failed++;
      }
    } catch (e) {
      console.log(`❌ Error: ${investor} — ${e.message}`);
      failed++;
    }

    await sleep(300);
  }

  console.log('\n══════════════════════════════════════════════');
  console.log(`✅ Added: ${added}   ⏭️  Skipped: ${skipped}   ❌ Failed: ${failed}`);
  console.log('══════════════════════════════════════════════');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
