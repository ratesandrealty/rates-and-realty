/* admin/js/rich-toolbar.js
   ONE rich-text toolbar for every contenteditable email surface in the CRM.

     var tb = window.RichToolbar.mount({
       target: 'emailEditor',          // the contenteditable (element or id)
       mount:  toolbarHostEl,          // where the row goes; default = before target
       slots:  [ { key:'canva', label:'✦ Canva', title:'Insert from Canva',
                   wide:1, accent:1, onClick: function (btn, api) { ... } } ]
     });
     tb.exec('bold');                  // same dispatcher the buttons use
     tb.destroy();                     // removes the document-level listener

   It replaced four divergent implementations - `tbCmd` in lead-detail.html,
   inbox.js's internal handler, settings.html's data-c delegate, and
   drip-builder's `fmtText`. Which side of each disagreement won is recorded in
   docs/TOOLBAR-CONSOLIDATION-DIVERGENCE-2026-08-20.md; the summary is:

     link URLs are VALIDATED (https/mailto/tel) and the prompt prefills https://
     every execCommand is in a try/catch - an uncaught throw abandons the handler
     focus() runs BEFORE and AFTER the command, or it applies to nothing
     fonts are named faces WITH a fallback stack, not generic families
     sizes are named on the legacy 1-7 scale, not point labels in the wrong order
     the dispatcher is (cmd, value) with an explicit target element

   FORMATTING IS THE UNION. INSERTS ARE NOT.
   Everything that changes the shape of text - B/I/U, lists, link, clear, font,
   size, colour, highlight, alignment, indent/outdent, quote - is a default here.
   Everything that puts foreign content IN - Canva, Loom, emoji, images, variable
   pickers - is a `slots` entry the host passes, because a signature has no
   variables and a drip step has no Loom recording.

   The component deliberately owns NO insert path and NO sanitizer. Hosts sanitize
   their own pasted and inserted HTML (inbox.js `sanitize`, settings `sigSanitize`);
   giving this file an insertHTML would mean giving it a default sanitizer, and a
   default sanitizer is the one nobody remembers to override.

   THE ROW WRAPS, ON PURPOSE. inbox.js kept a single non-wrapping row and pushed
   alignment, indent, quote and clear behind a "..." button - which is exactly why
   nobody could find them. Surfacing them costs a second line on a narrow
   composer; `row-gap` and a full-width row make that read as a toolbar rather
   than as the lone stray x that motivated the overflow in the first place.

   Class prefix is `rrt-`, NOT `rte-`: drip-builder.html already owns `.rte-toolbar`,
   `.rte-btn`, `.rte-divider` and `.rte-area`.
*/
(function () {
  'use strict';
  if (window.RichToolbar) return;

  /* -- fonts ----------------------------------------------------------------
   * fontName emits <font face="...">. A generic family ("sans-serif") in a face
   * attribute is resolved inconsistently by mail clients, so the VALUE is a full
   * stack and the LABEL is the face people recognise. */
  var FONTS = [
    ['Arial',           'Arial, Helvetica, sans-serif'],
    ['Georgia',         'Georgia, "Times New Roman", serif'],
    ['Times New Roman', '"Times New Roman", Times, serif'],
    ['Tahoma',          'Tahoma, Geneva, sans-serif'],
    ['Verdana',         'Verdana, Geneva, sans-serif'],
    ['Courier New',     '"Courier New", Courier, monospace']
  ];
  /* Legacy 1-7 scale, named. Point labels imply a precision the scale does not
   * have - value="4" is not 14px in any client, it is "one step above normal". */
  var SIZES = [['2', 'Small'], ['3', 'Normal'], ['5', 'Large'], ['6', 'Huge']];

  var LINK_OK = /^(https?:|mailto:|tel:)/i;

  // Commands whose emitted markup must be a style attribute rather than a <font>.
  var COLOUR_CMDS = { foreColor: 1, hiliteColor: 1, backColor: 1 };

  /* The formatting core, in row order. `sep` draws a divider. `state` is the
   * queryCommandState name used to light the button up. */
  var CORE = [
    { sel: 'font',  t: 'Font family for the selected text' },
    { sel: 'size',  t: 'Text size for the selected text' },
    { c: '_color',     l: '<span style="border-bottom:3px solid currentColor">A</span>', t: 'Text colour' },
    { c: '_highlight', l: '<span class="rrt-hl">A</span>', t: 'Highlight colour' },
    { sep: 1 },
    { c: 'bold',      l: '<b>B</b>', t: 'Bold (Ctrl+B)',      state: 'bold' },
    { c: 'italic',    l: '<i>I</i>', t: 'Italic (Ctrl+I)',    state: 'italic' },
    { c: 'underline', l: '<u>U</u>', t: 'Underline (Ctrl+U)', state: 'underline' },
    { sep: 1 },
    { c: 'insertUnorderedList', l: '&bull;', t: 'Bulleted list', state: 'insertUnorderedList' },
    { c: 'insertOrderedList',   l: '1.',     t: 'Numbered list', state: 'insertOrderedList' },
    { sep: 1 },
    /* Surfaced, not buried. These four were the "..." overflow in inbox.js. */
    { c: 'justifyLeft',   l: '&#8801;',  t: 'Align left',   state: 'justifyLeft' },
    { c: 'justifyCenter', l: '&#8803;',  t: 'Align centre', state: 'justifyCenter' },
    { c: 'justifyRight',  l: '&#8802;',  t: 'Align right',  state: 'justifyRight' },
    { c: 'outdent',       l: '&#8676;',  t: 'Decrease indent' },
    { c: 'indent',        l: '&#8677;',  t: 'Increase indent' },
    { sep: 1 },
    { c: 'formatBlock:blockquote', l: '&#8220;', t: 'Quote' },
    { c: '_link',        l: '&#128279;', t: 'Insert a hyperlink (Ctrl+K)' },
    { c: 'removeFormat', l: '&#10005;',  t: 'Clear formatting' }
  ];

  // -- styles -----------------------------------------------------------------
  /* Themed through CSS variables so each host keeps its own palette without a
   * second stylesheet. Defaults are the dark CRM chrome. */
  var CSS = [
    '.rrt-tb{',
    '  --rrt-fg:#bbb; --rrt-fg-hi:#fff; --rrt-bd:rgba(255,255,255,.14);',
    '  --rrt-hover:rgba(255,255,255,.08); --rrt-accent:#c9a84c; --rrt-input-bg:#0d0d0d;',
    '  display:flex; flex-wrap:wrap; align-items:center; gap:1px; row-gap:3px;',
    '  padding:5px 12px; box-sizing:border-box; flex-shrink:0 }',
    '.rrt-tb button{min-width:30px;height:30px;border-radius:6px;border:1px solid transparent;',
    '  background:transparent;color:var(--rrt-fg);cursor:pointer;font-size:13px;font-family:inherit;',
    '  display:inline-flex;align-items:center;justify-content:center;padding:0 6px;line-height:1}',
    '.rrt-tb button:hover{background:var(--rrt-hover);color:var(--rrt-fg-hi)}',
    /* .on, not .active: settings.html and drip-builder both already style .active. */
    '.rrt-tb button.on{color:var(--rrt-accent);background:rgba(201,168,76,.10);border-color:rgba(201,168,76,.28)}',
    '.rrt-tb button.wide{min-width:auto;padding:0 10px;font-size:11.5px;font-weight:700}',
    '.rrt-tb button.accent{background:rgba(201,168,76,.13);border-color:rgba(201,168,76,.42);',
    '  color:var(--rrt-accent);gap:4px}',
    '.rrt-tb button.accent:hover{background:rgba(201,168,76,.24);color:#fff}',
    '.rrt-tb select{height:30px;background:var(--rrt-input-bg);color:var(--rrt-fg);',
    '  border:1px solid var(--rrt-bd);border-radius:6px;font-size:11.5px;font-family:inherit;',
    '  padding:0 4px;max-width:112px;cursor:pointer}',
    '.rrt-tb select:hover{color:var(--rrt-fg-hi)}',
    '.rrt-tb .rrt-sep{width:1px;height:18px;background:var(--rrt-bd);margin:0 5px;flex-shrink:0}',
    '.rrt-tb .rrt-gap{flex:1 1 0;min-width:0}',
    /* The highlight glyph has to LOOK highlighted; a bare A is indistinguishable
     * from the text-colour button beside it. */
    '.rrt-hl{background:#ffe14d;color:#111;border-radius:2px;padding:0 3px;font-weight:600}',
    '@media (max-width:640px){.rrt-tb{padding:5px 8px}.rrt-tb select{max-width:88px}}'
  ].join('\n');

  function installCss() {
    if (document.getElementById('rrt-css')) return;
    var s = document.createElement('style');
    s.id = 'rrt-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function el(x) { return typeof x === 'string' ? document.getElementById(x) : x; }

  /* -- selection -------------------------------------------------------------
   * prompt(), <input type=color> and any popover the host opens all blur the
   * editor. Chrome usually restores a contenteditable's selection on refocus and
   * usually is not good enough for a command that silently applies to nothing -
   * so the range is captured before the UI opens and put back afterwards. */
  function saveRange(target) {
    try {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      var r = sel.getRangeAt(0);
      return target.contains(r.commonAncestorContainer) ? r.cloneRange() : null;
    } catch (_) { return null; }
  }
  function restoreRange(target, r) {
    target.focus();
    if (!r) return;
    try {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (_) {}
  }

  /* -- the dispatcher - (cmd, value) against an explicit target -------------- */
  function exec(target, cmd, value) {
    target = el(target);
    if (!target) return false;

    target.focus();                                   // BEFORE: or the click's own
                                                      // focus change collapses the
                                                      // selection and this applies
                                                      // to nothing.
    var isColour = !!COLOUR_CMDS[cmd];
    var prevCss = null;

    /* styleWithCSS is turned on for the COLOUR COMMANDS ONLY, then put back.
     * Globally it would change what bold and underline emit - <span
     * style="font-weight:700"> instead of <b> - across every email this CRM
     * sends, and <b>/<u> are the better-supported forms in mail. */
    if (isColour) {
      try { prevCss = document.queryCommandState('styleWithCSS'); } catch (_) { prevCss = null; }
      try { document.execCommand('styleWithCSS', false, true); } catch (_) {}
    }

    var ok = false;
    try {
      if (cmd.indexOf('formatBlock:') === 0) {
        ok = document.execCommand('formatBlock', false, cmd.slice('formatBlock:'.length));
      } else {
        ok = document.execCommand(cmd, false, value == null ? null : value);
      }
      /* hiliteColor is unimplemented in a few engines, which report false rather
       * than throwing; backColor is the same effect under a different name. */
      if (!ok && cmd === 'hiliteColor') {
        ok = document.execCommand('backColor', false, value == null ? null : value);
      }
    } catch (_) {
      ok = false;                                     // an uncaught throw here would
                                                      // abandon the rest of the click
                                                      // handler, including the restore
                                                      // below.
    }

    if (isColour && prevCss !== null) {
      try { document.execCommand('styleWithCSS', false, !!prevCss); } catch (_) {}
    }
    target.focus();                                   // AFTER: the caret goes back to
    return ok;                                        // the body, ready to keep typing.
  }

  // -- mount ------------------------------------------------------------------
  function mount(opts) {
    opts = opts || {};
    var target = el(opts.target);
    if (!target) return null;
    installCss();

    var host = el(opts.mount);
    var row = document.createElement('div');
    row.className = 'rrt-tb' + (opts.className ? ' ' + opts.className : '');
    if (opts.style) row.setAttribute('style', opts.style);

    var slots = opts.slots || [];
    var items = CORE.slice();
    if (slots.length) {
      // Inserts sit to the RIGHT of the formatting core, pushed over by a spacer,
      // so the row reads as "shape the text ... | ... add something to it".
      items.push({ gap: 1 });
      slots.forEach(function (s, i) {
        items.push({ c: '__slot' + i, l: s.label, t: s.title || s.label,
                     wide: s.wide, accent: s.accent });
      });
    }

    row.innerHTML = items.map(function (t) {
      if (t.sep) return '<span class="rrt-sep"></span>';
      if (t.gap) return '<span class="rrt-gap"></span>';
      if (t.sel === 'font') {
        return '<select data-rrt-sel="font" title="' + esc(t.t) + '" aria-label="Font">' +
          FONTS.map(function (f) {
            return '<option value="' + esc(f[1]) + '">' + esc(f[0]) + '</option>';
          }).join('') + '</select>';
      }
      if (t.sel === 'size') {
        return '<select data-rrt-sel="size" title="' + esc(t.t) + '" aria-label="Size">' +
          SIZES.map(function (s) {
            return '<option value="' + s[0] + '"' + (s[0] === '3' ? ' selected' : '') + '>' + s[1] + '</option>';
          }).join('') + '</select>';
      }
      var cls = [t.wide ? 'wide' : '', t.accent ? 'accent' : ''].filter(Boolean).join(' ');
      return '<button type="button"' + (cls ? ' class="' + cls + '"' : '') +
        ' data-rrt-c="' + esc(t.c) + '" title="' + esc(t.t) + '" aria-label="' + esc(t.t) + '">' +
        t.l + '</button>';
    }).join('');

    if (host) host.appendChild(row);
    else target.parentNode.insertBefore(row, target);

    var api = {
      el: row,
      target: target,
      exec: function (cmd, value) { return exec(target, cmd, value); },
      destroy: function () { destroy(); }
    };

    // -- selects --------------------------------------------------------------
    var fontSel = row.querySelector('select[data-rrt-sel="font"]');
    var sizeSel = row.querySelector('select[data-rrt-sel="size"]');

    Array.prototype.forEach.call(row.querySelectorAll('select[data-rrt-sel]'), function (s) {
      s.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      s.addEventListener('change', function () {
        exec(target, s.getAttribute('data-rrt-sel') === 'font' ? 'fontName' : 'fontSize', s.value);
      });
    });

    /* Reflect the caret's real state rather than snapping the controls back to a
     * placeholder. queryCommandValue('fontName') comes back quoted and sometimes
     * as a whole stack, so both sides are compared on the first family name. */
    function syncState() {
      // selectionchange is document-level but this toolbar is per-composer, so it
      // self-detaches once its editor is gone - otherwise every reopen leaks one.
      if (!target.isConnected) { destroy(); return; }
      if (document.activeElement !== target && !target.contains(document.activeElement)) return;
      try {
        if (fontSel) {
          var fn = String(document.queryCommandValue('fontName') || '').replace(/['"]/g, '');
          var first = fn.split(',')[0].trim().toLowerCase();
          for (var i = 0; i < fontSel.options.length; i++) {
            if (fontSel.options[i].value.split(',')[0].replace(/['"]/g, '').trim().toLowerCase() === first) {
              fontSel.selectedIndex = i; break;
            }
          }
        }
        if (sizeSel) {
          var fs = String(document.queryCommandValue('fontSize') || '');
          for (var j = 0; j < sizeSel.options.length; j++) {
            if (sizeSel.options[j].value === fs) { sizeSel.selectedIndex = j; break; }
          }
        }
      } catch (_) {}
      CORE.forEach(function (t) {
        if (!t.state) return;
        var b = row.querySelector('[data-rrt-c="' + t.c + '"]');
        if (!b) return;
        var on = false;
        try { on = document.queryCommandState(t.state); } catch (_) {}
        b.classList.toggle('on', !!on);
      });
    }
    document.addEventListener('selectionchange', syncState);
    target.addEventListener('keyup', syncState);
    target.addEventListener('mouseup', syncState);

    // -- colour pickers -------------------------------------------------------
    function pickColour(cmd, initial) {
      var saved = saveRange(target);
      var picker = document.createElement('input');
      picker.type = 'color';
      picker.value = initial;
      picker.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(picker);
      picker.addEventListener('change', function () {
        restoreRange(target, saved);
        exec(target, cmd, picker.value);
        if (picker.parentNode) picker.remove();
      });
      picker.click();
    }

    // -- buttons --------------------------------------------------------------
    Array.prototype.forEach.call(row.querySelectorAll('button[data-rrt-c]'), function (b) {
      // mousedown+preventDefault keeps the caret where it is; focus() in exec()
      // is the belt to this pair of braces.
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        var cmd = b.getAttribute('data-rrt-c');

        if (cmd.indexOf('__slot') === 0) {
          var s = slots[+cmd.slice(6)];
          if (s && s.onClick) s.onClick(b, api);
          return;
        }

        if (cmd === '_link') {
          var saved = saveRange(target);
          var url = window.prompt('Link URL:', 'https://');
          if (!url) return;
          url = url.trim();
          /* Two of the four toolbars this replaced put whatever was typed straight
           * into an href, javascript: included. Nothing renders it - DOMPurify
           * strips the scheme on display - but the send path sanitizes nothing,
           * so the address really does go out carrying it. */
          if (!LINK_OK.test(url)) {
            (opts.notify || window.alert)('Only http, https, mailto and tel links are allowed.');
            return;
          }
          restoreRange(target, saved);
          exec(target, 'createLink', url);
          return;
        }

        if (cmd === '_color')     { pickColour('foreColor', '#1a6fb5'); return; }
        if (cmd === '_highlight') { pickColour('hiliteColor', '#ffe14d'); return; }

        exec(target, cmd);
        syncState();
      });
    });

    // Ctrl/Cmd+K is the universal "insert link" and every one of the four surfaces
    // advertised it in a tooltip while only inbox.js bound it.
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        var lb = row.querySelector('[data-rrt-c="_link"]');
        if (lb) lb.click();
      }
    }
    target.addEventListener('keydown', onKey);

    var dead = false;
    function destroy() {
      if (dead) return;
      dead = true;
      document.removeEventListener('selectionchange', syncState);
      target.removeEventListener('keyup', syncState);
      target.removeEventListener('mouseup', syncState);
      target.removeEventListener('keydown', onKey);
      if (row.parentNode) row.parentNode.removeChild(row);
    }

    return api;
  }

  window.RichToolbar = { mount: mount, exec: exec, FONTS: FONTS, SIZES: SIZES };
})();
