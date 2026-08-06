/* share-nudge.js — "work started on a lead the VA cannot see" popup.
 *
 * ONE MODULE, TWO MOUNT POINTS. The notification bell is already implemented
 * twice — once in admin/lead-detail.html and once in dashboard/admin.html, each
 * with its own copy calling the same four RPCs. Writing this popup inline in
 * both would be the third and fourth copy of the same idea. Both pages load this
 * file instead.
 *
 * SHARING GOES THROUGH LeadShare.grant(). The insert into lead_shares lives in
 * admin/js/lead-share.js and nowhere else, so the popup and the lead-detail
 * toggle cannot drift apart.
 *
 * QUIET HOURS. The bell row is written by the DB trigger regardless of the hour,
 * because app_notify_system only inserts a row — it is silent and wakes nobody,
 * and suppressing it there would lose the nudge permanently (the
 * lead_share_nudges row is what stops it firing twice). The POPUP is the
 * intrusive surface, so it is the thing that holds off: share_nudges_pending()
 * returns a `quiet` flag and this module does not auto-open while it is true.
 * The bell still carries the notification, so nothing is lost either way.
 *
 * DISMISSAL IS PERMANENT per lead — see share_nudge_dismiss().
 */
(function () {
  'use strict';
  if (window.ShareNudge) return;

  var _shown = {};        // contact_id -> true, so one page load shows a lead once
  var _open = false;

  async function client() {
    try {
      if (typeof window._waitForAuthClient === 'function') return await window._waitForAuthClient();
      if (typeof window.getSupabaseClient === 'function') return await window.getSupabaseClient();
    } catch (e) { /* fall through */ }
    return window._supabaseClient || null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function css() {
    if (document.getElementById('share-nudge-css')) return;
    var s = document.createElement('style');
    s.id = 'share-nudge-css';
    s.textContent =
      '#shareNudge{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:340px;max-width:calc(100vw - 36px);'
      + 'background:#15140f;border:1px solid rgba(201,168,76,.45);border-radius:12px;padding:14px;'
      + 'box-shadow:0 18px 44px rgba(0,0,0,.6);font-size:13px;color:#e8e8e8;}'
      + '#shareNudge .sn-h{font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#C9A84C;margin-bottom:6px;}'
      + '#shareNudge .sn-b{line-height:1.45;color:#ddd;margin-bottom:10px;}'
      + '#shareNudge .sn-b strong{color:#fff;}'
      + '#shareNudge .sn-row{display:flex;gap:8px;align-items:center;}'
      + '#shareNudge button{font-family:inherit;font-size:12px;font-weight:600;border-radius:7px;padding:7px 12px;cursor:pointer;border:1px solid transparent;}'
      + '#shareNudge .sn-share{background:rgba(201,168,76,.16);border-color:rgba(201,168,76,.5);color:#C9A84C;}'
      + '#shareNudge .sn-share:disabled{opacity:.6;cursor:default;}'
      + '#shareNudge .sn-open{background:none;border-color:rgba(255,255,255,.16);color:#bbb;}'
      + '#shareNudge .sn-dismiss{background:none;border:none;color:#777;margin-left:auto;font-size:11px;}'
      + '#shareNudge .sn-msg{margin-top:8px;font-size:11px;color:#888;min-height:14px;}'
      + '#shareNudge .sn-msg.err{color:#F07878;}';
    document.head.appendChild(s);
  }

  function close() {
    var el = document.getElementById('shareNudge');
    if (el) el.remove();
    _open = false;
  }

  function render(row) {
    css();
    close();
    var el = document.createElement('div');
    el.id = 'shareNudge';
    el.innerHTML =
      '<div class="sn-h">Lead not shared with the VA</div>'
      + '<div class="sn-b"><strong>' + esc(row.order_label) + '</strong> started on <strong>'
      + esc(row.lead_name) + '</strong>, and she cannot see this lead.</div>'
      + '<div class="sn-row">'
        + '<button class="sn-share" id="snShare">Share with VA</button>'
        + '<button class="sn-open" id="snOpen">Open lead</button>'
        + '<button class="sn-dismiss" id="snDismiss">Not this one</button>'
      + '</div>'
      + '<div class="sn-msg" id="snMsg"></div>';
    document.body.appendChild(el);
    _open = true;

    var msg = function (t, isErr) {
      var m = document.getElementById('snMsg');
      if (m) { m.textContent = t || ''; m.className = 'sn-msg' + (isErr ? ' err' : ''); }
    };

    document.getElementById('snOpen').onclick = function () {
      location.href = '/admin/lead-detail?contact_id=' + encodeURIComponent(row.contact_id);
    };

    document.getElementById('snShare').onclick = async function () {
      var b = this;
      b.disabled = true;
      msg('Sharing…');
      try {
        /* The ONE share path. Not a second insert. */
        var va = await window.LeadShare.grant(row.contact_id);
        msg('Shared with ' + ((va && va.label) || 'the VA'));
        setTimeout(close, 1200);
      } catch (e) {
        b.disabled = false;
        msg('Could not share: ' + ((e && e.message) || 'try again'), true);
      }
    };

    document.getElementById('snDismiss').onclick = async function () {
      var b = this;
      b.disabled = true;
      try {
        var c = await client();
        var r = await c.rpc('share_nudge_dismiss', { p_contact_id: row.contact_id });
        if (r.error) throw r.error;
        close();
      } catch (e) {
        b.disabled = false;
        msg('Could not dismiss: ' + ((e && e.message) || 'try again'), true);
      }
    };
  }

  async function check() {
    if (_open) return;
    try {
      var c = await client();
      if (!c) return;
      var r = await c.rpc('share_nudges_pending');
      if (r.error) return;                       // not an admin, or unreadable — stay silent
      var rows = Array.isArray(r.data) ? r.data : [];
      if (!rows.length) return;
      /* Quiet hours suppress the POPUP only. The bell already has the row. */
      if (rows[0].quiet) return;
      var row = rows.find(function (x) { return !_shown[x.contact_id]; });
      if (!row) return;
      _shown[row.contact_id] = true;
      render(row);
    } catch (e) { /* never break the host page for a nudge */ }
  }

  function start() {
    check();
    setInterval(check, 5 * 60 * 1000);
  }

  window.ShareNudge = { check: check, close: close };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
