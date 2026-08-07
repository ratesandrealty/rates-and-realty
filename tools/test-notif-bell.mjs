#!/usr/bin/env node
/* test-notif-bell — proves the behaviours the two hand-ported copies disagreed
 * about, so the collapse into one module cannot silently pick the wrong one.
 *
 * The three that mattered:
 *   1. add_task_note writes kind='task_note' with source_kind='task'. The
 *      dashboard tested source_kind alone, never matched, and dropped the
 *      #vatask= hash — so the task never opened. Asserted against the
 *      producer's real shape, not the shape the old code assumed.
 *   2. kind='system' had an icon on one page and none on the other.
 *   3. @mentions were chips on one page and raw text on the other.
 *
 * Plus the reason the rows were rewritten at all: a quote in any interpolated
 * field used to land inside an inline onclick's JS string. The row markup is
 * asserted to contain no executable attribute at all.
 *
 *   node tools/test-notif-bell.mjs
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); if (detail !== undefined) console.log(`       ${String(detail).slice(0, 400)}`); }
};

/* One bell per harness. Returns the sandbox plus a recorder of everything the
 * module tried to do to the outside world. */
function harness({ rows = [], currentContactId, withShortcuts = false } = {}) {
  const dom = new JSDOM(
    `<body><button id="notifBell"></button><span id="notifBadge"></span></body>`,
    { url: 'https://admin.ratesandrealty.com/admin/lead-detail?contact_id=CUR', runScripts: 'outside-only' }
  );
  const { window } = dom;
  const log = { nav: [], rpc: [], shortcuts: [], errors: [] };

  const sb = {
    rpc: async (name, args) => {
      log.rpc.push([name, args]);
      if (name === 'notifications_list') return { data: rows, error: null };
      if (name === 'notifications_unread_count') return { data: rows.filter((r) => !r.is_read).length, error: null };
      return { data: null, error: null };
    },
  };

  /* jsdom's window.location is [Unforgeable] — it cannot be redefined, and
   * assigning href only logs "Not implemented: navigation" without the target.
   * So run the module with `window` as a FUNCTION PARAMETER shadowing the
   * global: everything it touches still reaches the real jsdom window through
   * the proxy, except location, which is ours to read. */
  let href = window.location.href;
  const fakeLoc = {
    get href() { return href; },
    set href(v) { href = v; log.nav.push(v); },
    search: '?contact_id=CUR',
  };
  const shim = new Proxy(window, {
    get(t, k) {
      if (k === 'location') return fakeLoc;
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) { Reflect.set(t, k, v); return true; },
  });

  const src = readFileSync('admin/js/notif-bell.js', 'utf8');
  new window.Function('window', src)(shim);

  const opts = {
    client: async () => sb,
    onError: (err, msg) => log.errors.push(msg),
  };
  if (currentContactId !== undefined) opts.currentContactId = () => currentContactId;
  if (withShortcuts) {
    opts.shortcuts = {
      taskNote: (id) => log.shortcuts.push(['taskNote', id]),
      sms: () => log.shortcuts.push(['sms']),
      doc: () => log.shortcuts.push(['doc']),
    };
  }
  window.NotifBell.mount(opts);
  return { window, log, doc: window.document };
}

const row = (o) => Object.assign(
  { id: 'n1', is_read: false, actor_display: 'Rene', preview: 'hello', created_at: new Date().toISOString(),
    kind: null, source_kind: null, source_id: null, contact_id: null, link: null }, o);

const settle = () => new Promise((r) => setTimeout(r, 30));

