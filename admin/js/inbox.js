/* inbox.js — Gmail inbox shared component (admin inbox, VA inbox, lead-detail viewer).
 * v=2026072401
 *
 * Talks ONLY to the `gmail-inbox` edge function. The mailbox is resolved server-side
 * from the caller's JWT role (admin=rene@|processing@, va=processing@ only, else 403);
 * this UI merely avoids offering what would 403.
 *
 * SECURITY: email bodies (body_html) are rendered ONLY inside a sandboxed iframe via
 * srcdoc (no allow-scripts → scripts never execute), mirroring lpVoeEmailOpen. Raw HTML
 * is never injected into the page DOM. Every other field is HTML-escaped.
 */
(function () {
  'use strict';
  var FN = 'gmail-inbox';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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
      '.gm-reply{padding:12px 16px;border-top:1px solid var(--border,rgba(255,255,255,.1));background:#0d0d0d}',
      '.gm-reply textarea{width:100%;min-height:90px;background:#0a0a0a;border:1px solid var(--border2,rgba(255,255,255,.14));border-radius:8px;padding:10px;color:#fff;font-size:13px;font-family:inherit;resize:vertical;box-sizing:border-box}',
      '.gm-reply-bar{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}',
      '.gm-reply-to{font-size:12px;color:var(--muted,#999)}',
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
      '@media (min-width:769px) and (max-width:1199px){.gm-list{width:290px}}',
      '@media (max-width:768px){',
      '  .gm-inbox{height:auto;min-height:calc(100vh - 90px)}',
      '  .gm-list{width:100%}',
      '  .gm-body .gm-pane{display:none}',
      '  .gm-inbox.gm-show-pane .gm-list{display:none}',
      '  .gm-inbox.gm-show-pane .gm-pane{display:block}',
      '  .gm-back{display:inline-flex}',
      '  .gm-modal{padding:0}.gm-modal .gm-modal-card{width:100vw;max-width:100vw;height:100vh;border-radius:0}',
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
    var last = msgs[msgs.length - 1] || {};
    var replyTo = (last.direction === 'inbound' ? (last.from && last.from.email) : (last.to && last.to[0])) ||
      (msgs.find && (function () { var m = msgs.find(function (x) { return x.direction === 'inbound'; }); return m && m.from && m.from.email; })()) || '';

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

    // reply composer
    h.push('<div class="gm-reply">');
    h.push('<textarea data-gm="replytext" placeholder="Reply to this thread…"></textarea>');
    h.push('<div class="gm-reply-bar"><button class="gm-btn" data-gm="send">Send reply</button><span class="gm-reply-to">to ' + esc(replyTo || '—') + '</span></div>');
    h.push('</div>');

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
    wire('[data-gm="send"]', async function (e) {
      var ta = host.querySelector('[data-gm="replytext"]'); var txt = (ta && ta.value || '').trim();
      if (!txt) { toast('Write a reply first'); return; }
      if (!replyTo) { toast('No reply recipient found'); return; }
      e.target.disabled = true; e.target.textContent = 'Sending…';
      var bodyHtml = '<div>' + esc(txt).replace(/\n/g, '<br>') + '</div>';
      try {
        await invoke(cl, mailbox, 'send', { to: replyTo, subject: /^re:/i.test(subj) ? subj : 'Re: ' + subj, body_html: bodyHtml, thread_id: threadId });
        toast('Reply sent'); renderThread(host, ctx); // refresh
      } catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = 'Send reply'; }
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
