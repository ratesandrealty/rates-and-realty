/* inbox.js — Gmail inbox shared component (admin inbox, VA inbox, lead-detail viewer).
 * v=2026072804
 *
 * Talks ONLY to the `gmail-inbox` edge function. The mailbox is resolved server-side
 * from the caller's JWT role (admin=rene@|processing@, va=processing@ only, else 403);
 * this UI merely avoids offering what would 403.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 SECURITY — TWO SEPARATE HTML BOUNDARIES. Do not collapse them.
 *
 * 1) READING inbound mail: body_html is rendered ONLY inside a sandboxed iframe via
 *    srcdoc (no allow-scripts → scripts never execute). Raw HTML is never injected
 *    into the page DOM. Every other field is HTML-escaped.
 *
 * 2) COMPOSING outbound mail: every scrap of HTML that becomes the text/html MIME part
 *    goes through DOMPurify (vendored at /admin/js/vendor/purify.min.js — Cure53,
 *    v3.4.12, tarball sha1 verified against the npm registry). NO hand-rolled regex or
 *    allowlist sanitizer — that is exactly where XSS slips through.
 *
 *    Sanitization happens at THREE points, deliberately redundant:
 *      a. on paste into the editor (Word/Gmail paste drags in <script>/<style>/onerror)
 *      b. when quoted prior-message HTML is built for reply/forward — inbound content is
 *         attacker-controlled and is NEVER trusted just because it came from our thread
 *      c. on send, over the WHOLE composed body (your text + signature + quote) as the
 *         last gate before it becomes MIME
 *
 *    If DOMPurify is absent, sanitize() THROWS and the send is refused. Never degrade
 *    to sending unsanitized HTML.
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';
  var FN = 'gmail-inbox';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * SANITIZER — DOMPurify only. See the security note above.
   * ══════════════════════════════════════════════════════════════════════════ */

  // Email-safe profile. Tags/attrs here are what real mail clients render; everything
  // else is dropped. DOMPurify already kills event handlers and javascript: URIs — this
  // config narrows further, it does not replace those guarantees.
  var PURIFY_CFG = {
    ALLOWED_TAGS: [
      'p', 'div', 'span', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup',
      'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup',
      'img', 'font', 'center', 'small', 'big'
    ],
    ALLOWED_ATTR: [
      'href', 'title', 'target', 'rel', 'style', 'align', 'dir', 'lang',
      'src', 'alt', 'width', 'height', 'border',
      'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'valign', 'bgcolor',
      'color', 'face', 'size', 'class'
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // Belt-and-braces: these are already excluded by ALLOWED_TAGS/ATTR above.
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea',
      'select', 'button', 'meta', 'link', 'base', 'svg', 'math', 'template'],
    FORBID_ATTR: ['srcset', 'formaction', 'action', 'background', 'poster', 'xlink:href', 'ping'],
    // Link/image targets: real protocols + cid: (inline mail images) + inline base64 images.
    // Relative URLs are intentionally rejected — they are meaningless once the HTML is mail.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|cid:|data:image\/(?:png|gif|jpe?g|webp);base64,)/i,
    // ⚠ DOMPurify runs ALLOWED_URI_REGEXP against EVERY attribute value that is not marked
    // URI-safe — so without this list a strict regex silently eats colspan="2", width="120",
    // bgcolor="#eee" and friends, mangling quoted tables and images. These are presentational
    // and cannot carry script; marking them URI-safe skips only the URL check.
    ADD_URI_SAFE_ATTR: ['align', 'dir', 'lang', 'target', 'rel', 'width', 'height', 'border',
      'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'valign', 'bgcolor', 'color',
      'face', 'size'],
    KEEP_CONTENT: true,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    WHOLE_DOCUMENT: false
  };

  var _hookInstalled = false;
  function installHook() {
    if (_hookInstalled) return;
    var DP = window.DOMPurify;
    if (!DP || typeof DP.addHook !== 'function') return;
    DP.addHook('afterSanitizeAttributes', function (node) {
      // Any surviving link opens isolated. Harmless in a mail client, meaningful if this
      // HTML is ever re-rendered inside the CRM.
      if (node.tagName === 'A' && node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });

    /* ── CSS DECLARATION FILTER ────────────────────────────────────────────────
     * DOMPurify never URI-checks `style`: it ships in DEFAULT_URI_SAFE_ATTRIBUTES,
     * so ALLOWED_URI_REGEXP has never applied to CSS values. This is NOT fixable
     * through the allowlist — removing `style` would flatten every branded
     * signature — so it is filtered here instead.
     *
     * It matters because signature HTML renders in the MAIN admin document in three
     * places (composer signature node, Settings preview, Settings editor), not only
     * inside the sandboxed reading iframe. A position:fixed block in a signature
     * could cover the admin UI; a url() to an attacker host is a tracking beacon
     * that fires on page load.
     *
     * Drops the offending DECLARATION only, never the whole attribute — losing one
     * bad rule must not flatten the other 40 that make the block look right.
     *
     * Deliberately NOT checked: @import (needs a <style> element, which is in
     * FORBID_TAGS) and expression() (dead since IE10). Dead checks rot.            */
    // Split on top-level ';' only. A naive raw.split(';') corrupts inline images:
    // url(data:image/png;base64,…) contains a semicolon, so it would be cut in half
    // and the surviving fragment silently dropped as malformed.
    function splitDecls(s) {
      var out = [], buf = '', depth = 0;
      for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '(') depth++;
        else if (c === ')') depth = depth > 0 ? depth - 1 : 0;
        if (c === ';' && depth === 0) { out.push(buf); buf = ''; continue; }
        buf += c;
      }
      out.push(buf);
      return out;
    }
    DP.addHook('uponSanitizeAttribute', function (node, data) {
      if (data.attrName !== 'style') return;
      var raw = String(data.attrValue == null ? '' : data.attrValue);
      var kept = splitDecls(raw).filter(function (decl) {
        if (!decl.trim()) return false;
        var i = decl.indexOf(':');
        if (i < 0) return false;
        var prop = decl.slice(0, i).trim().toLowerCase();
        var val = decl.slice(i + 1);
        // Overlay vectors: a signature has no business escaping its own flow.
        if (prop === 'position' && /^\s*(fixed|absolute)\s*$/i.test(val)) return false;
        // Every url() in this declaration must be https: or an inline data:image.
        var re = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, m;
        while ((m = re.exec(val)) !== null) {
          if (!/^(?:https:|data:image\/)/i.test(m[2].trim())) return false;
        }
        return true;
      }).join(';');
      data.attrValue = kept;
    });
    _hookInstalled = true;
  }

  /** The ONLY way HTML is allowed to become outbound mail. Throws if DOMPurify is missing. */
  function sanitize(html) {
    var DP = window.DOMPurify;
    if (!DP || typeof DP.sanitize !== 'function') {
      throw new Error('Sanitizer (DOMPurify) failed to load — refusing to compose or send HTML. Reload the page.');
    }
    installHook();
    return DP.sanitize(String(html == null ? '' : html), PURIFY_CFG);
  }
  function sanitizerReady() {
    return !!(window.DOMPurify && typeof window.DOMPurify.sanitize === 'function');
  }

  /** Plain-text fallback derived from already-sanitized HTML. <template> content is inert. */
  function htmlToText(html) {
    var t = document.createElement('template');
    t.innerHTML = String(html == null ? '' : html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n');
    return (t.content.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  /* Sender avatar. No image source exists for arbitrary senders, so this is initials
   * on a colour derived from the address — stable per sender, which is what makes a
   * list scannable. Hue only; saturation/lightness fixed so every chip stays legible
   * against the dark rows and the dark initials stay readable on top. */
  function avatarHtml(name, email) {
    var key = String(email || name || '?').toLowerCase();
    var h = 0;
    for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
    var label = String(name || email || '?').trim();
    var parts = label.split(/[\s@._-]+/).filter(Boolean);
    var initials = parts.length > 1
      ? (parts[0][0] + parts[1][0])
      : (label.slice(0, 2) || '?');
    return '<span class="gm-av" style="background:hsl(' + h + ',52%,62%)" aria-hidden="true">' +
      esc(initials.toUpperCase()) + '</span>';
  }

  /* List-column timestamps, Gmail's rules: today is a time, yesterday is a word,
   * anything else is a date. The old version passed hour/minute to
   * toLocaleDateString for every row, so even year-old mail carried a clock time
   * that told you nothing and cost width in a 340px column.
   * A year appears ONLY for a previous calendar year — comparing calendar days,
   * not elapsed hours, so mail from 11pm last night reads "Yesterday" at 1am. */
  function fmtDate(d) {
    if (!d) return '';
    try {
      var dt = new Date(d);
      if (isNaN(dt.getTime())) return '';
      var now = new Date();
      var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var startOfDate = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
      var dayDiff = Math.round((startOfToday - startOfDate) / 86400000);
      if (dayDiff === 0) return dt.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
      if (dayDiff === 1) return 'Yesterday';
      var opts = { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' };
      if (dt.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
      return dt.toLocaleDateString('en-US', opts);
    } catch (_) { return ''; }
  }
  function resolveClient(opt) {
    return (opt && opt.client) || window._supabaseClient ||
      (window.getSupabaseClient && window.getSupabaseClient()) || null;
  }

  // ── edge-function call with verbatim server error surfacing (403 etc.) ──
  async function invoke(cl, mailbox, action, params) {
    var resp;
    try { resp = await cl.functions.invoke(FN, { body: Object.assign({ action: action, mailbox: mailbox }, params || {}) }); }
    catch (e) { throw new Error((e && e.message) || 'network error'); }
    if (resp.error) {
      var msg = resp.error.message || 'request failed';
      try { if (resp.error.context && resp.error.context.json) { var j = await resp.error.context.json(); if (j && j.error) msg = j.error; } } catch (_) {}
      throw new Error(msg);
    }
    if (resp.data && resp.data.error) throw new Error(resp.data.error);
    return resp.data;
  }

  // ── one-time scoped stylesheet (all selectors under .gm-*) ──
  function injectStyles() {
    if (document.getElementById('gm-inbox-styles')) return;
    var s = document.createElement('style');
    s.id = 'gm-inbox-styles';
    s.textContent = [
      /* ── SHELL ───────────────────────────────────────────────────────────────
       * A ROW: fixed-width rail | everything else. The old column layout stacked a
       * Compose row and a folder row above the panes, which cost two full-width
       * rows of vertical space to hold about a dozen controls. height:100% (not a
       * viewport calc) so the host page owns the sizing.                          */
      '.gm-inbox{--g:var(--gold,#c9a84c);display:flex;flex-direction:row;min-height:0;height:100%;width:100%;background:var(--surface,#111);border:1px solid var(--border2,rgba(255,255,255,.12));border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text,#fff)}',
      '.gm-rail{width:200px;flex-shrink:0;display:flex;flex-direction:column;gap:10px;padding:10px;border-right:1px solid var(--border,rgba(255,255,255,.08));background:#0d0d0d;overflow-y:auto;min-height:0}',
      '.gm-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}',
      '.gm-tb{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border,rgba(255,255,255,.08));flex-shrink:0}',
      /* Mailbox switcher. Deliberately NOT styled like the folder buttons below it:
       * choosing rene@ vs processing@ crosses a server-enforced security boundary
       * (a va is refused rene@ outright), so it must not read as another filter. */
      '.gm-sw{display:flex;flex-direction:column;gap:4px;padding:8px;border:1px solid rgba(201,168,76,.28);border-radius:9px;background:rgba(201,168,76,.05)}',
      '.gm-sw-l{font-size:9px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:rgba(201,168,76,.75);padding:0 2px 2px}',
      '.gm-sw button{display:flex;align-items:center;gap:6px;width:100%;text-align:left;padding:6px 8px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--muted,#999);font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.gm-sw button:hover{background:rgba(255,255,255,.05);color:#ddd}',
      '.gm-sw button.active{background:rgba(201,168,76,.18);color:var(--g);border-color:rgba(201,168,76,.5)}',
      '.gm-sw button .k{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0;opacity:.55}',
      '.gm-sw button.active .k{opacity:1}',
      /* Vertical folder list with unread badges. */
      '.gm-fold{display:flex;flex-direction:column;gap:2px}',
      '.gm-fold button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 9px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--muted,#999);font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.gm-fold button:hover{background:rgba(255,255,255,.05);color:#ddd}',
      '.gm-fold button.on{background:rgba(201,168,76,.14);color:var(--g);border-color:rgba(201,168,76,.35);font-weight:800}',
      '.gm-fold .i{font-size:13px;width:16px;flex-shrink:0;text-align:center}',
      '.gm-fold .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gm-fold .c{font-size:10.5px;font-weight:800;color:var(--g);background:rgba(201,168,76,.16);border-radius:9px;padding:1px 6px;flex-shrink:0}',
      '.gm-fold button.on .c{background:rgba(201,168,76,.28)}',
      '.gm-search{flex:1;min-width:150px;display:flex;gap:6px}',
      '.gm-search input{flex:1;min-width:0;background:#0d0d0d;border:1px solid var(--border2,rgba(255,255,255,.12));border-radius:8px;padding:8px 10px;color:#fff;font-size:13px;font-family:inherit}',
      '.gm-btn{background:rgba(201,168,76,.12);border:1px solid rgba(201,168,76,.4);color:var(--g);border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}',
      '.gm-btn:hover{background:rgba(201,168,76,.22)}',
      '.gm-btn.plain{background:transparent;border-color:var(--border2,rgba(255,255,255,.14));color:var(--muted,#aaa)}',
      '.gm-body{display:flex;flex:1;min-height:0}',
      // .gm-list is a COLUMN now: category tabs pinned on top, rows scrolling under
      // them. The tabs used to span the full width including the reading pane, where
      // they mean nothing — they only ever filtered this column.
      /* overflow-x:hidden is load-bearing, not belt-and-braces. `overflow-y:auto`
       * alone leaves overflow-x computing to `auto` (CSS overflow: a non-visible
       * value on one axis forces the other from visible to auto), so ANY child a
       * pixel too wide raises a horizontal scrollbar in this column. */
      '.gm-list{width:340px;flex-shrink:0;display:flex;flex-direction:column;min-height:0;overflow-x:hidden;border-right:1px solid var(--border,rgba(255,255,255,.08))}',
      // Exactly one scroll region per column. The page itself does not scroll, so the
      // two stacked scrollbars on the right edge collapse to one per pane.
      '.gm-rows{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden}',
      '.gm-pane{flex:1;overflow-y:auto;min-width:0;min-height:0;padding:0}',
      /* ── thread rows: exactly 3 lines, ~64px ───────────────────────────────
       * line 1 sender + filed chip + time, line 2 subject, line 3 snippet, with
       * an avatar column beside them.
       *
       * The three lines carry a FIXED 16px height rather than a unitless
       * line-height. A multiplier still lets a row grow — a tall glyph, an emoji
       * that falls back to a colour font with different metrics, or any wrap that
       * slips past white-space:nowrap — and that is how these rows drifted to
       * ~110px. 16×3 + 8 + 8 padding = 64px, and no content can change it.
       * The filed chip sits ON line 1 for the same reason: as its own row it was
       * a fourth line, which is where ~16px of the drift came from. */
      '.gm-row{display:flex;gap:9px;padding:8px 12px;border-bottom:1px solid var(--border,rgba(255,255,255,.06));cursor:pointer;align-items:flex-start;overflow:hidden}',
      '.gm-row:hover{background:rgba(255,255,255,.03)}',
      '.gm-row.active{background:rgba(201,168,76,.08)}',
      '.gm-row.unread .gm-row-subj{font-weight:800;color:#fff}',
      '.gm-av{width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#12100b;margin-top:2px;user-select:none}',
      '.gm-rowmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:0}',
      '.gm-row-top{display:flex;gap:6px;align-items:center;height:16px;line-height:16px;overflow:hidden}',
      '.gm-row-from{flex:1;min-width:0;font-size:12px;line-height:16px;color:#ddd;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.gm-row-date{font-size:10.5px;line-height:16px;color:var(--muted,#888);flex-shrink:0}',
      '.gm-att-mark{display:inline-flex;align-items:center;gap:2px;font-size:11px;line-height:16px;flex-shrink:0;opacity:.85}',
      '.gm-att-mark b{font-size:9.5px;font-weight:800;color:var(--muted,#999)}',
      '.gm-att-mark i{font-style:normal;font-size:9px;font-weight:700;color:var(--muted,#777);opacity:.9}',
      '.gm-row-subj{font-size:12.5px;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:16px;line-height:16px}',
      '.gm-row-snip{font-size:11.5px;color:var(--muted,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:16px;line-height:16px}',
      // Filed-to-lead chip. Inline on line 1 (see the row-height note above), and it
      // yields to the sender rather than pushing the date out of the row.
      '.gm-row-filed{display:inline-flex;align-items:center;max-width:44%;flex-shrink:1;min-width:0;font-size:9.5px;line-height:13px;font-weight:700;color:#7ee2a0;background:rgba(80,200,120,.13);border:1px solid rgba(80,200,120,.32);border-radius:8px;padding:0 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gm-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--g);margin-right:6px;vertical-align:middle}',
      '.gm-cnt{display:inline-block;font-size:10px;color:var(--muted,#888);border:1px solid var(--border2,rgba(255,255,255,.14));border-radius:9px;padding:0 5px;margin-left:6px}',
      '.gm-empty{padding:40px 20px;text-align:center;color:var(--muted,#888);font-size:13px}',
      /* Header is now ONE line: subject + filed chip + a ▾ actions menu, instead of
       * a subject line followed by a full row of Filed/Re-file/Unfile/Archive. */
      '.gm-phead{position:sticky;top:0;background:var(--surface,#111);border-bottom:1px solid var(--border,rgba(255,255,255,.08));padding:9px 14px;z-index:2;display:flex;align-items:center;gap:8px}',
      '.gm-psubj{font-size:14px;font-weight:800;color:#fff;margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gm-pacts{display:flex;gap:6px;align-items:center;flex-shrink:0}',
      '.gm-badge{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:12px;background:rgba(80,200,120,.14);color:#50c878;border:1px solid rgba(80,200,120,.4);white-space:nowrap;max-width:190px;overflow:hidden;text-overflow:ellipsis}',
      '.gm-badge.none{background:rgba(255,255,255,.05);color:var(--muted,#999);border-color:var(--border2,rgba(255,255,255,.14))}',
      /* Escrow-number suggestion. Sits under the header, in the flow — not a
       * toast and not a modal, because it must survive being ignored and stay
       * re-readable. Three weights, and the difference is deliberate:
       *   .quiet  — a confirmation, or a disagreement with a HUMAN's tag. One
       *             line, no buttons. Nagging somebody about a decision they
       *             made on purpose is how a suggestion gets tuned out.
       *   (base)  — an ordinary suggestion on an unfiled thread.
       *   .loud   — escrow disagrees with an AUTOMATIC match. This is the 947 N
       *             Alamo case and it is the reason the feature exists. */
      '.gm-esc{padding:9px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.08));font-size:12px;line-height:1.5;display:flex;flex-wrap:wrap;align-items:center;gap:8px;background:rgba(201,168,76,.08)}',
      '.gm-esc .t{flex:1;min-width:220px;color:#e8e2d0}',
      '.gm-esc b{color:#fff}',
      '.gm-esc code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;color:#f0e6c8}',
      '.gm-esc.quiet{background:rgba(255,255,255,.03);color:var(--muted,#999)}',
      '.gm-esc.quiet .t{color:var(--muted,#9a9a9a)}',
      '.gm-esc.loud{background:rgba(248,113,113,.10);border-bottom-color:rgba(248,113,113,.35)}',
      '.gm-esc.loud .t{color:#f4d6d6}',
      '.gm-esc .gm-btn{flex-shrink:0}',
      /* Collapsed older messages: one-line stubs. A 4-message thread opens showing
       * the newest message only, which is the one being replied to. */
      '.gm-stub{display:flex;align-items:baseline;gap:8px;padding:7px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,.06));cursor:pointer;font-size:12px}',
      '.gm-stub:hover{background:rgba(255,255,255,.04)}',
      '.gm-stub .w{font-weight:700;color:#ccc;flex-shrink:0;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gm-stub .s{flex:1;min-width:0;color:var(--muted,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gm-stub .d{color:var(--muted,#777);font-size:11px;flex-shrink:0}',
      '.gm-stub .gm-att-mark{margin-right:2px}',
      '.gm-stubbar{display:flex;align-items:center;gap:8px;padding:6px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,.06))}',
      '.gm-stubbar button{background:none;border:none;color:var(--g);font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;padding:0}',
      // Quoted-trailer toggle: the "On <date> <sender> wrote:" block is split out of
      // the message body and rendered only on request.
      '.gm-qtog{background:rgba(255,255,255,.08);border:none;border-radius:9px;color:#9a9a9a;font-size:12px;line-height:1;letter-spacing:1px;padding:2px 8px;margin:6px 0 0;cursor:pointer;font-family:inherit}',
      '.gm-qtog:hover{background:rgba(255,255,255,.16);color:#fff}',
      '.gm-msg{padding:12px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,.06))}',
      '.gm-mmeta{font-size:12px;color:var(--muted,#999);margin-bottom:8px;line-height:1.5}',
      '.gm-mdir{font-weight:700}',
      '.gm-frame{width:100%;border:1px solid var(--border2,rgba(255,255,255,.1));border-radius:8px;background:#fff;min-height:80px}',
      /* RECEIVED attachments, in the reading pane. Named .gm-rx-att, NOT .gm-att:
       * the composer's own attachment tray further down this stylesheet is also
       * .gm-att and is display:none until it gets .on. Same class, later rule,
       * so it won. The chips were being rendered correctly and then hidden —
       * which is why a thread Gmail showed as having an attachment appeared to
       * have none. Two different things must not share a class name. */
      '.gm-rx-atts{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}',
      '.gm-rx-att{display:inline-flex;align-items:center;gap:8px;max-width:300px;background:rgba(255,255,255,.05);border:1px solid var(--border2,rgba(255,255,255,.14));border-radius:8px;padding:6px 9px;font-size:11.5px;color:#ddd;cursor:pointer;font-family:inherit;text-align:left}',
      '.gm-rx-att:hover{background:rgba(201,168,76,.1);border-color:rgba(201,168,76,.4)}',
      '.gm-rx-att .ic{font-size:15px;flex-shrink:0}',
      '.gm-rx-att .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}',
      '.gm-rx-att .s{color:#888;flex-shrink:0;font-size:10.5px}',
      '.gm-rx-att .go{color:var(--g);flex-shrink:0;font-size:10.5px;font-weight:700}',
      '.gm-rx-att.busy{opacity:.55;cursor:default}',
      '.gm-rx-att.err{border-color:rgba(248,113,113,.5);color:#fca5a5}',
      /* hover preview card — body-portalled, position:fixed, so .gm-pane's
         overflow:auto cannot clip it (same reason as .gm-pop-menu) */
      '.gm-att-hover{position:fixed;z-index:10060;background:#141414;border:1px solid var(--border2,rgba(255,255,255,.18));border-radius:10px;padding:7px;box-shadow:0 14px 38px rgba(0,0,0,.6);max-width:290px;pointer-events:none}',
      '.gm-att-hover img{display:block;max-width:274px;max-height:340px;border-radius:6px;background:#fff}',
      '.gm-att-hover .cap{font-size:11px;color:#aaa;padding:5px 3px 1px;max-width:274px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gm-att-hover .cap.err{color:#fca5a5;white-space:normal}',
      /* full viewer modal */
      '.gm-av-ov{position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:10070;display:flex;align-items:center;justify-content:center;padding:20px}',
      '.gm-av-card{width:1000px;max-width:97vw;height:92vh;background:#111;border:1px solid var(--border2,rgba(255,255,255,.16));border-radius:13px;display:flex;flex-direction:column;overflow:hidden}',
      '.gm-av-hd{display:flex;align-items:center;gap:7px;padding:9px 12px;border-bottom:1px solid var(--border,rgba(255,255,255,.08));flex-shrink:0}',
      '.gm-av-name{font-size:13px;font-weight:700;color:#eee;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gm-av-pg{font-size:11.5px;color:#888;flex-shrink:0}',
      '.gm-av-hd .gm-btn{padding:5px 10px;font-size:12px}',
      '.gm-av-hd .gm-btn:disabled{opacity:.4;cursor:default}',
      '.gm-av-body{flex:1;min-height:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:16px;background:#0a0a0a}',
      '.gm-av-canvas{background:#fff;border-radius:6px;box-shadow:0 6px 26px rgba(0,0,0,.5);max-width:100%}',
      '.gm-av-img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px}',
      '.gm-av-msg{color:#999;font-size:13px;padding:32px;text-align:center}',
      '.gm-av-msg.err{color:#fca5a5}',
      /* ── composer ── */
      '.gm-acts{display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--border,rgba(255,255,255,.1))}',
      // Flex column so header / fields / toolbar / footer stay put and only .gm-scroll
      // moves. Without min-height:0 a flex child refuses to shrink below its content
      // and the "scroller" silently pushes the footer off-screen instead of scrolling.
      '.gm-cmp{border-top:2px solid var(--g);background:#0d0d0d;display:flex;flex-direction:column;min-height:0}',
      // The one scrolling region: body + signature + quote.
      '.gm-scroll{flex:1;min-height:0;overflow-y:auto;max-height:46vh}',
      '.gm-cmp-head{display:flex;align-items:center;gap:8px;padding:9px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,.08))}',
      '.gm-cmp-title{font-size:13px;font-weight:800;color:var(--g);flex:1;min-width:0}',
      '.gm-x{background:none;border:none;color:#888;font-size:20px;cursor:pointer;line-height:1;padding:0 4px;font-family:inherit}',
      '.gm-x:hover{color:#fff}',
      '.gm-fld{display:flex;align-items:flex-start;gap:8px;padding:6px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,.06))}',
      // 56px so the full word "Subject" fits without wrapping (was 40px for "Subj").
      '.gm-fld-l{font-size:12px;color:var(--muted,#888);width:56px;flex-shrink:0;padding-top:7px;font-weight:700}',
      '.gm-chips{flex:1;display:flex;flex-wrap:wrap;gap:5px;align-items:center;min-width:0}',
      '.gm-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;background:rgba(201,168,76,.14);border:1px solid rgba(201,168,76,.38);color:#f0e2be;border-radius:14px;padding:3px 9px;font-size:12px}',
      '.gm-chip.bad{background:rgba(248,113,113,.13);border-color:rgba(248,113,113,.5);color:#fca5a5}',
      '.gm-chip i{font-style:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gm-chip b{cursor:pointer;font-weight:700;opacity:.6;flex-shrink:0}',
      '.gm-chip b:hover{opacity:1}',
      '.gm-chips input{flex:1;min-width:110px;background:transparent;border:none;outline:none;color:#fff;font-size:13px;font-family:inherit;padding:5px 2px}',
      '.gm-ccbcc{display:flex;gap:4px;flex-shrink:0;padding-top:5px}',
      '.gm-ccbcc button{background:none;border:none;color:var(--muted,#888);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;padding:2px 5px;border-radius:5px}',
      '.gm-ccbcc button:hover{color:#fff;background:rgba(255,255,255,.06)}',
      '.gm-ccbcc button.on{color:var(--g)}',
      '.gm-subj{flex:1;min-width:0;background:transparent;border:none;outline:none;color:#fff;font-size:13px;font-weight:600;font-family:inherit;padding:5px 2px}',
      // ONE row, never wrapping: anything that doesn't fit lives in the "⋯" overflow
      // menu instead. flex-wrap:wrap is what put a lone ✕ on a second row.
      '.gm-tools{display:flex;gap:1px;padding:5px 12px;border-bottom:1px solid var(--border,rgba(255,255,255,.06));flex-wrap:nowrap;align-items:center;flex-shrink:0}',
      '.gm-tools button{min-width:30px;height:30px;border-radius:6px;border:1px solid transparent;background:transparent;color:#bbb;cursor:pointer;font-size:13px;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;padding:0 6px}',
      '.gm-tools button:hover{background:rgba(255,255,255,.08);color:#fff}',
      '.gm-tools .sep{width:1px;height:18px;background:var(--border2,rgba(255,255,255,.14));margin:0 5px;flex-shrink:0}',
      '.gm-tools button.wide{min-width:auto;padding:0 10px;font-size:11.5px;font-weight:700}',
      // Attach adds a FILE to the message; its neighbours insert content into the body.
      // Different job, different look — it was unfindable as another grey glyph.
      '.gm-tools button.accent{background:rgba(201,168,76,.13);border-color:rgba(201,168,76,.42);color:var(--g,#c9a84c);gap:4px}',
      '.gm-tools button.accent:hover{background:rgba(201,168,76,.24);color:#fff}',
      '.gm-tools select{height:30px;background:#0d0d0d;color:#ccc;border:1px solid var(--border2,rgba(255,255,255,.14));border-radius:6px;font-size:11.5px;font-family:inherit;padding:0 4px;max-width:104px;cursor:pointer}',
      '.gm-tools select:hover{color:#fff}',
      '.gm-emoji{display:flex;flex-wrap:wrap;gap:2px;max-height:210px;overflow-y:auto}',
      '.gm-emoji button{width:34px;height:34px;border:none;background:transparent;border-radius:7px;font-size:19px;cursor:pointer;line-height:1;padding:0}',
      '.gm-emoji button:hover{background:rgba(201,168,76,.18)}',
      '.gm-ai-note{font-size:10.5px;line-height:1.5;color:#8a8a8a;padding:7px 8px 2px;border-top:1px solid rgba(255,255,255,.08);margin-top:5px}',
      '.gm-ed img{max-width:100%;height:auto}',
      // No own scroller / max-height any more — .gm-scroll is the single scrolling
      // region, so the body just grows and the reclaimed signature height goes here.
      '.gm-ed{min-height:200px;padding:12px 16px;color:#fff;font-size:13.5px;line-height:1.6;outline:none;word-wrap:break-word}',
      '.gm-ed:empty:before{content:attr(data-ph);color:#666}',
      '.gm-ed a{color:#8ab4f8}',
      '.gm-ed ul,.gm-ed ol{padding-left:22px;margin:6px 0}',
      '.gm-ed blockquote{border-left:2px solid #444;margin:6px 0;padding-left:10px;color:#aaa}',
      '.gm-sig{padding:6px 16px 10px;color:#b8b8b8;font-size:12.5px;line-height:1.5;outline:none}',
      '.gm-sig:focus{background:rgba(255,255,255,.03)}',
      '.gm-sig-l{font-size:10px;color:#666;padding:0 16px;text-transform:uppercase;letter-spacing:.5px;font-weight:700}',
      /* ── collapsed signature (Gmail parity) ──────────────────────────────────
       * Rene's real signature is ~350px of branded HTML and swallowed the compose
       * area. Gmail hides it behind a small ••• affordance sitting inline where the
       * signature will go; expanding reveals the same editable node. Nothing about
       * send composition changes — the sig still lives in its own contentEditable. */
      '.gm-sig-wrap{padding:2px 16px 10px}',
      '.gm-sig-who{font-size:11px;color:#8a8475;padding:0 0 5px 1px}',
      '.gm-sig-who b{color:#c9c3b4;font-weight:600}',
      '.gm-sig-who .none{color:#8a8475;font-style:italic}',
      '.gm-sig-who .stale{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;font-size:9.5px;font-weight:700;background:rgba(224,82,82,.12);color:#E05252;border:1px solid rgba(224,82,82,.3)}',
      '.gm-sig-dots{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:18px;padding:0 7px;border:none;border-radius:9px;background:rgba(255,255,255,.10);color:#9a9a9a;font-size:12px;line-height:1;letter-spacing:1px;cursor:pointer;font-family:inherit}',
      '.gm-sig-dots:hover{background:rgba(255,255,255,.18);color:#fff}',
      '.gm-sig-dots.on{background:rgba(201,168,76,.20);color:var(--g,#c9a84c)}',
      /* ── attachment chips ── */
      '.gm-att{display:none;flex-wrap:wrap;gap:6px;padding:8px 16px;border-top:1px solid var(--border,rgba(255,255,255,.06));flex-shrink:0}',
      '.gm-att.on{display:flex}',
      '.gm-att-chip{display:inline-flex;align-items:center;gap:7px;max-width:290px;background:rgba(255,255,255,.06);border:1px solid var(--border2,rgba(255,255,255,.14));border-radius:8px;padding:5px 8px;font-size:11.5px;color:#ddd}',
      '.gm-att-chip .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gm-att-chip .s{color:#888;flex-shrink:0}',
      '.gm-att-chip .x{background:none;border:none;color:#888;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;flex-shrink:0}',
      '.gm-att-chip .x:hover{color:#f87171}',
      '.gm-att-chip.err{border-color:rgba(248,113,113,.5);color:#fca5a5}',
      '.gm-att-chip.busy{opacity:.6}',
      /* ── video recorder (ported from email-marketing.html) ── */
      '.gm-vid-box{display:flex;flex-direction:column;gap:8px;align-items:center}',
      '.gm-vid-box video{width:100%;max-width:320px;border-radius:8px;background:#000;display:block}',
      '.gm-vid-t{font-size:12px;color:#bbb;font-variant-numeric:tabular-nums}',
      '.gm-vid-row{display:flex;gap:8px;align-items:center}',
      '.gm-qt{padding:0 16px 10px}',
      '.gm-qt-btn{background:rgba(255,255,255,.06);border:1px solid var(--border2,rgba(255,255,255,.14));color:#999;border-radius:6px;padding:0 10px;font-size:14px;cursor:pointer;letter-spacing:2px;line-height:1.6;font-family:inherit}',
      '.gm-qt-btn:hover{color:#fff}',
      '.gm-qt-box{display:none;margin-top:8px;border-left:2px solid #333;padding-left:10px}',
      '.gm-qt-box.open{display:block}',
      '.gm-qt-frame{width:100%;border:0;background:#fff;border-radius:6px;min-height:60px}',
      /* 🔴 STICKY FOOTER: Send must never scroll out of reach. The composer's own
       * scroller is the .gm-pane / .gm-cmp ancestor, so sticky-bottom pins the bar to
       * the bottom of the visible composer instead of the bottom of a long document.
       * The background is opaque on purpose — a translucent bar lets the editor text
       * show through underneath the button. */
      '.gm-cmp-bar{position:sticky;bottom:0;z-index:3;display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid var(--border,rgba(255,255,255,.14));flex-wrap:wrap;background:#0d0d0d;box-shadow:0 -6px 14px rgba(0,0,0,.35)}',
      /* 🔴 SEND VISIBILITY — the "greyed out" bug.
       * --g is declared on .gm-inbox ONLY. openCompose()/openThread() portal the
       * composer into a .gm-modal on <body>, OUTSIDE .gm-inbox, so var(--g) there
       * resolved to nothing: `background:var(--g)` became invalid-at-computed-value-
       * time (→ transparent) while color stayed #161616 — near-black text on a
       * see-through button, which reads exactly like a disabled control. The literal
       * fallback below is what actually fixes it; --g is also declared on .gm-modal
       * so every other gold accent inside a portalled composer resolves too. */
      '.gm-send{background:var(--g,#c9a84c);border:1px solid var(--g,#c9a84c);color:#161616;border-radius:8px;padding:11px 24px;font-size:13.5px;font-weight:800;cursor:pointer;font-family:inherit;box-shadow:0 1px 0 rgba(255,255,255,.18) inset}',
      '.gm-send:hover:not(:disabled){filter:brightness(1.08)}',
      /* Disabled must read as deliberate, not broken: dimmed but still legible. */
      '.gm-send:disabled{background:rgba(201,168,76,.28);border-color:rgba(201,168,76,.4);color:rgba(22,22,22,.65);cursor:not-allowed;filter:none;box-shadow:none}',
      '.gm-why{font-size:11.5px;color:#8a8a8a;flex:1;min-width:110px}',
      /* ── AI assistant ── */
      '.gm-ai-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,.06));background:rgba(201,168,76,.04)}',
      '.gm-ai-btn{display:inline-flex;align-items:center;gap:5px;background:rgba(201,168,76,.1);border:1px solid rgba(201,168,76,.32);color:var(--g,#c9a84c);border-radius:16px;padding:5px 11px;font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}',
      '.gm-ai-btn:hover:not(:disabled){background:rgba(201,168,76,.2)}',
      '.gm-ai-btn:disabled{opacity:.45;cursor:default}',
      '.gm-ai-lbl{font-size:10.5px;font-weight:800;letter-spacing:.06em;color:#8a7a45;text-transform:uppercase;margin-right:2px}',
      '.gm-ai-out{margin:0 16px 10px;border:1px solid rgba(201,168,76,.3);background:rgba(201,168,76,.06);border-radius:9px;padding:11px 13px;font-size:12.5px;line-height:1.6;color:#e8e2d2;display:none}',
      '.gm-ai-out.on{display:block}',
      '.gm-ai-out h5{margin:0 0 5px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--g,#c9a84c)}',
      '.gm-ai-out .gm-ai-x{float:right;background:none;border:none;color:#888;cursor:pointer;font-size:15px;line-height:1;padding:0 2px}',
      '.gm-ai-out.bad{border-color:rgba(248,113,113,.45);background:rgba(248,113,113,.08);color:#fca5a5}',
      '.gm-ai-spin{display:inline-block;width:11px;height:11px;border:2px solid rgba(201,168,76,.3);border-top-color:var(--g,#c9a84c);border-radius:50%;animation:gm-spin .7s linear infinite;vertical-align:-1px}',
      '@keyframes gm-spin{to{transform:rotate(360deg)}}',
      /* ── signature toggle ── */
      '.gm-sig-tog{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:#9a9a9a;cursor:pointer;user-select:none;white-space:nowrap}',
      '.gm-sig-tog input{width:14px;height:14px;accent-color:var(--g,#c9a84c);cursor:pointer;margin:0}',
      '.gm-sig-tog.off{color:#6a6a6a}',
      '.gm-cmp-hint{flex:1;min-width:120px;font-size:11.5px;color:#666}',
      /* loud, persistent send result — replaces the old 2.6s toast */
      '.gm-note{margin:12px 16px 0;border-radius:9px;padding:11px 13px;font-size:12.5px;line-height:1.55;display:none}',
      '.gm-note.ok{display:block;background:rgba(80,200,120,.12);border:1px solid rgba(80,200,120,.45);color:#7ee2a0}',
      '.gm-note.bad{display:block;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.5);color:#fca5a5}',
      '.gm-note.warn{display:block;background:rgba(251,146,60,.1);border:1px solid rgba(251,146,60,.5);color:#fdba74}',
      '.gm-note b{display:block;font-size:13.5px;margin-bottom:3px}',
      '.gm-note code{background:rgba(0,0,0,.35);border-radius:4px;padding:1px 5px;font-size:11.5px;word-break:break-all}',
      '.gm-pop{position:relative;display:inline-block}',
      // NOTE: .gm-pop-menu is body-portalled by portalPopover (position:fixed set inline).
      // It must NOT be position:absolute — .gm-pane/.gm-list are overflow:auto and clip it.
      '.gm-pop-menu{z-index:10050;width:280px;max-width:78vw;background:#141414;border:1px solid var(--border2,rgba(255,255,255,.16));border-radius:10px;padding:8px;box-shadow:0 12px 30px rgba(0,0,0,.5)}',
      /* ── compose button, folders, category tabs ── */
      // Full-width at the top of the rail, Gmail-style.
      '.gm-compose{display:block;width:100%;background:var(--g);border:1px solid var(--g);color:#161616;border-radius:9px;padding:9px 12px;font-size:12.5px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0}',
      '.gm-compose:hover{filter:brightness(1.08)}',
      /* ── CATEGORIES in the rail ──────────────────────────────────────────────
       * Was a horizontal tab strip pinned above the thread rows. Five nowrap tabs
       * (~440px of buttons) inside a 340px column meant the strip's own
       * overflow-x:auto drew a horizontal scrollbar across the top of the list —
       * the scrollbar in this column. Moving them here removes the overflow source
       * outright rather than hiding it.
       *
       * Deliberately NOT styled like .gm-fold. Categories are slices of Inbox, not
       * peers of Sent/Trash, so they read as subordinate: grouped under a heading
       * that matches the MAILBOX label above, indented past the folder icon column,
       * smaller and lighter, with a dot instead of an icon. */
      '.gm-cats{display:flex;flex-direction:column;gap:1px;margin-top:2px}',
      '.gm-cats-l{font-size:9px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:rgba(255,255,255,.32);padding:6px 2px 3px 9px}',
      /* Scoped rail: narrower, and the chip is deliberately styled as a LABEL —
         no border-radius pill, no hover, no pointer — so it does not read as one
         more filter button next to the ones that are gone. */
      '.gm-rail-scoped{width:216px;gap:12px}',
      '.gm-scope{padding:10px 11px;border-radius:9px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07)}',
      '.gm-scope-l{font-size:9px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:rgba(255,255,255,.32);margin-bottom:5px}',
      '.gm-scope-v{font-size:11.5px;line-height:1.45;color:rgba(255,255,255,.82);word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.gm-scope-n{margin-top:7px;font-size:10.5px;line-height:1.45;color:rgba(255,255,255,.38)}',
      '.gm-cats button{display:flex;align-items:center;gap:7px;width:100%;text-align:left;padding:5px 9px 5px 20px;border-radius:6px;border:1px solid transparent;background:transparent;color:rgba(255,255,255,.5);font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.gm-cats button:hover{background:rgba(255,255,255,.04);color:#ccc}',
      '.gm-cats button.on{background:rgba(201,168,76,.09);color:var(--g);font-weight:700}',
      '.gm-cats .d{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.5;flex-shrink:0}',
      '.gm-cats button.on .d{opacity:1}',
      '.gm-cats .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gm-cats .c{font-size:10px;font-weight:800;color:var(--g);background:rgba(201,168,76,.14);border-radius:9px;padding:0 5px;flex-shrink:0}',
      '.gm-hint{padding:8px 14px;font-size:11.5px;line-height:1.5;color:#fdba74;background:rgba(251,146,60,.09);border-bottom:1px solid rgba(251,146,60,.3);flex-shrink:0}',
      '.gm-draft-tag{display:inline-block;font-size:9.5px;font-weight:800;letter-spacing:.4px;color:#fca5a5;border:1px solid rgba(248,113,113,.45);border-radius:4px;padding:0 4px;margin-right:6px;vertical-align:middle}',
      /* ── compose modal sizing ────────────────────────────────────────────────
       * height:auto let the card grow to fit its content, so the CTA row and footer
       * ended up clipped at the bottom of the viewport. A definite height gives the
       * inner flex column something to divide up, which is what lets the body
       * scroll while the header, toolbar and Send bar stay visible. */
      '.gm-modal .gm-modal-card.gm-compose-card{height:86vh;max-height:92vh}',
      // .gm-pane normally scrolls; in the compose modal the inner .gm-scroll owns
      // scrolling instead, so this ancestor must not also scroll.
      '.gm-compose-card .gm-pane{overflow:hidden;display:flex;flex-direction:column;min-height:0}',
      '.gm-compose-card .gm-pane>[data-gm="cmp"]{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.gm-compose-card .gm-cmp{flex:1;min-height:0}',
      // In the modal the scroller takes all remaining height; the 46vh cap is only
      // for the inline (reply-in-thread) case where the pane itself scrolls.
      '.gm-compose-card .gm-scroll{max-height:none}',
      /* ── recipient autocomplete (body-portalled, position:fixed) ── */
      '.gm-ac{background:#141414;border:1px solid var(--border2,rgba(255,255,255,.18));border-radius:10px;padding:5px;box-shadow:0 14px 36px rgba(0,0,0,.6);max-height:260px;overflow-y:auto}',
      '.gm-ac-item{display:flex;align-items:center;gap:8px;padding:8px 9px;border-radius:7px;cursor:pointer;font-size:12.5px}',
      '.gm-ac-item.on,.gm-ac-item:hover{background:rgba(201,168,76,.14)}',
      '.gm-ac-n{color:#eee;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42%}',
      '.gm-ac-e{color:var(--muted,#888);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}',
      '.gm-ac-k{font-size:9.5px;font-weight:800;letter-spacing:.3px;padding:2px 6px;border-radius:9px;flex-shrink:0;text-transform:uppercase}',
      '.gm-ac-k.k-contact{background:rgba(80,200,120,.16);color:#7ee2a0}',
      '.gm-ac-k.k-directory{background:rgba(96,160,255,.16);color:#8ab4f8}',
      '.gm-ac-k.k-history{background:rgba(255,255,255,.08);color:#aaa}',
      '.gm-pop-menu input{width:100%;background:#0a0a0a;border:1px solid var(--border2,rgba(255,255,255,.14));border-radius:7px;padding:8px;color:#fff;font-size:13px;font-family:inherit;box-sizing:border-box}',
      '.gm-pop-res{max-height:220px;overflow-y:auto;margin-top:6px}',
      '.gm-pop-item{padding:8px 9px;border-radius:6px;cursor:pointer;font-size:12.5px;color:#eee}',
      // The AI menu renders <button data-ai> as menu rows, so strip button chrome and
      // let them fill the popover width like the <div> items do.
      'button.gm-pop-item{display:block;width:100%;text-align:left;background:none;border:none;font-family:inherit}',
      'button.gm-pop-item:disabled{opacity:.5;cursor:default}',
      '.gm-pop-item:hover{background:rgba(201,168,76,.12)}',
      '.gm-pop-item .e{color:var(--muted,#888);font-size:11px}',
      '.gm-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1a1a1a;border:1px solid var(--g);color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.5)}',
      '.gm-back{display:none}',
      /* modal (lead-detail viewer) */
      // --g is redeclared here because .gm-modal is portalled to <body>, outside
      // .gm-inbox where it is normally defined. See the .gm-send note above — this
      // is the other half of the greyed-out-Send fix.
      '.gm-modal{--g:var(--gold,#c9a84c);position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9998;display:flex;align-items:center;justify-content:center;padding:20px}',
      /* 820px was the narrow column in the thread reader and its reply composer.
       * The composer has no width of its own — .gm-cmp is a plain flex column —
       * so it is this card that sized it, not the host element and not the
       * reader. (The HOI quote-request modal's 680px, widened separately, is a
       * different overlay entirely and was never this one.)
       *
       * WHAT MOVES WITH IT — everything that opens WITHOUT a host, i.e. modal
       * mode: the Email Threads reader (lead-detail :16388, :16503, :16641) and
       * the standalone composer (:16792), since .gm-compose-card overrides only
       * height and inherits this width.
       *
       * WHAT DOES NOT — openThread WITH a host renders inline and has never been
       * constrained by this (lead-detail :14233, the order-card threads), and
       * GmailInbox.mount() is the full three-column flex layout used by
       * /admin/inbox, /admin/va-inbox and the in-page panels, which does not use
       * .gm-modal at all.
       *
       * max-width:96vw is kept, so on a laptop the card still fills the viewport
       * less the overlay's 20px padding; the cap only decides how much of a wide
       * screen it may use. */
      '.gm-modal .gm-modal-card{width:1180px;max-width:96vw;height:86vh;background:var(--surface,#111);border:1px solid var(--border2,rgba(255,255,255,.14));border-radius:14px;display:flex;flex-direction:column;overflow:hidden}',
      '.gm-modal-close{background:none;border:none;color:#999;font-size:22px;cursor:pointer;line-height:1}',
      '@media (min-width:769px) and (max-width:1199px){',
      '  .gm-rail{width:172px}',
      '  .gm-list{width:290px}',
      '  .gm-ed{max-height:34vh}',
      '}',
      '@media (max-width:768px){',
      // Phone: a 200px rail beside a 100%-wide list leaves nothing for either, so the
      // shell goes back to a column and the rail becomes a horizontal strip.
      '  .gm-inbox{flex-direction:column;height:auto;min-height:calc(100vh - 90px)}',
      '  .gm-rail{width:100%;flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px;padding:8px;border-right:none;border-bottom:1px solid var(--border,rgba(255,255,255,.08));overflow-x:auto}',
      '  .gm-sw{flex-direction:row;align-items:center;padding:4px 6px}',
      '  .gm-sw-l{display:none}',
      '  .gm-fold{flex-direction:row;gap:6px;flex:1;min-width:0;overflow-x:auto}',
      '  .gm-fold button{width:auto;min-height:38px;padding:8px 12px;flex-shrink:0}',
      /* Phone: the rail is a horizontal strip, so the category group becomes one too
       * and its heading would only eat width. It scrolls inside itself here — that is
       * safe because the rail is its own row, not stacked over the thread list. */
      '  .gm-cats{flex-direction:row;gap:6px;flex-basis:100%;min-width:0;overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:0}',
      '  .gm-cats-l{display:none}',
      '  .gm-cats button{width:auto;min-height:36px;padding:6px 12px;flex-shrink:0}',
      /* Scoped rail on a phone: the strip holds only a switcher and a text chip,
         so let the chip take the full row rather than being squeezed to nothing. */
      '  .gm-rail-scoped{width:100%}',
      '  .gm-scope{flex-basis:100%;min-width:0;padding:8px 10px}',
      '  .gm-scope-n{display:none}',
      '  .gm-list{width:100%}',
      '  .gm-body .gm-pane{display:none}',
      '  .gm-inbox.gm-show-pane .gm-list{display:none}',
      '  .gm-inbox.gm-show-pane .gm-pane{display:block}',
      '  .gm-back{display:inline-flex}',
      '  .gm-modal{padding:0}.gm-modal .gm-modal-card{width:100vw;max-width:100vw;height:100vh;border-radius:0}',
      /* composer on a phone: full-width taps, no cramped 30px targets */
      '  .gm-acts{padding:12px}',
      '  .gm-acts button{flex:1;min-width:calc(33% - 6px);min-height:44px}',
      '  .gm-fld,.gm-cmp-head,.gm-cmp-bar{padding-left:12px;padding-right:12px}',
      '  .gm-ed{padding:12px;min-height:150px;max-height:none}',
      '  .gm-sig,.gm-sig-l,.gm-qt{padding-left:12px;padding-right:12px}',
      '  .gm-note{margin-left:12px;margin-right:12px}',
      '  .gm-tools{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;padding:5px 8px}',
      '  .gm-tools button{min-width:38px;height:38px;flex-shrink:0}',
      '  .gm-tools button.wide{min-width:auto;padding:0 12px}',
      '  .gm-tools select{height:38px;flex-shrink:0;max-width:92px}',
      '  .gm-emoji button{width:40px;height:40px}',
      '  .gm-tools .sep{flex-shrink:0}',
      '  .gm-send{flex:1;min-height:46px;padding:12px 22px;order:-1}',   /* Send first in the bar on a phone */
      '  .gm-cmp-hint,.gm-why{order:3;flex-basis:100%;min-width:0}',
      /* The sticky bar is the one thing that must stay reachable on mobile; give it
       * safe-area padding so it clears the iOS home indicator. */
      '  .gm-cmp-bar{padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}',
      '  .gm-ai-bar{padding:8px 12px;flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch}',
      '  .gm-ai-btn{min-height:38px;flex-shrink:0}',
      '  .gm-ai-lbl{flex-shrink:0}',
      '  .gm-ai-out{margin-left:12px;margin-right:12px}',
      '  .gm-sig-tog{min-height:38px}',
      '  .gm-compose{min-height:40px;padding:9px 16px;width:auto;order:-1}',
      '  .gm-ac{max-height:46vh}',
      '  .gm-ac-n{max-width:100%}',
      '  .gm-ac-item{flex-wrap:wrap;gap:4px 8px;padding:10px 9px}',
      '  .gm-ac-e{flex-basis:100%}',
      // Same specificity as the desktop compose-card rule above, or that one wins here too
      // and the phone composer stops being full-screen.
      '  .gm-modal .gm-modal-card.gm-compose-card{height:100vh;max-height:100vh}',
      '}',
      '@media (max-width:480px){',
      '  .gm-fld{flex-wrap:wrap;gap:4px}',
      '  .gm-fld-l{width:100%;padding-top:2px}',
      '  .gm-ccbcc{padding-top:0}',
      '  .gm-acts button{min-width:calc(50% - 6px)}',
      '  .gm-chips input{min-width:100%}',
      '  .gm-compose{width:100%;border-radius:10px}',
      '  .gm-tb{gap:6px}',
      '  .gm-fold button .i{margin:0}',
      '  .gm-ai-btn{padding:5px 9px;font-size:11px}',
      '  .gm-sig-tog{flex-basis:100%;order:2}',
      '}',
      '@media (min-width:769px) and (max-width:1199px){',
      '  .gm-ai-btn{padding:5px 9px}',
      '}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── wrap an email body for the sandboxed iframe (html rendered as-is; text escaped) ──
  function wrapBody(html, text) {
    var inner = (html && html.trim())
      ? html
      : (text ? '<pre style="white-space:pre-wrap;font-family:inherit;margin:0">' + esc(text) + '</pre>' : '<p style="color:#999">No content</p>');
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>' +
      // Hygiene, NOT the clipping fix (that is the IntersectionObserver in autoFit). Marketing
      // templates set height:100% on <html>/<body> — Plaza's rate sheet does — which makes a
      // 100%-height wrapper stretch against the iframe viewport instead of the content. It was
      // measured not to affect scrollHeight in Chrome, but it keeps such templates laying out
      // sanely. Must stay above the reset below.
      'html,body{height:auto!important;min-height:0!important;max-height:none!important}' +
      'body{margin:0;padding:14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;background:#fff;line-height:1.5;word-wrap:break-word;overflow-x:auto}' +
      'img{max-width:100%;height:auto}a{color:#1155cc}' +
      'blockquote{border-left:3px solid #ddd;margin:0;padding-left:12px;color:#555}' +
      '</style></head><body>' +
      // A wrapper whose height is PURE CONTENT. body/documentElement heights are
      // max(content, viewport) and the viewport is the iframe's own height, which
      // is what made fitFrame a ratchet. A div has no viewport floor.
      '<div id="__fit">' + inner + '</div>' +
      '</body></html>';
  }

  /**
   * Size an email iframe to its real content height.
   *
   * body.scrollHeight alone is unreliable: it under-reports for floated/absolutely positioned
   * layouts and for documents whose root is the scrolling box, so take the max of both
   * elements' scroll/offset heights. `cap` is only used for the composer's quote preview —
   * message bodies are never capped, they expand and the pane scrolls (Gmail behavior).
   */
  function fitFrame(f, cap) {
    try {
      var d = f.contentDocument;
      if (!d || !d.body) return;

      /* COLLAPSE BEFORE MEASURING. This is the whole fix, and without it the
       * function is a ratchet that can only grow.
       *
       * documentElement.scrollHeight/offsetHeight return max(content, VIEWPORT),
       * and the viewport of an iframe is its own current height. So each call
       * measured at least the height set by the previous call, then added 28 —
       * and autoFit calls this a lot: onload, +120ms, +600ms, the 900ms
       * backstop, once per image, and once per ResizeObserver firing, which the
       * height change itself triggers. An iframe starts at the HTML default of
       * 150px, so roughly fourteen passes gives 150 + 14×28 ≈ 542px. That is the
       * ~550px card holding 151 characters — the number is arithmetic, not
       * content.
       *
       * Setting height to 0 first forces the document to report CONTENT height.
       * It happens inside one synchronous block, so there is no paint between
       * the collapse and the restore and nothing flickers. */
      /* Measure the wrapper if wrapBody built one — its height is content only,
       * with no viewport floor, so this is exact and needs no collapse. The
       * collapse path below stays for any frame not built by wrapBody. */
      var fit = d.getElementById('__fit');
      if (fit) {
        var fh = Math.max(fit.scrollHeight, Math.ceil(fit.getBoundingClientRect().height));
        if (fh) {
          var want = (cap ? Math.min(fh + 24, cap) : fh + 28);
          var now = parseInt(f.style.height, 10) || 0;
          if (Math.abs(now - want) > 2) f.style.height = want + 'px';
          return;
        }
      }
      var prev = f.style.height;
      f.style.height = '0px';
      var de = d.documentElement;
      var h = Math.max(
        d.body.scrollHeight, d.body.offsetHeight,
        de ? de.scrollHeight : 0, de ? de.offsetHeight : 0
      );
      if (!h) { f.style.height = prev; return; }
      var next = (cap ? Math.min(h + 24, cap) : h + 28);

      /* Don't rewrite a height that is already right. A ResizeObserver watching
       * a body whose size we just changed will fire again; if every firing wrote
       * a new value, the two would chase each other forever. */
      var cur = parseInt(prev, 10) || 0;
      f.style.height = (Math.abs(cur - next) <= 2 ? cur : next) + 'px';
    } catch (_) { if (!f.style.height) f.style.height = (cap || 360) + 'px'; }
  }

  /**
   * Fit now, then again as late images/webfonts land, then keep fitting if the doc reflows.
   *
   * 🔴 THE CLIPPING BUG: an iframe measured while ANY ancestor is display:none reports
   * scrollHeight 0, so the height locks to ~28px — a sliver — and never recovers, because
   * nothing re-measures once it becomes visible. Reproduced in Chrome: visible → 1948px,
   * hidden-at-load → 28px permanently. That happens whenever the frame is filled while its
   * pane is hidden — the ≤768px pane is display:none until .gm-show-pane is set, and any
   * tab/modal that renders before it is shown hits the same path.
   *
   * The IntersectionObserver below is the actual fix: the moment the frame has layout, it
   * re-measures. onload alone is not enough.
   */
  function autoFit(f, cap) {
    function fitSoon() {
      fitFrame(f, cap);
      // iframe onload waits for subresources, but conditional/lazy images, webfonts and
      // client-side reflow can still land after it.
      setTimeout(function () { fitFrame(f, cap); }, 120);
      setTimeout(function () { fitFrame(f, cap); }, 600);
    }
    f.onload = function () {
      fitSoon();
      try {
        var w = f.contentWindow;
        if (w && w.ResizeObserver) {
          new w.ResizeObserver(function () { fitFrame(f, cap); }).observe(f.contentDocument.body);
        }
        Array.prototype.forEach.call(f.contentDocument.images || [], function (im) {
          if (!im.complete) im.addEventListener('load', function () { fitFrame(f, cap); });
        });
      } catch (_) {}
    };
    // Re-measure as soon as the frame actually has layout (covers hidden-at-load).
    try {
      if (window.IntersectionObserver) {
        var io = new window.IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting || entries[i].intersectionRatio > 0) { fitSoon(); }
          }
        });
        io.observe(f);
      }
    } catch (_) {}
    // Belt and braces for engines/paths where IO does not fire (e.g. a pane toggled from
    // display:none to block without scrolling): if the frame is still a sliver but its
    // document has real content, fix it up.
    setTimeout(function () {
      try {
        if ((parseInt(f.style.height, 10) || 0) < 60 && f.offsetParent !== null) fitFrame(f, cap);
      } catch (_) {}
    }, 900);
  }

  function toast(msg) {
    var t = document.createElement('div'); t.className = 'gm-toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600);
  }

  /**
   * Portal a popover to <body> as position:fixed, anchored to `anchorEl`.
   *
   * 🔴 Do NOT use position:absolute for popovers in this component. .gm-list and .gm-pane are
   * overflow-y:auto, so an absolutely-positioned menu inside them gets CLIPPED at the scroller
   * edge — the original tag popover shipped with exactly that bug. Fixed + body-portal escapes
   * every ancestor's overflow and stacking context.
   *
   * Repositions on capture-phase scroll (so inner scrollers count, not just the window),
   * flips above the anchor when there's no room below, and self-destructs on Escape or an
   * outside mousedown.
   */
  function portalPopover(anchorEl, el, opts) {
    opts = opts || {};
    el.style.position = 'fixed';
    el.style.zIndex = '10050';
    document.body.appendChild(el);

    function place() {
      var r = anchorEl.getBoundingClientRect();
      var w = opts.width || Math.max(r.width, 260);
      w = Math.min(w, window.innerWidth - 16);
      el.style.width = w + 'px';
      el.style.left = Math.round(Math.min(Math.max(8, r.left), window.innerWidth - w - 8)) + 'px';
      var h = el.offsetHeight || 220;
      var below = window.innerHeight - r.bottom;
      if (below < h + 12 && r.top > below) el.style.top = Math.round(Math.max(8, r.top - h - 6)) + 'px';
      else el.style.top = Math.round(r.bottom + 6) + 'px';
    }
    place();

    var closed = false;
    function onMove() { if (!closed) place(); }
    function onDoc(e) { if (!el.contains(e.target) && !anchorEl.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    document.addEventListener('keydown', onKey);
    // Deferred so the click that opened this popover doesn't immediately close it.
    setTimeout(function () { if (!closed) document.addEventListener('mousedown', onDoc); }, 0);

    function close() {
      if (closed) return;
      closed = true;
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDoc);
      if (el.parentNode) el.parentNode.removeChild(el);
      if (opts.onClose) opts.onClose();
    }
    return { close: close, place: place, el: el };
  }

  // ── recipient autocomplete (email_recipient_search) ──
  var KIND_LABEL = { contact: 'Contact', directory: 'Directory', history: 'Recent' };

  /**
   * Wire type-ahead onto a chip input. `addFn(email)` adds the chip.
   * MUST be attached BEFORE the field's own keydown handler: on Enter with a highlighted
   * row we call stopImmediatePropagation() so the suggestion wins instead of the raw text
   * being committed. At the target phase listeners run in registration order, so ordering
   * here is what makes that work — capture:true alone would not.
   */
  function attachAutocomplete(inp, cl, addFn) {
    var pop = null, items = [], idx = -1, timer = null;

    function closePop() { if (pop) { var p = pop; pop = null; p.close(); } items = []; idx = -1; }
    function highlight() {
      if (!pop) return;
      Array.prototype.forEach.call(pop.el.querySelectorAll('[data-i]'), function (n, i) {
        n.classList.toggle('on', i === idx);
        if (i === idx && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
      });
    }
    function choose(i) {
      var r = items[i];
      if (!r) return;
      addFn(r.email);
      inp.value = '';
      closePop();
      inp.focus();
    }
    function render(rows) {
      items = rows || [];
      if (!items.length) { idx = -1; closePop(); return; }
      // Pre-highlight row 0 (Gmail does) EXCEPT when what's typed is already a complete
      // address: "bob@acme.com" can still surface substring matches, and auto-selecting one
      // would silently replace the address the user actually typed when they press Enter.
      // idx = -1 leaves Enter to the field's raw-text commit; ↓ still reaches the list.
      idx = RE_EMAIL.test(inp.value.trim()) ? -1 : 0;
      var el = pop ? pop.el : document.createElement('div');
      el.className = 'gm-ac';
      el.innerHTML = items.map(function (r, i) {
        var k = KIND_LABEL[r.kind] || r.kind || '';
        return '<div class="gm-ac-item' + (i === idx ? ' on' : '') + '" data-i="' + i + '">' +
          '<span class="gm-ac-n">' + esc(r.name || r.email) + '</span>' +
          '<span class="gm-ac-e">' + esc(r.email) + '</span>' +
          '<span class="gm-ac-k k-' + esc(r.kind || '') + '">' + esc(k) + '</span></div>';
      }).join('');
      if (!pop) {
        pop = portalPopover(inp, el, {
          width: Math.max(inp.getBoundingClientRect().width, 320),
          onClose: function () { pop = null; }
        });
      } else pop.place();
      Array.prototype.forEach.call(el.querySelectorAll('[data-i]'), function (it) {
        // mousedown + preventDefault: keeps focus in the input so the field's blur-commit
        // doesn't fire and turn the half-typed query into a bogus chip.
        it.addEventListener('mousedown', function (e) { e.preventDefault(); choose(+it.getAttribute('data-i')); });
      });
      pop.place();
    }

    inp.addEventListener('input', function () {
      var q = inp.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { closePop(); return; }
      timer = setTimeout(function () {
        cl.rpc('email_recipient_search', { p_q: q, p_limit: 8 }).then(function (r) {
          if (inp.value.trim() !== q) return;      // a newer keystroke already won
          if (r.error) { closePop(); return; }
          render(Array.isArray(r.data) ? r.data : []);
        }).catch(function () { closePop(); });
      }, 200);
    });

    inp.addEventListener('keydown', function (e) {
      if (!items.length || !pop) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % items.length; highlight(); }
      // From the "nothing selected" state (idx -1) ArrowUp means "last row", not n-2.
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length; highlight(); }
      else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); e.stopImmediatePropagation(); choose(idx); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closePop(); }
    });

    inp.addEventListener('blur', function () { setTimeout(closePop, 150); });
    return { close: closePop };
  }

  // ── contact search (returns contact_id) for the Tag flow ──
  async function searchContacts(cl, q) {
    q = (q || '').trim(); if (q.length < 2) return [];
    var like = '%' + q.replace(/[%,()]/g, ' ') + '%';
    var r = await cl.from('contacts').select('id,first_name,last_name,email')
      .or('first_name.ilike.' + like + ',last_name.ilike.' + like + ',email.ilike.' + like).limit(8);
    if (r.error) return [];
    return (r.data || []).map(function (c) {
      return { id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)', email: c.email || '' };
    });
  }
  async function contactName(cl, id) {
    if (!id) return null;
    var r = await cl.from('contacts').select('first_name,last_name').eq('id', id).limit(1);
    if (r.error || !r.data || !r.data.length) return null;
    var c = r.data[0]; return [c.first_name, c.last_name].filter(Boolean).join(' ') || null;
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * COMPOSER
   * ══════════════════════════════════════════════════════════════════════════ */

  var RE_EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

  // "Name <a@b.com>, c@d.com" → ['a@b.com','c@d.com'] (lowercased)
  function parseAddrs(s) {
    return String(s == null ? '' : s).split(/[,;]/).map(function (x) { return x.trim(); })
      .filter(Boolean).map(function (x) {
        var m = x.match(/<([^>]+)>/);
        return (m ? m[1] : x).trim().toLowerCase();
      }).filter(Boolean);
  }
  function dedupe(list, exclude) {
    var seen = {}, out = [];
    (exclude || []).forEach(function (e) { if (e) seen[String(e).toLowerCase()] = 1; });
    (list || []).forEach(function (e) {
      e = String(e || '').trim().toLowerCase();
      if (e && !seen[e]) { seen[e] = 1; out.push(e); }
    });
    return out;
  }
  function baseSubject(s) {
    var v = String(s == null ? '' : s);
    for (var i = 0; i < 5; i++) {
      var n = v.replace(/^\s*(re|fwd|fw)\s*:\s*/i, '');
      if (n === v) break;
      v = n;
    }
    return v.trim();
  }

  // ── signature (email_signature_get — admin + va/loa/agent/staff may read) ──
  var _sigCache = {};
  async function getSignature(cl, mailbox) {
    if (Object.prototype.hasOwnProperty.call(_sigCache, mailbox)) return _sigCache[mailbox];
    var v = '';
    try {
      var r = await cl.rpc('email_signature_get', { p_mailbox: mailbox });
      if (!r.error && r.data) v = String(r.data);
    } catch (_) { v = ''; }
    _sigCache[mailbox] = v;
    return v;
  }

  /* Identity behind the signature, for the line the composer shows before you
     send. Separate RPC from email_signature_get so the UI never has to parse a
     signature blob to find out whose name is in it. */
  var _idCache = {};
  async function getSignatureIdentity(cl, mailbox) {
    if (Object.prototype.hasOwnProperty.call(_idCache, mailbox)) return _idCache[mailbox];
    var v = null;
    try {
      var r = await cl.rpc('email_signature_identity', { p_mailbox: mailbox });
      if (!r.error && r.data) v = r.data;
    } catch (_) { v = null; }
    _idCache[mailbox] = v;
    return v;
  }

  function renderSigWho(node, id, mailbox) {
    if (!node) return;
    if (!id || !id.display_name) {
      /* HONEST DEGRADATION, matching the signature itself: no name set means the
         mail goes out as the company block alone. Say that plainly rather than
         showing a blank or a placeholder name. */
      node.innerHTML = 'Signing as <span class="none">' + esc(mailbox) +
        ' — no display name set, company signature only</span>';
      return;
    }
    node.innerHTML = 'Signing as <b>' + esc(id.display_name) + '</b> · ' + esc(mailbox) +
      (id.stale
        ? '<span class="stale" title="This name was set before the password on this shared login was last reset. It may belong to whoever held the account before. Check Settings → Users &amp; Roles.">name predates the last password reset</span>'
        : '');
  }

  /**
   * Who does this message go to?
   *  reply     → the last inbound sender (Reply-To wins over From); if we sent last, our own recipients
   *  replyAll  → the above, plus every other To/Cc participant plus the CC line, minus THIS mailbox
   *  forward   → nobody; the user picks
   * Only the ACTIVE mailbox is excluded — replying as rene@ with processing@ on the thread
   * is normal and intentional, so the other company address is kept.
   * ...UNLESS that exclusion empties the field, which happens on a self-addressed
   * thread (a CRM notification from rene@ to rene@). See the fallback below.
   */
  function computeRecipients(mode, msgs, mailbox) {
    var self = String(mailbox || '').toLowerCase();
    // 'new' = Compose / open-a-draft: no thread, no quote, nothing prefilled.
    if (mode === 'new') return { to: [], cc: [], target: null };
    var last = msgs[msgs.length - 1] || {};
    var target = null;
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].direction === 'inbound') { target = msgs[i]; break; }
    }
    if (!target) target = last;
    if (mode === 'forward') return { to: [], cc: [], target: last };

    /* The candidates BEFORE our own address is removed, kept so the
       self-addressed case below can fall back to them. */
    var candidates = (target.direction === 'outbound')
      ? (target.to || [])
      : [target.reply_to || (target.from && target.from.email) || ''];
    var to = dedupe(candidates, [self]);

    /* ── SELF-ADDRESSED THREAD ────────────────────────────────────────────
       Excluding the active mailbox is right when there is somebody else on the
       thread — replying to yourself as well as the borrower is noise. But a CRM
       notification is sent FROM rene@ TO rene@, so rene@ is the only
       participant, and removing it left To empty and the composer showing
       "Add a recipient to send." on a thread that plainly has a recipient.

       Falling back to the unfiltered candidates addresses the message to
       yourself, which is what replying to a self-addressed notification means.
       This only fires when the exclusion emptied the list, so a normal thread
       is bit-for-bit unaffected — and a message with genuinely no candidate
       address (empty from, empty to) still yields [], because there is nothing
       to fall back TO and inventing one would be worse than the empty field. */
    if (!to.length) to = dedupe(candidates, []);

    var cc = [];
    if (mode === 'replyAll') {
      cc = dedupe([].concat(target.to || [], target.cc || []), [self].concat(to));
    }
    return { to: to, cc: cc, target: target };
  }

  /**
   * Quoted prior message, Gmail-shaped.
   * 🔴 The prior body is INBOUND, attacker-controlled HTML. It is sanitized HERE before
   * being embedded, and again as part of the whole body on send. Never trust it because
   * "it came from our own thread".
   */
  function buildQuote(mode, m) {
    var raw = (m.body_html && m.body_html.trim())
      ? m.body_html
      : '<pre style="white-space:pre-wrap;font-family:inherit;margin:0">' + esc(m.body_text || '') + '</pre>';
    var clean = sanitize(raw);
    var who = esc((m.from && m.from.name) || (m.from && m.from.email) || 'sender');
    var addr = esc((m.from && m.from.email) || '');
    var when = esc(fmtDate(m.date));
    if (mode === 'forward') {
      return '<div class="gmail_quote">' +
        '<div>---------- Forwarded message ----------</div>' +
        '<div>From: ' + who + ' &lt;' + addr + '&gt;</div>' +
        '<div>Date: ' + when + '</div>' +
        '<div>Subject: ' + esc(m.subject || '') + '</div>' +
        '<div>To: ' + esc((m.to || []).join(', ')) + '</div><br>' +
        clean + '</div>';
    }
    return '<div class="gmail_quote">' +
      '<div class="gmail_attr">On ' + when + ', ' + who + ' &lt;' + addr + '&gt; wrote:</div>' +
      '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">' +
      clean + '</blockquote></div>';
  }

  // ── recipient chip field ──
  function chipField(host, initial, cl, onChange) {
    var vals = dedupe(initial || []);
    var inp = host.querySelector('input');
    function changed() { if (onChange) { try { onChange(); } catch (_) {} } }
    function render() {
      Array.prototype.forEach.call(host.querySelectorAll('.gm-chip'), function (c) { c.remove(); });
      vals.forEach(function (v, idx) {
        var c = document.createElement('span');
        c.className = 'gm-chip' + (RE_EMAIL.test(v) ? '' : ' bad');
        if (!RE_EMAIL.test(v)) c.title = 'Doesn’t look like a valid email address';
        var i = document.createElement('i'); i.textContent = v;
        var b = document.createElement('b'); b.textContent = '×';
        b.addEventListener('click', function () { vals.splice(idx, 1); render(); changed(); });
        c.appendChild(i); c.appendChild(b);
        host.insertBefore(c, inp);
      });
    }
    function commit() {
      if (!inp.value.trim()) return;
      vals = dedupe(vals.concat(parseAddrs(inp.value)));
      inp.value = '';
      render(); changed();
    }
    function addValue(email) { vals = dedupe(vals.concat([email])); render(); changed(); }

    // ⚠ Attach autocomplete FIRST — see attachAutocomplete: on Enter it calls
    // stopImmediatePropagation() to beat the raw-text commit registered just below, and at
    // the target phase listeners fire in registration order.
    if (cl) attachAutocomplete(inp, cl, addValue);

    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === 'Tab') {
        if (inp.value.trim()) { e.preventDefault(); commit(); }
      } else if (e.key === 'Backspace' && !inp.value && vals.length) {
        vals.pop(); render(); changed();
      }
    });
    inp.addEventListener('blur', commit);
    inp.addEventListener('paste', function () { setTimeout(commit, 0); });
    inp.addEventListener('input', changed);   // keeps the Send gate live while typing
    render();
    return {
      get: function () { commit(); return vals.slice(); },
      count: function () { return vals.length + (inp.value.trim() ? 1 : 0); },
      /**
       * How many RECIPIENTS would actually be sent to — what the Send button gates on.
       * Counts committed chips that look like real addresses, PLUS a valid address
       * still sitting uncommitted in the input. That last part matters: without it,
       * typing a full address and going straight for Send leaves the button disabled,
       * so the click lands on a dead control and is swallowed — the blur that would
       * have committed the chip fires too late to help.
       */
      valid: function () {
        var n = vals.filter(function (v) { return RE_EMAIL.test(v); }).length;
        var pending = inp.value.trim();
        if (pending && RE_EMAIL.test(pending)) n++;
        return n;
      },
      focus: function () { inp.focus(); }
    };
  }

  // ── formatting toolbar (execCommand — the only contentEditable API with universal support) ──
  /* One row only. Anything not here lives in the "⋯" overflow menu (TOOLS_MORE) so
   * the toolbar can never wrap — a wrapped row was putting a lone ✕ (Clear
   * formatting) on a second line and stealing height from the body. */
  var TOOLS = [
    { sel: 'font', t: 'Font' },
    { sel: 'size', t: 'Size' },
    { c: '_color', l: '<span style="border-bottom:3px solid currentColor">A</span>', t: 'Text colour' },
    { sep: 1 },
    { c: 'bold', l: '<b>B</b>', t: 'Bold (Ctrl+B)' },
    { c: 'italic', l: '<i>I</i>', t: 'Italic (Ctrl+I)' },
    { c: 'underline', l: '<u>U</u>', t: 'Underline (Ctrl+U)' },
    { sep: 1 },
    { c: 'insertUnorderedList', l: '&bull;&nbsp;', t: 'Bulleted list' },
    { c: 'insertOrderedList', l: '1.', t: 'Numbered list' },
    { sep: 1 },
    { c: '_link', l: '&#128279;', t: 'Insert a hyperlink into the message (Ctrl+K)' },
    { sep: 1 },
    /* Attach is the odd one out and is styled that way: it adds a FILE to the
     * message, while its neighbours insert content INTO the body. Rene could not
     * find it among identical grey glyphs, so it gets a label and its own colour. */
    { c: '_attach', l: '&#128206; Attach', t: 'Attach a file — sent with the message (20MB max)', wide: 1, accent: 1 },
    { c: '_image', l: '&#128247;', t: 'Insert an image into the message body' },
    { c: '_video', l: '&#127909;', t: 'Record a video message and insert it as a thumbnail' },
    { c: '_emoji', l: '&#128512;', t: 'Insert an emoji' },
    { sep: 1 },
    { c: '_insert', l: 'Insert &#9662;', t: 'Insert a call-to-action button', wide: 1 },
    { c: '_ai', l: '&#10024; AI &#9662;', t: 'AI assistant — draft, improve or summarize', wide: 1 },
    { c: '_more', l: '&#8943;', t: 'More formatting — alignment, indent, quote, clear formatting' }
  ];
  /* Overflow menu contents. Plain execCommand items, dispatched through the very
   * same data-c handler as the visible buttons — no second code path. */
  var TOOLS_MORE = [
    { c: 'justifyLeft', l: 'Align left' },
    { c: 'justifyCenter', l: 'Align centre' },
    { c: 'justifyRight', l: 'Align right' },
    { c: 'outdent', l: 'Decrease indent' },
    { c: 'indent', l: 'Increase indent' },
    { c: 'formatBlock:blockquote', l: 'Quote' },
    { c: 'removeFormat', l: 'Clear formatting' }
  ];
  var FONTS = ['Arial', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma', 'Courier New'];
  var SIZES = [['2', 'Small'], ['3', 'Normal'], ['4', 'Large'], ['5', 'Huge']];
  var EMOJI = ('😀 😁 😊 🙂 😉 👍 👏 🙏 💪 🎉 ✅ ❌ ⚠️ ⭐ 🔥 💡 📌 📎 📅 📞 ✉️ 📄 🏠 🔑 💰 📈 📉 🕐 ' +
    '🙌 👀 🤝 ✍️ 🎯 🚀 ❤️ 😅 😍 🤔 👋 💯').split(' ');

  /* ── Insert-buttons menu ───────────────────────────────────────────────────
   * Only URLs verified to resolve to what they claim get a button. Three of the
   * four CTAs in Rene's Gmail signature are dead and are deliberately ABSENT:
   *   Apply Now  emortgagecapital1.shapeportal.com → 302 → setshape.com
   *              marketing page (his Shape tenant is not provisioned)
   *   Reviews    www.emortgagecapital.com serves "Welcome to LWC Communities!"
   *              on every path — the whole domain is someone else's site
   *   Schedule   ratesandrealty.com/meeting/... serves the marketing homepage
   * Shipping a button that silently goes nowhere is worse than not shipping it.
   * Add them back here once there is a live URL.                              */
  var INSERT_BTNS = [
    { k: 'upload', label: '📄 Document Upload', bg: '#1a6fb5', fg: '#ffffff',
      url: 'https://documentguardian.com/filedrop/rduarte@emortgagecapital.com' }
  ];

  function btnHtml(b) {
    return '<a href="' + esc(b.url) + '" target="_blank" rel="noopener noreferrer" ' +
      'style="display:inline-block;font-size:12px;font-weight:700;color:' + b.fg +
      ';background:' + b.bg + ';border-radius:20px;padding:8px 18px;margin:2px 6px 2px 0;' +
      'text-decoration:none;letter-spacing:.04em;font-family:Arial,sans-serif">' +
      esc(b.label.replace(/^[^\w]+\s*/, '')) + '</a>&nbsp;';
  }

  /* The one thumbnail renderer. Mail clients can't embed video, so every video —
   * YouTube, Loom, or a recorded message in our own bucket — becomes the same
   * clickable poster + caption. Recorded video reuses this directly (see the _video
   * hook) rather than growing a second markup path. */
  function thumbLinkHtml(href, thumbSrc, caption) {
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" ' +
      'style="display:inline-block;text-decoration:none">' +
      '<img src="' + esc(thumbSrc) + '" alt="Watch the video" width="480" ' +
      'style="max-width:100%;border-radius:8px;display:block"></a>' +
      '<div style="font-size:12px;color:#666;margin-top:4px">▶ ' +
      esc(caption || 'Click the image to watch') + '</div>';
  }

  /* Pick the best recording container/codec available, MP4 first.
   * Probed in Chrome 150 on this machine — every candidate below reports supported,
   * so the MP4 branch wins there; the WebM fallbacks exist for browsers that cannot
   * record MP4 (notably Firefox). Bitrates are pinned rather than left to the
   * implementation default, which is what produced soft, over-compressed video. */
  var REC_MIMES = [
    { mime: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' }
  ];
  var REC_BITS = { videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 };
  function pickRecordMime() {
    for (var i = 0; i < REC_MIMES.length; i++) {
      var c = REC_MIMES[i];
      try {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(c.mime)) {
          return { mime: c.mime, ext: c.ext, opts: Object.assign({ mimeType: c.mime }, REC_BITS) };
        }
      } catch (_) {}
    }
    return { mime: '', ext: 'webm', opts: Object.assign({}, REC_BITS) };
  }

  /* Split a message body into the part actually written now and the quoted trailer
   * ("On <date> <sender> wrote:" + the whole prior thread). Gmail marks its own with
   * .gmail_quote; other clients use a cite blockquote or a bare "On … wrote:" line.
   * Conservative on purpose: if no confident boundary is found, nothing is hidden —
   * showing an extra quote is a much smaller failure than hiding real content. */
  function splitQuoted(html) {
    var s = String(html || '');
    if (!s) return { main: s, quoted: '' };
    var candidates = [
      s.search(/<div[^>]+class="[^"]*gmail_quote[^"]*"/i),
      s.search(/<blockquote[^>]+type="cite"/i),
      s.search(/<div[^>]+id="appendonsend"/i),
      /* Yahoo. Measured on a real reply (VOE, Rafael Hernandez Andrade): Yahoo
         Mail for iPhone opens its quote with
             <p class="yahoo-quoted-begin" style="...">On Wednesday, July ...
         which none of the patterns above match. That message DID cut — at the
         `gmail_quote` 7932 characters in, because our own original message is
         nested inside Yahoo's quote — so the reply, the signature AND the whole
         quoted history all landed in `main`. A late cut is worse than no cut:
         it looks exactly like a fall-through while the splitter reports success.
         Matched on the class rather than the tag so a p->div change does not
         silently reopen this. */
      s.search(/<[a-z]+[^>]+class="[^"]*yahoo-quoted-begin/i),
      // Bare textual trailer, e.g. "On Tue, Jul 8, 2026 at 9:14 AM Bob <b@x> wrote:"
      s.search(/On\s+[^<]{6,120}\s+wrote:\s*(<br|<\/div|<blockquote)/i)
    ].filter(function (i) { return i > -1; });
    if (!candidates.length) return { main: s, quoted: '' };
    var cut = Math.min.apply(null, candidates);
    // A boundary in the first few characters means the whole message IS a quote;
    // hiding all of it would leave an empty bubble.
    if (cut < 24) return { main: s, quoted: '' };
    return { main: s.slice(0, cut), quoted: s.slice(cut) };
  }

  /* Plain-text sibling of splitQuoted(), for Gmail's `snippet` — which arrives as
   * flattened TEXT, so every anchor splitQuoted() relies on (gmail_quote divs,
   * cite blockquotes, a "wrote:" followed by a tag) is already gone. That is why
   * snippets read "… > On Jul 30, 2026, at 4:49 PM, P…": the reply is two words
   * and the rest of the preview is the quote underneath it.
   *
   * Same conservatism, on purpose and in the same direction: no confident
   * boundary → return the snippet untouched, and a boundary in the first 24
   * characters means the snippet IS the quote, so show it rather than blank the
   * row. Showing an extra quote is a much smaller failure than hiding real text. */
  function splitQuotedText(text) {
    var s = String(text == null ? '' : text);
    if (!s) return { main: s, quoted: '' };
    var candidates = [
      // Apple Mail / Gmail reply headers, with or without the leading "> " marker.
      s.search(/(^|\s)>?\s*On\s+[^\n]{6,140}?\s+wrote:/i),
      s.search(/(^|\s)>?\s*On\s+\w{3},?\s+\w{3}\s+\d{1,2},?\s+\d{4}[^\n]{0,60}?,?\s+at\s+/i),
      // Outlook: the "-----Original Message-----" rule and the From:/Sent: block.
      s.search(/(^|\s)-{2,}\s*Original Message\s*-{2,}/i),
      s.search(/(^|\s)From:\s[^\n]{3,120}?\sSent:\s/i),
      // A run of quote markers is a quote even when no header survived flattening.
      s.search(/(^|\s)>\s?>\s?/)
    ].filter(function (i) { return i > -1; });
    if (!candidates.length) return { main: s, quoted: '' };
    var cut = Math.min.apply(null, candidates);
    if (cut < 24) return { main: s, quoted: '' };
    return { main: s.slice(0, cut).replace(/[\s>\-]+$/, ''), quoted: s.slice(cut) };
  }
  function snippetMain(text) { return splitQuotedText(text).main; }

  /* ── RECEIVED ATTACHMENTS ───────────────────────────────────────────────────
   * Metadata comes down with the thread; BYTES ONLY ON CLICK. Gmail returns
   * base64url, so a 25MB file is ~33MB of JSON — fetching every attachment of
   * every message just to draw a chip would be slow and, on a big thread,
   * fatal. */
  function attSize(n) {
    var b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
    return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }
  function attExt(name) {
    var m = String(name || '').match(/\.([A-Za-z0-9]{1,6})$/);
    return m ? m[1].toLowerCase() : '';
  }
  /* Mirrors attKind() in gmail-inbox. The server sends attachment_types on list
   * rows (already classified there); this classifies locally for thread chips
   * and collapsed stubs. ONE vocabulary — pdf|image|sheet|doc|archive|calendar|
   * other — so a file shows the SAME icon in the list, on a stub, and on its
   * chip. Extension is checked as well as MIME because senders mislabel. */
  function attKindOf(mime, name) {
    var t = String(mime || '').toLowerCase(), e = attExt(name);
    if (t.indexOf('pdf') > -1 || e === 'pdf') return 'pdf';
    if (t.indexOf('image/') === 0 || ['png','jpg','jpeg','gif','webp','bmp','heic'].indexOf(e) > -1) return 'image';
    if (t.indexOf('spreadsheet') > -1 || t.indexOf('excel') > -1 || ['xls','xlsx','csv'].indexOf(e) > -1) return 'sheet';
    if (t.indexOf('word') > -1 || t.indexOf('opendocument.text') > -1 || ['doc','docx','rtf','odt'].indexOf(e) > -1) return 'doc';
    if (t.indexOf('zip') > -1 || t.indexOf('gzip') > -1 || t.indexOf('compressed') > -1 || ['zip','gz','rar','7z'].indexOf(e) > -1) return 'archive';
    if (t.indexOf('calendar') > -1 || e === 'ics') return 'calendar';
    return 'other';
  }
  var KIND_ICON = { pdf: '📄', image: '🖼', sheet: '📊', doc: '📝', archive: '🗜', calendar: '📅', other: '📎' };
  var KIND_LABEL = { pdf: 'PDF', image: 'image', sheet: 'spreadsheet', doc: 'document', archive: 'archive', calendar: 'calendar invite', other: 'attachment' };
  function kindIcon(k) { return KIND_ICON[k] || KIND_ICON.other; }

  /* ONE renderer for both call sites, so a thread's mark is identical in the
   * list and on a collapsed stub.
   *
   * THE NUMBER BESIDE AN ICON IS ALWAYS THAT ICON'S OWN COUNT. The previous
   * version paired the dominant type's icon with the thread TOTAL, so
   * {pdf:16, other:1, image:1, sheet:1, doc:2} rendered as "PDF 21" — a PDF
   * icon asserting twenty-one PDFs when there are sixteen. A reader cannot tell
   * that from a miscount, which makes the whole indicator untrustworthy.
   *
   * Mixed threads get a separate "+N" for everything that is not the dominant
   * type, so the two numbers never contradict each other:
   *     one type,  one file   ->  [PDF]
   *     one type,  N files    ->  [PDF] 16
   *     mixed                 ->  [PDF] 16 +5
   * The tooltip always carries the full breakdown. */
  function attMarkHtml(counts, title) {
    var kinds = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || a.localeCompare(b);
    });
    if (!kinds.length) return '';
    var lead = kinds[0];
    var leadN = counts[lead];
    var others = kinds.slice(1).reduce(function (n, k) { return n + counts[k]; }, 0);
    return '<span class="gm-att-mark" title="' + esc(title) + '">' +
      kindIcon(lead) +
      (leadN > 1 ? '<b>' + leadN + '</b>' : '') +
      (others > 0 ? '<i>+' + others + '</i>' : '') +
      '</span>';
  }

  // From a message's own attachment array (thread view: stubs and messages).
  function attSummaryHtml(list) {
    if (!list || !list.length) return '';
    var counts = {};
    list.forEach(function (a) {
      var k = attKindOf(a.mimeType, a.filename);
      counts[k] = (counts[k] || 0) + 1;
    });
    var title = list.map(function (a) {
      return (a.filename || 'attachment') + (a.size ? ' (' + attSize(a.size) + ')' : '');
    }).join('\n');
    return attMarkHtml(counts, title);
  }

  // From the server's pre-classified per-type counts (list rows).
  function attSummaryFromTypes(types, count) {
    if (!count || !types) return '';
    var kinds = Object.keys(types).sort(function (a, b) { return types[b] - types[a]; });
    var title = kinds.map(function (k) {
      return types[k] + ' ' + KIND_LABEL[k] + (types[k] > 1 ? 's' : '');
    }).join(', ');
    return attMarkHtml(types, title);
  }

  function attIcon(mime, name) {
    var t = String(mime || '').toLowerCase(), e = attExt(name);
    if (t.indexOf('pdf') > -1 || e === 'pdf') return '📄';
    if (t.indexOf('image/') === 0 || ['png','jpg','jpeg','gif','webp','heic','bmp'].indexOf(e) > -1) return '🖼';
    if (t.indexOf('spreadsheet') > -1 || t.indexOf('excel') > -1 || ['xls','xlsx','csv'].indexOf(e) > -1) return '📊';
    if (t.indexOf('word') > -1 || ['doc','docx'].indexOf(e) > -1) return '📝';
    if (t.indexOf('zip') > -1 || ['zip','rar','7z'].indexOf(e) > -1) return '🗜';
    if (t.indexOf('audio/') === 0) return '🎵';
    if (t.indexOf('video/') === 0) return '🎬';
    return '📎';
  }
  // Only formats a browser renders natively get a preview tab; the rest download.
  function attCanPreview(mime, name) {
    var t = String(mime || '').toLowerCase(), e = attExt(name);
    return t.indexOf('pdf') > -1 || e === 'pdf' ||
      t.indexOf('image/') === 0 || ['png','jpg','jpeg','gif','webp','bmp'].indexOf(e) > -1;
  }
  function b64urlToBlob(data, mime) {
    var b = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
    var pad = b.length % 4 ? new Array(5 - (b.length % 4)).join('=') : '';
    var bin = atob(b + pad);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime || 'application/octet-stream' });
  }


  /* ── INLINE cid: IMAGES ─────────────────────────────────────────────────────
   *
   * Mail embeds its own images by reference: <img src="cid:ii_abc123"> pointing
   * at a MIME part in the same message. A browser cannot fetch a cid: URL — it
   * is not a network scheme — so every one of them rendered as a broken image
   * showing its alt text ("image0.jpeg"), and signatures, which are mostly a
   * table of cid: logos, appeared to vanish.
   *
   * Resolved against `inline_images` from get_thread: the parts
   * filterRealAttachments deliberately keeps OUT of `attachments` so they do not
   * become chips. Bytes come through get_attachment, the same authorised path
   * the chips use — nothing here reaches Gmail directly, and the mailbox is
   * re-checked server-side per fetch.
   *
   * BLOB URLS, NOT data: URIs. A 200KB logo as base64 inflates ~33% and lands in
   * the srcdoc string, which is parsed as a document — three of them turned a
   * 40KB body into a megabyte of markup. A blob: URL is a short token; the bytes
   * stay out of the HTML. The srcdoc iframe carries allow-same-origin, so it
   * shares this document's origin and can read blob: URLs minted here.
   *
   * REWRITTEN BEFORE srcdoc IS SET, never after. Reaching into a rendered
   * iframe's DOM to patch src attributes needs same-origin access and races the
   * load; rewriting the string is deterministic.
   */
  var INLINE_MAX = 3 * 1024 * 1024;   // per image; a signature logo is ~10-80KB
  var _cidCache = {};                 // msgId|cid → blob URL

  function _cidKey(msgId, cid) { return msgId + '|' + cid; }

  /* Matches src="cid:x", src='cid:x' and bare src=cid:x. The cid may be
   * URL-encoded and may carry the angle brackets from the raw Content-ID header
   * (`src="cid:<ii_abc>"`) — some Exchange and Notes generators emit that form.
   *
   * THE THREE QUOTING CASES ARE SEPARATE ALTERNATIVES on purpose. A single
   * `(["']?)…([^"'\s>]+)\2` cannot express "> is allowed inside a quoted value
   * but terminates an unquoted one", so the bracketed form silently failed to
   * match and was left as a broken image — caught by the unit tests, not by
   * reading it. Quoted values stop only at their own quote; the unquoted branch
   * stops at whitespace or >. */
  var CID_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(?:"cid:([^"]*)"|'cid:([^']*)'|cid:([^\s>]+))/gi;

  function hasCidRefs(html) { CID_SRC_RE.lastIndex = 0; return CID_SRC_RE.test(String(html || '')); }

  /* Fetch every inline part this body actually references, and return a
   * cid → blob-URL map. A part that fails is simply absent from the map, so the
   * rewrite leaves its cid: alone and it degrades to the broken-image it was —
   * one logo failing must not take out the message body. */
  async function resolveInlineImages(cl, mailbox, msg) {
    var parts = (msg && msg.inline_images) || [];
    if (!parts.length || !hasCidRefs(msg.body_html)) return {};
    var want = {};
    var m;
    CID_SRC_RE.lastIndex = 0;
    while ((m = CID_SRC_RE.exec(String(msg.body_html || '')))) {
      var raw = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);   // dq | sq | unquoted
      if (!raw) continue;
      try { raw = decodeURIComponent(raw); } catch (_) {}
      want[raw.replace(/^<|>$/g, '').toLowerCase()] = 1;
    }
    var map = {};
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var cid = String(p.content_id || '').replace(/^<|>$/g, '');
      if (!cid || !want[cid.toLowerCase()]) continue;
      var key = _cidKey(msg.id, cid.toLowerCase());
      if (_cidCache[key]) { map[cid.toLowerCase()] = _cidCache[key]; continue; }
      /* Size ceiling. The 15MB server cap still applies; this is about not
       * pulling megabytes to draw a footer nobody asked for.
       *
       * `p.size && …` WAS THE BUG: a part reporting no size — absent, null or 0 —
       * skipped the comparison entirely and was fetched whatever its true size.
       * The cap read like a bound and was not one. Gmail normally supplies size,
       * so this was latent rather than active, which is exactly why it would have
       * stayed. A part with an UNKNOWN size is now treated as over the cap and
       * left as a broken image: refusing to fetch an unbounded blob is the safe
       * direction, and the failure stays visible either way. */
      var psize = (p.size == null || p.size === '') ? null : Number(p.size);
      if (psize === null || !isFinite(psize) || psize > INLINE_MAX) continue;
      try {
        var r = await invoke(cl, mailbox, 'get_attachment', {
          message_id: msg.id, attachment_id: p.attachment_id, part_id: p.part_id || ''
        });
        var url = URL.createObjectURL(b64urlToBlob(r.data_b64url, r.mime_type || p.mime_type));
        _cidCache[key] = url;
        map[cid.toLowerCase()] = url;
      } catch (_) { /* leave unresolved — see above */ }
    }
    return map;
  }

  /* Swap resolved cids for their blob URLs. An unresolved cid is left exactly as
   * it was rather than blanked: a broken image is a visible "this did not load",
   * while src="" silently collapses to nothing and looks like the mail never had
   * the image at all. */
  function rewriteCidSrc(html, map) {
    if (!html || !map) return html;
    return String(html).replace(CID_SRC_RE, function (whole, pre, dq, sq, uq) {
      var k = dq != null ? dq : (sq != null ? sq : uq);
      if (!k) return whole;
      try { k = decodeURIComponent(k); } catch (_) {}
      k = k.replace(/^<|>$/g, '').toLowerCase();
      var url = map[k];
      return url ? (pre + '"' + url + '"') : whole;
    });
  }

  /* ── PDF / IMAGE PREVIEW ────────────────────────────────────────────────────
   * pdf.js is REUSED, not added. admin/guideline-ai.html already loads 4.0.379
   * from cdnjs as an ESM module and stashes it on window.__pdfjsLib; this loads
   * the identical build the same way, so there is one pdf.js version in the app
   * and no new dependency. The CSP already permits it (script-src * and
   * worker-src blob: *, set in src/worker.js withCsp).
   *
   * Bytes are fetched ONCE per attachment; the decoded blob and the rendered
   * thumbnail are cached for the session, keyed by messageId|partId — so a
   * second hover, or a hover then a click, costs nothing. */
  var PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
  var _pdfjsPromise = null;
  /* One pdf.js in the app. The loader moved to attachment-viewer.js with the
   * modal, but inbox still needs it for PDF hover-card THUMBNAILS (see the
   * caller below) — a second copy here would mean two module instances and two
   * workers. Falls back to the local constants only if the shared file is
   * somehow absent. */
  function loadPdfJs() {
    if (window.AttachmentViewer) return window.AttachmentViewer.loadPdfJs();
    if (window.__pdfjsLib) return Promise.resolve(window.__pdfjsLib);
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = import(PDFJS_SRC).then(function (mod) {
      mod.GlobalWorkerOptions.workerSrc = window.PDFJS_WORKER_URL || PDFJS_WORKER;
      window.__pdfjsLib = mod;
      return mod;
    });
    return _pdfjsPromise;
  }

  var _attCache = {};
  function attKey(msgId, partId, attId) { return msgId + '|' + (partId || attId || ''); }

  /* Auto-preview ceiling. The 15MB server cap still applies to every fetch; this
   * lower bar is about not pulling megabytes because a cursor crossed a chip. */
  var AUTO_PREVIEW_MAX = 5 * 1024 * 1024;

  async function fetchAttachment(cl, mailbox, btn) {
    var key = attKey(btn.getAttribute('data-att-msg'), btn.getAttribute('data-att-part'), btn.getAttribute('data-att-id'));
    if (_attCache[key] && _attCache[key].blob) return _attCache[key];
    var r = await invoke(cl, mailbox, 'get_attachment', {
      message_id: btn.getAttribute('data-att-msg'),
      attachment_id: btn.getAttribute('data-att-id'),
      part_id: btn.getAttribute('data-att-part') || ''
    });
    var rec = {
      blob: b64urlToBlob(r.data_b64url, r.mime_type),
      mime: r.mime_type, name: r.filename, size: r.size, thumb: null
    };
    _attCache[key] = rec;
    return rec;
  }

  // Page 1 → dataURL, sized for the hover card.
  async function renderPdfThumb(blob, targetW) {
    var lib = await loadPdfJs();
    var buf = await blob.arrayBuffer();
    var pdf = await lib.getDocument({ data: buf }).promise;
    var page = await pdf.getPage(1);
    var vp1 = page.getViewport({ scale: 1 });
    var scale = Math.min(2, (targetW || 260) / vp1.width);
    var vp = page.getViewport({ scale: scale });
    var c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    var url = c.toDataURL('image/png');
    try { pdf.destroy(); } catch (e) {}
    return url;
  }

  function imgThumbFromBlob(blob) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(blob);
      var im = new Image();
      im.onload = function () { res(u); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('could not decode image')); };
      im.src = u;
    });
  }

  /* Hover card. 400ms dwell before ANYTHING happens — no fetch on a cursor
   * merely crossing the row. */
  var _hoverTimer = null, _hoverCard = null;
  function hideHoverCard() {
    if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; }
    if (_hoverCard) { _hoverCard.remove(); _hoverCard = null; }
  }
  function showHoverCard(btn, inner) {
    if (_hoverCard) { _hoverCard.remove(); _hoverCard = null; }
    var card = document.createElement('div');
    card.className = 'gm-att-hover';
    card.innerHTML = inner;
    document.body.appendChild(card);
    var r = btn.getBoundingClientRect();
    var top = r.top - card.offsetHeight - 8;
    if (top < 8) top = r.bottom + 8;
    card.style.top = top + 'px';
    card.style.left = Math.max(8, Math.min(r.left, window.innerWidth - card.offsetWidth - 8)) + 'px';
    _hoverCard = card;
    return card;
  }

  function wireAttachmentHover(btn, cl, mailbox) {
    btn.addEventListener('mouseenter', function () {
      if (_hoverTimer) clearTimeout(_hoverTimer);
      _hoverTimer = setTimeout(async function () {
        var name = btn.getAttribute('data-att-name') || 'attachment';
        var mime = btn.getAttribute('data-att-mime') || '';
        var size = parseInt(btn.getAttribute('data-att-size') || '0', 10);
        var key = attKey(btn.getAttribute('data-att-msg'), btn.getAttribute('data-att-part'), btn.getAttribute('data-att-id'));
        var cached = _attCache[key];

        if (cached && cached.thumb) {
          showHoverCard(btn, '<img src="' + cached.thumb + '" alt=""><div class="cap">' + esc(name) + '</div>');
          return;
        }
        if (!attCanPreview(mime, name)) return;
        if (size && size > AUTO_PREVIEW_MAX) {
          showHoverCard(btn, '<div class="cap">' + esc(attSize(size)) + ' — click to preview</div>');
          return;
        }
        var card = showHoverCard(btn, '<div class="cap">Loading preview…</div>');
        try {
          var rec = await fetchAttachment(cl, mailbox, btn);
          var thumb = (/pdf/i.test(rec.mime) || /\.pdf$/i.test(name))
            ? await renderPdfThumb(rec.blob, 260)
            : await imgThumbFromBlob(rec.blob);
          rec.thumb = thumb;
          if (_hoverCard === card) card.innerHTML = '<img src="' + thumb + '" alt=""><div class="cap">' + esc(name) + '</div>';
        } catch (e) {
          // B5: the server's own words, never a blank box.
          var msg = (e && e.message) || 'Preview failed';
          if (_hoverCard === card) {
            card.innerHTML = '<div class="cap err"></div>';
            card.firstChild.textContent = msg;
          }
        }
      }, 400);
    });
    btn.addEventListener('mouseleave', function () {
      if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; }
      setTimeout(function () {
        try { if (_hoverCard && !_hoverCard.matches(':hover')) hideHoverCard(); }
        catch (e) { hideHoverCard(); }
      }, 150);
    });
  }

  /* ── FULL PREVIEW MODAL ─────────────────────────────────────────────────────
   * Renders from the cached blob. No Gmail URL is ever placed in the DOM, and
   * every byte still arrives through get_attachment, which re-checks the
   * JWT-derived mailbox on each call. */
  /* Delegates to the SHARED viewer (admin/js/attachment-viewer.js). The body
   * that used to live here now serves staff chat too — it could not before,
   * because it closed over fetchAttachment, this IIFE's hover-card state, and
   * the gm-* CSS, and no page loads both inbox.js and staff-chat.js.
   *
   * Three things cross the boundary as configuration:
   *   fetch      — inbox reads four data-att-* attributes off the button and
   *                memoises the decoded blob in _attCache; that DOM contract is
   *                inbox's, not the viewer's, so it stays on this side.
   *   onOpen     — hideHoverCard(). Nothing to do with viewing: it dismisses
   *                the attachment hover-preview card so it does not sit over
   *                the modal. Purely an inbox concern, and the one dependency
   *                a signature-only reading of this function would have missed.
   *   (download) — the viewer's default save is correct here, so no override. */
  async function openAttachmentModal(btn, cl, mailbox) {
    if (!window.AttachmentViewer) { toast('Viewer still loading, try again in a moment', true); return; }
    return window.AttachmentViewer.open({
      name: btn.getAttribute('data-att-name') || 'attachment',
      mime: btn.getAttribute('data-att-mime') || '',
      onOpen: hideHoverCard,
      fetch: function () { return fetchAttachment(cl, mailbox, btn); }
    });
  }

  /** YouTube/Loom → clickable thumbnail. */
  function videoThumbHtml(url) {
    var yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    var lm = url.match(/loom\.com\/(?:share|embed)\/([A-Za-z0-9]{8,})/);
    var thumb = yt ? 'https://img.youtube.com/vi/' + yt[1] + '/hqdefault.jpg'
      : (lm ? 'https://cdn.loom.com/sessions/thumbnails/' + lm[1] + '-with-play.gif' : null);
    if (!thumb) return null;
    return thumbLinkHtml(url, thumb, 'Click the image to watch');
  }

  /* ── image upload → PUBLIC bucket ──────────────────────────────────────────
   * email-assets is public-read so recipients load images with no auth. Never
   * borrower-documents: that bucket is private and its URLs 400 for recipients.
   * Downscaled before upload — Rene's headshot is a 717 KB 1080px JPEG rendered
   * at 96px, which is ~7000x more bytes than the pixels need.                 */
  var EMAIL_BUCKET = 'email-assets';
  var MAX_EDGE = 1200, MAX_BYTES = 3 * 1024 * 1024;

  function downscale(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type) || /svg/i.test(file.type)) { resolve(file); return; }
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        if (Math.max(w, h) <= MAX_EDGE && file.size <= MAX_BYTES) { resolve(file); return; }
        var s = Math.min(1, MAX_EDGE / Math.max(w, h));
        var cv = document.createElement('canvas');
        cv.width = Math.round(w * s); cv.height = Math.round(h * s);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob(function (b) { resolve(b || file); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  async function uploadEmailImage(cl, file) {
    if (file.size > MAX_BYTES * 4) throw new Error('That image is ' + Math.round(file.size / 1048576) + ' MB — too large. Use one under 12 MB.');
    var blob = await downscale(file);
    var ext = (blob.type && blob.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '');
    var path = 'composer/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    var up = await cl.storage.from(EMAIL_BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
    if (up.error) throw new Error('Upload failed: ' + up.error.message);
    var pub = cl.storage.from(EMAIL_BUCKET).getPublicUrl(path);
    var url = pub && pub.data && pub.data.publicUrl;
    if (!url) throw new Error('Upload succeeded but no public URL came back — check the email-assets bucket is public.');
    return url;
  }
  function imgHtml(url) {
    return '<img src="' + esc(url) + '" alt="" style="max-width:100%;height:auto;display:block;margin:6px 0">';
  }

  /* hooks: composer-scoped actions that need mailbox/attachment state, which lives in
   * mountComposer. Passing them in keeps ONE dispatch path for every toolbar button
   * rather than a second click handler bolted on elsewhere. */
  function wireEditor(ed, tools, cl, hooks) {
    hooks = hooks || {};
    // Paste: strip to sanitized HTML. This is the primary ingress for hostile markup.
    ed.addEventListener('paste', function (e) {
      var cb = e.clipboardData || window.clipboardData;
      if (!cb) return;
      // Pasted screenshot: upload to public storage and insert the hosted URL. A
      // raw data: URI would work in the editor but bloats the MIME and is stripped
      // by several mail clients, so it must not be left inline.
      var items = cb.items ? Array.prototype.slice.call(cb.items) : [];
      var imgItem = items.filter(function (it) { return it.kind === 'file' && /^image\//.test(it.type); })[0];
      if (imgItem && cl) {
        e.preventDefault();
        var file = imgItem.getAsFile();
        if (!file) return;
        try { document.execCommand('insertHTML', false, '<span data-upl="1" style="color:#888;font-size:12px">Uploading pasted image…</span>'); } catch (_) {}
        uploadEmailImage(cl, file).then(function (url) {
          var ph = ed.querySelector('[data-upl]');
          if (ph) ph.outerHTML = sanitize(imgHtml(url));
        }).catch(function (err) {
          var ph = ed.querySelector('[data-upl]');
          if (ph) ph.remove();
          alert('Pasted image upload failed.\n\n' + ((err && err.message) || err));
        });
        return;
      }
      e.preventDefault();
      var html = '';
      try { html = cb.getData('text/html'); } catch (_) {}
      var out;
      if (html && html.trim()) {
        try { out = sanitize(html); }
        catch (err) { out = esc(cb.getData('text/plain') || ''); }
      } else {
        out = esc(cb.getData('text/plain') || '').replace(/\r?\n/g, '<br>');
      }
      try { document.execCommand('insertHTML', false, out); }
      catch (_) { ed.appendChild(document.createTextNode(cb.getData('text/plain') || '')); }
    });
    // Drops carry the same risk as pastes and bypass the paste handler entirely.
    ed.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (!dt) return;
      var html = '';
      try { html = dt.getData('text/html'); } catch (_) {}
      if (!html) return;
      e.preventDefault();
      try { document.execCommand('insertHTML', false, sanitize(html)); } catch (_) {}
    });
    if (!tools) return;

    // Everything inserted goes in as HTML through execCommand, so it lands in the
    // same contentEditable and leaves via the same sanitize() on send. No bypass.
    function insertHTML(html) {
      ed.focus();
      try { document.execCommand('insertHTML', false, sanitize(html)); }
      catch (_) { ed.innerHTML += sanitize(html); }
    }

    // Hand the sanitizing insert back to the composer so the video hook inserts
    // through the identical path as everything else.
    hooks.insertHTML = insertHTML;

    // Shared by the visible buttons and the "⋯" overflow menu.
    function runCmd(cmd) {
      if (cmd.indexOf('formatBlock:') === 0) {
        try { document.execCommand('formatBlock', false, cmd.split(':')[1]); } catch (_) {}
        return;
      }
      try { document.execCommand(cmd, false, null); } catch (_) {}
    }

    var fontSel = tools.querySelector('select[data-sel="font"]');
    var sizeSel = tools.querySelector('select[data-sel="size"]');

    /* Reflect the caret's actual font/size in the dropdowns instead of snapping back
     * to a placeholder. queryCommandValue('fontName') comes back quoted and sometimes
     * as a full stack ("Arial", sans-serif), so match on the first family name. */
    function syncFontSize() {
      // selectionchange is a document-level listener but the editor is per-composer, so
      // self-detach once this editor is gone — otherwise every reopen leaks another one.
      if (!ed.isConnected) { document.removeEventListener('selectionchange', syncFontSize); return; }
      if (!ed.contains(document.activeElement) && document.activeElement !== ed) return;
      try {
        if (fontSel) {
          var fn = String(document.queryCommandValue('fontName') || '').replace(/['"]/g, '');
          var first = fn.split(',')[0].trim().toLowerCase();
          for (var i = 0; i < fontSel.options.length; i++) {
            if (fontSel.options[i].value.toLowerCase() === first) { fontSel.selectedIndex = i; break; }
          }
        }
        if (sizeSel) {
          var fs = String(document.queryCommandValue('fontSize') || '');
          for (var j = 0; j < sizeSel.options.length; j++) {
            if (sizeSel.options[j].value === fs) { sizeSel.selectedIndex = j; break; }
          }
        }
      } catch (_) {}
    }
    document.addEventListener('selectionchange', syncFontSize);
    ed.addEventListener('keyup', syncFontSize);
    ed.addEventListener('mouseup', syncFontSize);

    Array.prototype.forEach.call(tools.querySelectorAll('select[data-sel]'), function (s) {
      s.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      s.addEventListener('change', function () {
        ed.focus();
        try {
          if (s.getAttribute('data-sel') === 'font') document.execCommand('fontName', false, s.value);
          else document.execCommand('fontSize', false, s.value);
        } catch (_) {}
        // Selection keeps whatever was just applied — no reset to index 0.
      });
    });

    Array.prototype.forEach.call(tools.querySelectorAll('button[data-c]'), function (b) {
      // mousedown+preventDefault keeps the caret/selection inside the editor
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        var cmd = b.getAttribute('data-c');
        ed.focus();

        // Overflow menu: the formatting commands that no longer fit on the single row.
        if (cmd === '_more') {
          var mm = document.createElement('div');
          mm.className = 'gm-pop-menu';
          mm.innerHTML = TOOLS_MORE.map(function (m) {
            return '<div class="gm-pop-item" data-mc="' + esc(m.c) + '">' + m.l + '</div>';
          }).join('');
          var mpop = portalPopover(b, mm, { width: 200 });
          Array.prototype.forEach.call(mm.querySelectorAll('[data-mc]'), function (it) {
            it.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
            it.addEventListener('click', function () {
              ed.focus();
              runCmd(it.getAttribute('data-mc'));
              mpop.close();
            });
          });
          return;
        }

        if (cmd === '_ai') { if (hooks.ai) hooks.ai(b); return; }
        if (cmd === '_attach') { if (hooks.attach) hooks.attach(); return; }
        if (cmd === '_video') { if (hooks.video) hooks.video(b); return; }

        if (cmd === '_link') {
          var url = window.prompt('Link URL:', 'https://');
          if (!url) return;
          url = url.trim();
          if (!/^(https?:|mailto:|tel:)/i.test(url)) { alert('Only http, https, mailto and tel links are allowed.'); return; }
          try { document.execCommand('createLink', false, url); } catch (_) {}
          return;
        }

        if (cmd === '_color') {
          var picker = document.createElement('input');
          picker.type = 'color'; picker.value = '#1a6fb5';
          picker.style.cssText = 'position:fixed;left:-9999px';
          document.body.appendChild(picker);
          picker.addEventListener('change', function () {
            ed.focus();
            try { document.execCommand('foreColor', false, picker.value); } catch (_) {}
            picker.remove();
          });
          picker.click();
          return;
        }

        if (cmd === '_emoji') {
          var box = document.createElement('div');
          box.className = 'gm-pop-menu gm-emoji';
          box.innerHTML = EMOJI.map(function (e) {
            return '<button type="button" data-e="' + e + '">' + e + '</button>';
          }).join('');
          var pop = portalPopover(b, box, { width: 292 });
          Array.prototype.forEach.call(box.querySelectorAll('[data-e]'), function (x) {
            x.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
            x.addEventListener('click', function () { insertHTML(x.getAttribute('data-e')); pop.close(); });
          });
          return;
        }

        if (cmd === '_image') {
          var menu = document.createElement('div');
          menu.className = 'gm-pop-menu';
          menu.innerHTML =
            '<div class="gm-pop-item" data-i="file">⬆️ Upload an image…</div>' +
            '<div class="gm-pop-item" data-i="url">🔗 Insert by URL…</div>' +
            '<div class="gm-pop-item" data-i="video">🎥 Video link (thumbnail)…</div>' +
            '<div class="gm-ai-note">Uploads go to public storage so recipients can load them.</div>';
          var ipop = portalPopover(b, menu, { width: 268 });
          menu.querySelector('[data-i="url"]').addEventListener('click', function () {
            ipop.close();
            var u = window.prompt('Image URL (https):', 'https://');
            if (!u) return;
            u = u.trim();
            if (!/^https:/i.test(u)) { alert('Image URLs must be https so they load in the recipient’s mail client.'); return; }
            insertHTML(imgHtml(u));
          });
          menu.querySelector('[data-i="video"]').addEventListener('click', function () {
            ipop.close();
            var u = window.prompt('YouTube or Loom link:', 'https://');
            if (!u) return;
            var html = videoThumbHtml(u.trim());
            if (!html) { alert('That does not look like a YouTube or Loom link.\n\nEmail cannot embed video, so a recognisable link is needed to build the thumbnail.'); return; }
            insertHTML(html);
          });
          menu.querySelector('[data-i="file"]').addEventListener('click', function () {
            ipop.close();
            var inp = document.createElement('input');
            inp.type = 'file'; inp.accept = 'image/*';
            inp.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(inp);
            inp.addEventListener('change', async function () {
              var f = inp.files && inp.files[0];
              inp.remove();
              if (!f) return;
              if (!cl) { alert('Not signed in — cannot upload.'); return; }
              var mark = '<span data-upl="1" style="color:#888;font-size:12px">Uploading ' + esc(f.name) + '…</span>';
              insertHTML(mark);
              try {
                var url = await uploadEmailImage(cl, f);
                var ph = ed.querySelector('[data-upl]');
                if (ph) ph.outerHTML = sanitize(imgHtml(url)); else insertHTML(imgHtml(url));
              } catch (err) {
                var ph2 = ed.querySelector('[data-upl]');
                if (ph2) ph2.remove();
                // Loud: a swallowed upload error leaves a broken image in real mail.
                alert('Image upload failed.\n\n' + ((err && err.message) || err));
              }
            });
            inp.click();
          });
          return;
        }

        if (cmd === '_insert') {
          var im = document.createElement('div');
          im.className = 'gm-pop-menu';
          im.innerHTML = INSERT_BTNS.map(function (x) {
            return '<div class="gm-pop-item" data-b="' + x.k + '">' + esc(x.label) + '</div>';
          }).join('') +
          '<div class="gm-ai-note">Apply Now, Reviews and Schedule a Call are not listed — those URLs in the Gmail signature no longer resolve. Ask Rene for live links.</div>';
          var bpop = portalPopover(b, im, { width: 300 });
          Array.prototype.forEach.call(im.querySelectorAll('[data-b]'), function (x) {
            x.addEventListener('click', function () {
              var def = INSERT_BTNS.filter(function (y) { return y.k === x.getAttribute('data-b'); })[0];
              bpop.close();
              if (def) insertHTML(btnHtml(def));
            });
          });
          return;
        }

        runCmd(cmd);
      });
    });
  }

  /**
   * Mount the composer into `mountEl`.
   * cfg: { client, mailbox, threadId, mode, msgs, subject, actsEl, onDone }
   */
  function mountComposer(mountEl, cfg) {
    if (!mountEl) return;
    var cl = cfg.client, mailbox = cfg.mailbox, mode = cfg.mode, msgs = cfg.msgs || [];

    // Refuse to open at all if the sanitizer is missing — better a clear error than a
    // composer that can't safely send.
    if (!sanitizerReady()) {
      mountEl.innerHTML = '<div class="gm-note bad" style="display:block"><b>Composer unavailable</b>' +
        'The HTML sanitizer (DOMPurify) did not load, so mail cannot be composed safely. ' +
        'Reload the page; if it persists, check that <code>/admin/js/vendor/purify.min.js</code> is being served.</div>';
      if (cfg.actsEl) cfg.actsEl.style.display = 'none';
      return;
    }

    var pre = cfg.prefill || {};
    var rec, quoteHtml;
    try {
      rec = computeRecipients(mode, msgs, mailbox);
      if (mode === 'new') {
        rec.to = dedupe(pre.to || []);
        rec.cc = dedupe(pre.cc || []);
      }
      quoteHtml = (mode !== 'new' && rec.target) ? buildQuote(mode, rec.target) : '';
    } catch (e) {
      mountEl.innerHTML = '<div class="gm-note bad" style="display:block"><b>Could not prepare the message</b>' + esc(e.message) + '</div>';
      return;
    }

    var subject, title;
    if (mode === 'new') {
      subject = pre.subject || '';
      title = pre.draft_id ? '📝 Draft' : '✏️ New message';
    } else {
      subject = (mode === 'forward' ? 'Fwd: ' : 'Re: ') + baseSubject(cfg.subject || (rec.target && rec.target.subject) || '');
      title = mode === 'forward' ? '↪ Forward' : (mode === 'replyAll' ? '↩↩ Reply all' : '↩ Reply');
    }
    var preBcc = dedupe(pre.bcc || []);
    var showCc = (rec.cc && rec.cc.length) > 0;
    var showBcc = preBcc.length > 0;

    if (cfg.actsEl) cfg.actsEl.style.display = 'none';

    var h = [];
    h.push('<div class="gm-cmp">');
    h.push('<div class="gm-cmp-head"><span class="gm-cmp-title">' + title + '</span>' +
      '<span style="font-size:11px;color:#666">from ' + esc(mailbox) + '</span>' +
      '<button class="gm-x" data-c="close" title="Discard">×</button></div>');

    h.push('<div class="gm-fld"><span class="gm-fld-l">To</span>' +
      '<span class="gm-chips" data-f="to"><input type="text" autocomplete="off" spellcheck="false" placeholder="name@example.com"></span>' +
      '<span class="gm-ccbcc"><button data-t="cc"' + (showCc ? ' class="on"' : '') + '>Cc</button>' +
      '<button data-t="bcc"' + (showBcc ? ' class="on"' : '') + '>Bcc</button></span></div>');
    h.push('<div class="gm-fld" data-r="cc"' + (showCc ? '' : ' style="display:none"') + '><span class="gm-fld-l">Cc</span>' +
      '<span class="gm-chips" data-f="cc"><input type="text" autocomplete="off" spellcheck="false"></span></div>');
    h.push('<div class="gm-fld" data-r="bcc"' + (showBcc ? '' : ' style="display:none"') + '><span class="gm-fld-l">Bcc</span>' +
      '<span class="gm-chips" data-f="bcc"><input type="text" autocomplete="off" spellcheck="false"></span></div>');
    h.push('<div class="gm-fld"><span class="gm-fld-l">Subject</span>' +
      '<input class="gm-subj" data-f="subject" type="text" autocomplete="off" value="' + esc(subject) + '"></div>');

    h.push('<div class="gm-tools" data-gm="tools">' + TOOLS.map(function (t) {
      if (t.sep) return '<span class="sep"></span>';
      // No "Font"/"Size" placeholder option: the control shows what the caret is
      // actually in, and syncFontSize() keeps it in step with the selection.
      if (t.sel === 'font') {
        return '<select data-sel="font" title="Font family for the selected text" aria-label="Font">' +
          FONTS.map(function (f) { return '<option value="' + f + '">' + f + '</option>'; }).join('') + '</select>';
      }
      if (t.sel === 'size') {
        return '<select data-sel="size" title="Text size for the selected text" aria-label="Size">' +
          SIZES.map(function (s) {
            return '<option value="' + s[0] + '"' + (s[0] === '3' ? ' selected' : '') + '>' + s[1] + '</option>';
          }).join('') + '</select>';
      }
      var cls = [t.wide ? 'wide' : '', t.accent ? 'accent' : ''].filter(Boolean).join(' ');
      return '<button type="button"' + (cls ? ' class="' + cls + '"' : '') +
        ' data-c="' + t.c + '" title="' + esc(t.t) + '" aria-label="' + esc(t.t) + '">' + t.l + '</button>';
    }).join('') + '</div>');

    /* ── ✨ AI. The four buttons used to occupy their own always-visible row; they
     * now live behind the "AI ▾" toolbar button, which reclaims that row for the body.
     * The buttons themselves are unchanged and still carry data-ai, so the existing
     * handler binds to them wherever they are rendered — see aiMenuHtml(). */
    var aiContactId = cfg.contactId || pre.contact_id || null;
    var aiHasThread = !!(msgs && msgs.length);
    function aiMenuHtml() {
      return (aiContactId ? '<button type="button" class="gm-pop-item" data-ai="summarize_client">Summarize client</button>' : '') +
        (aiHasThread ? '<button type="button" class="gm-pop-item" data-ai="summarize_thread">Summarize thread</button>' : '') +
        '<button type="button" class="gm-pop-item" data-ai="draft_reply">Draft reply</button>' +
        '<button type="button" class="gm-pop-item" data-ai="improve">Improve my draft</button>';
    }
    // Kept in the DOM (hidden) so aiBusy()/binding have a stable container even while
    // the menu popover is closed.
    h.push('<div class="gm-ai-bar" data-gm="aibar" style="display:none"></div>');

    /* Everything from here to the note is the ONE scrolling region. Header, fields,
     * toolbar, attachment row and Send bar all sit outside it and stay put. */
    h.push('<div class="gm-scroll" data-gm="scroll">');
    h.push('<div class="gm-ai-out" data-gm="aiout"></div>');
    h.push('<div class="gm-ed" data-f="body" contenteditable="true" data-ph="Write your message…"></div>');
    /* Collapsed by default, Gmail-style: a ••• chip inline where the signature goes.
     * Expanding shows the same editable node — the signature is never inlined into
     * the body, so send-time composition is unchanged. */
    /* ── WHO THIS WILL BE SIGNED AS ──────────────────────────────────────────
     * OUTSIDE the ••• toggle on purpose. The signature body is collapsed by
     * default, so anything inside it is effectively invisible at send time —
     * and the one fact that must not be invisible is whose name is going out.
     * processing@ is a shared, rotating login; the name attached to a borrower
     * email should never be something you have to go and look up. */
    h.push('<div class="gm-sig-wrap" data-gm="sigwrap" style="display:none">' +
      '<div class="gm-sig-who" data-gm="sigwho"></div>' +
      '<button type="button" class="gm-sig-dots" data-gm="sigdots" title="Show signature">•••</button>' +
      '<div class="gm-sig-l" data-gm="sigl" style="display:none">Signature — click to edit</div>' +
      '<div class="gm-sig" data-f="sig" contenteditable="true" style="display:none"></div>' +
      '</div>');

    if (quoteHtml) {
      h.push('<div class="gm-qt"><button class="gm-qt-btn" data-c="quote" title="Show quoted text">•••</button>' +
        '<div class="gm-qt-box" data-gm="qtbox"><iframe class="gm-qt-frame" sandbox="allow-same-origin"></iframe></div></div>');
    }
    h.push('</div>');   // /.gm-scroll

    h.push('<div class="gm-att" data-gm="att"></div>');
    h.push('<div class="gm-note" data-gm="note"></div>');
    h.push('<div class="gm-cmp-bar">' +
      '<button class="gm-send" data-c="send" disabled>Send</button>' +
      '<button class="gm-btn plain" data-c="close">Discard</button>' +
      '<label class="gm-sig-tog" data-gm="sigtog" style="display:none">' +
        '<input type="checkbox" data-gm="sigchk"><span data-gm="siglbl">Signature on</span></label>' +
      '<span class="gm-why" data-gm="why"></span>' +
      '<span class="gm-cmp-hint" data-gm="hint"></span></div>');
    h.push('</div>');
    mountEl.innerHTML = h.join('');

    var noteEl = mountEl.querySelector('[data-gm="note"]');
    var hintEl = mountEl.querySelector('[data-gm="hint"]');
    var edEl = mountEl.querySelector('[data-f="body"]');
    var sigEl = mountEl.querySelector('[data-f="sig"]');
    var sigL = mountEl.querySelector('[data-gm="sigl"]');
    var subjEl = mountEl.querySelector('[data-f="subject"]');
    var sendBtn = mountEl.querySelector('[data-c="send"]');

    var whyEl = mountEl.querySelector('[data-gm="why"]');

    /* ── SEND GATE ────────────────────────────────────────────────────────────
     * Send enables on: at least one valid recipient AND a non-empty body.
     * Forward is exempt from the body half — forwarding a thread with no added
     * note is a normal thing to do, and the quoted message is the payload. */
    var bodyRequired = !(mode === 'forward' && quoteHtml);
    function bodyHasContent() {
      return (edEl.innerHTML || '').replace(/<br\s*\/?>|&nbsp;|<div>\s*<\/div>|<p>\s*<\/p>|\s/gi, '') !== '';
    }
    var _sent = false;
    function refreshSend() {
      if (_sent) return;                       // frozen after a successful send
      var nTo = toF ? toF.valid() : 0;
      var okBody = !bodyRequired || bodyHasContent();
      // An attachment still uploading has no storage path yet, so sending now would
      // silently drop it. Block instead, and say why.
      var waiting = attPending();
      sendBtn.disabled = !(nTo && okBody) || waiting;
      whyEl.textContent = waiting ? 'Waiting for attachments to finish uploading…'
        : (nTo ? (okBody ? '' : 'Write a message to send.') : 'Add a recipient to send.');
    }

    var toF = chipField(mountEl.querySelector('[data-f="to"]'), rec.to, cl, refreshSend);
    var ccF = chipField(mountEl.querySelector('[data-f="cc"]'), rec.cc, cl, refreshSend);
    var bccF = chipField(mountEl.querySelector('[data-f="bcc"]'), preBcc, cl, refreshSend);
    edEl.addEventListener('input', refreshSend);

    // Draft body: sanitized before it ever reaches the editor — a draft's stored HTML is not
    // trustworthy just because it lives in our own mailbox.
    if (pre.body_html) {
      try { edEl.innerHTML = sanitize(pre.body_html); } catch (_) {}
    } else if (pre.body_text) {
      edEl.innerHTML = esc(pre.body_text).replace(/\r?\n/g, '<br>');
    }

    function note(kind, title, detail) {
      noteEl.className = 'gm-note ' + kind;
      noteEl.innerHTML = '<b>' + esc(title) + '</b>' + (detail || '');
    }
    function clearNote() { noteEl.className = 'gm-note'; noteEl.innerHTML = ''; }

    /* hooks are read at click time, so the functions below can be declared later in
     * this scope (they are hoisted function declarations). wireEditor also writes
     * insertHTML back onto this object for the video path. */
    var edHooks = {
      attach: function () { pickAttachments(); },
      video: function (btn) { openVideoRecorder(btn); },
      ai: function (btn) {
        if (_aiBusy) return;
        var am = document.createElement('div');
        am.className = 'gm-pop-menu';
        am.innerHTML = aiMenuHtml();
        var apop = portalPopover(btn, am, { width: 240 });
        bindAi(am);
        // Every AI action writes into the body or the AI output panel, so the menu has
        // done its job the moment one is clicked.
        Array.prototype.forEach.call(am.querySelectorAll('[data-ai]'), function (x) {
          x.addEventListener('click', function () { setTimeout(function () { apop.close(); }, 0); });
        });
      }
    };
    wireEditor(edEl, mountEl.querySelector('[data-gm="tools"]'), cl, edHooks);
    wireEditor(sigEl, null, cl);

    // Cc/Bcc toggles
    Array.prototype.forEach.call(mountEl.querySelectorAll('.gm-ccbcc button'), function (b) {
      b.addEventListener('click', function () {
        var row = mountEl.querySelector('[data-r="' + b.getAttribute('data-t') + '"]');
        var on = row.style.display === 'none';
        row.style.display = on ? '' : 'none';
        b.classList.toggle('on', on);
        if (on) (b.getAttribute('data-t') === 'cc' ? ccF : bccF).focus();
      });
    });

    // Collapsible quote — rendered in a sandboxed iframe, same boundary as reading mail
    var qBtn = mountEl.querySelector('[data-c="quote"]');
    if (qBtn) {
      qBtn.addEventListener('click', function () {
        var box = mountEl.querySelector('[data-gm="qtbox"]');
        var open = box.classList.toggle('open');
        qBtn.title = open ? 'Hide quoted text' : 'Show quoted text';
        if (open) {
          var f = box.querySelector('iframe');
          if (!f.getAttribute('data-filled')) {
            f.setAttribute('data-filled', '1');
            autoFit(f, 260); // quote preview stays capped; the box scrolls
            f.srcdoc = wrapBody(quoteHtml, '');
          }
        }
      });
    }

    /* ── SIGNATURE (async — never blocks typing) ───────────────────────────────
     * The signature lives in its OWN contentEditable, never inside the body. That
     * is what makes double-append structurally impossible: send composes
     * body + signature + quote fresh each time from separate nodes, so editing and
     * re-sending can't stack a second copy. The toggle only decides whether that
     * one node is included. Last choice is remembered across composers. */
    var SIG_KEY = 'gmComposerSignatureOn';
    var sigLoaded = '';
    var sigOn = (function () {
      try { var v = localStorage.getItem(SIG_KEY); return v === null ? true : v === '1'; }
      catch (_) { return true; }
    })();
    var sigTog = mountEl.querySelector('[data-gm="sigtog"]');
    var sigChk = mountEl.querySelector('[data-gm="sigchk"]');
    var sigLbl = mountEl.querySelector('[data-gm="siglbl"]');

    /* Collapsed is the default state, matching Gmail. sigExpanded is per-composer and
     * deliberately NOT persisted — collapsed is what reclaims the height, so every
     * new composer should start that way. The "Signature on" toggle is separate and
     * still persisted: it decides whether the signature is SENT, not whether it's
     * shown. Off ⇒ the whole affordance disappears. */
    var sigExpanded = false;
    var sigWrap = mountEl.querySelector('[data-gm="sigwrap"]');
    var sigDots = mountEl.querySelector('[data-gm="sigdots"]');

    function applySig() {
      var have = !!sigLoaded;
      sigTog.style.display = have ? '' : 'none';   // no signature on file → no toggle
      sigChk.checked = sigOn;
      sigTog.classList.toggle('off', !sigOn);
      sigLbl.textContent = sigOn ? 'Signature on' : 'Signature off';
      var show = have && sigOn;
      sigWrap.style.display = show ? '' : 'none';
      sigEl.style.display = (show && sigExpanded) ? '' : 'none';
      sigL.style.display = (show && sigExpanded) ? '' : 'none';
      sigDots.classList.toggle('on', sigExpanded);
      sigDots.title = sigExpanded ? 'Hide signature' : 'Show signature';
      sigDots.setAttribute('aria-expanded', sigExpanded ? 'true' : 'false');
    }
    sigDots.addEventListener('click', function () {
      sigExpanded = !sigExpanded;
      applySig();
      if (sigExpanded) sigEl.focus();
    });
    sigChk.addEventListener('change', function () {
      sigOn = sigChk.checked;
      try { localStorage.setItem(SIG_KEY, sigOn ? '1' : '0'); } catch (_) {}
      applySig();
    });
    getSignature(cl, mailbox).then(function (sig) {
      if (!sig) return;
      try { sigEl.innerHTML = sanitize(sig); } catch (_) { return; }
      sigLoaded = sig;
      applySig();
    });
    /* Independent of the signature fetch: the "signing as" line must render
       even when the signature body fails to load, because a missing signature
       is obvious and a wrong NAME is not. */
    getSignatureIdentity(cl, mailbox).then(function (id) {
      renderSigWho(mountEl.querySelector('[data-gm="sigwho"]'), id, mailbox);
    });
    applySig();

    /* ── ATTACHMENTS ───────────────────────────────────────────────────────────
     * Files upload to the PRIVATE email-attachments bucket with the authenticated
     * client, and the send payload carries their storage paths — not their bytes.
     * gmail-inbox then downloads each path service-side to build the multipart/mixed
     * MIME. Two reasons for that shape: a 20MB attachment is ~27MB as base64 JSON,
     * which is a hostile request body; and the persisted copy the spec asks for falls
     * out of the same upload instead of needing a second one. */
    var ATT_BUCKET = 'email-attachments';
    var ATT_MAX_TOTAL = 20 * 1024 * 1024;    // 20MB across all attachments
    var atts = [];
    var attEl = mountEl.querySelector('[data-gm="att"]');

    function fmtBytes(n) {
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }
    // Failed uploads don't count toward the cap — they were never attached, so charging
    // the budget for them would block a legitimate retry.
    function attTotal() {
      return (atts || []).reduce(function (s, a) {
        return a.state === 'error' ? s : s + (a.size || 0);
      }, 0);
    }
    // Defensive on `atts`: refreshSend() runs during chipField construction, which
    // happens before this block's `var atts = []` has executed.
    function attPending() {
      return (atts || []).some(function (a) { return a.state === 'uploading'; });
    }
    function renderAtts() {
      attEl.classList.toggle('on', atts.length > 0);
      attEl.innerHTML = atts.map(function (a) {
        var cls = 'gm-att-chip' + (a.state === 'error' ? ' err' : (a.state === 'uploading' ? ' busy' : ''));
        var note = a.state === 'uploading' ? ' · uploading…' : (a.state === 'error' ? ' · failed' : '');
        return '<span class="' + cls + '" title="' + esc(a.name + (a.error ? ' — ' + a.error : '')) + '">' +
          '<span class="n">📎 ' + esc(a.name) + '</span>' +
          '<span class="s">' + fmtBytes(a.size) + esc(note) + '</span>' +
          '<button type="button" class="x" data-att="' + esc(a.id) + '" title="Remove">×</button></span>';
      }).join('');
      Array.prototype.forEach.call(attEl.querySelectorAll('[data-att]'), function (x) {
        x.addEventListener('click', function () { removeAtt(x.getAttribute('data-att')); });
      });
      refreshSend();
    }
    function removeAtt(id) {
      var a = atts.filter(function (x) { return x.id === id; })[0];
      atts = atts.filter(function (x) { return x.id !== id; });
      renderAtts();
      // Best-effort tidy of the stored object; an orphan is harmless and the send
      // record is what matters, so a failure here must not block anything.
      if (a && a.path) {
        try { cl.storage.from(ATT_BUCKET).remove([a.path]).catch(function () {}); } catch (_) {}
      }
    }
    function safeAttName(n) {
      return (String(n || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'file').slice(-120);
    }
    async function addFiles(files) {
      var list = Array.prototype.slice.call(files || []);
      if (!list.length) return;
      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        // Loud, specific refusal — never a silent drop.
        if (attTotal() + f.size > ATT_MAX_TOTAL) {
          note('bad', 'Attachment too large',
            esc(f.name) + ' is ' + fmtBytes(f.size) + '. The 20MB total limit would be exceeded' +
            (atts.length ? ' (' + fmtBytes(attTotal()) + ' already attached)' : '') +
            '. Remove something or send a link instead.');
          continue;
        }
        var rec2 = {
          id: 'a' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          name: f.name, size: f.size, mime: f.type || 'application/octet-stream',
          path: null, state: 'uploading', error: null
        };
        atts.push(rec2);
        renderAtts();
        /* eslint-disable no-loop-func */
        (function (r, file) {
          var path = mailbox + '/' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) +
            '/' + safeAttName(file.name);
          cl.storage.from(ATT_BUCKET).upload(path, file, {
            contentType: r.mime, upsert: false
          }).then(function (res) {
            if (res && res.error) throw new Error(res.error.message);
            r.path = path; r.state = 'ready';
            renderAtts();
          }).catch(function (e) {
            r.state = 'error';
            r.error = (e && e.message) || 'upload failed';
            renderAtts();
            note('bad', 'Attachment upload failed', esc(r.name) + ' — ' + esc(r.error) +
              '. Remove it and retry, or send without it.');
          });
        })(rec2, f);
        /* eslint-enable no-loop-func */
      }
    }
    function pickAttachments() {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      inp.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(inp);
      inp.addEventListener('change', function () {
        addFiles(inp.files);
        inp.remove();
      });
      inp.click();
    }

    /* ── RECORD VIDEO ──────────────────────────────────────────────────────────
     * Ported from admin/email-marketing.html: same getUserMedia + MediaRecorder
     * state machine, same 120s cap, same authenticated upload to video-messages
     * (window._supabaseClient — NOT the anon key; that bucket's write policy is
     * authenticated-only). What differs is only the shell: a popover instead of that
     * page's fixed modal, and insertion through thumbLinkHtml + the composer's
     * sanitizing insertHTML instead of a Quill call. */
    var VID_BUCKET = 'video-messages';
    // Public origin that serves /v/<slug>. loom-recorder.js now emits the same
    // shape — until 2026-08-05 it emitted /watch.html?v=<slug> while this comment
    // already claimed they matched, which is the kind of claim worth checking
    // rather than reading.
    var WATCH_BASE = 'https://ratesandrealty.com';
    function openVideoRecorder(anchor) {
      var box = document.createElement('div');
      box.className = 'gm-pop-menu gm-vid-box';
      box.innerHTML =
        '<video data-v="pre" autoplay muted playsinline></video>' +
        '<video data-v="play" controls playsinline style="display:none"></video>' +
        '<div class="gm-vid-t" data-v="t">0:00</div>' +
        '<div class="gm-vid-row">' +
          '<button type="button" class="gm-ai-btn" data-v="rec">● Record</button>' +
          '<button type="button" class="gm-ai-btn" data-v="use" style="display:none">Insert</button>' +
          '<button type="button" class="gm-ai-btn" data-v="re" style="display:none">Retake</button>' +
        '</div>' +
        '<div class="gm-ai-note" data-v="msg">Up to 2 minutes. The video uploads and is inserted as a clickable thumbnail — mail clients can’t play video inline.</div>';

      // onClose must be supplied up front (portalPopover reads opts.onClose), but the
      // teardown it needs is defined below — so route through a holder.
      var cleanup = null;
      var pop = portalPopover(anchor, box, {
        width: 340,
        onClose: function () { if (cleanup) cleanup(); }
      });
      var pre = box.querySelector('[data-v="pre"]');
      var play = box.querySelector('[data-v="play"]');
      var tEl = box.querySelector('[data-v="t"]');
      var recB = box.querySelector('[data-v="rec"]');
      var useB = box.querySelector('[data-v="use"]');
      var reB = box.querySelector('[data-v="re"]');
      var msg = box.querySelector('[data-v="msg"]');

      var stream = null, mr = null, chunks = [], blob = null, secs = 0, tick = null, objUrl = null;
      var recExt = 'webm', recMime = 'video/webm';
      // Poster captured DURING recording (see grabPoster) rather than from the
      // playback element afterwards: the live stream is guaranteed to have a decoded
      // frame available, whereas the <video> may not have painted one yet when the
      // user clicks Insert immediately after stopping.
      var posterBlob = null;

      function stopStream() {
        if (tick) { clearInterval(tick); tick = null; }
        if (mr && mr.state === 'recording') { try { mr.stop(); } catch (_) {} }
        if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
        if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (_) {} objUrl = null; }
      }
      // Releasing the camera when the popover closes is not optional — the capture
      // light staying on after dismissal is alarming and looks like a bug.
      cleanup = stopStream;

      /* Unconstrained getUserMedia gave whatever the driver defaulted to — 640x480 on
       * Rene's machine. Ask for 720p30 explicitly, and turn on the three audio
       * cleanups, because these are recorded in a home office on a laptop mic. */
      navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      }).then(function (s) {
        stream = s;
        pre.srcObject = s;
        var t = s.getVideoTracks()[0];
        var st = t && t.getSettings ? t.getSettings() : null;
        if (st && st.width) msg.textContent = 'Ready · ' + st.width + '×' + st.height +
          (st.frameRate ? ' @' + Math.round(st.frameRate) + 'fps' : '') + ' · up to 2 minutes.';
      }).catch(function () {
        msg.innerHTML = '<b>Camera unavailable.</b> Grant camera and microphone access, then reopen this menu.';
        recB.disabled = true;
      });

      function fmtT(n) { return Math.floor(n / 60) + ':' + (n % 60 < 10 ? '0' : '') + (n % 60); }

      recB.addEventListener('click', function () {
        if (mr && mr.state === 'recording') { mr.stop(); return; }
        if (!stream) return;
        chunks = [];
        /* Codec preference: MP4/H.264 first. Recipients open these on phones and WebM
         * has real playback gaps on older iOS, so an MP4 that plays everywhere beats a
         * marginally smaller WebM that silently fails for some of them. Verified on
         * this machine (Chrome 150): video/mp4;codecs=avc1 IS supported for recording,
         * so this chain actually takes the first branch rather than falling through. */
        var chosen = pickRecordMime();
        try { mr = new MediaRecorder(stream, chosen.opts); }
        catch (_) {
          try { mr = new MediaRecorder(stream); chosen = { mime: '', ext: 'webm', opts: {} }; }
          catch (e2) { msg.textContent = 'Recording is not supported in this browser.'; return; }
        }
        recExt = chosen.ext;
        recMime = chosen.mime || 'video/webm';
        mr.ondataavailable = function (e) { if (e.data && e.data.size > 0) chunks.push(e.data); };
        mr.onstop = function () {
          if (tick) { clearInterval(tick); tick = null; }
          blob = new Blob(chunks, { type: 'video/webm' });
          objUrl = URL.createObjectURL(blob);
          pre.style.display = 'none';
          play.src = objUrl;
          play.style.display = '';
          recB.style.display = 'none';
          useB.style.display = '';
          reB.style.display = '';
          msg.textContent = 'Recorded ' + fmtT(secs) + ' · ' + fmtBytes(blob.size);
        };
        mr.start();
        secs = 0; tEl.textContent = '0:00';
        recB.textContent = '■ Stop';
        // Grab the poster a beat in — frame 0 is usually the camera still warming up.
        setTimeout(grabPoster, 1200);
        tick = setInterval(function () {
          secs++;
          tEl.textContent = fmtT(secs);
          if (secs >= 120) { try { mr.stop(); } catch (_) {} }   // same 2-minute cap
        }, 1000);
      });

      reB.addEventListener('click', function () {
        blob = null;
        if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (_) {} objUrl = null; }
        play.style.display = 'none';
        play.removeAttribute('src');
        pre.style.display = '';
        pre.srcObject = stream;
        useB.style.display = 'none';
        reB.style.display = 'none';
        recB.style.display = '';
        recB.textContent = '● Record';
        secs = 0; tEl.textContent = '0:00';
        msg.textContent = 'Up to 2 minutes.';
      });

      /* Real frame for the poster, taken off the LIVE preview while recording. Used
       * both as the <video poster> on the landing page and as the emailed thumbnail
       * image — the old behaviour fell back to a generic "Click to watch" chip. */
      function grabPoster() {
        if (posterBlob || !stream) return;
        try {
          var w = pre.videoWidth || 1280, hh = pre.videoHeight || 720;
          if (!w || !hh) return;
          var c = document.createElement('canvas');
          c.width = w; c.height = hh;
          c.getContext('2d').drawImage(pre, 0, 0, w, hh);
          c.toBlob(function (b) { if (b) posterBlob = b; }, 'image/jpeg', 0.82);
        } catch (_) {}
      }

      useB.addEventListener('click', async function () {
        if (!blob) return;
        useB.disabled = true; reB.disabled = true;
        msg.textContent = 'Uploading…';
        try {
          // The bucket's write policy is authenticated-only; _supabaseClient carries
          // the session. Anything else 403s.
          var vcl = window._supabaseClient || cl;
          if (!vcl) throw new Error('Not signed in — reload the page and try again.');

          /* PRIVACY: the object name IS the access control here — video-messages is
           * public-read so anyone holding the URL can watch. The old name was
           * inbox-<epoch-ms>.webm, and epoch-ms is trivially walkable: guess a
           * plausible millisecond and you have someone else's video. Use an
           * unguessable id, and follow the convention loom-recorder.js already
           * established (videos/<uuid>.<ext>) instead of inventing a second one. */
          var uuid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
            : Array.from(crypto.getRandomValues(new Uint8Array(16)))
                .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
          var vpath = 'videos/' + uuid + '.' + recExt;
          var up = await vcl.storage.from(VID_BUCKET).upload(vpath, blob, {
            contentType: recMime, upsert: false
          });
          if (up && up.error) throw new Error(up.error.message);
          var base = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL) || '';
          var videoUrl = base + '/storage/v1/object/public/' + VID_BUCKET + '/' + vpath;

          /* Anything already written when a later step fails gets removed, so a
           * half-finished save leaves no orphaned objects in the bucket. */
          var written = [vpath];
          async function rollback() {
            try { await vcl.storage.from(VID_BUCKET).remove(written); } catch (_) {}
          }

          /* POSTER — fatal on failure, not "a nicety".
           * It was swallowed by a bare catch and an `if (!error)`, so a poster that
           * never uploaded silently downgraded the message to a bare text link and
           * left the landing page with no <video poster> — a partial save that
           * reported success. The recording is still in the buffer at this point, so
           * failing here costs a retry, not the take. */
          grabPoster();   // last chance, if the 1.2s timer never fired
          if (!posterBlob) {
            await rollback();
            throw new Error('Could not capture a thumbnail frame from this recording. Re-record and try again.');
          }
          var ppath = 'videos/' + uuid + '-poster.jpg';
          var pu = await vcl.storage.from(VID_BUCKET).upload(ppath, posterBlob, {
            contentType: 'image/jpeg', upsert: false
          });
          if (pu && pu.error) {
            await rollback();
            throw new Error('Thumbnail upload failed: ' + pu.error.message);
          }
          written.push(ppath);
          var thumbUrl = base + '/storage/v1/object/public/' + VID_BUCKET + '/' + ppath;

          /* Register the video so it has a shareable slug — also fatal now.
           * video_create is the same RPC loom-recorder.js uses, so both recorders
           * produce one kind of row and the /v/<slug> landing page has a single
           * source to resolve. Without a slug there IS no landing page, so nothing
           * about the send is trackable: that is a failed save, not a degraded one.
           * Param names are exactly video_create's signature (p_duration / p_size,
           * no p_mime_type) — the old bare catch meant a mismatch would 404 the RPC
           * and be swallowed, silently leaving the video unregistered. */
          var vc = await vcl.rpc('video_create', {
            p_title: 'Video message · ' + new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }),
            p_storage_path: vpath,
            p_public_url: videoUrl,
            p_duration: secs,
            p_size: blob.size,
            p_kind: 'inbox',
            p_contact_id: cfg.contactId || null,
            p_context: 'email'
          });
          if (vc && vc.error) { await rollback(); throw new Error('Could not register the video: ' + vc.error.message); }
          var vslug = vc && vc.data && vc.data.slug;
          if (!vslug) { await rollback(); throw new Error('Could not register the video — no share link was issued.'); }

          /* Link to the landing page, never to storage. The direct supabase.co URL
           * put the origin in the recipient's inbox and bypassed /v/<slug> tracking
           * entirely, so none of the milestones could ever fire. */
          var watchUrl = WATCH_BASE + '/v/' + encodeURIComponent(vslug);
          var posterUrl = WATCH_BASE + '/v/' + encodeURIComponent(vslug) + '/poster';
          var html = thumbLinkHtml(watchUrl, posterUrl, 'Click to watch (' + fmtT(secs) + ')');

          // Same sanitizing insert as every other toolbar action (wireEditor writes
          // insertHTML onto the hooks object it was handed).
          if (edHooks.insertHTML) edHooks.insertHTML(html); else edEl.innerHTML += sanitize(html);
          refreshSend();
          pop.close();
        } catch (e) {
          useB.disabled = false; reB.disabled = false;
          msg.innerHTML = '<b>Upload failed.</b> ' + esc((e && e.message) || String(e));
        }
      });
    }

    /* ── ✨ AI ASSISTANT ───────────────────────────────────────────────────────
     * Everything the model writes lands in the SAME contentEditable Rene types in,
     * so it is fully editable afterwards and — critically — leaves via the identical
     * DOMPurify path on send. AI output is sanitized here too (defence in depth: it
     * arrives as HTML over the network and is not trusted just because we asked for it).
     */
    var aiOut = mountEl.querySelector('[data-gm="aiout"]');
    var aiBar = mountEl.querySelector('[data-gm="aibar"]');
    var _aiBusy = false;

    function aiShow(kind, title, html) {
      aiOut.className = 'gm-ai-out on' + (kind === 'bad' ? ' bad' : '');
      aiOut.innerHTML = '<button class="gm-ai-x" data-gm="aix" title="Dismiss">×</button>' +
        '<h5>' + esc(title) + '</h5><div>' + html + '</div>';
      var x = aiOut.querySelector('[data-gm="aix"]');
      if (x) x.addEventListener('click', function () { aiOut.className = 'gm-ai-out'; aiOut.innerHTML = ''; });
    }
    function aiBusy(on) {
      // The buttons now live in a body-portalled popover that may be open or closed,
      // so latch the state too — the AI ▾ button consults _aiBusy before opening.
      _aiBusy = !!on;
      Array.prototype.forEach.call(aiBar.querySelectorAll('[data-ai]'), function (b) { b.disabled = on; });
      Array.prototype.forEach.call(document.querySelectorAll('.gm-pop-menu [data-ai]'), function (b) { b.disabled = on; });
    }
    // Thread text is sent from here rather than re-fetched server-side — the browser
    // already has the full thread from get_thread, so a refetch would be a second
    // Gmail round trip per click for bytes we're holding.
    function threadText() {
      return (msgs || []).map(function (m) {
        var who = m.direction === 'outbound' ? 'Rene (us)' : ((m.from && (m.from.name || m.from.email)) || 'them');
        var when = m.date ? String(m.date).slice(0, 10) : '';
        return '--- ' + who + ' ' + when + '\n' + String(m.body_text || '').slice(0, 4000);
      }).join('\n\n').slice(0, 40000);
    }
    async function callAI(action, extra) {
      var r = await cl.functions.invoke('compose-ai', {
        body: Object.assign({ action: action }, extra || {})
      });
      if (r.error) {
        var msg = r.error.message || 'request failed';
        try { if (r.error.context && r.error.context.json) { var j = await r.error.context.json(); if (j && j.error) msg = j.error; } } catch (_) {}
        throw new Error(msg);
      }
      if (r.data && r.data.ok === false) throw new Error(r.data.error || 'request failed');
      return r.data || {};
    }

    /* The AI buttons are now rendered on demand inside the "AI ▾" popover, so binding
     * has to happen per-render instead of once at mount. Same handler, same buttons —
     * bindAi() is called with the popover's root each time it opens. */
    function bindAi(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-ai]'), function (btn) {
      btn.addEventListener('click', async function () {
        var action = btn.getAttribute('data-ai');
        var label = btn.textContent;
        if (action === 'improve' && !bodyHasContent()) {
          aiShow('bad', 'Nothing to improve', 'Write a draft first, then Improve will rewrite it.');
          return;
        }
        var instruction = '';
        if (action === 'draft_reply') {
          instruction = window.prompt(
            'Anything specific for this reply? (optional — e.g. "decline politely", "ask for the updated CD")', '') || '';
          if (instruction === null) return;
        }
        aiBusy(true);
        aiShow('', label, '<span class="gm-ai-spin"></span> Working…');
        try {
          var payload;
          if (action === 'summarize_client') payload = { contact_id: aiContactId };
          else if (action === 'summarize_thread') payload = { thread_text: threadText(), thread_id: cfg.threadId || null, mailbox: mailbox };
          else if (action === 'draft_reply') payload = { thread_text: threadText(), contact_id: aiContactId, mailbox: mailbox, instruction: instruction };
          else payload = { draft_text: edEl.innerHTML };

          var res = await callAI(action, payload);

          if (action === 'summarize_client' || action === 'summarize_thread') {
            // Read-only briefing — never touches the message body.
            aiShow('', label, esc(res.text || '').replace(/\n/g, '<br>'));
            return;
          }

          var clean = sanitize(res.html || '');
          if (!clean.trim()) { aiShow('bad', label, 'The AI returned nothing usable. Try again.'); return; }

          if (action === 'improve') {
            // Destructive — swap in place, but keep the original one undo away.
            var prev = edEl.innerHTML;
            edEl.innerHTML = clean;
            aiShow('', 'Draft improved', 'Your message was rewritten — edit it freely. ' +
              '<button class="gm-ai-btn" data-gm="aiundo" style="margin-left:6px">Undo</button>');
            var u = aiOut.querySelector('[data-gm="aiundo"]');
            if (u) u.addEventListener('click', function () {
              edEl.innerHTML = prev; refreshSend();
              aiShow('', 'Reverted', 'Your original draft is back.');
            });
          } else {
            // draft_reply: replacing silently would destroy typing in progress, so
            // only an empty body is replaced outright — otherwise append and say so.
            if (bodyHasContent()) {
              edEl.innerHTML = edEl.innerHTML + '<br>' + clean;
              aiShow('', 'Draft appended', 'You had already written something, so the suggestion was added below it rather than replacing it.');
            } else {
              edEl.innerHTML = clean;
              aiShow('', 'Draft inserted', 'Edit it as you like before sending.');
            }
          }
          refreshSend();
          edEl.focus();
        } catch (e) {
          aiShow('bad', label + ' failed', esc((e && e.message) || String(e)));
        } finally { aiBusy(false); }
      });
    });
    }   // /bindAi

    function close() {
      if (cfg.onClose) { cfg.onClose(); return; }   // modal compose closes the overlay
      mountEl.innerHTML = '';
      if (cfg.actsEl) cfg.actsEl.style.display = '';
    }
    Array.prototype.forEach.call(mountEl.querySelectorAll('[data-c="close"]'), function (b) {
      b.addEventListener('click', function () {
        var dirty = (edEl.innerHTML || '').replace(/<br>|\s|&nbsp;/g, '') !== '';
        if (dirty && !window.confirm('Discard this message? (Draft saving arrives in the next release.)')) return;
        close();
      });
    });

    // focus: an empty recipient list means start there; otherwise start writing
    if (mode === 'forward' || (mode === 'new' && !rec.to.length)) toF.focus(); else edEl.focus();
    refreshSend();   // set the initial enabled/disabled state from the prefilled values

    sendBtn.addEventListener('click', async function () {
      clearNote();
      var to = toF.get(), cc = ccF.get(), bcc = bccF.get();
      var subjVal = (subjEl.value || '').trim();

      var bad = to.concat(cc, bcc).filter(function (e) { return !RE_EMAIL.test(e); });
      if (!to.length) { note('bad', 'Add at least one recipient', 'The <b>To</b> field is empty.'); toF.focus(); return; }
      if (bad.length) { note('bad', 'Fix these addresses', esc(bad.join(', ')) + ' — that doesn’t look like a valid email.'); return; }
      if (!subjVal) { note('bad', 'Add a subject', 'Subject can’t be empty.'); subjEl.focus(); return; }
      var bodyEmpty = (edEl.innerHTML || '').replace(/<br>|\s|&nbsp;|<div><\/div>/gi, '') === '';
      if (bodyEmpty && mode !== 'forward' && !window.confirm('Send with an empty message body?')) return;
      // Never let a failed upload leave silently. Sending is still allowed, but only
      // as an explicit choice.
      var failedAtts = (atts || []).filter(function (a) { return a.state === 'error'; });
      if (failedAtts.length && !window.confirm(
        failedAtts.length + ' attachment' + (failedAtts.length > 1 ? 's' : '') +
        ' failed to upload and will NOT be attached:\n\n' +
        failedAtts.map(function (a) { return '• ' + a.name; }).join('\n') +
        '\n\nSend anyway?')) return;

      // ── assemble, then sanitize the WHOLE composed body as the last gate ──
      var composed;
      try {
        var parts = ['<div dir="ltr">' + edEl.innerHTML + '</div>'];
        // Signature is appended from its own node, gated on the toggle. Composed
        // fresh every send, so a re-send after an edit cannot stack a second copy.
        if (sigOn && sigLoaded && sigEl.innerHTML.trim()) {
          parts.push('<br><div class="gmail_signature">' + sigEl.innerHTML + '</div>');
        }
        if (quoteHtml) parts.push('<br>' + quoteHtml);
        composed = sanitize(parts.join(''));
      } catch (e) {
        note('bad', 'Refused to send', esc(e.message));
        return;
      }
      var bodyText = htmlToText(composed);

      sendBtn.disabled = true;
      var wasLabel = sendBtn.textContent;
      sendBtn.textContent = 'Sending…';
      hintEl.textContent = '';
      note('warn', 'Sending…', 'Contacting Gmail as ' + esc(mailbox) + '.');

      var payload = {
        to: to.join(', '), subject: subjVal,
        body_html: composed, body_text: bodyText
      };
      // Only uploaded attachments travel — paths, not bytes. gmail-inbox fetches each
      // one service-side to build the multipart/mixed body and records the same list
      // on the email_log row.
      var readyAtts = (atts || []).filter(function (a) { return a.state === 'ready' && a.path; });
      if (readyAtts.length) {
        payload.attachments = readyAtts.map(function (a) {
          return { path: a.path, name: a.name, size: a.size, mime: a.mime };
        });
      }
      // Compose/draft is a NEW conversation — sending it with a thread_id would staple it
      // onto an unrelated thread.
      if (mode !== 'new' && cfg.threadId) payload.thread_id = cfg.threadId;
      if (cc.length) payload.cc = cc.join(', ');
      if (bcc.length) payload.bcc = bcc.join(', ');
      if (mode !== 'new' && rec.target && rec.target.message_id) payload.in_reply_to = rec.target.message_id;

      try {
        var res = await invoke(cl, mailbox, 'send', payload);
        var when = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT';
        var filed = res && res.filed_as
          ? 'Filed to the lead (' + esc(res.filed_as) + ').'
          : 'Not filed to a lead — no recipient matched a contact. Tag the thread to file it.';
        note('ok', '✓ Sent to ' + esc(to.join(', ')),
          when + ' · from <b>' + esc(mailbox) + '</b><br>' + filed +
          (res && res.message_id ? '<br>Gmail id <code>' + esc(res.message_id) + '</code>' : ''));
        // Freeze the composer: the message is gone, editing it now means nothing.
        // _sent latches so refreshSend() can't re-enable the button behind us.
        _sent = true;
        whyEl.textContent = '';
        sendBtn.textContent = 'Sent ✓';
        aiBusy(true);
        [edEl, sigEl].forEach(function (n) { n.setAttribute('contenteditable', 'false'); });
        subjEl.disabled = true;
        Array.prototype.forEach.call(mountEl.querySelectorAll('.gm-chips input,.gm-tools button'), function (n) { n.disabled = true; });
        var bar = mountEl.querySelector('.gm-cmp-bar');
        var done = document.createElement('button');
        done.className = 'gm-btn';
        done.textContent = mode === 'new' ? 'Close' : 'Back to thread';
        done.addEventListener('click', function () { if (cfg.onDone) cfg.onDone(); else close(); });
        bar.appendChild(done);

        // Sending from a draft does NOT consume the Gmail draft — the copy would linger in
        // Drafts forever. Offer removal explicitly rather than deleting silently.
        if (pre.draft_id) {
          var del = document.createElement('button');
          del.className = 'gm-btn plain';
          del.textContent = 'Delete the original draft';
          del.addEventListener('click', async function () {
            del.disabled = true; del.textContent = 'Deleting…';
            try {
              await invoke(cl, mailbox, 'delete_draft', { draft_id: pre.draft_id });
              del.textContent = 'Draft deleted ✓';
              if (cfg.onDraftGone) cfg.onDraftGone(pre.draft_id);
            } catch (e2) { del.disabled = false; del.textContent = 'Delete failed — retry'; }
          });
          bar.appendChild(del);
        }
      } catch (err) {
        // Loud, persistent, and the draft is left completely intact.
        note('bad', '✕ Not sent — nothing was delivered',
          'Gmail rejected the send:<br><code>' + esc(err.message) + '</code><br>' +
          'Your message is still here. Fix the issue and press Send again.');
        sendBtn.disabled = false;
        sendBtn.textContent = wasLabel;
        hintEl.textContent = 'Nothing was sent — your text is preserved.';
      }
    });
  }

  // ── render one thread (used by both the desktop pane and the modal viewer) ──
  async function renderThread(host, ctx) {
    var cl = ctx.client, mailbox = ctx.mailbox, threadId = ctx.threadId;
    host.innerHTML = '<div class="gm-empty">Loading thread…</div>';
    var data;
    try { data = await invoke(cl, mailbox, 'get_thread', { thread_id: threadId }); }
    catch (e) { host.innerHTML = '<div class="gm-empty">Could not load thread: ' + esc(e.message) + '</div>'; return; }
    var msgs = data.messages || [];
    // filed status: explicit tag wins, else auto-match from get_thread
    var filedId = null, filedVia = null;
    try {
      var tr = await cl.from('email_thread_tags').select('contact_id').eq('gmail_thread_id', threadId).limit(1);
      if (!tr.error && tr.data && tr.data.length) { filedId = tr.data[0].contact_id; filedVia = 'tag'; }
    } catch (_) {}
    if (!filedId && data.matched && data.matched.contact_id) { filedId = data.matched.contact_id; filedVia = data.matched.matched_by; }
    var filedNm = filedId ? (await contactName(cl, filedId)) : null;

    var subj = (msgs[0] && msgs[0].subject) || '(no subject)';
    // reply target: last inbound sender, else last message's first recipient
    // Recipients are computed by the composer (computeRecipients) — it honors Reply-To,
    // which the old inline heuristic here ignored.
    var last = msgs[msgs.length - 1] || {};

    /* ── header: ONE line ──────────────────────────────────────────────────────
     * Subject, the filed state as a chip, and everything actionable behind a ▾.
     * This used to be a subject line plus a full row of Filed/Re-file/Unfile/
     * Archive buttons, which cost a whole row of the reading pane permanently. */
    var h = [];
    h.push('<div class="gm-phead">');
    if (!ctx.modal) h.push('<button class="gm-btn plain gm-back" data-gm="back">‹</button>');
    h.push('<div class="gm-psubj" title="' + esc(subj) + '">' + esc(subj) + '</div>');
    h.push('<div class="gm-pacts">');
    h.push('<span class="gm-badge' + (filedId ? '' : ' none') + '"' +
      (filedId ? ' title="Filed via ' + esc(filedVia || '') + '"' : ' title="Not filed to a lead"') + '>' +
      (filedId ? '🏷 ' + esc(filedNm || 'lead') : '🏷 Not filed') + '</span>');
    h.push('<button class="gm-btn plain" data-gm="acts" title="Thread actions">▾</button>');
    if (ctx.modal) h.push('<button class="gm-modal-close" data-gm="close">×</button>');
    h.push('</div></div>');

    /* ── escrow-number suggestion ──────────────────────────────────────────────
     *
     * SUGGESTS, NEVER FILES. Every button here is a human deciding; nothing
     * below writes a filing on its own.
     *
     * The copy names BOTH the token matched and the contact, and in the loud
     * case also names the address the automatic match used. That is the whole
     * design: an insurance thread about 947 N Alamo, filed on a contact because
     * an agent's address appeared in the CC, is obviously wrong the moment the
     * evidence is written down — and indistinguishable from a deliberate
     * decision when it is not. */
    var esc_ = data.escrow || { state: 'none' };
    var escHtml = '';
    if (esc_.state === 'suggest') {
      escHtml = '<div class="gm-esc"><div class="t">🔎 Escrow <code>' + esc(esc_.reference) + '</code> appears in this thread. ' +
        'That is the escrow number on <b>' + esc(esc_.contact.name) + '</b>’s file.</div>' +
        '<button class="gm-btn" data-esc="file">File on ' + esc(esc_.contact.name) + '</button>' +
        '<button class="gm-btn plain" data-esc="dismiss">Dismiss</button></div>';
    } else if (esc_.state === 'contradicts_auto') {
      escHtml = '<div class="gm-esc loud"><div class="t">⚠️ This thread is filed on <b>' + esc(esc_.filed.name) + '</b> — matched automatically' +
        (esc_.filed.evidence ? ' on the address <code>' + esc(esc_.filed.evidence) + '</code>' : ' by the ' + esc(esc_.filed.via) + ' rule') + '.<br>' +
        'Escrow <code>' + esc(esc_.reference) + '</code> in this thread belongs to <b>' + esc(esc_.contact.name) + '</b>.</div>' +
        '<button class="gm-btn" data-esc="file">Re-file on ' + esc(esc_.contact.name) + '</button>' +
        '<button class="gm-btn plain" data-esc="dismiss">Keep ' + esc(esc_.filed.name) + '</button></div>';
    } else if (esc_.state === 'contradicts_human') {
      // One quiet line, no buttons — somebody filed this deliberately.
      escHtml = '<div class="gm-esc quiet"><div class="t">Escrow <code>' + esc(esc_.reference) + '</code> in this thread is recorded on <b>' +
        esc(esc_.contact.name) + '</b>’s file.</div></div>';
    } else if (esc_.state === 'confirms') {
      escHtml = '<div class="gm-esc quiet"><div class="t">✓ Escrow <code>' + esc(esc_.reference) + '</code> in this thread confirms the current filing.</div></div>';
    } else if (esc_.state === 'ambiguous_reference') {
      escHtml = '<div class="gm-esc quiet"><div class="t">⚠️ Escrow <code>' + esc(esc_.reference) + '</code> is recorded on <b>' + esc_.contacts.length +
        '</b> files (' + esc_.contacts.map(function (c) { return esc(c.name); }).join(', ') +
        '). Not suggesting a lead — one of those is probably a typo.</div></div>';
    } else if (esc_.state === 'multiple_references') {
      escHtml = '<div class="gm-esc quiet"><div class="t">This thread mentions escrow numbers from more than one file (' +
        esc_.hits.map(function (x) { return esc(x.reference) + ' → ' + esc(x.contact.name); }).join('; ') +
        '). Not suggesting a lead.</div></div>';
    }
    if (escHtml) h.push(escHtml);

    /* ── messages ──────────────────────────────────────────────────────────────
     * Only the newest is expanded. The rest are one-line stubs — a 4-message thread
     * opens showing one message, not four, and the one shown is the one being
     * replied to. Click a stub to expand it in place. */
    var newest = msgs.length - 1;
    if (msgs.length > 1) {
      h.push('<div class="gm-stubbar"><button data-gm="expandall">Expand all ' + msgs.length + ' messages</button></div>');
    }
    msgs.forEach(function (m, i) {
      var inbound = m.direction === 'inbound';
      var who = inbound ? ((m.from && (m.from.name || m.from.email)) || 'them') : 'You';
      if (i !== newest) {
        h.push('<div class="gm-stub" data-stub="' + i + '" title="Click to expand">' +
          '<span class="w">' + (inbound ? '↓ ' : '↑ ') + esc(who) + '</span>' +
          '<span class="s">' + esc(m.body_text ? String(m.body_text).replace(/\s+/g, ' ').slice(0, 200) : '') + '</span>' +
          // get_thread already returned this message's parts, so the stub costs
          // nothing extra. Survives expand/collapse: the stub element is never
          // re-rendered, only shown or hidden.
          attSummaryHtml(m.attachments) +
          '<span class="d">' + esc(m.date ? fmtDate(m.date) : '') + '</span></div>');
      }
      var meta = ['<span class="gm-mdir" style="color:' + (inbound ? '#50c878' : '#c9a84c') + '">' + (inbound ? '↓ ' + esc(who) : '↑ You') + '</span>'];
      if (m.from && m.from.email) meta.push(esc(m.from.email));
      if (m.to && m.to.length) meta.push('to ' + esc(m.to.join(', ')));
      if (m.date) meta.push(fmtDate(m.date));
      h.push('<div class="gm-msg" data-msg="' + i + '"' + (i !== newest ? ' style="display:none"' : '') + '>');
      h.push('<div class="gm-mmeta">' + meta.join(' &nbsp;·&nbsp; ') + '</div>');
      h.push('<iframe class="gm-frame" data-fi="' + i + '" sandbox="allow-same-origin allow-popups"></iframe>');
      // The quoted trailer gets its own frame, rendered only when asked for. It has
      // to be a separate frame: the iframes carry no allow-scripts, so nothing inside
      // one can toggle itself.
      h.push('<div data-qt="' + i + '" style="display:none">' +
        '<button class="gm-qtog" data-qtog="' + i + '" title="Show quoted text">•••</button>' +
        '<iframe class="gm-frame" data-qi="' + i + '" sandbox="allow-same-origin allow-popups" style="display:none"></iframe></div>');
      /* Attachment chips. Bytes are NOT fetched here — only the metadata Gmail
       * already returned with the thread. The click handler pulls the file. */
      if (m.attachments && m.attachments.length) {
        h.push('<div class="gm-rx-atts">' + m.attachments.map(function (a) {
          var name = a.filename || 'attachment';
          var canPreview = attCanPreview(a.mimeType, name);
          return '<button type="button" class="gm-rx-att" ' +
            'data-att-msg="' + esc(m.id || m.gmail_message_id || '') + '" ' +
            'data-att-id="' + esc(a.attachmentId || '') + '" ' +
            'data-att-part="' + esc(a.partId == null ? '' : a.partId) + '" ' +
            'data-att-name="' + esc(name) + '" ' +
            'data-att-mime="' + esc(a.mimeType || '') + '" ' +
            'data-att-preview="' + (canPreview ? '1' : '0') + '" ' +
            'data-att-size="' + (a.size || 0) + '" ' +
            'title="' + esc(name) + (a.size ? ' · ' + attSize(a.size) : '') + '">' +
            '<span class="ic">' + kindIcon(attKindOf(a.mimeType, name)) + '</span>' +
            '<span class="n">' + esc(name) + '</span>' +
            (a.size ? '<span class="s">' + esc(attSize(a.size)) + '</span>' : '') +
            '<span class="go">' + (canPreview ? 'Open' : 'Download') + '</span>' +
            '</button>';
        }).join('') + '</div>');
      }
      h.push('</div>');
    });

    // composer: action row (Reply / Reply all / Forward) + the mount point it expands into
    h.push('<div class="gm-acts" data-gm="acts">');
    h.push('<button class="gm-btn" data-cmp="reply">↩ Reply</button>');
    if (msgs.length && (last.to || []).length + ((last.cc || []).length) > 1) {
      h.push('<button class="gm-btn" data-cmp="replyAll">↩↩ Reply all</button>');
    } else {
      h.push('<button class="gm-btn plain" data-cmp="replyAll">↩↩ Reply all</button>');
    }
    h.push('<button class="gm-btn plain" data-cmp="forward">↪ Forward</button>');
    h.push('</div>');
    h.push('<div data-gm="cmp"></div>');

    host.innerHTML = h.join('');

    // fill iframes AFTER insertion (srcdoc, never innerHTML)
    msgs.forEach(function (m, i) {
      var f = host.querySelector('.gm-frame[data-fi="' + i + '"]');
      if (!f) return;
      var split = splitQuoted(m.body_html);
      autoFit(f, 0); // 0 = uncapped: long rate sheets must render in full
      f.srcdoc = wrapBody(split.main || m.body_html, m.body_text);
      // Only offer the toggle when there is genuinely a trailer to hide.
      if (split.quoted) {
        var box = host.querySelector('[data-qt="' + i + '"]');
        if (box) box.style.display = '';
        var qf = host.querySelector('.gm-frame[data-qi="' + i + '"]');
        if (qf) { autoFit(qf, 0); qf.setAttribute('data-src', split.quoted); }
      }

      /* INLINE IMAGES, resolved after the first paint. Deliberately not awaited
       * before setting srcdoc above: fetching a signature's logos costs a round
       * trip per image, and blocking the whole thread body on that would trade a
       * broken footer for a blank message. The text renders immediately and the
       * images fill in.
       * The quoted trailer is rewritten too — a forwarded rate sheet keeps its
       * images in the quote — but only when it is opened, which is where its
       * srcdoc is set from data-src. */
      if (m.inline_images && m.inline_images.length) {
        resolveInlineImages(cl, mailbox, m).then(function (map) {
          if (!map || !Object.keys(map).length) return;
          var f2 = host.querySelector('.gm-frame[data-fi="' + i + '"]');
          if (f2) {
            f2.srcdoc = wrapBody(rewriteCidSrc(split.main || m.body_html, map), m.body_text);
            autoFit(f2, 0);
          }
          var qf2 = host.querySelector('.gm-frame[data-qi="' + i + '"]');
          if (qf2 && split.quoted) {
            qf2.setAttribute('data-src', rewriteCidSrc(split.quoted, map));
            // Already open? Re-fill it; otherwise the toggle picks up data-src.
            if (qf2.srcdoc) { qf2.srcdoc = wrapBody(qf2.getAttribute('data-src'), ''); autoFit(qf2, 0); }
          }
        }).catch(function () { /* body already rendered; images are the only loss */ });
      }
    });

    /* Attachment chips — the ONLY place bytes are fetched, and only for the one
     * file clicked. Previewable types open in a tab, everything else downloads;
     * both go through a blob URL, so nothing is ever navigated to a Gmail URL
     * that would need its own auth. */
    /* Attachment chips. Hover (after a 400ms dwell) renders a thumbnail; click
     * opens the full viewer. Bytes are fetched at most once per attachment and
     * cached for the session, so hover-then-click costs one request. */
    Array.prototype.forEach.call(host.querySelectorAll('.gm-rx-att'), function (btn) {
      wireAttachmentHover(btn, cl, mailbox);
      btn.addEventListener('click', async function () {
        if (btn.classList.contains('busy')) return;
        var name = btn.getAttribute('data-att-name') || 'attachment';
        var preview = btn.getAttribute('data-att-preview') === '1';
        var go = btn.querySelector('.go'), original = go ? go.textContent : '';
        if (preview) { openAttachmentModal(btn, cl, mailbox); return; }
        // Not previewable → download, same as before.
        btn.classList.add('busy'); btn.classList.remove('err');
        if (go) go.textContent = 'Opening…';
        try {
          var rec = await fetchAttachment(cl, mailbox, btn);
          var url = URL.createObjectURL(rec.blob);
          var a = document.createElement('a');
          a.href = url; a.download = rec.name || name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
          if (go) go.textContent = original;
        } catch (e) {
          // B5: surface the server's own words — 403 and 413 both say something useful.
          btn.classList.add('err');
          if (go) go.textContent = 'Failed';
          btn.title = (e && e.message) || 'Could not open this attachment';
          toast((e && e.message) || 'Could not open this attachment');
        } finally {
          btn.classList.remove('busy');
        }
      });
    });

    // Quoted-trailer toggles. srcdoc is set on first open so a long thread's quotes
    // are never parsed unless someone asks for them.
    Array.prototype.forEach.call(host.querySelectorAll('[data-qtog]'), function (btn) {
      btn.addEventListener('click', function () {
        var i = btn.getAttribute('data-qtog');
        var qf = host.querySelector('.gm-frame[data-qi="' + i + '"]');
        if (!qf) return;
        var open = qf.style.display !== 'none';
        if (!open && !qf.srcdoc) qf.srcdoc = wrapBody(qf.getAttribute('data-src') || '', '');
        qf.style.display = open ? 'none' : '';
        btn.title = open ? 'Show quoted text' : 'Hide quoted text';
      });
    });

    // Stubs → expand that message in place.
    function expandMsg(i) {
      var stub = host.querySelector('[data-stub="' + i + '"]');
      var msg = host.querySelector('[data-msg="' + i + '"]');
      if (stub) stub.style.display = 'none';
      if (msg) msg.style.display = '';
    }
    Array.prototype.forEach.call(host.querySelectorAll('[data-stub]'), function (st) {
      st.addEventListener('click', function () { expandMsg(st.getAttribute('data-stub')); });
    });
    var expandAll = host.querySelector('[data-gm="expandall"]');
    if (expandAll) {
      expandAll.addEventListener('click', function () {
        msgs.forEach(function (_m, i) { expandMsg(i); });
        var bar = expandAll.closest('.gm-stubbar');
        if (bar) bar.remove();
      });
    }

    // mark the thread read (best-effort) + clear the list dot
    invoke(cl, mailbox, 'modify', { thread_id: threadId, mark_read: true }).then(function () {
      if (ctx.onRead) ctx.onRead(threadId);
    }).catch(function () {});

    // wire actions
    function wire(sel, fn) { var el = host.querySelector(sel); if (el) el.addEventListener('click', fn); }
    wire('[data-gm="back"]', function () { if (ctx.onBack) ctx.onBack(); });
    wire('[data-gm="close"]', function () { if (ctx.onClose) ctx.onClose(); });
    /* Thread actions moved off the header row into this ▾ menu. Same operations,
     * same calls — only the affordance changed, so the header costs one line total
     * instead of a permanent button row. */
    async function doArchive() {
      try { await invoke(cl, mailbox, 'modify', { thread_id: threadId, archive: true }); toast('Archived'); if (ctx.onArchived) ctx.onArchived(threadId); }
      catch (err) { toast(err.message); }
    }
    async function doUnfile() {
      try { await invoke(cl, mailbox, 'untag', { thread_id: threadId, unfile: true }); toast('Unfiled'); renderThread(host, ctx); if (ctx.onChanged) ctx.onChanged(); }
      catch (err) { toast(err.message); }
    }
    /* Accept → the EXISTING tag action, unchanged. So an accepted suggestion
     * lands as a human tag with tagged_by set — correctly, because a human
     * decided. That is the point of suggesting rather than filing, and it means
     * the accept path needed no new write path at all. */
    wire('[data-esc="file"]', async function (e) {
      var btn = e.currentTarget, was = btn.textContent;
      btn.disabled = true; btn.textContent = 'Filing…';
      try {
        await invoke(cl, mailbox, 'tag', { thread_id: threadId, contact_id: esc_.contact.id });
        toast('Filed on ' + (esc_.contact.name || 'lead'));
        renderThread(host, ctx);
        if (ctx.onChanged) ctx.onChanged();
      } catch (err) {
        // Loud, and the suggestion stays on screen so it can be retried.
        btn.disabled = false; btn.textContent = was;
        toast('Could not file: ' + err.message);
      }
    });
    /* Dismiss must STICK. The row is keyed on (thread, suggested contact), so
     * this rejects one claim and not the thread — a later, different suggestion
     * still gets through. */
    wire('[data-esc="dismiss"]', async function (e) {
      var btn = e.currentTarget, was = btn.textContent;
      btn.disabled = true; btn.textContent = 'Dismissing…';
      try {
        await invoke(cl, mailbox, 'dismiss_suggestion', {
          thread_id: threadId, contact_id: esc_.contact.id, evidence: esc_.reference,
        });
        var banner = host.querySelector('.gm-esc');
        if (banner) banner.remove();
      } catch (err) {
        /* Leave the banner up. A dismissal that only APPEARS to have worked is
         * the worst outcome here: it returns on the next render and reads as the
         * feature ignoring you. */
        btn.disabled = false; btn.textContent = was;
        toast('Could not dismiss: ' + err.message);
      }
    });
    wire('[data-gm="acts"]', function (e) {
      var anchor = e.currentTarget;
      var menu = document.createElement('div');
      menu.className = 'gm-pop-menu';
      var items = [];
      if (ctx.allowTag !== false) items.push('<div class="gm-pop-item" data-a="tag">🏷 ' + (filedId ? 'Re-file to another lead' : 'Tag borrower') + '</div>');
      if (filedId && ctx.allowTag !== false) items.push('<div class="gm-pop-item" data-a="unfile">Unfile from ' + esc(filedNm || 'lead') + '</div>');
      items.push('<div class="gm-pop-item" data-a="archive">🗄 Archive thread</div>');
      menu.innerHTML = items.join('');
      var pop = portalPopover(anchor, menu, { width: 240 });
      Array.prototype.forEach.call(menu.querySelectorAll('[data-a]'), function (it) {
        it.addEventListener('click', function () {
          var a = it.getAttribute('data-a');
          pop.close();
          if (a === 'archive') doArchive();
          else if (a === 'unfile') doUnfile();
          else openTagPopover(anchor);
        });
      });
    });
    // Reply / Reply all / Forward → mount the composer
    Array.prototype.forEach.call(host.querySelectorAll('[data-cmp]'), function (b) {
      b.addEventListener('click', function () {
        mountComposer(host.querySelector('[data-gm="cmp"]'), {
          client: cl, mailbox: mailbox, threadId: threadId,
          mode: b.getAttribute('data-cmp'), msgs: msgs, subject: subj,
          // Filed thread → the AI panel can brief on the borrower. Null when the
          // thread isn't tagged, which just hides "Summarize client".
          contactId: filedId,
          actsEl: host.querySelector('[data-gm="acts"]'),
          onDone: function () { renderThread(host, ctx); }
        });
      });
    });
    // tag popover
    var tagPop = null;
    function openTagPopover(btn) {
      if (tagPop) { tagPop.close(); tagPop = null; return; }
      var menu = document.createElement('div'); menu.className = 'gm-pop-menu';
      menu.innerHTML = '<input type="text" placeholder="Search contacts…"><div class="gm-pop-res"></div>';
      // Body-portalled: as an absolutely-positioned child it was clipped by .gm-pane's
      // overflow, which is why the contact list used to get cut off.
      tagPop = portalPopover(btn, menu, { width: 300, onClose: function () { tagPop = null; } });
      var inp = menu.querySelector('input'), res = menu.querySelector('.gm-pop-res'), timer;
      inp.focus();
      inp.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(async function () {
          var rows = await searchContacts(cl, inp.value);
          res.innerHTML = rows.length ? rows.map(function (c) {
            return '<div class="gm-pop-item" data-cid="' + esc(c.id) + '">' + esc(c.name) + '<div class="e">' + esc(c.email) + '</div></div>';
          }).join('') : '<div class="gm-pop-item" style="cursor:default;color:#777">No matches</div>';
          if (tagPop) tagPop.place();   // menu just grew — re-anchor (and re-flip if needed)
          Array.prototype.forEach.call(res.querySelectorAll('[data-cid]'), function (it) {
            it.addEventListener('click', async function () {
              try {
                await invoke(cl, mailbox, 'tag', { thread_id: threadId, contact_id: it.getAttribute('data-cid') });
                toast('Filed to lead');
                // close() (not menu.remove()) so the scroll/resize/key listeners are torn down
                if (tagPop) { tagPop.close(); tagPop = null; }
                renderThread(host, ctx);
                if (ctx.onChanged) ctx.onChanged();
              } catch (err) { toast(err.message); }
            });
          });
        }, 220);
      });
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * FOLDERS + CATEGORY TABS → Gmail system labels
   *
   * Gmail assigns each inbox message exactly ONE CATEGORY_* label, so a tab is the
   * INTERSECTION INBOX ∧ CATEGORY_x — not "inbox minus the others". Primary is
   * CATEGORY_PERSONAL.
   *
   * Two traps handled here:
   *  - threads.list hides SPAM/TRASH unless includeSpamTrash=true, so Trash needs it or it
   *    reads as permanently empty.
   *  - "Archived" is not a Gmail label; it is everything that is not in inbox/sent/draft/
   *    trash/spam, which only a search query can express.
   * ══════════════════════════════════════════════════════════════════════════ */
  var FOLDERS = [
    { k: 'INBOX', label: 'Inbox', icon: '📥', labels: ['INBOX'] },
    { k: 'SENT', label: 'Sent', icon: '📤', labels: ['SENT'] },
    { k: 'DRAFT', label: 'Drafts', icon: '📝', drafts: true },
    { k: 'STARRED', label: 'Starred', icon: '⭐', labels: ['STARRED'] },
    { k: 'ARCHIVED', label: 'Archived', icon: '🗄️', q: '-in:inbox -in:sent -in:draft -in:trash -in:spam' },
    { k: 'TRASH', label: 'Trash', icon: '🗑️', labels: ['TRASH'], includeSpamTrash: true }
  ];
  var CATEGORIES = [
    { k: 'CATEGORY_PERSONAL', label: 'Primary' },
    { k: 'CATEGORY_PROMOTIONS', label: 'Promotions' },
    { k: 'CATEGORY_UPDATES', label: 'Updates' },
    { k: 'CATEGORY_SOCIAL', label: 'Social' },
    { k: 'CATEGORY_FORUMS', label: 'Forums' }
  ];
  function catLabel(k) {
    var c = CATEGORIES.filter(function (x) { return x.k === k; })[0];
    return c ? c.label : k;
  }

  // ── full inbox (list + pane) mounted into a container ──
  function mount(opts) {
    injectStyles();
    var el = typeof opts.el === 'string' ? document.querySelector(opts.el) : opts.el;
    if (!el) { console.warn('[inbox] mount target not found'); return; }
    var cl = resolveClient(opts);
    if (!cl) { el.innerHTML = '<div class="gm-empty">Not signed in.</div>'; return; }
    var mailboxes = opts.mailboxes && opts.mailboxes.length ? opts.mailboxes : ['processing@ratesandrealty.com'];
    var showSwitcher = !!opts.showSwitcher && mailboxes.length > 1;

    /* SCOPED MODE — `mount({ scoped: true, q: '…' })`.
     *
     * The per-lead Inbox tab shows ONE contact's mail inside a page about that
     * contact. Everything below exists because "scoped" has to be a property of
     * the component, not a habit of its caller.
     *
     * The bug this closes was not in the mount path — that always carried q.
     * It was that the folder buttons (Inbox/Sent/Drafts/Trash) and the category
     * buttons each did `state.q = ''` before re-listing, on purpose: in the
     * standalone inbox a live search must not survive picking a folder, or the
     * rail would highlight Sent while still listing search hits. Correct there.
     * On a lead tab it means ONE CLICK on a control that looks like a view
     * toggle silently widens the list to the entire mailbox — the va disclosure
     * case, reachable without typing anything.
     *
     * The fix is structural, not defensive: in scoped mode those controls are
     * never rendered, so there is nothing to click, and listParams() THROWS
     * rather than returning label-scoped params if q is somehow empty. A guard
     * that can be reached and returns the whole mailbox is not a guard. */
    var scoped = !!opts.scoped;
    var scopeQ = String(opts.q || '').trim();
    var scopeLabel = String(opts.scopeLabel || '');
    if (scoped && !scopeQ) {
      /* Refuse to mount, exactly as lead-detail refuses for a contact with no
         address. An empty q is not "no filter", it is the whole mailbox. */
      el.innerHTML = '<div class="gm-empty">Nothing to show — this inbox was opened ' +
        'scoped to a contact but no search was supplied, and listing the whole ' +
        'mailbox here would show mail belonging to other people.</div>';
      return;
    }
    /* INITIAL QUERY. `mount({ q: 'from:x OR to:x' })` opens the component
     * already scoped — used by the per-lead Inbox tab so the same component
     * serves both the full mailbox and one contact's mail, rather than a fork.
     *
     * An EMPTY q is not "no filter" here, it is a different product: with no q,
     * listParams() falls through to label-based browsing and returns the WHOLE
     * mailbox. A caller that means "scoped" must therefore never pass '' and
     * hope — see the guard in lead-detail's tab, which refuses to mount at all
     * when the contact has no address. 708 of 1042 contacts have none.
     *
     * state.q is what the search box shows and what Search/refresh reuse, so
     * seeding it here (rather than firing a one-off search) keeps the query
     * visible and editable instead of being invisible state the user cannot
     * see or clear. */
    var state = {
      mailbox: mailboxes[0], q: String(opts.q || ''), threads: [], drafts: [], active: null,
      folder: 'INBOX', category: 'CATEGORY_PERSONAL', primaryFellBack: false,
      // thread_id -> lead name (or null when checked and unfiled). Cached so the
      // list can re-render without re-querying every scroll/refresh.
      filed: {}
    };

    var root = document.createElement('div'); root.className = 'gm-inbox';
    /* Mailbox switcher stays visually separate from the folder list under it. These
     * are not the same kind of control: folders filter what you see, the mailbox
     * decides WHOSE mail you may see at all, and the server refuses a va asking for
     * rene@. Styling them alike would invite treating it as another filter. */
    var sw = showSwitcher ? '<div class="gm-sw"><div class="gm-sw-l">Mailbox</div>' + mailboxes.map(function (m, i) {
      return '<button data-mb="' + esc(m) + '"' + (i === 0 ? ' class="active"' : '') +
        ' title="' + esc(m) + '"><span class="k"></span>' + esc(m.split('@')[0]) + '@</button>';
    }).join('') + '</div>' : '';

    var HINT = 'Gmail · ' + mailboxes.join(' / ') + ' — tag a thread to file it on a lead';

    /* THE RAIL, and why scoped mode does not have one.
     *
     * Every control in it is wrong on a lead-scoped tab, and for three different
     * reasons rather than one:
     *   - folders and categories CLEAR q (see the scoped-mode note above), so
     *     they are the disclosure bug itself;
     *   - the counts come from Gmail's label_counts, which returns per-label
     *     totals for the WHOLE mailbox and cannot be narrowed by a query. A
     *     badge reading 999+ next to a list of four threads is a number about
     *     mail this tab is deliberately not showing;
     *   - Drafts has no contact scope at all — a draft carries no thread.
     * So it is replaced wholesale, not trimmed. What survives is the mailbox
     * switcher and a chip that states the scope and cannot be clicked. */
    var railHtml = scoped
      ? '<div class="gm-rail gm-rail-scoped">' + sw +
          '<div class="gm-scope">' +
            '<div class="gm-scope-l">Showing only mail to or from</div>' +
            '<div class="gm-scope-v">' + esc(scopeLabel || scopeQ) + '</div>' +
            '<div class="gm-scope-n">Everything else in this mailbox is hidden on this tab. ' +
              'Edit the search box to look wider.</div>' +
          '</div>' +
        '</div>'
      : '<div class="gm-rail">' +
        '<button class="gm-compose" data-gm="compose">✏️ Compose</button>' + sw +
        '<div class="gm-fold" data-gm="fold">' + FOLDERS.map(function (f) {
          return '<button data-fd="' + f.k + '"' + (f.k === 'INBOX' ? ' class="on"' : '') +
            ' title="' + esc(f.label) + '"><span class="i">' + f.icon + '</span>' +
            '<span class="n">' + esc(f.label) + '</span>' +
            '<span class="c" data-cnt="' + f.k + '" style="display:none"></span></button>';
        }).join('') + '</div>' +
        // Categories live under the folders, below Trash, grouped and subordinate.
        '<div class="gm-cats" data-gm="cats">' +
          '<div class="gm-cats-l">Categories</div>' + CATEGORIES.map(function (c) {
            return '<button data-ct="' + c.k + '"' + (c.k === 'CATEGORY_PERSONAL' ? ' class="on"' : '') +
              ' title="' + esc(c.label) + ' — a slice of Inbox">' +
              '<span class="d"></span><span class="n">' + esc(c.label) + '</span>' +
              '<span class="c" data-ccnt="' + c.k + '" style="display:none"></span></button>';
          }).join('') +
        '</div>' +
      '</div>';

    root.innerHTML =
      railHtml +
      '<div class="gm-main">' +
        // ONE row: search + refresh. The old page-title row and its hint are gone;
        // the hint survives as this tooltip and as the reading pane's empty state.
        '<div class="gm-tb" title="' + esc(HINT) + '">' +
          '<div class="gm-search"><input type="text" placeholder="Search mail (Gmail syntax: from: subject: is:unread …)"><button class="gm-btn" data-gm="go">Search</button></div>' +
          '<button class="gm-btn plain" data-gm="refresh" title="Refresh">↻</button>' +
        '</div>' +
        '<div class="gm-hint" data-gm="hint" style="display:none"></div>' +
        '<div class="gm-body">' +
          '<div class="gm-list">' +
            '<div class="gm-rows" data-gm="rows"><div class="gm-empty">Loading…</div></div>' +
          '</div>' +
          '<div class="gm-pane"><div class="gm-empty">Select a thread to read.<br><span style="font-size:11.5px;opacity:.7">' + esc(HINT) + '</span></div></div>' +
        '</div>' +
      '</div>';
    el.innerHTML = ''; el.appendChild(root);

    var listEl = root.querySelector('[data-gm="rows"]'), paneEl = root.querySelector('.gm-pane'),
        searchEl = root.querySelector('.gm-search input'), catsEl = root.querySelector('[data-gm="cats"]'),
        hintEl = root.querySelector('[data-gm="hint"]'), foldEl = root.querySelector('[data-gm="fold"]');

    function folder() { return FOLDERS.filter(function (f) { return f.k === state.folder; })[0] || FOLDERS[0]; }

    /* Rail highlighting is derived from state in ONE place, because two controls now
     * describe the same selection: picking a category IS picking Inbox. Setting the
     * `on` class at each click site instead would let Inbox and a category disagree.
     *
     * CHOICE (of the two the brief offered): selecting a category SWITCHES TO INBOX
     * rather than hiding the group in other folders. Hiding makes the rail change
     * height as you move between Sent and Inbox, and a category is a useful way to
     * jump back to Inbox. A category is only lit while it is actually in force —
     * Inbox with no active search — so it never claims to be filtering Sent. */
    function syncRail() {
      var catsLive = state.folder === 'INBOX' && !state.q;
      Array.prototype.forEach.call(root.querySelectorAll('[data-fd]'), function (x) {
        x.classList.toggle('on', x.getAttribute('data-fd') === state.folder);
      });
      Array.prototype.forEach.call(root.querySelectorAll('[data-ct]'), function (x) {
        x.classList.toggle('on', catsLive && x.getAttribute('data-ct') === state.category);
      });
    }
    function setHint(msg) {
      if (!msg) { hintEl.style.display = 'none'; hintEl.textContent = ''; return; }
      hintEl.style.display = ''; hintEl.textContent = msg;
    }

    /* THE FIX FOR THE ACTUAL COMPLAINT.
     *
     * A search only ever covers the mailbox you are standing in. Searching
     * processing@ for a thread that lives in rene@ returns nothing, correctly,
     * and the old empty state made that look like the mail did not exist.
     *
     * So when a search comes back empty and the caller can reach another
     * mailbox, ask that one too and say what is there. Costs one extra
     * list_threads ONLY on the empty-search path — never on a normal load.
     *
     * A va has exactly one mailbox, so this is a no-op for her: the server would
     * refuse rene@ anyway (403 with the reason), and asking would be inviting a
     * refusal we already know the answer to. */
    async function searchOtherMailboxes() {
      var others = mailboxes.filter(function (m) { return m !== state.mailbox; });
      var slot = listEl.querySelector('[data-gm="elsewhere"]');
      if (!slot || !others.length || !state.q) return;
      var q = state.q, box = state.mailbox;
      slot.textContent = 'Checking ' + others.join(', ') + '…';
      var found = [];
      for (var i = 0; i < others.length; i++) {
        try {
          var r = await invoke(cl, others[i], 'list_threads', { q: gmailQuery(q) });
          var n = (r.threads || []).length;
          if (n) found.push({ mailbox: others[i], n: n });
        } catch (e) { /* a refusal here is not the user's problem — stay quiet */ }
      }
      // The result may have arrived after the user moved on. Do not overwrite
      // whatever is on screen now with an answer to a question they left behind.
      if (state.q !== q || state.mailbox !== box) return;
      if (!listEl.querySelector('[data-gm="elsewhere"]')) return;
      slot = listEl.querySelector('[data-gm="elsewhere"]');
      if (!found.length) { slot.textContent = 'No matches in ' + others.join(' or ') + ' either.'; return; }
      slot.innerHTML = found.map(function (f) {
        return '<button class="gm-btn" data-gm="gomb" data-mb="' + esc(f.mailbox) + '">' +
          f.n + ' match' + (f.n === 1 ? '' : 'es') + ' in ' + esc(f.mailbox) + ' — switch</button>';
      }).join(' ');
      Array.prototype.forEach.call(slot.querySelectorAll('[data-gm="gomb"]'), function (b) {
        b.addEventListener('click', function () {
          switchMailbox(b.getAttribute('data-mb'));
        });
      });
    }

    /* One place that changes mailbox, so the switcher and the "switch" button in
       an empty result cannot drift apart. Deliberately KEEPS state.q: the whole
       point of arriving here is to run the same search somewhere else. */
    function switchMailbox(mb) {
      state.mailbox = mb;
      state.active = null;
      state.threads = [];
      state.drafts = [];
      // Category availability is per-mailbox, so re-test the Primary fallback.
      state.primaryFellBack = false;
      // Thread ids and their filings are per-mailbox; carrying the cache across
      // would paint one mailbox's lead names onto the other's rows.
      state.filed = {};
      Array.prototype.forEach.call(root.querySelectorAll('.gm-sw button'), function (x) {
        x.classList.toggle('active', x.getAttribute('data-mb') === mb);
      });
      paneEl.innerHTML = '<div class="gm-empty">Select a thread to read.</div>';
      root.classList.remove('gm-show-pane');
      loadThreads();
    }

    /* Tells the HOST what is actually on screen, after every load.
       lead-detail's banner used to be written once at mount time from the toggle
       state, so it went on saying "Showing the whole processing@ mailbox" while a
       search was active and returning nothing — describing which button was lit
       rather than what was displayed. */
    function publishStatus() {
      if (typeof opts.onStatus !== 'function') return;
      try {
        opts.onStatus({
          mailbox: state.mailbox,
          q: state.q || '',
          searching: !!state.q,
          scoped: scoped,
          scopeQ: scopeQ,
          folder: folder().label,
          category: state.folder === 'INBOX' && !state.q ? catLabel(state.category) : null,
          count: state.threads.length,
        });
      } catch (_) {}
    }

    /* A bare identifier is sent to Gmail QUOTED.
     *
     * In Gmail syntax a leading '-' negates a term, so an order number like
     * SC-27335-BU risks being read as "SC and NOT 27335 and NOT BU" — which
     * would exclude the very thread being looked for. Quoting a single
     * whitespace-free token cannot lose results (a one-token phrase is that
     * token) and removes the ambiguity.
     *
     * DELIBERATELY NARROW. Anything with a space, a ':' operator or a '(' is a
     * query the user is writing on purpose — from:x OR to:y, the scoped-mode
     * query, is:unread — and quoting those would turn an expression into a
     * literal string, which is a real regression. So only a lone token that
     * contains a hyphen or slash is touched.
     *
     * NOT VERIFIED against live Gmail: this is defensive. The PROVEN cause of
     * the SC-27335-BU miss was the mailbox — every thread carrying it is in
     * rene@ and the panel was searching processing@. */
    function gmailQuery(raw) {
      var q = String(raw || '').trim();
      if (!q) return q;
      if (/[\s:()"]/.test(q)) return q;          // an expression, not a bare term
      if (!/[-\/]/.test(q)) return q;            // nothing that could parse as an operator
      return '"' + q + '"';
    }

    /** Folder/category → Gmail list params. A search box query overrides folder scoping. */
    function listParams() {
      /* Scoped mode has no unfiltered branch to fall into. This throw is not
         expected to fire — the controls that used to clear q are not rendered —
         which is exactly why it is a throw and not a fallback: if a future edit
         reintroduces a path that empties q, this fails loudly here instead of
         quietly listing someone else's mail under a borrower's name. */
      if (scoped) {
        if (!state.q) throw new Error('Refusing to list: this inbox is scoped to a contact and the search is empty.');
        return { q: gmailQuery(state.q) };
      }
      if (state.q) return { q: gmailQuery(state.q) };
      var f = folder();
      var p = {};
      if (f.k === 'INBOX') p.labels = state.primaryFellBack && state.category === 'CATEGORY_PERSONAL'
        ? ['INBOX'] : ['INBOX', state.category];
      else if (f.labels) p.labels = f.labels.slice();
      if (f.q) p.q = f.q;
      if (f.includeSpamTrash) p.include_spam_trash = true;
      return p;
    }

    function renderList() {
      if (folder().drafts) return renderDrafts();
      if (!state.threads.length) {
        /* AN EMPTY SEARCH RESULT IS NOT AN EMPTY FOLDER.
         *
         * This used to say "Nothing in Inbox · Primary" whatever had been asked
         * for, which was wrong twice over during a search: listParams() drops the
         * folder and category entirely when state.q is set, so a search covers the
         * WHOLE mailbox, not the Inbox — and the message named neither the query
         * nor the mailbox it had searched.
         *
         * That is how "SC-27335-BU" read as "this mail does not exist". The search
         * ran correctly against processing@; every thread carrying that number is
         * in rene@. "Nothing found" and "nothing here to find" are different
         * claims and the UI made the stronger one. */
        if (state.q) {
          listEl.innerHTML = '<div class="gm-empty">No matches for <b>' + esc(state.q) + '</b> in ' +
            esc(state.mailbox) + ' <span style="opacity:.7">(whole mailbox, not just Inbox)</span>.' +
            '<div data-gm="elsewhere" style="margin-top:10px;font-size:12px;opacity:.85"></div></div>';
          searchOtherMailboxes();
        } else {
          listEl.innerHTML = '<div class="gm-empty">Nothing in ' + esc(folder().label) +
            (state.folder === 'INBOX' ? ' · ' + esc(catLabel(state.category)) : '') +
            ' <span style="opacity:.7">· ' + esc(state.mailbox) + '</span>.</div>';
        }
        publishStatus();
        return;
      }
      listEl.innerHTML = state.threads.map(function (t) {
        var from = (t.from && (t.from.name || t.from.email)) || '';
        var filed = state.filed[t.id];
        return '<div class="gm-row' + (t.unread ? ' unread' : '') + (state.active === t.id ? ' active' : '') + '" data-tid="' + esc(t.id) + '">' +
          avatarHtml(from, (t.from && t.from.email) || '') +
          '<div class="gm-rowmain">' +
            '<div class="gm-row-top"><span class="gm-row-from">' + (t.unread ? '<span class="gm-dot"></span>' : '') + esc(from) + '</span>' +
            (filed ? '<span class="gm-row-filed" title="Filed to ' + esc(filed) + '">🏷 ' + esc(filed) + '</span>' : '') +
            attSummaryFromTypes(t.attachment_types, t.attachment_count) +
            '<span class="gm-row-date">' + esc(fmtDate(t.date)) + '</span></div>' +
            '<div class="gm-row-subj">' + esc(t.subject || '(no subject)') + (t.message_count > 1 ? '<span class="gm-cnt">' + t.message_count + '</span>' : '') + '</div>' +
            // Quoted trailer trimmed off the preview — see splitQuotedText().
            '<div class="gm-row-snip">' + esc(snippetMain(t.snippet)) + '</div>' +
          '</div></div>';
      }).join('');
      Array.prototype.forEach.call(listEl.querySelectorAll('[data-tid]'), function (r) {
        r.addEventListener('click', function () { openThread(r.getAttribute('data-tid')); });
      });
      loadFiledChips();
    }

    /* Filed-to-lead chips. email_thread_tags holds the explicit tags; resolve the
     * visible thread ids in ONE query rather than per row, then fill in the chips.
     * Deliberately after render so a slow/failed lookup never delays the list. */
    function loadFiledChips() {
      var ids = state.threads.map(function (t) { return t.id; }).filter(function (id) {
        return !(id in state.filed);
      });
      if (!ids.length) return;
      cl.from('email_thread_tags').select('gmail_thread_id,contact_id').in('gmail_thread_id', ids)
        .then(function (r) {
          if (r.error || !r.data || !r.data.length) {
            ids.forEach(function (id) { state.filed[id] = null; });
            return;
          }
          var byThread = {};
          r.data.forEach(function (x) { byThread[x.gmail_thread_id] = x.contact_id; });
          var cids = Object.keys(byThread).map(function (k) { return byThread[k]; })
            .filter(function (v, i, a) { return v && a.indexOf(v) === i; });
          if (!cids.length) { ids.forEach(function (id) { state.filed[id] = null; }); return; }
          /* `name` is NOT a column on contacts (only first_name/last_name). Asking for
           * it made PostgREST reject the whole select, so c.data came back null and
           * every chip fell through to the literal placeholder "lead" — the filing was
           * real, the person's name was not. */
          return cl.from('contacts').select('id,first_name,last_name').in('id', cids).then(function (c) {
            var nm = {};
            (c.data || []).forEach(function (x) {
              nm[x.id] = ([x.first_name, x.last_name].filter(Boolean).join(' ') || '').trim() || 'lead';
            });
            ids.forEach(function (id) {
              state.filed[id] = byThread[id] ? (nm[byThread[id]] || 'lead') : null;
            });
            renderFiledChips();
          });
        }).catch(function () {});
    }
    // Patch chips into the existing rows — re-rendering the whole list would fight
    // with scroll position and the active-row highlight.
    function renderFiledChips() {
      Array.prototype.forEach.call(listEl.querySelectorAll('[data-tid]'), function (row) {
        var id = row.getAttribute('data-tid');
        var name = state.filed[id];
        var existing = row.querySelector('.gm-row-filed');
        if (!name) { if (existing) existing.remove(); return; }
        if (existing) { existing.textContent = '🏷 ' + name; existing.title = 'Filed to ' + name; return; }
        // Insert before the date on line 1, matching renderList's markup. Appending to
        // .gm-rowmain would add a fourth line and break the fixed 64px row height.
        var top = row.querySelector('.gm-row-top');
        var dateEl = top && top.querySelector('.gm-row-date');
        if (!top) return;
        var chip = document.createElement('span');
        chip.className = 'gm-row-filed';
        chip.title = 'Filed to ' + name;
        chip.textContent = '🏷 ' + name;
        if (dateEl) top.insertBefore(chip, dateEl); else top.appendChild(chip);
      });
    }

    /* Unread badges in the rail. Archived has none by design — it is a search
     * expression, not a Gmail label, so there is no count to read. */
    function loadCounts() {
      // Scoped mode renders no folder rail to hold the badges, and label_counts
      // is whole-mailbox regardless. Belt and braces with the call site.
      if (scoped || !foldEl) return;
      invoke(cl, state.mailbox, 'label_counts', {}).then(function (r) {
        var counts = (r && r.counts) || {};
        FOLDERS.forEach(function (f) {
          var el2 = foldEl.querySelector('[data-cnt="' + f.k + '"]');
          if (!el2) return;
          var c = counts[f.k];
          // Drafts has no "unread" concept — show the total instead.
          var n = c ? (f.k === 'DRAFT' ? c.total : c.unread) : 0;
          if (n > 0) { el2.textContent = n > 999 ? '999+' : String(n); el2.style.display = ''; }
          else { el2.style.display = 'none'; }
        });
        /* Category unread counts, when the server supplies them. CAVEAT: Gmail's
         * CATEGORY_* counters span the whole mailbox, so a category that also has
         * archived unread mail reads slightly higher than the INBOX ∧ CATEGORY list
         * below it. Absent counts simply render no badge. */
        CATEGORIES.forEach(function (cat) {
          var el3 = catsEl && catsEl.querySelector('[data-ccnt="' + cat.k + '"]');
          if (!el3) return;
          var cc = counts[cat.k];
          var n2 = cc ? cc.unread : 0;
          if (n2 > 0) { el3.textContent = n2 > 999 ? '999+' : String(n2); el3.style.display = ''; }
          else { el3.style.display = 'none'; }
        });
      }).catch(function () {});
    }

    function renderDrafts() {
      if (!state.drafts.length) { listEl.innerHTML = '<div class="gm-empty">No drafts.</div>'; return; }
      /* Wrapped in .gm-rowmain like a thread row. Without it the three lines were
       * direct children of .gm-row, which is display:flex — so they laid out
       * side-by-side instead of stacked, and a long recipient list pushed the row
       * wider than the column. */
      listEl.innerHTML = state.drafts.map(function (d) {
        return '<div class="gm-row" data-did="' + esc(d.id) + '">' +
          '<div class="gm-rowmain">' +
            '<div class="gm-row-top"><span class="gm-row-from"><span class="gm-draft-tag">Draft</span>' +
            esc((d.to || []).join(', ') || '(no recipient)') + '</span>' +
            '<span class="gm-row-date">' + esc(fmtDate(d.date)) + '</span></div>' +
            '<div class="gm-row-subj">' + esc(d.subject || '(no subject)') + '</div>' +
            '<div class="gm-row-snip">' + esc(snippetMain(d.snippet)) + '</div>' +
          '</div></div>';
      }).join('');
      Array.prototype.forEach.call(listEl.querySelectorAll('[data-did]'), function (r) {
        r.addEventListener('click', function () { openDraft(r.getAttribute('data-did')); });
      });
    }

    async function loadThreads() {
      listEl.innerHTML = '<div class="gm-empty">Loading…</div>';
      setHint('');
      // The category group stays put in every folder now (see syncRail); only its
      // highlight reflects whether a category is actually in force.
      syncRail();
      try {
        if (folder().drafts && !state.q) {
          var dd = await invoke(cl, state.mailbox, 'list_drafts', {});
          state.drafts = dd.drafts || []; renderDrafts();
          return;
        }
        var d = await invoke(cl, state.mailbox, 'list_threads', listParams());
        state.threads = d.threads || [];
        // Category labels only exist when Gmail's tabbed inbox is enabled. If Primary comes
        // back empty, fall back to the whole inbox rather than showing a convincing "no mail".
        if (!state.threads.length && state.folder === 'INBOX' && !state.q &&
            state.category === 'CATEGORY_PERSONAL' && !state.primaryFellBack) {
          var all = await invoke(cl, state.mailbox, 'list_threads', { labels: ['INBOX'] });
          if ((all.threads || []).length) {
            state.primaryFellBack = true;
            state.threads = all.threads;
            setHint('Gmail category tabs look disabled for this mailbox — showing the full Inbox. Turn tabs on in Gmail to split Primary from Promotions.');
          }
        }
        renderList();
        publishStatus();
        // No rail in scoped mode, so nothing to count into — and label_counts is
        // whole-mailbox anyway. Skipping it also drops a request per load.
        if (!scoped) loadCounts();
      } catch (e) { listEl.innerHTML = '<div class="gm-empty">' + esc(e.message) + '</div>'; }
    }

    async function openDraft(did) {
      root.classList.add('gm-show-pane');
      paneEl.innerHTML = '<div class="gm-empty">Opening draft…</div>';
      var d;
      try { d = await invoke(cl, state.mailbox, 'get_draft', { draft_id: did }); }
      catch (e) { paneEl.innerHTML = '<div class="gm-empty">Could not open draft: ' + esc(e.message) + '</div>'; return; }
      paneEl.innerHTML = '<div class="gm-phead"><button class="gm-btn plain gm-back" data-gm="back">‹ Back</button>' +
        '<div class="gm-psubj">' + esc(d.subject || '(no subject)') + '</div></div><div data-gm="cmp"></div>';
      paneEl.querySelector('[data-gm="back"]').addEventListener('click', function () { root.classList.remove('gm-show-pane'); });
      mountComposer(paneEl.querySelector('[data-gm="cmp"]'), {
        client: cl, mailbox: state.mailbox, mode: 'new', msgs: [],
        prefill: { to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body_html: d.body_html, body_text: d.body_text, draft_id: d.draft_id },
        onDone: function () { root.classList.remove('gm-show-pane'); loadThreads(); },
        onDraftGone: function (id) { state.drafts = state.drafts.filter(function (x) { return x.id !== id; }); renderDrafts(); }
      });
    }

    function openThread(tid) {
      state.active = tid; renderList();
      root.classList.add('gm-show-pane');
      renderThread(paneEl, {
        client: cl, mailbox: state.mailbox, threadId: tid, allowTag: true,
        onBack: function () { root.classList.remove('gm-show-pane'); },
        onRead: function (id) { var t = state.threads.filter(function (x) { return x.id === id; })[0]; if (t) { t.unread = false; renderList(); } },
        onArchived: function (id) { state.threads = state.threads.filter(function (x) { return x.id !== id; }); state.active = null; renderList(); paneEl.innerHTML = '<div class="gm-empty">Select a thread to read.</div>'; root.classList.remove('gm-show-pane'); }
      });
    }

    // wire toolbar
    if (showSwitcher) Array.prototype.forEach.call(root.querySelectorAll('.gm-sw button'), function (b) {
      // Routed through switchMailbox so this and the "switch" button offered on an
      // empty search cannot drift apart — one of them clearing state the other
      // keeps is exactly how a stale filed-cache or category fallback survives.
      b.addEventListener('click', function () { switchMailbox(b.getAttribute('data-mb')); });
    });

    // folder switcher
    Array.prototype.forEach.call(root.querySelectorAll('[data-fd]'), function (b) {
      b.addEventListener('click', function () {
        state.folder = b.getAttribute('data-fd');
        // A live search overrides folder scoping in listParams(), so picking a folder without
        // clearing it would highlight (say) Sent while still listing the old search hits.
        state.q = ''; searchEl.value = '';
        state.active = null; state.threads = []; state.drafts = [];
        paneEl.innerHTML = '<div class="gm-empty">Select a thread to read.</div>';
        root.classList.remove('gm-show-pane');
        loadThreads();
      });
    });

    /* Categories. A category is a SLICE OF INBOX, never a folder, so selecting one
     * implies Inbox: if you are sitting in Sent or Trash, this moves you to Inbox
     * and applies the category there rather than pretending to filter Sent. */
    Array.prototype.forEach.call(root.querySelectorAll('[data-ct]'), function (b) {
      b.addEventListener('click', function () {
        state.category = b.getAttribute('data-ct');
        state.folder = 'INBOX';
        // Same reason as the folder switcher: a live search would swallow the category.
        state.q = ''; searchEl.value = '';
        // The fallback only ever applies to Primary; picking a real category clears it.
        if (state.category !== 'CATEGORY_PERSONAL') state.primaryFellBack = false;
        state.active = null; state.threads = []; state.drafts = [];
        paneEl.innerHTML = '<div class="gm-empty">Select a thread to read.</div>';
        root.classList.remove('gm-show-pane');
        loadThreads();
      });
    });

    /* Compose. Absent in scoped mode — the rail is gone, and the lead page has
       its own compose button that prefills the contact, which a blank composer
       here would not. Look it up rather than assuming it exists. */
    var composeBtn = root.querySelector('[data-gm="compose"]');
    if (composeBtn) composeBtn.addEventListener('click', function () {
      openCompose({ client: cl, mailbox: state.mailbox, onSent: function () { loadThreads(); } });
    });

    function doSearch() {
      var typed = searchEl.value.trim();
      /* Editing the query in scoped mode is allowed — widening the search is a
         deliberate act by someone who can already read this mailbox. CLEARING it
         is not the same act: an empty box means "no filter", which here means the
         whole mailbox under a contact's name. Restore the scope and say so
         rather than refusing silently or listing everything. */
      var restored = scoped && !typed;
      if (restored) { searchEl.value = scopeQ; state.q = scopeQ; }
      else { state.q = typed; }
      state.active = null;
      // loadThreads() clears the hint on entry, so set it after the call — it
      // runs synchronously up to its first await.
      loadThreads();
      if (restored) setHint('An empty search would have listed the whole mailbox, so the contact scope was put back. Edit it if you want a wider search.');
    }
    root.querySelector('[data-gm="go"]').addEventListener('click', doSearch);
    root.querySelector('[data-gm="refresh"]').addEventListener('click', loadThreads);
    searchEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });

    /* Show the seeded query in the box. Without this the list would be filtered
       by something the user can neither see nor clear, which reads as a broken
       inbox rather than a scoped one. */
    if (state.q) searchEl.value = state.q;

    loadThreads();
  }

  // ── Compose: the Stage-1 composer in a modal, with no thread context ──
  function openCompose(opts) {
    injectStyles();
    var cl = resolveClient(opts);
    if (!cl || !opts.mailbox) return;
    var ov = document.createElement('div'); ov.className = 'gm-modal';
    ov.innerHTML = '<div class="gm-modal-card gm-compose-card">' +
      '<div class="gm-pane" style="flex:1"><div data-gm="cmp"></div></div></div>';
    document.body.appendChild(ov);
    function close() { ov.remove(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    mountComposer(ov.querySelector('[data-gm="cmp"]'), {
      client: cl, mailbox: opts.mailbox, mode: 'new', msgs: [],
      prefill: opts.prefill || {},
      /* Passed through so a compose started FROM a lead carries that lead:
         the composer uses contactId for AI context and for registering a video
         message against the right person. Filing of the sent thread itself is
         separate and server-side — gmail-inbox's send resolves the contact from
         email_thread_tags first and matchContact second, and matchContact
         checks email AND secondary_email, so a message addressed to either
         files without the client asserting anything. */
      contactId: opts.contactId || (opts.prefill && opts.prefill.contact_id) || null,
      onClose: close,
      onDone: function () { close(); if (opts.onSent) opts.onSent(); }
    });
  }

  // ── standalone modal viewer (lead-detail: open one filed thread) ──
  function openThread(opts) {
    injectStyles();
    var cl = resolveClient(opts);
    if (!cl || !opts.threadId || !opts.mailbox) return;

    /* HOST TARGET. With `host` the thread renders INTO that element; without it
       the original full-screen overlay is created, unchanged. Added so the
       HOI/VOE order cards can show a conversation inline instead of throwing an
       overlay over the record you are reading it against — the comparison IS
       the point on those panels.
       `modal` stays tied to whether an overlay was created, because it is what
       selects back-button vs close-button chrome inside renderThread; an inline
       thread has neither. */
    var host = opts.host || null;
    if (host) {
      renderThread(host, {
        client: cl, mailbox: opts.mailbox, threadId: opts.threadId, modal: false,
        allowTag: opts.allowTag === true,   // inline: opt IN, the card owns filing
        onClose: null,
        onChanged: opts.onChanged || null
      });
      return;
    }

    var ov = document.createElement('div'); ov.className = 'gm-modal';
    ov.innerHTML = '<div class="gm-modal-card"><div class="gm-pane" style="flex:1"></div></div>';
    document.body.appendChild(ov);
    function close() { ov.remove(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    renderThread(ov.querySelector('.gm-pane'), {
      client: cl, mailbox: opts.mailbox, threadId: opts.threadId, modal: true,
      allowTag: opts.allowTag !== false, onClose: close,
      onChanged: opts.onChanged || null
    });
  }

  /**
   * `sanitize` and `PURIFY_CFG` are exported so OTHER surfaces (the Settings
   * signature editor) can reuse the composer's exact sanitize path instead of
   * declaring a second config that drifts. There must be exactly one allowlist:
   * it is the one carrying the ADD_URI_SAFE_ATTR fix that keeps table-based
   * signature HTML (width/colspan/bgcolor/cellpadding/valign) from being mangled.
   * Anything that will end up in outbound mail must go through THIS function.
   */
  /* `call` is the SAME invoke every surface here uses. Exported so lead-detail
   * can run a mailbox-scoped list_threads without hand-rolling a second
   * functions.invoke — the hand-rolled one is where the 403 body gets lost. This
   * unwraps resp.error.context.json() to surface the server's actual message
   * ("mailbox not permitted for role va") instead of a bare "Edge Function
   * returned a non-2xx status code". The role check itself stays server-side in
   * resolveMailbox; nothing here decides access, it only reports the refusal. */
  /* `splitQuoted` and `wrapBody` are exported for the SAME reason as `sanitize`:
   * so a second surface reuses this logic instead of growing its own copy that
   * drifts. lead-detail's VOE fallback modal reads legacy mail that has no
   * gmail_thread_id and therefore cannot go through renderThread at all — but
   * it must still collapse quoted history and render inside a controlled
   * document, which is exactly these two functions. One renderer's logic, two
   * entry points; not a second renderer.
   *
   * splitQuoted(html) -> { main, quoted }. Cuts at the first of: a gmail_quote
   * div, a blockquote type="cite", #appendonsend, or a bare "On ... wrote:"
   * trailer — and refuses a cut inside the first 24 characters, because a body
   * that IS a quote from its first byte has no main part to show.
   * wrapBody(html, text) -> a full document with a reset, img{max-width:100%}
   * and blockquote styling, for use as an iframe srcdoc. */
  window.GmailInbox = {
    mount: mount, openThread: openThread, openCompose: openCompose, call: invoke,
    sanitize: sanitize, sanitizerReady: sanitizerReady, PURIFY_CFG: PURIFY_CFG,
    splitQuoted: splitQuoted, wrapBody: wrapBody,
    /* INLINE cid: IMAGES, exported so lead-detail's reader uses THIS
     * implementation rather than growing a second one.
     *
     * lead-detail had no cid: handling at all — it set srcdoc directly — so every
     * embedded image in an HOI or VOE thread rendered as a broken image with its
     * alt text, and signatures (mostly a table of cid: logos) appeared to vanish.
     * The same message opened in the Communications inbox rendered correctly,
     * because only this file knew how.
     *
     * Two functions, used together and in this order:
     *   resolveInlineImages(client, mailbox, msg) -> { cid: blobUrl }   (async)
     *   rewriteCidSrc(html, map) -> html with src="blob:…"
     * plus hasCidRefs(html) to skip the round trip when there is nothing to do.
     *
     * The blob cache is module-level and shared, so a message opened in both
     * places fetches each part once. */
    resolveInlineImages: resolveInlineImages,
    rewriteCidSrc: rewriteCidSrc,
    hasCidRefs: hasCidRefs
  };
})();