console.log('\n── the divergence that shipped broken ──────────────────');
{
  /* The producer's actual shape, read off add_task_note:
   *   kind='task_note', source_kind='task', source_id=<task id>          */
  const r = row({ id: 'T1', kind: 'task_note', source_kind: 'task', source_id: 'TASK-9', contact_id: 'OTHER' });
  const h = harness({ rows: [r] });
  h.window.NotifBell.toggle();
  await settle();
  h.doc.querySelector('[data-nb-row]').click();
  await settle();
  check('task note from add_task_note carries #vatask= (dashboard used to drop it)',
    h.log.nav[0] === '/admin/lead-detail?contact_id=OTHER#vatask=TASK-9', h.log.nav);
}
{
  // The legacy shape must keep working too — the rule accepts either field.
  const r = row({ id: 'T2', kind: null, source_kind: 'task_note', source_id: 'TASK-7', contact_id: 'OTHER' });
  const h = harness({ rows: [r] });
  h.window.NotifBell.toggle();
  await settle();
  h.doc.querySelector('[data-nb-row]').click();
  await settle();
  check('legacy source_kind=task_note still opens the task',
    h.log.nav[0] === '/admin/lead-detail?contact_id=OTHER#vatask=TASK-7', h.log.nav);
}

console.log('\n── the two cosmetic divergences ────────────────────────');
{
  const h = harness({ rows: [
    row({ id: 'a', kind: 'system', preview: 'monitor fired' }),
    row({ id: 'b', kind: 'sms_inbound', contact_id: 'C' }),
    row({ id: 'c', kind: 'doc_uploaded', contact_id: 'C' }),
    row({ id: 'd', kind: null, preview: 'plain' }),
  ] });
  h.window.NotifBell.toggle();
  await settle();
  const html = h.doc.getElementById('notifDropdown').innerHTML;
  check('kind=system renders the 🛠 icon (lead-detail had none)', html.includes('🛠'), html.slice(0, 200));
  check('sms/doc icons still render', html.includes('💬') && html.includes('📄'));
}
{
  const h = harness({ rows: [row({ preview: 'ping @rene about this' })] });
  h.window.NotifBell.toggle();
  await settle();
  const html = h.doc.getElementById('notifDropdown').innerHTML;
  check('@mention renders as a chip everywhere (dashboard showed raw text)',
    html.includes('>@rene</span>'), html.slice(-260));
}

console.log('\n── navigation rules ────────────────────────────────────');
{
  const h = harness({ rows: [row({ contact_id: 'OTHER' })] });
  h.window.NotifBell.toggle(); await settle();
  h.doc.querySelector('[data-nb-row]').click(); await settle();
  check('navigates to an ABSOLUTE lead URL (works from /dashboard/)',
    h.log.nav[0] === '/admin/lead-detail?contact_id=OTHER', h.log.nav);
}
{
  const h = harness({ rows: [row({ contact_id: 'OTHER', link: '/admin/video-chats?s=1' })] });
  h.window.NotifBell.toggle(); await settle();
  h.doc.querySelector('[data-nb-row]').click(); await settle();
  check('an explicit link wins over contact_id', h.log.nav[0] === '/admin/video-chats?s=1', h.log.nav);
}
{
  // Protocol-relative //evil.com is the one that looks site-relative and is not.
  const h = harness({ rows: [row({ contact_id: null, link: '//evil.example/x' })] });
  h.window.NotifBell.toggle(); await settle();
  h.doc.querySelector('[data-nb-row]').click(); await settle();
  check('a protocol-relative link is ignored, not followed', h.log.nav.length === 0, h.log.nav);
}
{
  const h = harness({ rows: [row({ kind: 'system', contact_id: null })] });
  h.window.NotifBell.toggle(); await settle();
  const el = h.doc.querySelector('[data-nb-row]');
  check('a row with nowhere to go is not advertised as clickable',
    el.style.cursor === 'default' && el.getAttribute('title') === 'Click to mark read', el.getAttribute('style'));
  el.click(); await settle();
  check('…and clicking it still marks it read',
    h.log.rpc.some(([n, a]) => n === 'notification_mark_read' && a.p_id === 'n1'), h.log.rpc);
  check('…and does not navigate', h.log.nav.length === 0, h.log.nav);
}

