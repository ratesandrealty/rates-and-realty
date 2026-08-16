#!/usr/bin/env node
/* serve-prefix — serve the repo over http, but answer /admin/lead-detail.html
 * with the bytes from BEFORE a given commit (default 9f87ca6^, the parent of
 * "Six borrower-data writes stop failing silently").
 *
 * WHY: write-failure-proof.mjs is only worth anything if it FAILS on the code
 * the fix replaced. A harness that has only ever passed proves nothing. Point
 * the harness at this server and the break directions should report success —
 * "✓ Liability added" on a forced 400 — which is the defect 9f87ca6 removed.
 *
 *   node tools/serve-prefix.mjs                 # port 8788, ref 9f87ca6^
 *   node tools/serve-prefix.mjs 8788 9f87ca6^
 *   RC_BASE=http://127.0.0.1:8788 node tools/write-failure-proof.mjs BREAK
 *
 * NOTE: api/env.js is gitignored, so a worktree does not have it and the page
 * would load with no APP_CONFIG. Copy it in from the main checkout first, or
 * run this from the main checkout. The server says so rather than 404ing quietly.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, normalize } from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.argv[2] || 8788);
const REF = process.argv[3] || '9f87ca6^';
const TARGET = '/admin/lead-detail.html';

let OLD_BYTES;
try {
  OLD_BYTES = execFileSync('git', ['show', `${REF}:admin/lead-detail.html`], { maxBuffer: 1 << 28 });
} catch (e) {
  console.error(`refused: cannot read admin/lead-detail.html at ${REF} — ${e.message}`);
  process.exit(2);
}

if (!existsSync(join(ROOT, 'api', 'env.js'))) {
  console.error('WARNING: api/env.js is missing (it is gitignored). The page will load with no');
  console.error('         APP_CONFIG and will not build a Supabase client. Copy it in first.');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
};

createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === TARGET) {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(OLD_BYTES);
    return;
  }
  try {
    const file = join(ROOT, normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('outside root'); return; }
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found: ' + p);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serve-prefix on http://127.0.0.1:${PORT}`);
  console.log(`  ${TARGET} = ${REF} (${OLD_BYTES.length} bytes); everything else = working tree`);
});
