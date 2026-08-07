#!/usr/bin/env node
/* check-short-urls — the worker serves /portal from public/portal.html via an
 * ALLOWLIST in src/worker.js. An allowlist is only safe while it matches the
 * directory, and nothing about adding a page to public/ makes anyone edit the
 * worker. This fails the build when the two drift.
 *
 * It is not a style check. A page added to public/ and left out of the list is
 * a page whose short URL 404s — the same silent-wrong-page class this whole
 * change exists to close, just with a different symptom.
 *
 * Deliberate omissions are declared here, WITH a reason, so "missing" and
 * "intentionally excluded" can never be confused for each other.
 *
 *   node tools/check-short-urls.mjs
 */
import { readdirSync, existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';

const WORKER = 'src/worker.js';

/* Every slug that exists under public/ but is NOT given a short URL, and why.
 * Adding a page here is a decision; forgetting one is a bug. */
const EXCLUDED = {
  fee: 'routed as /fee/<slug>; the page reads the slug from location.pathname',
  cma: 'routed as /cma/<slug>; same',
  search: 'a meta-refresh stub, not a page; the worker 301s /search to /search-homes',
  'privacy-policy': 'credit-funnel legal fork, pending merge with root privacy.html',
  'terms-of-service': 'credit-funnel legal fork, pending merge with root terms.html',
};

function setFrom(src, name) {
  const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) throw new Error(`${name} not found in ${WORKER}`);
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

const src = readFileSync(WORKER, 'utf8');
const listed = setFrom(src, 'PUBLIC_PAGES');
const rootListed = setFrom(src, 'ROOT_PAGES');
const onDisk = new Set(readdirSync('public').filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')));

const problems = [];

for (const slug of onDisk) {
  if (listed.has(slug) || EXCLUDED[slug]) continue;
  problems.push(`public/${slug}.html has no short URL — add '${slug}' to PUBLIC_PAGES in ${WORKER}, ` +
    `or record why not in EXCLUDED here.`);
}
for (const slug of listed) {
  if (!onDisk.has(slug)) problems.push(`PUBLIC_PAGES lists '${slug}' but public/${slug}.html does not exist — /${slug} would 404.`);
  if (EXCLUDED[slug]) problems.push(`'${slug}' is both listed in PUBLIC_PAGES and EXCLUDED here. One of them is wrong.`);
}
for (const slug of rootListed) {
  if (!existsSync(`${slug}.html`)) problems.push(`ROOT_PAGES lists '${slug}' but ${slug}.html does not exist — /${slug} would 404.`);
}
for (const slug of Object.keys(EXCLUDED)) {
  if (!onDisk.has(slug)) problems.push(`EXCLUDED mentions '${slug}', which is no longer in public/. Drop the entry.`);
}

if (problems.length) {
  console.log(`check-short-urls: ${problems.length} problem(s)\n`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`check-short-urls: OK — ${listed.size} public + ${rootListed.size} root short URL(s), ` +
  `${Object.keys(EXCLUDED).length} deliberately excluded, all accounted for.`);
