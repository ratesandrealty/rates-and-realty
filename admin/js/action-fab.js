/* ─────────────────────────────────────────────────────────────────────────────
   ONE floating action button, bottom-right, replacing the two that were there.

   Before this there were two independent position:fixed buttons stacked on top
   of each other — #tc-fab (task-capture.js, 📌, right:18px bottom:88px) and
   .sc-bubble-btn (staff-chat.js, right:20px bottom:20px). Both were mounted by
   auth-guard.js, neither knew about the other, and a third would have made it a
   column of unlabelled circles. This is one bubble that expands into a labelled
   vertical stack.

   ── IT DOES NOT REIMPLEMENT EITHER WIDGET ──────────────────────────────────
   Each action forwards to the ORIGINAL button by synthesising a click on it:

       document.querySelector(a.source).click()

   task-capture and staff-chat are untouched by this file. Their own buttons are
   still mounted and still wired to their own handlers — they are only hidden
   (display:none), never removed. So every code path inside those widgets is the
   one that was already there and already tested, and deleting this file
   restores the previous UI exactly.

   ── THE ROLE GATE IS INHERITED, NOT COPIED ─────────────────────────────────
   An action appears ONLY IF its source element is in the DOM. That is the whole
   gate, and it is deliberate: staff-chat.js already decides who gets a chat
   bubble (`if (!isStaff()) return` — admin/agent/va/loa), and task-capture.js
   already decides that everyone past auth-guard gets a pin. Re-deriving those
   rules here would create two sources of truth that drift the first time either
   widget changes its mind. Instead:

       no #staff-chat-bubble in the DOM  ->  no Chat row in the menu

   which is right by construction and can never disagree with the widget. It
   also handles the embedded case for free: chat.html and va-dashboard.html
   render chat into #staff-chat-fullpage and mount NO floating bubble, so on
   those pages the Chat row correctly does not appear — the chat is already on
   screen.

   ── ADDING A THIRD ACTION ──────────────────────────────────────────────────
   Add one entry to ACTIONS below. Nothing else. It needs a `source` selector
   pointing at an existing control; if that control is absent the row hides
   itself. (A Call action is deliberately NOT here yet — twilio-voice hardcodes
   identity 'rene_duarte', so a VA-placed call would attribute to Rene.)
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  if (window._actionFabLoaded) return;          // idempotent (auth-guard + any page loader)
  window._actionFabLoaded = true;

  var GOLD = '#C9A84C';

  /* Declarative registry. `source` is the ORIGINAL widget's button. */
  var ACTIONS = [
    {
      key: 'pin',
      label: 'Capture a task',
      source: '#tc-fab',
      hint: 'Ctrl+Shift+K',
      icon: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">'
          + '<path d="M9 4h6l-1 5 3.5 3.5H14v6l-2 2-2-2v-6H6.5L10 9 9 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    },
    {
      key: 'chat',
      label: 'Chat',
      source: '#staff-chat-bubble',
      icon: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">'
          + '<path d="M4 5h12a1 1 0 011 1v7a1 1 0 01-1 1H8l-4 3.5V14H4a1 1 0 01-1-1V6a1 1 0 011-1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
          + '<path d="M7 8.5h6M7 11h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
    }
  ];

  function available() {
    return ACTIONS.filter(function (a) { return !!document.querySelector(a.source); });
  }

  // ── styles ────────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('action-fab-css')) return;
    var s = document.createElement('style');
    s.id = 'action-fab-css';
    s.textContent = [
      /* The originals stay mounted and wired — hidden, never removed. Both
         selectors are !important because each widget sets its own inline/CSS
         sizing and we must win without editing either file. */
      '#tc-fab{display:none!important}',
      '.sc-bubble-btn{display:none!important}',

      '.af-wrap{position:fixed;right:20px;bottom:20px;z-index:95;display:flex;flex-direction:column;align-items:flex-end;gap:10px;font-family:inherit}',

      '.af-menu{display:flex;flex-direction:column;align-items:flex-end;gap:8px;margin:0;padding:0;list-style:none;pointer-events:none;opacity:0;transform:translateY(8px) scale(.96);transform-origin:bottom right;transition:opacity .16s ease,transform .16s cubic-bezier(.4,0,.2,1)}',
      '.af-wrap.is-open .af-menu{pointer-events:auto;opacity:1;transform:none}',

      '.af-item{display:flex;align-items:center;gap:9px;background:none;border:none;padding:0;cursor:pointer;font-family:inherit}',
      '.af-item-label{background:#15140f;border:1px solid rgba(201,168,76,.3);color:#e9e2cf;font-size:12.5px;font-weight:600;line-height:1;padding:8px 11px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.45);white-space:nowrap}',
      '.af-item-hint{color:#7d766a;font-weight:500;margin-left:7px;font-size:11px}',
      '.af-item-icon{width:42px;height:42px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(145deg,#1f1f1f 0%,#121212 100%);color:#e9e2cf;box-shadow:0 6px 18px rgba(0,0,0,.5),0 0 0 1.5px rgba(201,168,76,.42);transition:transform .13s ease,box-shadow .13s ease,color .13s ease}',
      '.af-item:hover .af-item-icon{transform:scale(1.06);color:' + GOLD + ';box-shadow:0 8px 22px rgba(0,0,0,.6),0 0 0 1.5px rgba(201,168,76,.9)}',
      '.af-item:hover .af-item-label{border-color:rgba(201,168,76,.6)}',
      '.af-item:active .af-item-icon{transform:scale(.97)}',
      '.af-item:focus-visible .af-item-icon{outline:2px solid ' + GOLD + ';outline-offset:3px}',

      /* Matches .sc-bubble-btn's geometry and finish exactly, so the corner looks
         unchanged apart from there now being one button instead of two. */
      '.af-fab{position:relative;width:56px;height:56px;flex:none;box-sizing:border-box;padding:0;line-height:0;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(145deg,#1f1f1f 0%,#121212 100%);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.5),0 0 0 1.5px rgba(201,168,76,.5),inset 0 1px 0 rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;transition:transform .18s cubic-bezier(.4,0,.2,1),box-shadow .15s ease}',
      '.af-fab:hover{transform:scale(1.05);box-shadow:0 12px 30px rgba(0,0,0,.6),0 0 0 1.5px rgba(201,168,76,.85),inset 0 1px 0 rgba(255,255,255,.06)}',
      '.af-fab:active{transform:scale(.97)}',
      '.af-fab:focus-visible{outline:2px solid ' + GOLD + ';outline-offset:3px}',
      '.af-fab>svg{pointer-events:none;transition:transform .18s cubic-bezier(.4,0,.2,1)}',
      '.af-wrap.is-open .af-fab>svg{transform:rotate(135deg)}',
      '.af-wrap.is-open .af-fab{box-shadow:0 12px 30px rgba(0,0,0,.6),0 0 0 1.5px rgba(201,168,76,.95),inset 0 1px 0 rgba(255,255,255,.06)}',

      /* Mirrors staff-chat's unread badge. Hiding .sc-bubble-btn would otherwise
         hide the only unread signal on every page that has one. */
      '.af-badge{position:absolute;top:-3px;right:-3px;min-width:19px;height:19px;padding:0 5px;border-radius:10px;background:#E5484D;color:#fff;font-size:10.5px;font-weight:800;display:none;align-items:center;justify-content:center;box-sizing:border-box;box-shadow:0 0 0 2px #0d0d0d,0 1px 4px rgba(0,0,0,.45)}',

      '@media(max-width:720px){.af-wrap{right:16px;bottom:16px}.af-fab{width:52px;height:52px}}',
      '@media(prefers-reduced-motion:reduce){.af-menu,.af-fab,.af-fab>svg,.af-item-icon{transition:none!important}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── build ─────────────────────────────────────────────────────────────────
  var wrap, fab, menu, badge, open = false;

  function render() {
    var list = available();
    /* No usable action -> no button at all, rather than a bubble that opens an
       empty menu. Re-checked on every widget mount (see watch() below). */
    wrap.style.display = list.length ? '' : 'none';
    menu.innerHTML = list.map(function (a) {
      return '<li><button type="button" class="af-item" data-af="' + a.key + '">'
        + '<span class="af-item-label">' + a.label
        + (a.hint ? '<span class="af-item-hint">' + a.hint + '</span>' : '')
        + '</span>'
        + '<span class="af-item-icon">' + a.icon + '</span>'
        + '</button></li>';
    }).join('');
  }

  function setOpen(v) {
    open = !!v;
    wrap.classList.toggle('is-open', open);
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) render();
  }

  function mount() {
    if (document.getElementById('action-fab')) return;
    injectCss();

    wrap = document.createElement('div');
    wrap.className = 'af-wrap';
    wrap.id = 'action-fab';

    menu = document.createElement('ul');
    menu.className = 'af-menu';
    menu.id = 'action-fab-menu';

    fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'af-fab';
    fab.id = 'action-fab-btn';
    fab.setAttribute('aria-label', 'Actions');
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-controls', 'action-fab-menu');
    fab.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">'
      + '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
      + '<span class="af-badge" id="action-fab-badge"></span>';

    wrap.appendChild(menu);
    wrap.appendChild(fab);
    document.body.appendChild(wrap);
    badge = document.getElementById('action-fab-badge');

    fab.addEventListener('click', function (e) { e.stopPropagation(); setOpen(!open); });

    /* One delegated listener for every row, present and future. */
    menu.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-af]') : null;
      if (!btn) return;
      var a = ACTIONS.filter(function (x) { return x.key === btn.getAttribute('data-af'); })[0];
      setOpen(false);
      if (!a) return;
      var src = document.querySelector(a.source);
      /* Forward to the ORIGINAL control. It is display:none, which does not stop
         a programmatic .click() from firing its handler. */
      if (src) src.click();
      else console.warn('[action-fab] source missing for', a.key, a.source);
    });

    document.addEventListener('click', function (e) {
      if (open && !wrap.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) { setOpen(false); fab.focus(); }
    });

    render();
    watch();
  }

  /* Both widgets are injected as <script> by auth-guard and mount whenever they
     finish loading — after this file, before it, or seconds later once
     staff-chat's supabase-client poll resolves. So the menu cannot be built once
     and trusted. Cheap re-checks catch every ordering. */
  function watch() {
    var tries = 0;
    var iv = setInterval(function () {
      render();
      mirrorBadge();
      if (++tries > 40) clearInterval(iv);          // ~20s, well past staff-chat's ~7s client cap
    }, 500);
    if (window.MutationObserver) {
      new MutationObserver(function () { render(); mirrorBadge(); })
        .observe(document.body, { childList: true });
    }
  }

  /* Copy staff-chat's unread count onto this FAB. Its own badge lives inside the
     hidden bubble, so without this the count would still update and nobody would
     ever see it. */
  function mirrorBadge() {
    if (!badge) return;
    var src = document.getElementById('staff-chat-badge');
    var n = src ? (src.textContent || '').trim() : '';
    var on = !!(src && n && src.style.display !== 'none');
    badge.textContent = on ? n : '';
    badge.style.display = on ? 'flex' : 'none';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