console.log('\n── same-page shortcuts (lead-detail only) ──────────────');
{
  const h = harness({ rows: [row({ kind: 'sms_inbound', contact_id: 'CUR' })], currentContactId: 'CUR', withShortcuts: true });
  h.window.NotifBell.toggle(); await settle();
  h.doc.querySelector('[data-nb-row]').click(); await settle();
  check('already on the lead → composer opens in place, no reload',
    h.log.shortcuts[0]?.[0] === 'sms' && h.log.nav.length === 0, [h.log.shortcuts, h.log.nav]);
}
{
  const h = harness({ rows: [row({ kind: 'task_note', source_kind: 'task', source_id: 'T5', contact_id: 'CUR' })], currentContactId: 'CUR', withShortcuts: true });
  h.window.NotifBell.toggle(); await settle();
  h.doc.querySelector('[data-nb-row]').click(); await settle();
  check('already on the lead → task opens in place',
    h.log.shortcuts[0]?.[0] === 'taskNote' && h.log.shortcuts[0]?.[1] === 'T5' && h.log.nav.length === 0, h.log.shortcuts);
}
{
  // The dashboard passes neither, so the SAME row must navigate instead.
  const h = harness({ rows: [row({ kind: 'sms_inbound', contact_id: 'CUR' })] });
  h.window.NotifBell.toggle(); await settle();
  h.doc.querySelector('[data-nb-row]').click(); await settle();
  check('no shortcuts configured → the same row navigates',
    h.log.nav[0] === '/admin/lead-detail?contact_id=CUR#text', h.log.nav);
}

console.log('\n── the interpolation hole is gone ──────────────────────');
{
  /* The old markup was onclick="notifOpen('<id>',…)" with the value escaped by
   * lpEsc (which leaves ' alone) or escapeHtml (whose &#39; the HTML parser
   * decodes back to ' before the JS is parsed). Both broke the JS string. */
  const nasty = `x' ,alert(1),'`;
  const h = harness({ rows: [row({ id: nasty, contact_id: `c'`, link: `/a'b`, preview: `<img src=x onerror=alert(1)>` })] });
  h.window.NotifBell.toggle(); await settle();
  const box = h.doc.getElementById('notifDropdown');
  const el = box.querySelector('[data-nb-row]');
  check('no inline event handler survives on a row',
    !el.hasAttribute('onclick') && !el.hasAttribute('onmouseover') && !el.hasAttribute('onmouseout'),
    el.outerHTML.slice(0, 200));
  check('the quote round-trips as DATA, exactly as stored', el.dataset.id === nasty, el.dataset.id);
  check('no <img> was parsed out of the preview', box.querySelectorAll('img').length === 0);
  check('no <script> anywhere in the dropdown', box.querySelectorAll('script').length === 0);
  el.click(); await settle();
  check('clicking the hostile row marks read with the UNMANGLED id',
    h.log.rpc.some(([n, a]) => n === 'notification_mark_read' && a.p_id === nasty), h.log.rpc);
}

console.log('\n── plumbing ────────────────────────────────────────────');
{
  const h = harness({ rows: [row({ is_read: false }), row({ id: 'n2', is_read: true })] });
  await settle();
  check('badge counts unread only', h.doc.getElementById('notifBadge').textContent === '1');
  h.window.NotifBell.toggle(); await settle();
  h.doc.querySelector('[data-nb-act="mark-all"]').click(); await settle();
  check('Mark all read reaches the RPC via the delegated listener',
    h.log.rpc.some(([n]) => n === 'notifications_mark_all_read'), h.log.rpc);
}
{
  const h = harness({ rows: [] });
  h.window.NotifBell.toggle(); await settle();
  check('empty state renders', h.doc.getElementById('notifDropdown').innerHTML.includes('No notifications'));
}
{
  const h = harness({ rows: [row({})] });
  h.window.NotifBell.toggle(); await settle();
  check('toggle closes on a second click', (h.window.NotifBell.toggle(), h.doc.getElementById('notifDropdown').style.display === 'none'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
