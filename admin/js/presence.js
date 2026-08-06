/* presence.js — 60-second heartbeat, and the "active time" readout it feeds.
 *
 * VISIBLE BY DESIGN. This renders a small readout on the page it runs on, so the
 * person being measured can see the same number their employer sees. A silent
 * heartbeat in a page someone uses every day is the version that reads badly if
 * it is ever discovered, and it buys nothing — the measurement is identical
 * either way.
 *
 * WHY A HEARTBEAT AND NOT auth.sessions
 * Sessions cannot answer this. On this project not_after was null on all 66
 * rows, only 6 of 66 had ever refreshed, and lifetimes ran to 36 days — because
 * closing a tab writes nothing. A session row measures "how long until someone
 * explicitly signed out", which for this account was up to five weeks.
 *
 * PARAMETERS, and why each one
 *   60s beat          — cheap, and fine-grained enough that a 10-minute cutoff
 *                       has ten chances to notice.
 *   10-minute idle    — a five-minute connection dropout mid-shift is ABSORBED,
 *                       not treated as clocking off. Philippine connections drop
 *                       more often than domestic ones; counting session rows
 *                       would have measured the ISP rather than the work.
 *   90-minute gap     — starts a new "work session" for shift-start alerting.
 *   PHT day buckets   — the account is UTC+8, Rene is UTC-7. A 09:00 PHT start
 *                       is 18:00 PT the PREVIOUS day, so bucketing on his
 *                       calendar day splits one shift across two reports.
 *
 * "ACTIVE TIME", never "hours worked". A dropout longer than ten minutes reads
 * as idle and is not counted; the difference between the two numbers is her
 * connection, not her effort.
 *
 * SHARED LOGIN. processing@ is used by whichever VA is on. This measures the
 * ACCOUNT. Two people signed in at once are one indistinguishable timeline —
 * not merged-but-separable, genuinely unrecoverable, because the information is
 * never captured. The readout says so.
 */
(function () {
  'use strict';
  if (window.__presenceStarted) return;
  window.__presenceStarted = true;

  var BEAT_MS = 60 * 1000;
  var _timer = null;

  async function client() {
    try {
      if (typeof window.getSupabaseClient === 'function') return await window.getSupabaseClient();
    } catch (e) { /* fall through */ }
    return window._supabaseClient || null;
  }

  async function beat() {
    /* Only while the tab is actually visible. A backgrounded tab left open
       overnight would otherwise report a full night of "active time" — the
       single easiest way to make this number a lie. */
    if (document.visibilityState === 'hidden') return;
    try {
      var c = await client();
      if (!c) return;
      await c.rpc('presence_beat');
    } catch (e) { /* never surface: a missed beat costs one minute of resolution */ }
  }

  function fmt(secs) {
    var s = Math.max(0, Math.round(secs || 0));
    var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? (h + 'h ' + m + 'm') : (m + 'm');
  }

  function timeIn(tz, iso) {
    try {
      return new Date(iso).toLocaleTimeString('en-US',
        { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  async function render() {
    var el = document.getElementById('presence-readout');
    if (!el) return;
    try {
      var c = await client();
      if (!c) return;
      var r = await c.rpc('presence_day', { p_user: null, p_day: null });
      var rows = (r && r.data) || [];
      if (!rows.length) { el.textContent = ''; return; }
      var d = rows[0];
      /* BOTH zones, always. A single time is ambiguous when the two people
         reading it are 15 hours apart, and the ambiguity always resolves in
         favour of whoever is not looking. */
      el.innerHTML =
        '<span class="pr-label">Active time today</span> '
        + '<strong>' + fmt(d.active_seconds) + '</strong> '
        + '<span class="pr-span">' + timeIn('Asia/Manila', d.first_beat) + '–'
        + timeIn('Asia/Manila', d.last_beat) + ' PHT'
        + ' · ' + timeIn('America/Los_Angeles', d.first_beat) + '–'
        + timeIn('America/Los_Angeles', d.last_beat) + ' PT</span>'
        + '<span class="pr-note" title="Time is recorded against the shared processing@ account, not an individual. Gaps longer than 10 minutes are not counted, so this is active time rather than hours worked.">'
        + 'ⓘ account time, not hours worked</span>';
    } catch (e) { /* readout is informational; never break the page for it */ }
  }

  function css() {
    if (document.getElementById('presence-css')) return;
    var s = document.createElement('style'); s.id = 'presence-css';
    s.textContent =
      '#presence-readout{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:rgba(255,255,255,.55)}'
      + '#presence-readout strong{color:#C9A84C;font-size:12px}'
      + '#presence-readout .pr-label{text-transform:uppercase;letter-spacing:.4px;font-weight:700;font-size:9px}'
      + '#presence-readout .pr-span{color:rgba(255,255,255,.38)}'
      + '#presence-readout .pr-note{border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:1px 7px;cursor:help}';
    document.head.appendChild(s);
  }

  function start() {
    css();
    beat();
    render();
    if (_timer) clearInterval(_timer);
    _timer = setInterval(beat, BEAT_MS);
    setInterval(render, 5 * BEAT_MS);
    // Beat immediately on returning to the tab, so a gap closes at once rather
    // than up to a minute later.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { beat(); render(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
