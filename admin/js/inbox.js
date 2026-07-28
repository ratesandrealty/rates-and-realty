/* inbox.js — Gmail inbox shared component (admin inbox, VA inbox, lead-detail viewer).
 * v=2026072701
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
  function fmtDate(d) {
    if (!d) return '';
    try {
      var dt = new Date(d), now = new Date();
      var opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
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
      '.gm-inbox{--g:var(--gold,#c9a84c);display:flex;flex-direction:column;min-height:480px;height:calc(100vh - 120px);background:var(--surface,#111);border:1px solid var(--border2,rgba(255,255,255,.12));border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text,#fff)}',
      '.gm-tb{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border,rgba(255,255,255,.08));flex-wrap:wrap;flex-shrink:0}',
      '.gm-sw{display:flex;gap:4px}',
      '.gm-sw button{padding:6px 12px;border-radius:18px;border:1px solid var(--border2,rgba(255,255,255,.12));background:transparent;color:var(--muted,#999);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.gm-sw button.active{background:rgba(201,168,76,.15);color:var(--g);border-color:var(--g)}',
      '.gm-search{flex:1;min-width:150px;display:flex;gap:6px}',
      '.gm-search input{flex:1;min-width:0;background:#0d0d0d;border:1px solid var(--border2,rgba(255,255,255,.12));border-radius:8px;padding:8px 10px;color:#fff;font-size:13px;font-family:inherit}',
      '.gm-btn{background:rgba(201,168,76,.12);border:1px solid rgba(201,168,76,.4);color:var(--g);border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}',
      '.gm-btn:hover{background:rgba(201,168,76,.22)}',
      '.gm-btn.plain{background:transparent;border-color:var(--border2,rgba(255,255,255,.14));color:var(--muted,#aaa)}',
      '.gm-body{display:flex;flex:1;min-height:0}',
      '.gm-list{width:340px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--border,rgba(255,255,255,.08))}',
      '.gm-pane{flex:1;overflow-y:auto;min-width:0;padding:0}',
      '.gm-row{padding:11px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.06));cursor:pointer}',
      '.gm-row:hover{background:rgba(255,255,255,.03)}',
      '.gm-row.active{background:rgba(201,168,76,.08)}',
      '.gm-row.unread .gm-row-subj{font-weight:800;color:#fff}',
      '.gm-row-top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}',
      '.gm-row-from{font-size:12.5px;color:#ddd;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.gm-row-date{font-size:11px;color:var(--muted,#888);flex-shrink:0}',
      '.gm-row-subj{font-size:13px;color:#eee;margin:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.gm-row-snip{font-size:12px;color:var(--muted,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.gm-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--g);margin-right:6px;vertical-align:middle}',
      '.gm-cnt{display:inline-block;font-size:10px;color:var(--muted,#888);border:1px solid var(--border2,rgba(255,255,255,.14));border-radius:9px;padding:0 5px;margin-left:6px}',
      '.gm-empty{padding:40px 20px;text-align:center;color:var(--muted,#888);font-size:13px}',
      '.gm-phead{position:sticky;top:0;background:var(--surface,#111);border-bottom:1px solid var(--border,rgba(255,255,255,.08));padding:12px 16px;z-index:2}',
      '.gm-psubj{font-size:15px;font-weight:800;color:#fff;margin:0 0 6px}',
      '.gm-pacts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.gm-badge{font-size:11px;font-weight:700;padding:3px 9px;border-radius:12px;background:rgba(80,200,120,.14);color:#50c878;border:1px solid rgba(80,200,120,.4)}',
      '.gm-msg{padding:12px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,.06))}',
      '.gm-mmeta{font-size:12px;color:var(--muted,#999);margin-bottom:8px;line-height:1.5}',
      '.gm-mdir{font-weight:700}',
      '.gm-frame{width:100%;border:1px solid var(--border2,rgba(255,255,255,.1));border-radius:8px;background:#fff;min-height:80px}',
      '.gm-att{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted,#bbb);background:rgba(255,255,255,.04);border:1px solid var(--border2,rgba(255,255,255,.12));border-radius:6px;padding:4px 8px;margin:6px 6px 0 0}',
      /* ── composer ── */
      '.gm-acts{display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--border,rgba(255,255,255,.1))}',
      '.gm-cmp{border-top:2px solid var(--g);background:#0d0d0d}',
      '.gm-cmp-head{display:flex;align-items:center;gap:8px;padding:9px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,.08))}',
      '.gm-cmp-title{font-size:13px;font-weight:800;color:var(--g);flex:1;min-width:0}',
      '.gm-x{background:none;border:none;color:#888;font-size:20px;cursor:pointer;line-height:1;padding:0 4px;font-family:inherit}',
      '.gm-x:hover{color:#fff}',
      '.gm-fld{display:flex;align-items:flex-start;gap:8px;padding:6px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,.06))}',
      '.gm-fld-l{font-size:12px;color:var(--muted,#888);width:40px;flex-shrink:0;padding-top:7px;font-weight:700}',
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
      '.gm-tools{display:flex;gap:1px;padding:5px 12px;border-bottom:1px solid var(--border,rgba(255,255,255,.06));flex-wrap:wrap;align-items:center}',
      '.gm-tools button{min-width:30px;height:30px;border-radius:6px;border:1px solid transparent;background:transparent;color:#bbb;cursor:pointer;font-size:13px;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;padding:0 6px}',
      '.gm-tools button:hover{background:rgba(255,255,255,.08);color:#fff}',
      '.gm-tools .sep{width:1px;height:18px;background:var(--border2,rgba(255,255,255,.14));margin:0 5px;flex-shrink:0}',
      '.gm-ed{min-height:130px;max-height:40vh;overflow-y:auto;padding:12px 16px;color:#fff;font-size:13.5px;line-height:1.6;outline:none;word-wrap:break-word}',
      '.gm-ed:empty:before{content:attr(data-ph);color:#666}',
      '.gm-ed a{color:#8ab4f8}',
      '.gm-ed ul,.gm-ed ol{padding-left:22px;margin:6px 0}',
      '.gm-ed blockquote{border-left:2px solid #444;margin:6px 0;padding-left:10px;color:#aaa}',
      '.gm-sig{padding:6px 16px 10px;color:#b8b8b8;font-size:12.5px;line-height:1.5;outline:none}',
      '.gm-sig:focus{background:rgba(255,255,255,.03)}',
      '.gm-sig-l{font-size:10px;color:#666;padding:0 16px;text-transform:uppercase;letter-spacing:.5px;font-weight:700}',
      '.gm-qt{padding:0 16px 10px}',
      '.gm-qt-btn{background:rgba(255,255,255,.06);border:1px solid var(--border2,rgba(255,255,255,.14));color:#999;border-radius:6px;padding:0 10px;font-size:14px;cursor:pointer;letter-spacing:2px;line-height:1.6;font-family:inherit}',
      '.gm-qt-btn:hover{color:#fff}',
      '.gm-qt-box{display:none;margin-top:8px;border-left:2px solid #333;padding-left:10px}',
      '.gm-qt-box.open{display:block}',
      '.gm-qt-frame{width:100%;border:0;background:#fff;border-radius:6px;min-height:60px}',
      '.gm-cmp-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid var(--border,rgba(255,255,255,.08));flex-wrap:wrap}',
      '.gm-send{background:var(--g);border:1px solid var(--g);color:#161616;border-radius:8px;padding:9px 22px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit}',
      '.gm-send:hover{filter:brightness(1.08)}',
      '.gm-send:disabled{opacity:.5;cursor:default;filter:none}',
      '.gm-cmp-hint{flex:1;min-width:120px;font-size:11.5px;color:#666}',
      /* loud, persistent send result — replaces the old 2.6s toast */
      '.gm-note{margin:12px 16px 0;border-radius:9px;padding:11px 13px;font-size:12.5px;line-height:1.55;display:none}',
      '.gm-note.ok{display:block;background:rgba(80,200,120,.12);border:1px solid rgba(80,200,120,.45);color:#7ee2a0}',
      '.gm-note.bad{display:block;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.5);color:#fca5a5}',
      '.gm-note.warn{display:block;background:rgba(251,146,60,.1);border:1px solid rgba(251,146,60,.5);color:#fdba74}',
      '.gm-note b{display:block;font-size:13.5px;margin-bottom:3px}',
      '.gm-note code{background:rgba(0,0,0,.35);border-radius:4px;padding:1px 5px;font-size:11.5px;word-break:break-all}',
      '.gm-pop{position:relative;display:inline-block}',
      '.gm-pop-menu{position:absolute;z-index:20;top:calc(100% + 4px);left:0;width:280px;max-width:78vw;background:#141414;border:1px solid var(--border2,rgba(255,255,255,.16));border-radius:10px;padding:8px;box-shadow:0 12px 30px rgba(0,0,0,.5)}',
      '.gm-pop-menu input{width:100%;background:#0a0a0a;border:1px solid var(--border2,rgba(255,255,255,.14));border-radius:7px;padding:8px;color:#fff;font-size:13px;font-family:inherit;box-sizing:border-box}',
      '.gm-pop-res{max-height:220px;overflow-y:auto;margin-top:6px}',
      '.gm-pop-item{padding:8px 9px;border-radius:6px;cursor:pointer;font-size:12.5px;color:#eee}',
      '.gm-pop-item:hover{background:rgba(201,168,76,.12)}',
      '.gm-pop-item .e{color:var(--muted,#888);font-size:11px}',
      '.gm-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1a1a1a;border:1px solid var(--g);color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.5)}',
      '.gm-back{display:none}',
      /* modal (lead-detail viewer) */
      '.gm-modal{position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9998;display:flex;align-items:center;justify-content:center;padding:20px}',
      '.gm-modal .gm-modal-card{width:820px;max-width:96vw;height:86vh;background:var(--surface,#111);border:1px solid var(--border2,rgba(255,255,255,.14));border-radius:14px;display:flex;flex-direction:column;overflow:hidden}',
      '.gm-modal-close{background:none;border:none;color:#999;font-size:22px;cursor:pointer;line-height:1}',
      '@media (min-width:769px) and (max-width:1199px){',
      '  .gm-list{width:290px}',
      '  .gm-ed{max-height:34vh}',
      '}',
      '@media (max-width:768px){',
      '  .gm-inbox{height:auto;min-height:calc(100vh - 90px)}',
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
      '  .gm-tools .sep{flex-shrink:0}',
      '  .gm-send{flex:1;min-height:44px;padding:11px 22px}',
      '  .gm-cmp-hint{order:3;flex-basis:100%;min-width:0}',
      '}',
      '@media (max-width:480px){',
      '  .gm-fld{flex-wrap:wrap;gap:4px}',
      '  .gm-fld-l{width:100%;padding-top:2px}',
      '  .gm-ccbcc{padding-top:0}',
      '  .gm-acts button{min-width:calc(50% - 6px)}',
      '  .gm-chips input{min-width:100%}',
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
      '<style>body{margin:0;padding:14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;background:#fff;line-height:1.5;word-wrap:break-word}img{max-width:100%;height:auto}a{color:#1155cc}blockquote{border-left:3px solid #ddd;margin:0;padding-left:12px;color:#555}</style>' +
      '</head><body>' + inner + '</body></html>';
  }

  function toast(msg) {
    var t = document.createElement('div'); t.className = 'gm-toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600);
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

  /**
   * Who does this message go to?
   *  reply     → the last inbound sender (Reply-To wins over From); if we sent last, our own recipients
   *  replyAll  → the above, plus every other To/Cc participant plus the CC line, minus THIS mailbox
   *  forward   → nobody; the user picks
   * Only the ACTIVE mailbox is excluded — replying as rene@ with processing@ on the thread
   * is normal and intentional, so the other company address is kept.
   */
  function computeRecipients(mode, msgs, mailbox) {
    var self = String(mailbox || '').toLowerCase();
    var last = msgs[msgs.length - 1] || {};
    var target = null;
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].direction === 'inbound') { target = msgs[i]; break; }
    }
    if (!target) target = last;
    if (mode === 'forward') return { to: [], cc: [], target: last };

    var to;
    if (target.direction === 'outbound') to = dedupe(target.to || [], [self]);
    else to = dedupe([target.reply_to || (target.from && target.from.email) || ''], [self]);

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
  function chipField(host, initial) {
    var vals = dedupe(initial || []);
    var inp = host.querySelector('input');
    function render() {
      Array.prototype.forEach.call(host.querySelectorAll('.gm-chip'), function (c) { c.remove(); });
      vals.forEach(function (v, idx) {
        var c = document.createElement('span');
        c.className = 'gm-chip' + (RE_EMAIL.test(v) ? '' : ' bad');
        if (!RE_EMAIL.test(v)) c.title = 'Doesn’t look like a valid email address';
        var i = document.createElement('i'); i.textContent = v;
        var b = document.createElement('b'); b.textContent = '×';
        b.addEventListener('click', function () { vals.splice(idx, 1); render(); });
        c.appendChild(i); c.appendChild(b);
        host.insertBefore(c, inp);
      });
    }
    function commit() {
      if (!inp.value.trim()) return;
      vals = dedupe(vals.concat(parseAddrs(inp.value)));
      inp.value = '';
      render();
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === 'Tab') {
        if (inp.value.trim()) { e.preventDefault(); commit(); }
      } else if (e.key === 'Backspace' && !inp.value && vals.length) {
        vals.pop(); render();
      }
    });
    inp.addEventListener('blur', commit);
    inp.addEventListener('paste', function () { setTimeout(commit, 0); });
    render();
    return {
      get: function () { commit(); return vals.slice(); },
      count: function () { return vals.length + (inp.value.trim() ? 1 : 0); },
      focus: function () { inp.focus(); }
    };
  }

  // ── formatting toolbar (execCommand — the only contentEditable API with universal support) ──
  var TOOLS = [
    { c: 'bold', l: '<b>B</b>', t: 'Bold (Ctrl+B)' },
    { c: 'italic', l: '<i>I</i>', t: 'Italic (Ctrl+I)' },
    { c: 'underline', l: '<u>U</u>', t: 'Underline (Ctrl+U)' },
    { sep: 1 },
    { c: 'insertUnorderedList', l: '&bull;&nbsp;', t: 'Bulleted list' },
    { c: 'insertOrderedList', l: '1.', t: 'Numbered list' },
    { sep: 1 },
    { c: '_link', l: '&#128279;', t: 'Insert link' },
    { c: 'removeFormat', l: '&#10006;', t: 'Clear formatting' }
  ];

  function wireEditor(ed, tools) {
    // Paste: strip to sanitized HTML. This is the primary ingress for hostile markup.
    ed.addEventListener('paste', function (e) {
      e.preventDefault();
      var cb = e.clipboardData || window.clipboardData;
      if (!cb) return;
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
    Array.prototype.forEach.call(tools.querySelectorAll('button[data-c]'), function (b) {
      // mousedown+preventDefault keeps the caret/selection inside the editor
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        var cmd = b.getAttribute('data-c');
        ed.focus();
        if (cmd === '_link') {
          var url = window.prompt('Link URL:', 'https://');
          if (!url) return;
          url = url.trim();
          if (!/^(https?:|mailto:|tel:)/i.test(url)) { alert('Only http, https, mailto and tel links are allowed.'); return; }
          try { document.execCommand('createLink', false, url); } catch (_) {}
          return;
        }
        try { document.execCommand(cmd, false, null); } catch (_) {}
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

    var rec, quoteHtml;
    try {
      rec = computeRecipients(mode, msgs, mailbox);
      quoteHtml = rec.target ? buildQuote(mode, rec.target) : '';
    } catch (e) {
      mountEl.innerHTML = '<div class="gm-note bad" style="display:block"><b>Could not prepare the message</b>' + esc(e.message) + '</div>';
      return;
    }

    var base = baseSubject(cfg.subject || (rec.target && rec.target.subject) || '');
    var subject = (mode === 'forward' ? 'Fwd: ' : 'Re: ') + base;
    var title = mode === 'forward' ? '↪ Forward' : (mode === 'replyAll' ? '↩↩ Reply all' : '↩ Reply');
    var showCc = (rec.cc && rec.cc.length) > 0;

    if (cfg.actsEl) cfg.actsEl.style.display = 'none';

    var h = [];
    h.push('<div class="gm-cmp">');
    h.push('<div class="gm-cmp-head"><span class="gm-cmp-title">' + title + '</span>' +
      '<span style="font-size:11px;color:#666">from ' + esc(mailbox) + '</span>' +
      '<button class="gm-x" data-c="close" title="Discard">×</button></div>');

    h.push('<div class="gm-fld"><span class="gm-fld-l">To</span>' +
      '<span class="gm-chips" data-f="to"><input type="text" autocomplete="off" spellcheck="false" placeholder="name@example.com"></span>' +
      '<span class="gm-ccbcc"><button data-t="cc"' + (showCc ? ' class="on"' : '') + '>Cc</button><button data-t="bcc">Bcc</button></span></div>');
    h.push('<div class="gm-fld" data-r="cc"' + (showCc ? '' : ' style="display:none"') + '><span class="gm-fld-l">Cc</span>' +
      '<span class="gm-chips" data-f="cc"><input type="text" autocomplete="off" spellcheck="false"></span></div>');
    h.push('<div class="gm-fld" data-r="bcc" style="display:none"><span class="gm-fld-l">Bcc</span>' +
      '<span class="gm-chips" data-f="bcc"><input type="text" autocomplete="off" spellcheck="false"></span></div>');
    h.push('<div class="gm-fld"><span class="gm-fld-l">Subj</span>' +
      '<input class="gm-subj" data-f="subject" type="text" autocomplete="off" value="' + esc(subject) + '"></div>');

    h.push('<div class="gm-tools" data-gm="tools">' + TOOLS.map(function (t) {
      return t.sep ? '<span class="sep"></span>'
        : '<button type="button" data-c="' + t.c + '" title="' + esc(t.t) + '">' + t.l + '</button>';
    }).join('') + '</div>');

    h.push('<div class="gm-ed" data-f="body" contenteditable="true" data-ph="Write your message…"></div>');
    h.push('<div class="gm-sig-l" data-gm="sigl" style="display:none">Signature — click to edit</div>');
    h.push('<div class="gm-sig" data-f="sig" contenteditable="true" style="display:none"></div>');

    if (quoteHtml) {
      h.push('<div class="gm-qt"><button class="gm-qt-btn" data-c="quote" title="Show quoted text">•••</button>' +
        '<div class="gm-qt-box" data-gm="qtbox"><iframe class="gm-qt-frame" sandbox="allow-same-origin"></iframe></div></div>');
    }

    h.push('<div class="gm-note" data-gm="note"></div>');
    h.push('<div class="gm-cmp-bar"><button class="gm-send" data-c="send">Send</button>' +
      '<button class="gm-btn plain" data-c="close">Discard</button>' +
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

    var toF = chipField(mountEl.querySelector('[data-f="to"]'), rec.to);
    var ccF = chipField(mountEl.querySelector('[data-f="cc"]'), rec.cc);
    var bccF = chipField(mountEl.querySelector('[data-f="bcc"]'), []);

    function note(kind, title, detail) {
      noteEl.className = 'gm-note ' + kind;
      noteEl.innerHTML = '<b>' + esc(title) + '</b>' + (detail || '');
    }
    function clearNote() { noteEl.className = 'gm-note'; noteEl.innerHTML = ''; }

    wireEditor(edEl, mountEl.querySelector('[data-gm="tools"]'));
    wireEditor(sigEl, null);

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
            f.srcdoc = wrapBody(quoteHtml, '');
            f.onload = function () {
              try { f.style.height = Math.min(f.contentDocument.body.scrollHeight + 24, 260) + 'px'; }
              catch (_) { f.style.height = '200px'; }
            };
          }
        }
      });
    }

    // Signature (async — never blocks typing)
    var sigLoaded = '';
    getSignature(cl, mailbox).then(function (sig) {
      if (!sig) return;
      sigLoaded = sig;
      try { sigEl.innerHTML = sanitize(sig); } catch (_) { return; }
      sigEl.style.display = ''; sigL.style.display = '';
    });

    function close() {
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

    // focus: forward starts on the empty To field, replies start in the body
    if (mode === 'forward') toF.focus(); else edEl.focus();

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

      // ── assemble, then sanitize the WHOLE composed body as the last gate ──
      var composed;
      try {
        var parts = ['<div dir="ltr">' + edEl.innerHTML + '</div>'];
        if (sigEl.style.display !== 'none' && sigEl.innerHTML.trim()) {
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
        body_html: composed, body_text: bodyText,
        thread_id: cfg.threadId
      };
      if (cc.length) payload.cc = cc.join(', ');
      if (bcc.length) payload.bcc = bcc.join(', ');
      if (rec.target && rec.target.message_id) payload.in_reply_to = rec.target.message_id;

      try {
        var res = await invoke(cl, mailbox, 'send', payload);
        var when = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        var filed = res && res.filed_as
          ? 'Filed to the lead (' + esc(res.filed_as) + ').'
          : 'Not filed to a lead — no recipient matched a contact. Tag the thread to file it.';
        note('ok', '✓ Sent to ' + esc(to.join(', ')),
          when + ' · from <b>' + esc(mailbox) + '</b><br>' + filed +
          (res && res.message_id ? '<br>Gmail id <code>' + esc(res.message_id) + '</code>' : ''));
        // Freeze the composer: the message is gone, editing it now means nothing.
        sendBtn.textContent = 'Sent ✓';
        [edEl, sigEl].forEach(function (n) { n.setAttribute('contenteditable', 'false'); });
        subjEl.disabled = true;
        Array.prototype.forEach.call(mountEl.querySelectorAll('.gm-chips input,.gm-tools button'), function (n) { n.disabled = true; });
        var bar = mountEl.querySelector('.gm-cmp-bar');
        var done = document.createElement('button');
        done.className = 'gm-btn'; done.textContent = 'Back to thread';
        done.addEventListener('click', function () { if (cfg.onDone) cfg.onDone(); else close(); });
        bar.appendChild(done);
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

    var h = [];
    h.push('<div class="gm-phead">');
    if (ctx.modal) h.push('<div style="display:flex;justify-content:space-between;align-items:start;gap:10px"><div class="gm-psubj">' + esc(subj) + '</div><button class="gm-modal-close" data-gm="close">×</button></div>');
    else h.push('<button class="gm-btn plain gm-back" data-gm="back" style="margin-bottom:8px">‹ Back</button><div class="gm-psubj">' + esc(subj) + '</div>');
    h.push('<div class="gm-pacts">');
    if (filedId) h.push('<span class="gm-badge" title="Filed via ' + esc(filedVia || '') + '">🏷 Filed to ' + esc(filedNm || 'lead') + '</span>');
    if (ctx.allowTag !== false) {
      h.push('<span class="gm-pop"><button class="gm-btn" data-gm="tagbtn">🏷 ' + (filedId ? 'Re-file' : 'Tag borrower') + '</button></span>');
      if (filedId) h.push('<button class="gm-btn plain" data-gm="unfile">Unfile</button>');
    }
    h.push('<button class="gm-btn plain" data-gm="archive">Archive</button>');
    h.push('</div></div>');

    msgs.forEach(function (m, i) {
      var inbound = m.direction === 'inbound';
      var meta = ['<span class="gm-mdir" style="color:' + (inbound ? '#50c878' : '#c9a84c') + '">' + (inbound ? '↓ ' + esc((m.from && m.from.name) || (m.from && m.from.email) || '') : '↑ You') + '</span>'];
      if (m.from && m.from.email) meta.push(esc(m.from.email));
      if (m.to && m.to.length) meta.push('to ' + esc(m.to.join(', ')));
      if (m.date) meta.push(fmtDate(m.date));
      h.push('<div class="gm-msg">');
      h.push('<div class="gm-mmeta">' + meta.join(' &nbsp;·&nbsp; ') + '</div>');
      h.push('<iframe class="gm-frame" data-fi="' + i + '" sandbox="allow-same-origin allow-popups"></iframe>');
      if (m.attachments && m.attachments.length) {
        h.push('<div>' + m.attachments.map(function (a) { return '<span class="gm-att">📎 ' + esc(a.filename || 'attachment') + '</span>'; }).join('') + '</div>');
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
      f.srcdoc = wrapBody(m.body_html, m.body_text);
      f.onload = function () { try { f.style.height = (f.contentDocument.body.scrollHeight + 28) + 'px'; } catch (_) { f.style.height = '360px'; } };
    });

    // mark the thread read (best-effort) + clear the list dot
    invoke(cl, mailbox, 'modify', { thread_id: threadId, mark_read: true }).then(function () {
      if (ctx.onRead) ctx.onRead(threadId);
    }).catch(function () {});

    // wire actions
    function wire(sel, fn) { var el = host.querySelector(sel); if (el) el.addEventListener('click', fn); }
    wire('[data-gm="back"]', function () { if (ctx.onBack) ctx.onBack(); });
    wire('[data-gm="close"]', function () { if (ctx.onClose) ctx.onClose(); });
    wire('[data-gm="archive"]', async function (e) {
      e.target.disabled = true;
      try { await invoke(cl, mailbox, 'modify', { thread_id: threadId, archive: true }); toast('Archived'); if (ctx.onArchived) ctx.onArchived(threadId); }
      catch (err) { toast(err.message); e.target.disabled = false; }
    });
    // Reply / Reply all / Forward → mount the composer
    Array.prototype.forEach.call(host.querySelectorAll('[data-cmp]'), function (b) {
      b.addEventListener('click', function () {
        mountComposer(host.querySelector('[data-gm="cmp"]'), {
          client: cl, mailbox: mailbox, threadId: threadId,
          mode: b.getAttribute('data-cmp'), msgs: msgs, subject: subj,
          actsEl: host.querySelector('[data-gm="acts"]'),
          onDone: function () { renderThread(host, ctx); }
        });
      });
    });
    wire('[data-gm="unfile"]', async function (e) {
      e.target.disabled = true;
      try { await invoke(cl, mailbox, 'untag', { thread_id: threadId, unfile: true }); toast('Unfiled'); renderThread(host, ctx); if (ctx.onChanged) ctx.onChanged(); }
      catch (err) { toast(err.message); e.target.disabled = false; }
    });
    // tag popover
    wire('[data-gm="tagbtn"]', function (e) {
      var pop = e.target.closest('.gm-pop'); if (!pop) return;
      if (pop.querySelector('.gm-pop-menu')) { pop.querySelector('.gm-pop-menu').remove(); return; }
      var menu = document.createElement('div'); menu.className = 'gm-pop-menu';
      menu.innerHTML = '<input type="text" placeholder="Search contacts…"><div class="gm-pop-res"></div>';
      pop.appendChild(menu);
      var inp = menu.querySelector('input'), res = menu.querySelector('.gm-pop-res'), timer;
      inp.focus();
      inp.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(async function () {
          var rows = await searchContacts(cl, inp.value);
          res.innerHTML = rows.length ? rows.map(function (c) {
            return '<div class="gm-pop-item" data-cid="' + esc(c.id) + '">' + esc(c.name) + '<div class="e">' + esc(c.email) + '</div></div>';
          }).join('') : '<div class="gm-pop-item" style="cursor:default;color:#777">No matches</div>';
          Array.prototype.forEach.call(res.querySelectorAll('[data-cid]'), function (it) {
            it.addEventListener('click', async function () {
              try { await invoke(cl, mailbox, 'tag', { thread_id: threadId, contact_id: it.getAttribute('data-cid') }); toast('Filed to lead'); menu.remove(); renderThread(host, ctx); if (ctx.onChanged) ctx.onChanged(); }
              catch (err) { toast(err.message); }
            });
          });
        }, 220);
      });
    });
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
    var state = { mailbox: mailboxes[0], q: '', threads: [], active: null };

    var root = document.createElement('div'); root.className = 'gm-inbox';
    var sw = showSwitcher ? '<div class="gm-sw">' + mailboxes.map(function (m, i) {
      return '<button data-mb="' + esc(m) + '"' + (i === 0 ? ' class="active"' : '') + '>' + esc(m.split('@')[0]) + '@</button>';
    }).join('') + '</div>' : '';
    root.innerHTML =
      '<div class="gm-tb">' + sw +
      '<div class="gm-search"><input type="text" placeholder="Search mail (Gmail syntax: from: subject: is:unread …)"><button class="gm-btn" data-gm="go">Search</button></div>' +
      '<button class="gm-btn plain" data-gm="refresh">↻</button></div>' +
      '<div class="gm-body"><div class="gm-list"><div class="gm-empty">Loading…</div></div><div class="gm-pane"><div class="gm-empty">Select a thread to read.</div></div></div>';
    el.innerHTML = ''; el.appendChild(root);

    var listEl = root.querySelector('.gm-list'), paneEl = root.querySelector('.gm-pane'), searchEl = root.querySelector('.gm-search input');

    function renderList() {
      if (!state.threads.length) { listEl.innerHTML = '<div class="gm-empty">No threads.</div>'; return; }
      listEl.innerHTML = state.threads.map(function (t) {
        var from = (t.from && (t.from.name || t.from.email)) || '';
        return '<div class="gm-row' + (t.unread ? ' unread' : '') + (state.active === t.id ? ' active' : '') + '" data-tid="' + esc(t.id) + '">' +
          '<div class="gm-row-top"><span class="gm-row-from">' + (t.unread ? '<span class="gm-dot"></span>' : '') + esc(from) + '</span><span class="gm-row-date">' + esc(fmtDate(t.date)) + '</span></div>' +
          '<div class="gm-row-subj">' + esc(t.subject || '(no subject)') + (t.message_count > 1 ? '<span class="gm-cnt">' + t.message_count + '</span>' : '') + '</div>' +
          '<div class="gm-row-snip">' + esc(t.snippet || '') + '</div></div>';
      }).join('');
      Array.prototype.forEach.call(listEl.querySelectorAll('[data-tid]'), function (r) {
        r.addEventListener('click', function () { openThread(r.getAttribute('data-tid')); });
      });
    }

    async function loadThreads() {
      listEl.innerHTML = '<div class="gm-empty">Loading…</div>';
      try {
        var d = await invoke(cl, state.mailbox, 'list_threads', state.q ? { q: state.q } : {});
        state.threads = d.threads || []; renderList();
      } catch (e) { listEl.innerHTML = '<div class="gm-empty">' + esc(e.message) + '</div>'; }
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
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(root.querySelectorAll('.gm-sw button'), function (x) { x.classList.remove('active'); });
        b.classList.add('active'); state.mailbox = b.getAttribute('data-mb'); state.active = null;
        paneEl.innerHTML = '<div class="gm-empty">Select a thread to read.</div>'; loadThreads();
      });
    });
    function doSearch() { state.q = searchEl.value.trim(); loadThreads(); }
    root.querySelector('[data-gm="go"]').addEventListener('click', doSearch);
    root.querySelector('[data-gm="refresh"]').addEventListener('click', loadThreads);
    searchEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });

    loadThreads();
  }

  // ── standalone modal viewer (lead-detail: open one filed thread) ──
  function openThread(opts) {
    injectStyles();
    var cl = resolveClient(opts);
    if (!cl || !opts.threadId || !opts.mailbox) return;
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

  window.GmailInbox = { mount: mount, openThread: openThread };
})();
