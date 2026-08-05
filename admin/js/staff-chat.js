/* admin/js/staff-chat.js
   Staff-to-staff chat. Renders a floating "Chat" bubble + compact panel (beside
   the AI FAB), and a full two-pane view when a #staff-chat-fullpage container is
   present (admin/chat.html). Uses the session-aware Supabase client and realtime.

   Backend contract (all live RPCs):
     staff_threads_list()                         -> [{thread_id,is_group,title,last_message_at,last_message,last_sender,unread,others}]
     staff_thread_messages(p_thread, p_limit=50)  -> [{id,sender_user_id,sender_email,body,created_at,mine}]  (NEWEST FIRST)
     staff_message_send(p_thread, p_body)         -> message (fires notifications)
     staff_thread_mark_read(p_thread)             -> void
     staff_chat_contacts()                        -> [{user_id,email,role}]
     staff_dm_open(p_other)                        -> thread_id
   Realtime: public.staff_messages INSERT, filter thread_id=eq.<id>.
*/
(function () {
  'use strict';
  if (window._staffChatLoaded) return;          // idempotent (page + any global loader)
  window._staffChatLoaded = true;

  var STAFF_ROLES = ['admin', 'agent', 'va', 'loa'];
  function role() { return (sessionStorage.getItem('rnr_app_role') || '').toLowerCase(); }
  function isStaff() { var r = role(); return !r || STAFF_ROLES.indexOf(r) >= 0; }  // empty = not resolved yet → allow

  var _sb = null, _threads = [], _active = null, _msgs = [], _channel = null;
  var _open = false, _mode = 'floating', _pollId = null, _lastBadge = 0;   // _mode: 'floating' | 'full' | 'column'
  var _pending = [], _signed = {}, _pidSeq = 0, _rec = null;               // staged attachments, signed-URL cache, recorder state
  // ── CRM Copilot (relocated from layout.js so the combined bubble is app-wide) ──
  var _tab = 'chat';                                                        // active panel tab: 'chat' | 'copilot'
  var _copHistory = [], _copBusy = false, _copActions = {}, _copActionSeq = 0, _copConvoDate = null;
  var COP_CHIPS = ["Who should I work today?", "How's my pipeline?", "Who's gone stale?", "Summarize [lead name]"];
  var COP_CONVO_KEY = 'rnr_copilot_convo', COP_MAX_MSGS = 50;               // sessionStorage: persist until logoff
  var COP_EXPANDED_KEY = 'rnr_combo_expanded';                              // localStorage: large vs normal panel size
  function copAllowed() { return role() !== 'va'; }                        // copilot backend is admin/agent/loa-gated

  function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function localPart(email) { return ((email || '').split('@')[0]) || 'Staff'; }
  function rel(iso) {
    if (!iso) return ''; var t = new Date(iso).getTime(); if (!isFinite(t)) return '';
    var d = Math.max(0, (Date.now() - t) / 1000);
    if (d < 60) return 'now'; if (d < 3600) return Math.floor(d / 60) + 'm';
    if (d < 86400) return Math.floor(d / 3600) + 'h'; if (d < 604800) return Math.floor(d / 86400) + 'd';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function nameOf(t) {
    if (t.title) return t.title;
    var o = t.others || [];
    if (o.length === 1) return localPart(o[0].email);
    if (o.length > 1) return o.map(function (x) { return localPart(x.email); }).join(', ');
    return 'Conversation';
  }

  // ── data ────────────────────────────────────────────────────────────────
  // Session-aware client: prefer the canonical getter; fall back to the one
  // auth-guard publishes (some admin pages only expose window._supabaseClient).
  async function client() {
    if (_sb) return _sb;
    if (typeof window.getSupabaseClient === 'function') { _sb = await window.getSupabaseClient(); }
    else if (window._supabaseClient) { _sb = window._supabaseClient; }
    return _sb;
  }
  async function rpc(fn, args) { var sb = await client(); var r = await sb.rpc(fn, args || {}); if (r && r.error) throw r.error; return r ? r.data : null; }

  async function loadThreads() {
    try { _threads = await rpc('staff_threads_list') || []; }
    catch (e) { console.warn('[staff-chat] threads:', e && e.message); _threads = []; }
    renderThreads(); renderBadge();
  }
  async function reloadActive() {
    if (!_active) return;
    try { var rows = await rpc('staff_thread_messages', { p_thread: _active, p_limit: 50 }) || []; _msgs = rows.slice().reverse(); renderMessages(); }
    catch (e) { console.warn('[staff-chat] messages:', e && e.message); }
  }
  async function openThread(id) {
    _active = id;
    await reloadActive();
    subscribe(id);
    try { await rpc('staff_thread_mark_read', { p_thread: id }); } catch (_) {}
    loadThreads();                                // refresh unread counts
    showConversation();
  }
  async function send() {
    var inp = document.getElementById('sc-input');
    var body = inp ? inp.value.trim() : '';
    if (!_active) return;
    if (anyUploading()) { scToast('Waiting for upload…'); return; }
    var atts = _pending.filter(function (p) { return !p._error && p.storage_path; })
      .map(function (p) { return { storage_path: p.storage_path, file_name: p.file_name, mime_type: p.mime_type, size_bytes: p.size_bytes, kind: p.kind }; });
    if (!body && !atts.length) return;              // nothing to send
    try {
      var row = await rpc('staff_message_send', { p_thread: _active, p_body: body, p_attachments: atts });
      if (inp) inp.value = '';
      _pending = []; renderTray(); updateSendState();
      // Optimistic: render our own message WITH the attachments we just uploaded, so the
      // sender's bubble matches the recipient's immediately — independent of re-fetch/echo
      // timing. reloadActive() then reconciles (it also returns attachments).
      if (row && row.id && !_msgs.some(function (x) { return x.id === row.id; })) {
        _msgs.push({ id: row.id, sender_user_id: row.sender_user_id || null, sender_email: null, body: body, created_at: row.created_at || new Date().toISOString(), mine: true, attachments: atts });
        renderMessages();
      }
      await rpc('staff_thread_mark_read', { p_thread: _active });
      reloadActive(); loadThreads();
    } catch (e) { console.warn('[staff-chat] send:', e && e.message); scToast('Message failed to send'); }
  }
  async function openDm(userId) {
    try { var tid = await rpc('staff_dm_open', { p_other: userId }); await loadThreads(); openThread(tid); if (_mode === 'floating') setOpen(true); }
    catch (e) { console.warn('[staff-chat] dm:', e && e.message); }
  }
  // Embedded column (va-dashboard): auto-open the admin (Rene) DM so the composer
  // is an instant "note to Rene".
  async function autoOpenAdmin() {
    try {
      var contacts = await rpc('staff_chat_contacts') || [];
      var admin = contacts.filter(function (c) { return (c.role || '').toLowerCase() === 'admin'; })[0]
        || contacts.filter(function (c) { return (c.email || '').toLowerCase().indexOf('rene') === 0; })[0];
      if (admin) await openDm(admin.user_id);
    } catch (e) { console.warn('[staff-chat] autoOpenAdmin:', e && e.message); }
  }

  // ── realtime (per open thread) + background unread poll ───────────────────
  async function subscribe(threadId) {
    var sb = await client();
    if (_channel) { try { sb.removeChannel(_channel); } catch (_) {} _channel = null; }
    _channel = sb.channel('staff-chat-' + threadId)
      /* '*' not 'INSERT'. A soft delete is an UPDATE, so an INSERT-only
         subscription would leave the message sitting on the other person's
         screen until they switched threads or reloaded — and "removes it for
         everyone" was the explicit decision. The 25s poll below only refreshes
         the thread LIST, not the open message list, so it would not have
         covered this either. */
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'staff_messages', filter: 'thread_id=eq.' + threadId },
        function () {
          if (_active === threadId) { reloadActive(); rpc('staff_thread_mark_read', { p_thread: threadId }).catch(function () {}); }
          loadThreads();
        })
      .subscribe();
  }
  function startPoll() {
    if (_pollId) return;
    _pollId = setInterval(function () { if (document.visibilityState !== 'hidden') loadThreads(); }, 25000);
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function totalUnread() { return _threads.reduce(function (s, t) { return s + (Number(t.unread) || 0); }, 0); }
  function renderBadge() {
    var n = totalUnread(), b = document.getElementById('staff-chat-badge');
    if (b) {
      if (n > 0) {
        b.textContent = n > 99 ? '99+' : String(n); b.style.display = 'flex';
        if (n !== _lastBadge) { b.classList.remove('sc-pop'); void b.offsetWidth; b.classList.add('sc-pop'); }  // subtle pop on change
      } else b.style.display = 'none';
    }
    _lastBadge = n;
    var fb = document.getElementById('sc-full-unread'); if (fb) fb.textContent = n > 0 ? ('· ' + n + ' unread') : '';
  }
  function threadRowsHtml() {
    if (!_threads.length) return '<div class="sc-empty">No conversations yet.<br>Tap ＋ to start one.</div>';
    return _threads.map(function (t) {
      var unread = Number(t.unread) || 0, active = t.thread_id === _active;
      return '<div class="sc-thread' + (active ? ' is-active' : '') + '" data-sc-thread="' + esc(t.thread_id) + '">'
        + '<div class="sc-thread-top"><span class="sc-thread-name">' + esc(nameOf(t)) + '</span><span class="sc-thread-time">' + esc(rel(t.last_message_at)) + '</span></div>'
        + '<div class="sc-thread-bot"><span class="sc-thread-last">' + esc(t.last_message || '') + '</span>'
        + (unread > 0 ? '<span class="sc-thread-unread">' + (unread > 99 ? '99+' : unread) + '</span>' : '') + '</div>'
        + '</div>';
    }).join('');
  }
  function renderThreads() {
    ['sc-thread-list', 'sc-full-threads'].forEach(function (id) { var h = document.getElementById(id); if (h) h.innerHTML = threadRowsHtml(); });
  }
  function messagesHtml() {
    if (!_active) return '<div class="sc-empty">Select a conversation.</div>';
    if (!_msgs.length) return '<div class="sc-empty">No messages yet — say hi 👋</div>';
    return _msgs.map(function (m) {
      var mine = !!m.mine;

      /* TOMBSTONE. A deleted message keeps its place rather than vanishing: a
         thread that silently loses messages leaves the other person reading a
         conversation with holes in it. The server already blanked the body and
         attachments, so there is nothing here to leak — only the fact that
         something was removed. No deleter name: one shared login means naming
         it would add nothing true. */
      if (m.is_deleted) {
        return '<div class="sc-msg' + (mine ? ' mine' : '') + ' sc-msg-deleted">'
          + (mine ? '' : '<div class="sc-msg-who">' + esc(localPart(m.sender_email)) + '</div>')
          + '<div class="sc-msgbubble sc-tombstone">message deleted</div>'
          + '<div class="sc-msg-time">' + esc(rel(m.created_at)) + '</div></div>';
      }

      var atts = Array.isArray(m.attachments) ? m.attachments : [];
      var bodyHtml = m.body ? '<div class="sc-msgbubble">' + esc(m.body) + '</div>' : '';
      var attHtml = atts.length ? '<div class="sc-att-wrap">' + atts.map(attPlaceholderHtml).join('') + '</div>' : '';
      /* Delete is offered only on the admin's OWN messages. The button is a
         convenience, not the control — staff_message_delete() raises 'admin
         only' regardless of what the page renders. */
      var canDelete = mine && role() === 'admin';
      var menuHtml = canDelete
        ? '<button type="button" class="sc-msg-menu" data-sc-del="' + esc(m.id) + '" title="Delete message" aria-label="Delete message">⋯</button>'
        : '';
      return '<div class="sc-msg' + (mine ? ' mine' : '') + '">'
        + (mine ? '' : '<div class="sc-msg-who">' + esc(localPart(m.sender_email)) + '</div>')
        + menuHtml + bodyHtml + attHtml
        + '<div class="sc-msg-time">' + esc(rel(m.created_at)) + '</div></div>';
    }).join('');
  }

  /* Delete is destructive from the other person's point of view — it removes the
     message from THEIR view too — so it asks first. */
  async function deleteMessage(id) {
    if (!window.confirm('Delete this message for everyone? It will show as "message deleted".')) return;
    try {
      await rpc('staff_message_delete', { p_id: id });
      await reloadActive();
      loadThreads();
    } catch (e) {
      var msg = (e && (e.message || e.hint)) || 'Delete failed';
      scToast('Could not delete: ' + msg);
      console.warn('[staff-chat] delete failed:', e);
    }
  }
  function renderMessages() {
    ['sc-messages', 'sc-full-messages'].forEach(function (id) { var h = document.getElementById(id); if (h) { h.innerHTML = messagesHtml(); h.scrollTop = h.scrollHeight; } });
    hydrateAttachments();                            // lazily resolve signed URLs for any attachments
    var t = _threads.filter(function (x) { return x.thread_id === _active; })[0];
    var title = t ? nameOf(t) : (_mode === 'full' ? 'Select a conversation' : '');
    ['sc-conv-title', 'sc-full-conv-title'].forEach(function (id) { var h = document.getElementById(id); if (h) h.textContent = title; });
  }

  function showConversation() { if (_mode === 'full') return; var lv = document.getElementById('sc-list-view'), cv = document.getElementById('sc-conv-view'); if (lv) lv.style.display = 'none'; if (cv) cv.style.display = 'flex'; var i = document.getElementById('sc-input'); if (i) setTimeout(function () { i.focus(); }, 30); }
  function showList() { if (_mode === 'full') return; var lv = document.getElementById('sc-list-view'), cv = document.getElementById('sc-conv-view'); if (lv) lv.style.display = 'flex'; if (cv) cv.style.display = 'none'; }
  function setOpen(v) {
    _open = v; var p = document.getElementById('staff-chat-panel'); if (p) p.classList.toggle('is-open', v);
    if (v) {
      showList(); loadThreads();
      var saved = 'chat';
      try { saved = localStorage.getItem('rnr_combo_tab') || 'chat'; } catch (e) {}
      scSetTab(saved);                               // restore last-used tab (default chat)
    }
  }

  // ── new-chat picker ─────────────────────────────────────────────────────
  async function showNewChat() {
    var contacts = []; try { contacts = await rpc('staff_chat_contacts') || []; } catch (e) { console.warn('[staff-chat] contacts:', e && e.message); }
    var listHtml = contacts.length
      ? contacts.map(function (c) { return '<button class="sc-contact" data-sc-user="' + esc(c.user_id) + '"><span class="sc-contact-name">' + esc(localPart(c.email)) + '</span><span class="sc-contact-role">' + esc(c.role || '') + '</span></button>'; }).join('')
      : '<div class="sc-empty">No staff available to message.</div>';
    var ov = document.createElement('div'); ov.className = 'sc-newchat-ov';
    ov.innerHTML = '<div class="sc-newchat"><div class="sc-newchat-head"><span>New chat</span><button class="sc-icon" data-sc-x>✕</button></div><div class="sc-newchat-list">' + listHtml + '</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.closest('[data-sc-x]')) { ov.remove(); return; }
      var c = e.target.closest('[data-sc-user]'); if (c) { ov.remove(); openDm(c.getAttribute('data-sc-user')); }
    });
  }

  // ── composer (shared by all three mounts) ────────────────────────────────
  function composerHtml() {
    return '<div class="sc-composer-wrap">'
      + '<div id="sc-attach-tray" class="sc-attach-tray"></div>'
      + '<div class="sc-composer">'
      + '<input type="file" id="sc-file" multiple style="display:none">'
      + '<button type="button" class="sc-cbtn" data-sc-attach title="Attach file" aria-label="Attach file">📎</button>'
      + '<button type="button" class="sc-cbtn" data-sc-record title="Record video / screen" aria-label="Record">🎥</button>'
      + '<input id="sc-input" type="text" placeholder="Message…" autocomplete="off">'
      + '<button class="sc-send" data-sc-send>Send</button>'
      + '</div></div>';
  }

  // ── attachments: upload / stage / signed-URL render ───────────────────────
  var MAX_BYTES = 100 * 1024 * 1024;
  function safeName(n) { return (String(n || 'file').replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(0, 120)) || 'file'; }
  function kindOf(mime) {
    var m = (mime || '').toLowerCase();
    if (m.indexOf('image/') === 0) return 'image';
    if (m.indexOf('video/') === 0) return 'video';
    if (m.indexOf('audio/') === 0) return 'audio';
    return 'file';
  }
  function humanSize(b) {
    b = Number(b) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  function scToast(msg) {
    var t = document.createElement('div'); t.className = 'sc-toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 3200);
  }
  function anyUploading() { return _pending.some(function (p) { return p._uploading; }); }
  function updateSendState() { var b = document.querySelector('[data-sc-send]'); if (b) b.disabled = anyUploading(); }
  function renderTray() {
    var tray = document.getElementById('sc-attach-tray'); if (!tray) return;
    if (!_pending.length) { tray.innerHTML = ''; tray.style.display = 'none'; return; }
    tray.style.display = 'flex';
    tray.innerHTML = _pending.map(function (p) {
      var icon = p._uploading ? '<span class="sc-spin"></span>' : (p._error ? '⚠' : '📎');
      return '<div class="sc-tray-item' + (p._error ? ' is-error' : '') + '">'
        + '<span class="sc-tray-ic">' + icon + '</span>'
        + '<span class="sc-tray-name">' + esc(p.file_name) + '</span>'
        + '<span class="sc-tray-size">' + esc(humanSize(p.size_bytes)) + '</span>'
        + '<button type="button" class="sc-tray-x" data-sc-tray-remove="' + esc(p._id) + '" title="Remove">✕</button>'
        + '</div>';
    }).join('');
  }
  function removePending(id) { _pending = _pending.filter(function (p) { return p._id !== id; }); renderTray(); updateSendState(); }
  async function stageFile(file, forcedKind) {
    if (!_active) { scToast('Open a conversation first'); return; }
    if (file.size > MAX_BYTES) { scToast('“' + file.name + '” is over 100 MB'); return; }
    var item = {
      _id: 'p' + (++_pidSeq), _uploading: true, _error: false, storage_path: null,
      file_name: file.name || 'file', mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size, kind: forcedKind || kindOf(file.type)
    };
    _pending.push(item); renderTray(); updateSendState();
    try {
      var sb = await client();
      var path = _active + '/' + crypto.randomUUID() + '-' + safeName(file.name);
      var up = await sb.storage.from('chat-attachments').upload(path, file, { contentType: item.mime_type, upsert: false });
      if (up.error) throw up.error;
      item.storage_path = path; item._uploading = false;
    } catch (e) {
      item._uploading = false; item._error = true;
      scToast('Upload failed: ' + ((e && e.message) || 'error'));
    }
    renderTray(); updateSendState();
  }
  function handleFiles(list) { Array.prototype.slice.call(list || []).forEach(function (f) { stageFile(f); }); }

  function signedUrl(path) {
    var now = Date.now(), c = _signed[path];
    if (c && c.exp > now) return Promise.resolve(c.url);
    return client().then(function (sb) {
      return sb.storage.from('chat-attachments').createSignedUrl(path, 3600).then(function (r) {
        if (r.error || !r.data) throw (r.error || new Error('sign failed'));
        _signed[path] = { url: r.data.signedUrl, exp: now + 55 * 60000 };
        return r.data.signedUrl;
      });
    });
  }
  // Real file download (works cross-origin, keeps the original file name): sign →
  // fetch → blob → <a download>. Falls back to opening the signed URL in a new tab.
  async function downloadAttachment(path, name) {
    if (!path) return;
    try {
      var url = await signedUrl(path);
      var res = await fetch(url); if (!res.ok) throw new Error('http ' + res.status);
      var blob = await res.blob();
      var obj = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = obj; a.download = name || 'download';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(obj); } catch (_) {} }, 5000);
    } catch (e) {
      try { var u = await signedUrl(path); window.open(u, '_blank', 'noopener'); scToast('Opened in a new tab (direct download blocked)'); }
      catch (_) { scToast('Could not download attachment'); }
    }
  }
  /* FOUR ways out, because any one missing strands somebody:
   *   1. an X button that is always visible and touch-sized (44px) — the old
   *      one was a 15px #888 glyph on a near-black backdrop, styled with the
   *      generic .sc-icon class shared with 12px inline controls
   *   2. clicking the backdrop — the old handler only fired when the click
   *      target WAS .sc-light-ov, but .sc-light-body fills the whole area below
   *      the bar, so every click on the dark surround hit the body div instead
   *      and did nothing
   *   3. Escape, which did not exist at all
   *   4. Browser Back is NOT required and must not be: nothing here touches
   *      history, so Back would leave the page entirely
   *
   * Matches the email attachment viewer's exit semantics deliberately
   * (inbox.js openAttachmentViewer: X, capture-phase Escape, backdrop). The two
   * cannot share code today — see the note on _scLightKey. */
  var _scLightKey = null;

  function openLightbox(path, name, kind) {
    signedUrl(path).then(function (url) {
      closeLightbox();                       // never stack two
      var k = kind || 'image';
      var media = k === 'video' || k === 'recording'
        ? '<video src="' + esc(url) + '" controls autoplay playsinline></video>'
        : k === 'audio'
          ? '<audio src="' + esc(url) + '" controls autoplay></audio>'
          : '<img src="' + esc(url) + '" alt="' + esc(name || '') + '">';
      var ov = document.createElement('div'); ov.className = 'sc-light-ov'; ov.id = 'sc-light-ov';
      ov.innerHTML = '<div class="sc-light-bar"><span class="sc-light-name">' + esc(name || '') + '</span>'
        + '<button type="button" class="sc-light-dl" data-sc-download="' + esc(path) + '" data-name="' + esc(name || 'file') + '">⬇ Download</button>'
        + '<button type="button" class="sc-light-x" data-sc-light-close aria-label="Close">✕</button></div>'
        + '<div class="sc-light-body">' + media + '</div>';
      document.body.appendChild(ov);
      _scLightKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeLightbox(); } };
      document.addEventListener('keydown', _scLightKey, true);
    }).catch(function () { scToast('Could not open attachment'); });
  }

  function closeLightbox() {
    if (_scLightKey) { document.removeEventListener('keydown', _scLightKey, true); _scLightKey = null; }
    var ov = document.getElementById('sc-light-ov');
    if (ov) {
      // Stop playback explicitly; removing the node alone can leave audio running.
      try { ov.querySelectorAll('video,audio').forEach(function (m) { try { m.pause(); } catch (_) {} }); } catch (_) {}
      ov.remove();
    }
  }

  function attViewHtml(kind, mime, url, name, size, path) {
    var k = kind || kindOf(mime);
    var dl = '" data-sc-download="' + esc(path) + '" data-name="' + esc(name) + '"';
    if (k === 'image') return '<div class="sc-att-imgwrap">'
      + '<img class="sc-att-img" src="' + esc(url) + '" alt="' + esc(name) + '" data-sc-light="' + esc(path) + '" data-name="' + esc(name) + '" data-lkind="image">'
      + '<button type="button" class="sc-att-dl' + dl + ' title="Download">⬇</button></div>';
    /* Expand is a BUTTON, not a click-the-video gesture: clicking a <video>
       toggles playback, so overloading it would make play and full-screen the
       same gesture. Always visible — hover does not exist on touch. */
    if (k === 'video' || k === 'recording') return '<div class="sc-att-vidwrap">'
      + '<video class="sc-att-media" controls preload="metadata" src="' + esc(url) + '"></video>'
      + '<div class="sc-att-vidbtns">'
      + '<button type="button" class="sc-att-dl2" data-sc-light="' + esc(path) + '" data-name="' + esc(name) + '" data-lkind="video">⤢ Expand</button>'
      + '<button type="button" class="sc-att-dl2' + dl + '>⬇ Download</button></div></div>';
    if (k === 'audio') return '<div class="sc-att-audwrap">'
      + '<audio class="sc-att-audio" controls preload="metadata" src="' + esc(url) + '"></audio>'
      + '<button type="button" class="sc-att-dl2' + dl + '>⬇ Download</button></div>';
    return '<button type="button" class="sc-att-file' + dl + '><span class="sc-att-fic">📄</span><span class="sc-att-fmeta"><span class="sc-att-fname">' + esc(name) + '</span><span class="sc-att-fsize">' + esc(humanSize(size)) + '</span></span><span class="sc-att-fdl">⬇</span></button>';
  }
  function attPlaceholderHtml(a) {
    var kind = a.kind || kindOf(a.mime_type);
    return '<div class="sc-att" data-sc-att="' + esc(a.storage_path) + '" data-kind="' + esc(kind) + '" data-mime="' + esc(a.mime_type || '') + '" data-name="' + esc(a.file_name || 'file') + '" data-size="' + (Number(a.size_bytes) || 0) + '"><div class="sc-att-load"><span class="sc-spin"></span></div></div>';
  }
  function hydrateAttachments() {
    var nodes = document.querySelectorAll('.sc-att[data-sc-att]:not([data-hydrated])');
    Array.prototype.forEach.call(nodes, function (node) {
      node.setAttribute('data-hydrated', '1');
      signedUrl(node.getAttribute('data-sc-att')).then(function (url) {
        node.innerHTML = attViewHtml(node.getAttribute('data-kind'), node.getAttribute('data-mime'), url, node.getAttribute('data-name'), +node.getAttribute('data-size'), node.getAttribute('data-sc-att'));
        var host = node.closest('.sc-messages, #sc-full-messages'); if (host) host.scrollTop = host.scrollHeight;
      }).catch(function () {
        node.innerHTML = '<div class="sc-att-err">⚠ Couldn\'t load ' + esc(node.getAttribute('data-name')) + '</div>';
      });
    });
  }

  // ── recording (camera / audio-only / screen) ─────────────────────────────
  function openRecordMenu() {
    if (!_active) { scToast('Open a conversation first'); return; }
    closeRecordUi();
    var ov = document.createElement('div'); ov.className = 'sc-rec-ov'; ov.id = 'sc-rec-ov';
    ov.innerHTML = '<div class="sc-rec-box"></div>';
    document.body.appendChild(ov);
    showRecMenu();
  }
  function showRecMenu() {
    stopRecording();
    var box = document.querySelector('#sc-rec-ov .sc-rec-box'); if (!box) return;
    box.innerHTML = '<div class="sc-rec-head"><span>Record</span><button type="button" class="sc-icon" data-sc-rec-cancel>✕</button></div>'
      + '<div class="sc-rec-menu">'
      + '<button type="button" class="sc-rec-opt" data-sc-rec-start="camera">🎥 Record camera (myself)</button>'
      + '<button type="button" class="sc-rec-opt" data-sc-rec-start="audio">🎙️ Record audio only</button>'
      + '<button type="button" class="sc-rec-opt" data-sc-rec-start="screen">🖥️ Record screen</button>'
      + '</div>';
  }
  function stopTracks() { if (_rec && _rec.stream) { try { _rec.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {} } }
  function closeRecordUi() {
    stopRecording();
    if (_rec && _rec.previewUrl) { try { URL.revokeObjectURL(_rec.previewUrl); } catch (_) {} }
    var ov = document.getElementById('sc-rec-ov'); if (ov) ov.remove();
    _rec = null;
  }
  // Never throws: shows a clear inline "grant permission" message + a Back button.
  function recPermError(box, mode) {
    stopTracks();
    var msg = (mode === 'screen')
      ? 'Screen sharing was blocked or cancelled. Go back and try again.'
      : 'Allow camera & microphone for this site in your browser settings, then try again.';
    box.innerHTML = '<div class="sc-rec-head"><span>Permission needed</span><button type="button" class="sc-icon" data-sc-rec-cancel>✕</button></div>'
      + '<div class="sc-rec-msg">🔒 ' + esc(msg) + '</div>'
      + '<div class="sc-rec-ctrl"><button type="button" class="sc-rec-opt sc-rec-discard" data-sc-rec-menu>← Back</button></div>';
  }
  async function beginRecording(mode) {
    var box = document.querySelector('#sc-rec-ov .sc-rec-box'); if (!box) return;
    if (!navigator.mediaDevices) { recPermError(box, mode); return; }
    var isAudio = (mode === 'audio'), stream;
    try {
      if (mode === 'screen') {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        try { var mic = await navigator.mediaDevices.getUserMedia({ audio: true }); mic.getAudioTracks().forEach(function (t) { stream.addTrack(t); }); } catch (_) { /* mic optional */ }
      } else if (isAudio) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      }
    } catch (e) { recPermError(box, mode); return; }
    var recMime = isAudio ? 'audio/webm' : 'video/webm';
    var useMime = (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(recMime)) ? recMime : '';
    var recorder;
    try { recorder = useMime ? new MediaRecorder(stream, { mimeType: useMime }) : new MediaRecorder(stream); }
    catch (e) { scToast('Recording is not supported in this browser'); try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {} return; }
    var chunks = [];
    recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = function () { showRecPreview(new Blob(chunks, { type: recMime })); };
    _rec = { recorder: recorder, stream: stream, mode: mode, isAudio: isAudio, timer: null, blob: null, previewUrl: null };
    box.innerHTML = '<div class="sc-rec-head"><span>Recording…</span><button type="button" class="sc-icon" data-sc-rec-cancel>✕</button></div>'
      + (isAudio
          ? '<div class="sc-rec-audio"><span class="sc-rec-dot"></span> Recording audio…</div>'
          : '<video class="sc-rec-preview" autoplay muted playsinline></video>')
      + '<div class="sc-rec-ctrl">' + (isAudio ? '' : '<span class="sc-rec-dot"></span>') + '<span id="sc-rec-timer">0:00</span>'
      + '<button type="button" class="sc-rec-stop" data-sc-rec-stop>■ Stop</button></div>';
    if (!isAudio) { var v = box.querySelector('.sc-rec-preview'); if (v) v.srcObject = stream; }
    try { recorder.start(); } catch (e) { scToast('Could not start recording'); closeRecordUi(); return; }
    var secs = 0;
    _rec.timer = setInterval(function () {
      secs++; var t = document.getElementById('sc-rec-timer');
      if (t) t.textContent = Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2);
    }, 1000);
  }
  function stopRecording() {
    if (_rec && _rec.recorder && _rec.recorder.state !== 'inactive') { try { _rec.recorder.stop(); } catch (_) {} }
    if (_rec && _rec.timer) { clearInterval(_rec.timer); _rec.timer = null; }
    stopTracks();
  }
  function showRecPreview(blob) {
    var box = document.querySelector('#sc-rec-ov .sc-rec-box'); if (!box || !_rec) return;
    var url = URL.createObjectURL(blob); _rec.blob = blob; _rec.previewUrl = url;
    box.innerHTML = '<div class="sc-rec-head"><span>Preview</span><button type="button" class="sc-icon" data-sc-rec-cancel>✕</button></div>'
      + (_rec.isAudio
          ? '<div class="sc-rec-audiowrap"><audio class="sc-rec-audio-el" controls src="' + url + '"></audio></div>'
          : '<video class="sc-rec-preview" controls playsinline src="' + url + '"></video>')
      + '<div class="sc-rec-ctrl"><button type="button" class="sc-rec-opt sc-rec-discard" data-sc-rec-menu>↺ Redo</button>'
      + '<button type="button" class="sc-send" data-sc-rec-send>Send</button></div>';
  }
  async function sendRecording() {
    if (!_rec || !_rec.blob) return;
    var isAudio = _rec.isAudio, mode = _rec.mode, blob = _rec.blob;
    var base = isAudio ? 'audio' : (mode === 'screen' ? 'screen' : 'video');
    var file = new File([blob], base + '-' + Date.now() + '.webm', { type: isAudio ? 'audio/webm' : 'video/webm' });
    closeRecordUi();
    await stageFile(file, isAudio ? 'audio' : 'recording');
    send();
  }

  // ── CRM Copilot engine (ported from layout.js; reuses esc/client/scToast) ──
  // Tiny SAFE markdown: escape first, then a limited subset (no raw HTML injection).
  function copMd(text) {
    var h = esc(text || '');
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/^### (.+)$/gm, '<h4>$1</h4>').replace(/^## (.+)$/gm, '<h3>$1</h3>').replace(/^# (.+)$/gm, '<h3>$1</h3>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/(?:^|\n)\s*(?:[-*]|\d+\.)\s+(.+)/g, '\n<li>$1</li>');
    h = h.replace(/(<li>[\s\S]*?<\/li>(?:\n<li>[\s\S]*?<\/li>)*)/g, '<ul>$1</ul>');
    h = h.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
    return h;
  }
  // Format an ISO datetime (carries a Pacific offset) for display in Pacific,
  // regardless of the viewer's timezone → e.g. "Fri Jul 10, 3:00 PM".
  function copFmtWhen(iso) {
    try {
      var d = new Date(iso); if (isNaN(d.getTime())) return String(iso || '');
      return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }).replace(/^(\w{3}),/, '$1');
    } catch (e) { return String(iso || ''); }
  }
  // loe / esign / email actions navigate-and-prefill (handoff), not inline execute.
  function copIsHandoff(a) { return a.type === 'loe' || a.type === 'esign' || (a.type === 'message' && a.channel === 'email'); }
  function copConfirmLabel(a) {
    if (a.type === 'loe') return 'Open LOE tool';
    if (a.type === 'esign') return 'Open e-sign';
    if (a.type === 'appointment') return 'Schedule';
    if (a.type === 'message') return a.channel === 'email' ? ('✉️ Open in ' + (a.contact_name || 'lead')) : 'Send text';
    if (a.type === 'task') return 'Create task';
    if (a.type === 'note') return 'Save note';
    if (a.type === 'status') return 'Update';
    return 'Confirm';
  }
  function copDoneLabel(a) {
    if (a._state === 'opened') {
      if (a.type === 'loe') return 'Opened LOE for ' + (a.contact_name || 'lead');
      if (a.type === 'esign') return 'Opened e-sign for ' + (a.contact_name || 'lead');
      return 'Opened email for ' + (a.contact_name || 'lead');
    }
    if (a.type === 'appointment') return a._doneMsg || ('Scheduled' + (a.start ? ' · ' + copFmtWhen(a.start) : ''));
    if (a.type === 'message') return (a.channel === 'email' ? 'Email sent to ' : 'Text sent to ') + (a.contact_name || 'lead');
    if (a.type === 'task') return 'Task created: ' + (a.title || '');
    if (a.type === 'note') return 'Note saved on ' + (a.contact_name || 'lead');
    if (a.type === 'status') return 'Updated ' + (a.contact_name || 'lead');
    return 'Done';
  }
  function copCardHtml(a) {
    if (a._state === 'done' || a._state === 'opened') {
      var ic = a._state === 'opened' ? '↗' : '✓';
      return '<div class="cop-card done" data-cop-card="' + a.id + '"><div class="cop-card-h">' + ic + ' ' + (a._state === 'opened' ? 'Opened' : 'Done') + '</div><div class="cop-card-sub">' + esc(copDoneLabel(a)) + '</div></div>';
    }
    var busy = a._state === 'busy';
    var errHtml = (a._state === 'error') ? '<div class="cop-card-err">⚠ ' + esc(a._err || 'Failed — try again') + '</div>' : '';
    var inner = '';
    if (a.type === 'appointment') {
      var when = copFmtWhen(a.start);
      var meta = when + ' · ' + ((Number(a.duration_minutes) || 30) + ' min') + (a.contact_name ? (' with ' + a.contact_name) : '');
      inner = '<div class="cop-card-h">📅 Schedule: ' + esc(a.title || 'Appointment') + '</div>'
        + '<div class="cop-card-meta" style="text-transform:none;">' + esc(meta) + '</div>'
        + '<input class="cop-card-title" data-cop-title="' + a.id + '" value="' + esc(a.title || '') + '" placeholder="Title"' + (busy ? ' disabled' : '') + '>'
        + '<textarea class="cop-card-ta" data-cop-body="' + a.id + '" placeholder="Notes (optional)"' + (busy ? ' disabled' : '') + '>' + esc(a.notes || '') + '</textarea>';
    } else if (a.type === 'loe') {
      inner = '<div class="cop-card-h">✍️ Letter of Explanation for ' + esc(a.contact_name || 'lead') + '</div>'
        + (a.category ? '<div class="cop-card-meta">' + esc(a.category) + '</div>' : '')
        + '<textarea class="cop-card-ta" data-cop-details="' + a.id + '" placeholder="What should the letter explain?"' + (busy ? ' disabled' : '') + '>' + esc(a.details || '') + '</textarea>';
    } else if (a.type === 'esign') {
      inner = '<div class="cop-card-h">🖊️ Send for signature to ' + esc(a.contact_name || 'lead') + '</div>'
        + '<textarea class="cop-card-ta" data-cop-note="' + a.id + '" placeholder="Note for the recipient (optional)"' + (busy ? ' disabled' : '') + '>' + esc(a.note || '') + '</textarea>';
    } else if (a.type === 'message') {
      var verb = a.channel === 'email' ? '✉️ Email' : '💬 Text';
      inner = '<div class="cop-card-h">' + verb + ' to ' + esc(a.contact_name || 'lead') + '</div>'
        + (a.channel === 'email' ? '<input class="cop-card-title" data-cop-subject="' + a.id + '" value="' + esc(a.subject || '') + '" placeholder="Subject"' + (busy ? ' disabled' : '') + '>' : '')
        + '<textarea class="cop-card-ta" data-cop-body="' + a.id + '"' + (busy ? ' disabled' : '') + '>' + esc(a.body || '') + '</textarea>';
    } else if (a.type === 'task') {
      inner = '<div class="cop-card-h">✅ Task: ' + esc(a.title || 'Task') + '</div>'
        + '<div class="cop-card-meta">' + esc(a.priority || 'normal') + (a.due_date ? ' · due ' + esc(a.due_date) : '') + '</div>'
        + (a.description ? '<div class="cop-card-desc">' + esc(a.description) + '</div>' : '');
    } else if (a.type === 'note') {
      inner = '<div class="cop-card-h">📝 Note on ' + esc(a.contact_name || 'lead') + '</div>'
        + '<textarea class="cop-card-ta" data-cop-body="' + a.id + '"' + (busy ? ' disabled' : '') + '>' + esc(a.text || '') + '</textarea>';
    } else if (a.type === 'status') {
      var rows = [];
      if (a.pipeline_status) rows.push('Stage → ' + esc(a.pipeline_status));
      if (a.lead_status) rows.push('Status → ' + esc(a.lead_status));
      if (a.next_follow_up) rows.push('Follow-up → ' + esc(a.next_follow_up));
      inner = '<div class="cop-card-h">🔄 Update ' + esc(a.contact_name || 'lead') + '</div>'
        + '<div class="cop-card-desc">' + (rows.join('<br>') || '—') + '</div>';
    } else {
      inner = '<div class="cop-card-h">' + esc(a.type) + '</div>';
    }
    return '<div class="cop-card" data-cop-card="' + a.id + '">' + inner + errHtml
      + '<div class="cop-card-actions">'
      + '<button class="cop-card-btn" data-cop-cancel="' + a.id + '"' + (busy ? ' disabled' : '') + '>Dismiss</button>'
      + '<button class="cop-card-btn primary" data-cop-confirm="' + a.id + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Working…' : copConfirmLabel(a)) + '</button>'
      + '</div></div>';
  }
  function copUpdateCard(a) { var el = document.querySelector('[data-cop-card="' + a.id + '"]'); if (el) el.outerHTML = copCardHtml(a); copPersist(); }
  function copCancelAction(id) { var a = _copActions[id]; if (a) a._state = 'dismissed'; var el = document.querySelector('[data-cop-card="' + id + '"]'); if (el) el.remove(); copPersist(); }
  // Message send — reuses the CRM's existing edge functions: sms-service / email-service.
  async function copSendMessage(cl, a) {
    var cfg = window.APP_CONFIG || {};
    var anon = cfg.SUPABASE_ANON_KEY || '', base = cfg.SUPABASE_URL || '';
    var dest = await cl.from('contacts').select('phone,email').eq('id', a.contact_id).single();
    if (dest.error) throw dest.error;
    var c = dest.data || {};
    if (a.channel === 'email') {
      if (!c.email) throw new Error('No email on file for this lead');
      var er = await fetch(base + '/functions/v1/email-service', {
        method: 'POST', headers: await _scAuthHeaders(anon),   // session token: email-service is guarded / has no caller auth of its own
        body: JSON.stringify({ action: 'send', contact_id: a.contact_id, to: [c.email], from: 'rene@ratesandrealty.com', subject: a.subject || '', body_html: (a.body || '').replace(/\n/g, '<br>'), body_text: a.body || '' })
      });
      var ed = await er.json().catch(function () { return {}; });
      if (!(ed.success || ed.id)) throw new Error(ed.error || 'Email failed');
    } else {
      if (!c.phone) throw new Error('No phone on file for this lead');
      var sr = await fetch(base + '/functions/v1/sms-service', {
        method: 'POST', headers: await _scAuthHeaders(anon),   // session token: sms-service is guarded / has no caller auth of its own
        body: JSON.stringify({ trigger: 'manual', to_phone: c.phone, params: { message: a.body || '' }, contact_id: a.contact_id, direction: 'outbound' })
      });
      var sd = await sr.json().catch(function () { return {}; });
      if (!sd.success) throw new Error(sd.error || 'SMS failed');
    }
  }
  // Navigate-and-prefill: store a handoff for lead-detail to consume, then go there.
  // Marks the card resolved ('opened') so it can't re-fire on refresh/return.
  function copHandoff(a) {
    var action = (a.type === 'message') ? 'email' : a.type;   // 'loe' | 'esign' | 'email'
    try {
      var p = { action: action, contact_id: a.contact_id, ts: Date.now() };
      if (a.type === 'loe') { p.category = a.category || ''; p.details = a.details || ''; }
      else if (a.type === 'esign') { p.note = a.note || ''; }
      else { p.subject = a.subject || ''; p.body = a.body || ''; }
      sessionStorage.setItem('rnr_copilot_handoff', JSON.stringify(p));
    } catch (e) {}
    a._state = 'opened'; copUpdateCard(a);            // persisted by copUpdateCard before navigation
    if (a.contact_id) {
      var hash = (a.type === 'loe') ? '#copilot=loe' : (a.type === 'esign') ? '#copilot=esign' : '';
      window.location.href = '/admin/lead-detail.html?contact_id=' + encodeURIComponent(a.contact_id) + hash;
    }
  }
  async function copExecAction(id) {
    var a = _copActions[id];
    if (!a || a._state === 'busy' || a._state === 'done' || a._state === 'opened') return;
    if (copIsHandoff(a)) { copHandoff(a); return; }   // esign + email → navigate-and-prefill (no inline execute)
    a._state = 'busy'; a._err = null; copUpdateCard(a);
    try {
      var cl = await client();
      if (!cl) throw new Error('Not signed in');
      if (a.type === 'message') {
        await copSendMessage(cl, a);
      } else if (a.type === 'appointment') {
        // Step (a): create the appointment via the RPC.
        var ap = { contact_id: a.contact_id, title: a.title || 'Appointment', start: a.start, duration_minutes: (Number(a.duration_minutes) || 30), notes: a.notes || '' };
        var ar = await cl.rpc('copilot_execute_action', { p_type: 'appointment', p_payload: ap });
        if (ar && ar.error) throw ar.error;
        var aptId = ar && ar.data && ar.data.appointment_id;
        // Step (b): push to Google (same path as the CRM's syncToGoogleCalendar). Non-fatal.
        var pending = false;
        if (aptId) {
          try { var gr = await cl.functions.invoke('google-calendar-sync', { body: { appointment_id: aptId } }); if (!gr || gr.error || (gr.data && gr.data.error)) pending = true; }
          catch (ge) { pending = true; }
        }
        a._doneMsg = pending ? 'Created (Google sync pending)' : ('✓ Scheduled' + (a.start ? ' · ' + copFmtWhen(a.start) : ''));
      } else {
        var payload = { contact_id: a.contact_id };
        if (a.type === 'note') payload.text = a.text || '';
        else if (a.type === 'task') { payload.title = a.title || 'Task'; payload.priority = a.priority || 'normal'; payload.due_date = a.due_date || null; payload.description = a.description || null; }
        else if (a.type === 'status') { payload.pipeline_status = a.pipeline_status || null; payload.lead_status = a.lead_status || null; payload.next_follow_up = a.next_follow_up || null; }
        else throw new Error('Unsupported action');
        var r = await cl.rpc('copilot_execute_action', { p_type: a.type, p_payload: payload });
        if (r && r.error) throw r.error;
      }
      a._state = 'done'; copUpdateCard(a);
    } catch (e) {
      a._state = 'error'; a._err = (e && e.message) ? e.message : 'Failed'; copUpdateCard(a);
    }
  }
  // Persist the Copilot conversation to sessionStorage (survives refresh, clears on
  // browser/session end + explicit logout). Transient states are normalized so a refresh
  // mid-execution can't strand a card or re-offer Confirm for an already-done action.
  function copPersist() {
    try {
      var hist = _copHistory.slice(-COP_MAX_MSGS).map(function (m) {
        var e = { role: m.role, content: m.content };
        if (m._briefing) e._briefing = true;
        if (m.actions && m.actions.length) {
          e.actions = m.actions.map(function (a) {
            var st = (a._state === 'busy' || a._state === 'error') ? 'pending' : a._state;   // interrupted → re-offerable
            return Object.assign({}, a, { _state: st });
          });
        }
        return e;
      });
      // date = Pacific day the convo was last written; read back by copRestore so a new day
      // still auto-briefs even when yesterday's conversation is rehydrated (see maybeAutoBrief).
      sessionStorage.setItem(COP_CONVO_KEY, JSON.stringify({ v: 1, seq: _copActionSeq, date: copToday(), history: hist }));
    } catch (e) {}
  }
  function copRestore() {
    var raw = null; try { raw = sessionStorage.getItem(COP_CONVO_KEY); } catch (e) {}
    if (!raw) return;
    var data; try { data = JSON.parse(raw); } catch (e) { return; }
    if (!data || !Array.isArray(data.history)) return;
    _copHistory = data.history;
    _copActions = {};
    _copActionSeq = Number(data.seq) || 0;
    _copConvoDate = data.date || null;                          // Pacific date this convo was last saved (may be a prior day)
    _copHistory.forEach(function (m) {
      if (m.actions && m.actions.length) {
        m.actions.forEach(function (a) {
          if (a._state === 'busy' || a._state === 'error') a._state = 'pending';   // never restore mid-flight
          if (a.id) {
            _copActions[a.id] = a;
            var n = parseInt(String(a.id).replace(/\D/g, ''), 10);
            if (!isNaN(n) && n > _copActionSeq) _copActionSeq = n;                  // keep new ids unique
          }
        });
      }
    });
  }
  function copClearSaved() { try { sessionStorage.removeItem(COP_CONVO_KEY); } catch (e) {} }

  // ── Auto morning briefing (in-app only; once per Pacific day) ──
  var COP_BRIEF_KEY = 'rnr_copilot_briefing_date';
  var COP_BRIEF_PROMPT = "Good morning — give me my briefing for today: my top priority leads to work, what's on my calendar today, and anyone who's gone stale and needs follow-up. Keep it tight and actionable.";
  function copToday() { try { return new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }); } catch (e) { return new Date().toDateString(); } }
  function maybeAutoBrief() {
    if (!copAllowed()) return;                                  // copilot is gated (not VA)
    if (!document.getElementById('sc-cop-msgs')) return;        // only the floating copilot pane
    if (_copBusy) return;                                       // don't interrupt an in-flight turn
    var today = copToday(), last = null;
    try { last = localStorage.getItem(COP_BRIEF_KEY); } catch (e) {}
    if (last === today) return;                                 // already auto-briefed today
    // Skip only if there's an ONGOING conversation from TODAY. A convo restored from a
    // previous day is treated as stale, so a new day still auto-briefs even though history
    // was rehydrated (_copConvoDate carries the persisted convo's Pacific date; see copPersist).
    if (_copHistory.length > 0 && _copConvoDate === today) return;
    try { localStorage.setItem(COP_BRIEF_KEY, today); } catch (e) {}   // set BEFORE async → at most once/day
    copSend(COP_BRIEF_PROMPT, { briefing: true });
  }

  function copRender() {
    var box = document.getElementById('sc-cop-msgs'); if (!box) return;
    if (!_copHistory.length && !_copBusy) {
      box.innerHTML = '<div class="cop-empty"><div class="cop-empty-t">Hi 👋 I\'m your CRM Copilot.</div>'
        + '<div class="cop-empty-s">Ask about your leads, pipeline, and who to work.</div>'
        + '<div class="cop-chips"><button class="cop-chip cop-chip-brief" data-cop-brief>☀️ Morning briefing</button>'
        + COP_CHIPS.map(function (c) { return '<button class="cop-chip" data-cop-chip="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div></div>';
      copPersist();
      return;
    }
    var html = _copHistory.map(function (m) {
      var mine = m.role === 'user';
      if (mine && m._briefing) return '<div class="cop-brief-label">☀️ Morning briefing</div>';   // auto-brief header, not a user bubble
      var bubble = '<div class="cop-msg' + (mine ? ' mine' : '') + '">' + (mine ? esc(m.content) : copMd(m.content)) + '</div>';
      if (!mine && m.actions && m.actions.length) bubble += m.actions.filter(function (a) { return a._state !== 'dismissed'; }).map(copCardHtml).join('');
      return bubble;
    }).join('');
    if (_copBusy) {
      var lastT = _copHistory[_copHistory.length - 1];
      var briefing = lastT && lastT.role === 'user' && lastT._briefing;
      html += briefing
        ? '<div class="cop-msg cop-think cop-brief-think">☀️ Preparing your briefing… <span></span><span></span><span></span></div>'
        : '<div class="cop-msg cop-think"><span></span><span></span><span></span></div>';
    }
    box.innerHTML = html; box.scrollTop = box.scrollHeight;
    copPersist();
  }
  async function copToken() {
    try { var cl = await client(); if (!cl) return null; var r = await cl.auth.getSession(); return (r && r.data && r.data.session) ? r.data.session.access_token : null; }
    catch (e) { return null; }
  }
  async function copSend(text, opts) {
    text = (text || '').trim(); if (!text || _copBusy) return;
    var cfg = window.APP_CONFIG || {};
    var userTurn = { role: 'user', content: text };
    if (opts && opts.briefing) userTurn._briefing = true;       // rendered as a "Morning briefing" header
    _copHistory.push(userTurn);
    _copBusy = true; copRender();
    var token = await copToken();
    if (!token) { _copBusy = false; _copHistory.push({ role: 'assistant', content: 'Please sign in to use the Copilot.' }); copRender(); return; }
    try {
      // API history must be CLEAN — only {role, content}. _copHistory carries UI-only
      // fields (actions/cards) which the AI endpoint rejects ("Extra inputs not permitted"),
      // so project them out here. Card data stays in _copHistory/_copActions for rendering.
      var prior = _copHistory.slice(0, -1).slice(-10).map(function (m) { return { role: m.role, content: String(m.content == null ? '' : m.content) }; });
      var res = await fetch((cfg.SUPABASE_URL || '') + '/functions/v1/crm-copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': cfg.SUPABASE_ANON_KEY || '', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ message: text, history: prior })
      });
      var data = await res.json().catch(function () { return {}; });
      _copBusy = false;
      if (data && data.error) {
        _copHistory.push({ role: 'assistant', content: (res.status === 403) ? 'Copilot is available to admin/staff only.' : (data.error || 'Something went wrong.') });
      } else {
        var acts = null;
        if (data && Array.isArray(data.proposed_actions) && data.proposed_actions.length) {
          acts = [];
          data.proposed_actions.forEach(function (pa) {
            if (!pa || !pa.type) return;
            var id = 'copact' + (++_copActionSeq);
            var a = Object.assign({}, pa, { id: id, _state: 'pending' });
            _copActions[id] = a; acts.push(a);
          });
        }
        _copHistory.push({ role: 'assistant', content: (data && data.reply) || 'No response — try rephrasing.', actions: (acts && acts.length) ? acts : null });
      }
      copRender();
    } catch (e) {
      _copBusy = false; _copHistory.push({ role: 'assistant', content: 'Network error — please try again.' }); copRender();
    }
  }

  // ── tab switching (floating panel only): 'chat' | 'copilot' ──
  function scSetTab(tab) {
    if (tab === 'copilot' && !copAllowed()) tab = 'chat';
    _tab = tab;
    try { localStorage.setItem('rnr_combo_tab', tab); } catch (e) {}
    var panel = document.getElementById('staff-chat-panel'); if (!panel) return;
    panel.setAttribute('data-tab', tab);
    var cp = document.getElementById('sc-chat-pane'), kp = document.getElementById('sc-copilot-pane');
    if (cp) cp.style.display = (tab === 'chat') ? 'flex' : 'none';
    if (kp) kp.style.display = (tab === 'copilot') ? 'flex' : 'none';
    Array.prototype.forEach.call(panel.querySelectorAll('[data-sc-tab]'), function (b) { b.classList.toggle('is-active', b.getAttribute('data-sc-tab') === tab); });
    if (tab === 'copilot') { copRender(); maybeAutoBrief(); var i = document.getElementById('sc-cop-input'); if (i) setTimeout(function () { i.focus(); }, 30); }
  }

  // ── expand / collapse the floating panel size (persisted; both tabs) ──
  function scIsExpanded() { try { return localStorage.getItem(COP_EXPANDED_KEY) === '1'; } catch (e) { return false; } }
  function scApplyExpanded() {
    var p = document.getElementById('staff-chat-panel'); if (!p) return;
    var on = scIsExpanded();
    p.classList.toggle('is-expanded', on);
    var b = p.querySelector('[data-sc-size]');
    if (b) { b.textContent = on ? '⤡' : '⤢'; b.title = on ? 'Collapse' : 'Expand'; }
  }
  function scToggleExpanded() { try { localStorage.setItem(COP_EXPANDED_KEY, scIsExpanded() ? '0' : '1'); } catch (e) {} scApplyExpanded(); }

  // ── CSS ─────────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('staff-chat-css')) return;
    var s = document.createElement('style'); s.id = 'staff-chat-css';
    s.textContent = [
      // Floating bubble — flush to the bottom-right corner by default. On the dashboard
      // (AI FAB present) JS adds .sc-clear-fab to shift it left of the FAB, no overlap.
      '.sc-bubble-btn{position:fixed;bottom:20px;right:20px;z-index:90;width:56px!important;height:56px!important;min-width:56px;min-height:56px;max-width:56px;max-height:56px;box-sizing:border-box;flex:none;align-self:center;padding:0;line-height:0;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(145deg,#1f1f1f 0%,#121212 100%);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.5),0 0 0 1.5px rgba(201,168,76,.5),inset 0 1px 0 rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;transition:transform .15s ease,box-shadow .15s ease}',
      '.sc-bubble-btn.sc-clear-fab{right:84px}',
      '.sc-bubble-btn:hover{transform:scale(1.05);box-shadow:0 12px 30px rgba(0,0,0,.6),0 0 0 1.5px rgba(201,168,76,.85),inset 0 1px 0 rgba(255,255,255,.06)}',
      '.sc-bubble-btn:active{transform:scale(.97)}',
      '.sc-bubble-btn:focus-visible{outline:2px solid #C9A84C;outline-offset:3px}',
      '.sc-bubble-btn>svg{pointer-events:none}',
      '@media(max-width:720px){.sc-bubble-btn{width:52px!important;height:52px!important;min-width:52px;min-height:52px;max-width:52px;max-height:52px;bottom:16px;right:16px}.sc-bubble-btn.sc-clear-fab{right:76px}}',
      '.sc-badge{position:absolute;top:-3px;right:-3px;min-width:19px;height:19px;padding:0 5px;border-radius:10px;background:#E5484D;color:#fff;font-size:10.5px;font-weight:800;display:none;align-items:center;justify-content:center;box-sizing:border-box;box-shadow:0 0 0 2px #0d0d0d,0 1px 4px rgba(0,0,0,.45)}',
      '.sc-badge.sc-pop{animation:sc-badge-pop .3s cubic-bezier(.3,1.5,.5,1)}',
      '@keyframes sc-badge-pop{0%{transform:scale(.5)}60%{transform:scale(1.25)}100%{transform:scale(1)}}',
      // Panel
      '.sc-panel{position:fixed;bottom:84px;right:20px;z-index:95;width:min(400px,calc(100vw - 32px));height:520px;max-height:calc(100vh - 104px);background:#0d0d0d;border:1px solid rgba(201,168,76,.28);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden;transform:scale(.94) translateY(14px);opacity:0;pointer-events:none;transition:all .18s cubic-bezier(.4,0,.2,1);transform-origin:bottom right;font-family:inherit}',
      '.sc-panel.is-open{transform:none;opacity:1;pointer-events:auto}',
      // Narrow screens: fill the width with small side margins so nothing overflows.
      '@media(max-width:480px){.sc-panel{left:12px;right:12px;bottom:80px;width:auto;max-height:calc(100vh - 96px)}}',
      '.sc-panel-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0}',
      '.sc-panel-title{font-size:13px;font-weight:700;color:#C9A84C;letter-spacing:.3px}',
      '.sc-head-actions{display:flex;gap:2px}',
      '.sc-icon{background:transparent;border:none;color:#888;font-size:15px;cursor:pointer;padding:4px 7px;border-radius:6px;line-height:1;font-family:inherit}',
      '.sc-icon:hover{color:#fff;background:rgba(255,255,255,.06)}',
      '.sc-panel-body{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.sc-list-view{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.sc-thread-list,.sc-messages{overflow-y:auto;flex:1;min-height:0}',
      // Thread rows
      '.sc-thread{padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;transition:background .12s}',
      '.sc-thread:hover{background:rgba(255,255,255,.03)}',
      '.sc-thread.is-active{background:rgba(201,168,76,.08)}',
      '.sc-thread-top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}',
      '.sc-thread-name{font-size:13px;font-weight:600;color:#eee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-thread-time{font-size:10px;color:#777;flex-shrink:0}',
      '.sc-thread-bot{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:2px}',
      '.sc-thread-last{font-size:11.5px;color:#8a8a8a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-thread-unread{flex-shrink:0;min-width:17px;height:17px;padding:0 5px;border-radius:9px;background:#C9A84C;color:#111;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;box-sizing:border-box}',
      // Conversation
      '.sc-conv-view{flex:1;min-height:0;display:none;flex-direction:column}',
      '.sc-conv-head{display:flex;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0}',
      '.sc-conv-title{font-size:13px;font-weight:700;color:#eee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-messages{padding:12px 14px;display:flex;flex-direction:column;gap:8px}',
      '.sc-msg{display:flex;flex-direction:column;align-items:flex-start;max-width:82%}',
      '.sc-msg.mine{align-self:flex-end;align-items:flex-end}',
      '.sc-msg-who{font-size:10px;color:#C9A84C;font-weight:700;margin-bottom:2px}.sc-msg{position:relative}.sc-msg-menu{position:absolute;top:-2px;right:-4px;display:none;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.16);color:#bbb;border-radius:6px;cursor:pointer;font:700 12px/1 inherit;padding:3px 6px}.sc-msg:hover .sc-msg-menu{display:block}.sc-msg-menu:hover{color:#F07878;border-color:rgba(240,120,120,.5)}.sc-tombstone{background:transparent;border:1px dashed rgba(255,255,255,.18);color:#777;font-style:italic}',
      '.sc-msgbubble{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);color:#e6e6e6;padding:7px 11px;border-radius:4px 12px 12px 12px;font-size:13px;line-height:1.4;word-break:break-word;white-space:pre-wrap}',
      '.sc-msg.mine .sc-msgbubble{background:rgba(201,168,76,.16);border-color:rgba(201,168,76,.3);color:#fff;border-radius:12px 4px 12px 12px}',
      '.sc-msg-time{font-size:9px;color:#666;margin-top:2px}',
      '.sc-composer{display:flex;gap:6px;align-items:center;padding:10px 12px}',
      '.sc-composer input{flex:1 1 auto;min-width:0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eee;font-size:13px;padding:8px 11px;outline:none;font-family:inherit}',
      '.sc-send{flex:0 0 auto;background:#C9A84C;border:none;color:#111;font-weight:700;font-size:12px;border-radius:8px;padding:0 14px;height:34px;cursor:pointer;font-family:inherit}',
      '.sc-empty{color:#888;font-size:12.5px;padding:22px 16px;text-align:center;line-height:1.6}',
      // New-chat overlay
      '.sc-newchat-ov{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px}',
      '.sc-newchat{width:min(360px,94vw);max-height:80vh;display:flex;flex-direction:column;background:#0d0d0d;border:1px solid rgba(201,168,76,.3);border-radius:14px;overflow:hidden;box-shadow:0 20px 56px rgba(0,0,0,.6)}',
      '.sc-newchat-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);font-size:14px;font-weight:700;color:#C9A84C}',
      '.sc-newchat-list{overflow-y:auto}',
      '.sc-contact{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,.05);color:#eee;padding:12px 16px;cursor:pointer;font-family:inherit;text-align:left}',
      '.sc-contact:hover{background:rgba(255,255,255,.04)}',
      '.sc-contact-name{font-size:13px;font-weight:600}',
      '.sc-contact-role{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.4px}',
      // Full-page two-pane
      '.sc-full{display:grid;grid-template-columns:300px 1fr;height:100%;min-height:0}',
      '.sc-full-left{border-right:1px solid rgba(255,255,255,.07);display:flex;flex-direction:column;min-height:0}',
      '.sc-full-left-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.06)}',
      '.sc-full-left-head .t{font-size:14px;font-weight:700;color:#C9A84C}',
      '.sc-full-right{display:flex;flex-direction:column;min-height:0}',
      '.sc-full-right-head{padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.06);font-size:14px;font-weight:700;color:#eee}',
      '#sc-full-threads{overflow-y:auto;flex:1;min-height:0}',
      '#sc-full-messages{overflow-y:auto;flex:1;min-height:0;padding:16px 20px;display:flex;flex-direction:column;gap:8px}',
      '@media(max-width:720px){.sc-full{grid-template-columns:1fr}.sc-full-right{display:none}}',
      // Embedded single-column mode (va-dashboard right rail)
      '.sc-col-root{height:100%}',
      '.sc-col{height:100%;display:flex;flex-direction:column;min-height:0}',
      '.sc-col-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0}',
      '.sc-col-title{font-size:13px;font-weight:700;color:#C9A84C;letter-spacing:.3px}',
      '.sc-col .sc-panel-body{flex:1;min-height:0;display:flex;flex-direction:column}',
      // Tabs (combined Chat + Copilot panel)
      '.sc-tabs{display:flex;gap:4px}',
      '.sc-tab{background:transparent;border:none;color:#888;font-size:12.5px;font-weight:700;cursor:pointer;padding:5px 10px;border-radius:8px;font-family:inherit;letter-spacing:.2px}',
      '.sc-tab:hover{color:#ddd;background:rgba(255,255,255,.05)}',
      '.sc-tab.is-active{color:#111;background:#C9A84C}',
      '.sc-pane{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.sc-panel[data-tab="copilot"] .sc-chat-only{display:none}',
      // header controls that only apply to the Copilot tab (e.g. ☀️ on-demand briefing)
      '.sc-cop-only{display:none}',
      '.sc-panel[data-tab="copilot"] .sc-cop-only{display:inline-block}',
      // Expanded (large / near-fullscreen) panel — pin TOP and bottom explicitly so the top
      // edge (tabs + ✕ + size toggle) is always on-screen, never above 0. Height is defined by
      // top+bottom; override the base bottom:84px and max-height. The panel is a flex column
      // (header flex-shrink:0 → body flex:1 → composer flex-shrink:0), so only the message list
      // scrolls while the header and composer stay put at both sizes.
      // top:68px clears the site's fixed top bar (--topbar-h:48px on lead-detail/admin pages) + ~20px
      // margin, so the tab row + ✕/size-toggle sit fully below the navbar and are never clipped under it.
      '.sc-panel.is-expanded{top:68px;bottom:20px;right:20px;left:auto;width:min(1000px,calc(100vw - 40px));height:auto;max-height:none}',
      '@media(max-width:480px){.sc-panel.is-expanded{top:64px;bottom:16px;left:12px;right:12px;width:auto;height:auto;max-height:none}}',
      '.cop-chip-brief{background:rgba(201,168,76,.18);border-color:rgba(201,168,76,.5)}',
      // Copilot pane (ported look from layout.js)
      '.cop-msgs{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}',
      '.cop-empty{color:#aaa;text-align:center;padding:16px 8px;margin:auto 0}',
      '.cop-empty-t{font-size:14px;color:#eee;font-weight:600}.cop-empty-s{font-size:12px;color:#888;margin-top:4px}',
      '.cop-chips{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;margin-top:14px}',
      '.cop-chip{background:rgba(201,168,76,.1);border:1px solid rgba(201,168,76,.35);color:#C9A84C;font-size:11.5px;font-weight:600;border-radius:14px;padding:6px 12px;cursor:pointer;font-family:inherit}',
      '.cop-chip:hover{background:rgba(201,168,76,.2)}',
      '.cop-msg{max-width:88%;font-size:13px;line-height:1.5;padding:9px 12px;border-radius:4px 12px 12px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);color:#e6e6e6;word-break:break-word;align-self:flex-start}',
      '.cop-msg.mine{align-self:flex-end;background:rgba(201,168,76,.16);border-color:rgba(201,168,76,.3);color:#fff;border-radius:12px 4px 12px 12px;white-space:pre-wrap}',
      '.cop-msg h3{font-size:14px;margin:8px 0 4px;color:#fff}.cop-msg h4{font-size:13px;margin:6px 0 3px;color:#fff}',
      '.cop-msg ul{margin:6px 0;padding-left:18px}.cop-msg li{margin:2px 0}',
      '.cop-msg code{background:rgba(255,255,255,.1);border-radius:4px;padding:1px 5px;font-size:12px}.cop-msg a{color:#C9A84C}',
      '.cop-msg.cop-think{display:flex;flex-direction:row;gap:4px;align-items:center}',
      '.cop-think span{width:6px;height:6px;border-radius:50%;background:#C9A84C;animation:cop-blink 1.2s infinite}',
      '.cop-think span:nth-child(2){animation-delay:.2s}.cop-think span:nth-child(3){animation-delay:.4s}',
      '@keyframes cop-blink{0%,60%,100%{opacity:.3}30%{opacity:1}}',
      // Copilot Phase 2 action cards
      '.cop-card{align-self:flex-start;width:100%;max-width:92%;box-sizing:border-box;border:1px solid rgba(201,168,76,.5);background:rgba(201,168,76,.06);border-radius:10px;padding:10px 12px;margin:1px 0 3px}',
      '.cop-card.done{border-color:rgba(82,200,122,.5);background:rgba(82,200,122,.08)}',
      '.cop-card-h{font-size:12.5px;font-weight:700;color:#C9A84C;margin-bottom:4px}',
      '.cop-card.done .cop-card-h{color:#52c87a}',
      '.cop-card-sub{font-size:11px;color:#bbb;margin-bottom:5px}',
      '.cop-card-meta{font-size:11px;color:#9a9a9a;margin-bottom:4px;text-transform:capitalize}',
      '.cop-card-desc{font-size:12px;color:#ddd;line-height:1.45;margin-bottom:5px;white-space:pre-wrap;word-break:break-word}',
      '.cop-card-ta{width:100%;box-sizing:border-box;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.12);border-radius:7px;color:#eee;font-size:12.5px;line-height:1.45;font-family:inherit;padding:7px 9px;min-height:66px;resize:vertical;margin-bottom:6px;outline:none}',
      '.cop-card-title{width:100%;box-sizing:border-box;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.12);border-radius:7px;color:#eee;font-size:12.5px;font-weight:600;font-family:inherit;padding:6px 9px;margin-bottom:6px;outline:none}',
      '.cop-brief-label{align-self:center;font-size:10.5px;color:#C9A84C;font-weight:700;letter-spacing:.5px;text-transform:uppercase;opacity:.85;margin:2px 0}',
      '.cop-brief-think{color:#C9A84C;font-size:12px;font-weight:600;gap:4px}',
      '.cop-card-title:focus{border-color:rgba(201,168,76,.55)}',
      '.cop-card-ta:focus{border-color:rgba(201,168,76,.55)}',
      '.cop-card-err{font-size:11px;color:#f2a5a7;margin-bottom:6px}',
      '.cop-card-actions{display:flex;gap:6px;justify-content:flex-end}',
      '.cop-card-btn{font-size:11.5px;font-weight:600;border-radius:7px;padding:6px 12px;cursor:pointer;font-family:inherit;border:1px solid rgba(255,255,255,.15);background:transparent;color:#ccc}',
      '.cop-card-btn:hover{background:rgba(255,255,255,.06);color:#fff}',
      '.cop-card-btn.primary{background:#C9A84C;border-color:#C9A84C;color:#111}',
      '.cop-card-btn.primary:hover{background:#d8ba63}',
      '.cop-card-btn:disabled{opacity:.55;cursor:default}',
      // composer: attach/record buttons + staging tray
      '.sc-composer-wrap{border-top:1px solid rgba(255,255,255,.06);flex-shrink:0}',
      '.sc-cbtn{background:transparent;border:none;color:#9a9a9a;font-size:17px;cursor:pointer;padding:4px 5px;border-radius:6px;line-height:1;flex-shrink:0}',
      '.sc-cbtn:hover{color:#fff;background:rgba(255,255,255,.06)}',
      '.sc-send:disabled{opacity:.5;cursor:default}',
      '.sc-attach-tray{display:none;flex-wrap:wrap;gap:6px;padding:8px 12px 0}',
      '.sc-tray-item{display:flex;align-items:center;gap:6px;max-width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:4px 6px 4px 8px;font-size:11px;color:#ddd}',
      '.sc-tray-item.is-error{border-color:rgba(229,72,77,.5);color:#f2a5a7}',
      '.sc-tray-name{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-tray-size{color:#888;flex-shrink:0}',
      '.sc-tray-x{background:transparent;border:none;color:#888;cursor:pointer;font-size:12px;padding:0 2px}',
      '.sc-tray-x:hover{color:#fff}',
      '.sc-spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(201,168,76,.3);border-top-color:#C9A84C;border-radius:50%;animation:sc-spin .7s linear infinite;vertical-align:middle}',
      '@keyframes sc-spin{to{transform:rotate(360deg)}}',
      // rendered attachments in bubbles
      '.sc-att-wrap{display:flex;flex-direction:column;gap:6px;margin-top:6px}',
      '.sc-att{max-width:100%}',
      '.sc-att-load{padding:10px;color:#888;font-size:11px}',
      '.sc-att-err{font-size:11px;color:#f2a5a7}',
      '.sc-att-img{max-width:min(220px,100%);max-height:240px;width:auto;border-radius:8px;display:block;cursor:pointer;border:1px solid rgba(255,255,255,.1)}',
      '.sc-att-media{max-width:min(260px,100%);width:100%;border-radius:8px;background:#000;display:block}',
      '.sc-att-audio{width:230px;max-width:100%;display:block}',
      '.sc-att-file{display:flex;align-items:center;gap:8px;text-decoration:none;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 10px;color:#e6e6e6;max-width:min(240px,100%);width:100%;text-align:left;cursor:pointer;font-family:inherit}',
      '.sc-att-file:hover{background:rgba(255,255,255,.1)}',
      '.sc-att-fic{font-size:18px;flex-shrink:0}',
      '.sc-att-fmeta{display:flex;flex-direction:column;min-width:0}',
      '.sc-att-fname{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-att-fsize{font-size:10px;color:#888}',
      '.sc-att-fdl{margin-left:auto;flex-shrink:0;color:#C9A84C;font-size:14px}',
      '.sc-msg.mine .sc-att-file{background:rgba(201,168,76,.14);border-color:rgba(201,168,76,.3)}',
      // in-message download controls
      '.sc-att-imgwrap{position:relative;display:inline-block;max-width:100%}',
      '.sc-att-dl{position:absolute;top:6px;right:6px;width:28px;height:28px;border-radius:8px;border:none;background:rgba(0,0,0,.6);color:#fff;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.9}',
      '.sc-att-dl:hover{opacity:1;background:rgba(0,0,0,.82)}',
      '.sc-att-vidwrap,.sc-att-audwrap{display:flex;flex-direction:column;gap:5px;align-items:flex-start;max-width:100%}',
      '.sc-att-dl2{align-self:flex-start;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#e6e6e6;font-size:11px;font-weight:600;border-radius:7px;padding:4px 10px;cursor:pointer;font-family:inherit}',
      '.sc-att-dl2:hover{background:rgba(255,255,255,.14)}',
      // full-size image lightbox
      '.sc-light-ov{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.92);display:flex;flex-direction:column}',
      '.sc-light-x{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.28);color:#fff;font-size:18px;line-height:1;cursor:pointer;border-radius:10px;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:inherit}',
      '.sc-light-x:hover{background:rgba(255,255,255,.22)}',
      '.sc-light-body video,.sc-light-body audio{max-width:100%;max-height:100%;outline:none}',
      '.sc-light-body video{background:#000;border-radius:6px}',
      '.sc-att-vidbtns{display:flex;gap:6px;flex-wrap:wrap}',
      '.sc-light-bar{display:flex;align-items:center;gap:12px;padding:12px 16px;flex-shrink:0}',
      '.sc-light-name{flex:1;min-width:0;color:#ddd;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-light-dl{background:#C9A84C;border:none;color:#111;font-weight:700;font-size:12px;border-radius:8px;padding:7px 14px;cursor:pointer;font-family:inherit;flex-shrink:0}',
      '.sc-light-body{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 16px 16px}',
      '.sc-light-body img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px}',
      // record overlay
      '.sc-rec-ov{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:18px}',
      '.sc-rec-box{width:min(420px,94vw);background:#0d0d0d;border:1px solid rgba(201,168,76,.3);border-radius:14px;overflow:hidden;box-shadow:0 20px 56px rgba(0,0,0,.6);display:flex;flex-direction:column}',
      '.sc-rec-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08);font-size:13px;font-weight:700;color:#C9A84C}',
      '.sc-rec-menu{display:flex;flex-direction:column;gap:8px;padding:16px}',
      '.sc-rec-opt{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);color:#eee;border-radius:8px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.sc-rec-opt:hover{background:rgba(255,255,255,.09)}',
      '.sc-rec-discard{flex:1}',
      '.sc-rec-preview{width:100%;max-height:50vh;background:#000;display:block}',
      '.sc-rec-ctrl{display:flex;align-items:center;gap:10px;padding:12px 14px;border-top:1px solid rgba(255,255,255,.08)}',
      '.sc-rec-dot{width:10px;height:10px;border-radius:50%;background:#E5484D;animation:sc-blink 1s steps(2,start) infinite;flex-shrink:0}',
      '@keyframes sc-blink{50%{opacity:.25}}',
      '#sc-rec-timer{font-size:12px;color:#ddd;flex:1}',
      '.sc-rec-stop{background:#E5484D;border:none;color:#fff;font-weight:700;font-size:12px;border-radius:8px;padding:8px 14px;cursor:pointer;font-family:inherit}',
      '.sc-rec-msg{padding:20px 18px;color:#e6c9a0;font-size:13px;line-height:1.5;text-align:center}',
      '.sc-rec-audio{display:flex;align-items:center;justify-content:center;gap:10px;padding:34px 18px;color:#ddd;font-size:13px;font-weight:600}',
      '.sc-rec-audiowrap{padding:24px 18px;display:flex;justify-content:center}',
      '.sc-rec-audio-el{width:100%}',
      // toast
      '.sc-toast{position:fixed;bottom:90px;left:50%;transform:translateX(-50%) translateY(10px);z-index:120;background:#1a1a1a;border:1px solid rgba(201,168,76,.4);color:#fff;font-size:12.5px;padding:9px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);opacity:0;transition:opacity .25s,transform .25s;max-width:90vw;text-align:center}',
      '.sc-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}'
    ].join('');
    document.head.appendChild(s);
  }

  // ── mount: floating widget ─────────────────────────────────────────────
  function mountFloating() {
    if (document.getElementById('staff-chat-bubble')) return;
    var btn = document.createElement('button');
    btn.id = 'staff-chat-bubble'; btn.className = 'sc-bubble-btn'; btn.type = 'button';
    btn.setAttribute('aria-label', 'Staff chat & Copilot'); btn.setAttribute('data-sc-toggle', '');
    // Hybrid icon: chat bubble + a small gold sparkle badge (Chat + Copilot).
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="23" height="23" fill="none" aria-hidden="true">'
      + '<path d="M4 5h12a1 1 0 011 1v7a1 1 0 01-1 1H8l-4 3.5V14H4a1 1 0 01-1-1V6a1 1 0 011-1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
      + '<path d="M7 8.5h6M7 11h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
      + '<path d="M19 2l.85 2.65L22.5 5.5l-2.65.85L19 9l-.85-2.65L15.5 5.5l2.65-.85z" fill="#C9A84C"/></svg>'
      + '<span id="staff-chat-badge" class="sc-badge"></span>';
    document.body.appendChild(btn);

    var copTabBtn = copAllowed() ? '<button class="sc-tab" data-sc-tab="copilot">✨ Copilot</button>' : '';
    var panel = document.createElement('div');
    panel.id = 'staff-chat-panel'; panel.className = 'sc-panel'; panel.setAttribute('data-tab', 'chat');
    panel.innerHTML =
      '<div class="sc-panel-head">'
      + '<span class="sc-tabs"><button class="sc-tab is-active" data-sc-tab="chat">💬 Chat</button>' + copTabBtn + '</span>'
      + '<span class="sc-head-actions">'
      + '<button class="sc-icon sc-chat-only" data-sc-new title="New chat">＋</button>'
      + '<button class="sc-icon sc-cop-only" data-cop-brief title="Morning briefing">☀️</button>'
      + '<button class="sc-icon sc-chat-only" data-sc-expand title="Open full page">↗</button>'
      + '<button class="sc-icon" data-sc-size title="Expand">⤢</button>'
      + '<button class="sc-icon" data-sc-close title="Close">✕</button></span></div>'
      + '<div class="sc-panel-body">'
      + '<div id="sc-chat-pane" class="sc-pane" style="display:flex">'
      +   '<div id="sc-list-view" class="sc-list-view"><div id="sc-thread-list" class="sc-thread-list"></div></div>'
      +   '<div id="sc-conv-view" class="sc-conv-view">'
      +   '<div class="sc-conv-head"><button class="sc-icon" data-sc-back title="Back">‹</button><span id="sc-conv-title" class="sc-conv-title"></span></div>'
      +   '<div id="sc-messages" class="sc-messages"></div>'
      +   composerHtml()
      +   '</div></div>'
      + '<div id="sc-copilot-pane" class="sc-pane" style="display:none">'
      +   '<div id="sc-cop-msgs" class="cop-msgs"></div>'
      +   '<div class="sc-composer-wrap"><div class="sc-composer"><input id="sc-cop-input" type="text" placeholder="Ask about your leads, pipeline…" autocomplete="off"><button class="sc-send" data-cop-send>Send</button></div></div>'
      + '</div>'
      + '</div>';
    document.body.appendChild(panel);
    copRestore();   // rehydrate the Copilot conversation from sessionStorage (survives refresh)
    scApplyExpanded();   // restore the last expanded/collapsed panel-size preference

    // Anchor flush to the corner unless the AI FAB is present (dashboard) — then
    // clear it. The FAB is injected by layout.js and may land after us, so re-check.
    positionBubble();
    setTimeout(positionBubble, 400);
    setTimeout(positionBubble, 1200);
  }
  // right:20 flush by default; .sc-clear-fab shifts to right:84 beside the AI FAB.
  function positionBubble() {
    var btn = document.getElementById('staff-chat-bubble'); if (!btn) return;
    btn.classList.toggle('sc-clear-fab', !!document.querySelector('.ai-agent-fab'));
  }

  // ── mount: embedded single-column chat (va-dashboard right column) ───────
  function mountColumn(rootEl) {
    _mode = 'column';
    rootEl.classList.add('sc-col-root');
    rootEl.innerHTML =
      '<div class="sc-col">'
      + '<div class="sc-col-head"><span class="sc-col-title">💬 Chat</span>'
      + '<button class="sc-icon" data-sc-new title="New chat">＋</button></div>'
      + '<div class="sc-panel-body">'
      + '<div id="sc-list-view" class="sc-list-view"><div id="sc-thread-list" class="sc-thread-list"></div></div>'
      + '<div id="sc-conv-view" class="sc-conv-view">'
      + '<div class="sc-conv-head"><button class="sc-icon" data-sc-back title="All chats">‹</button><span id="sc-conv-title" class="sc-conv-title"></span></div>'
      + '<div id="sc-messages" class="sc-messages"></div>'
      + composerHtml()
      + '</div></div></div>';
  }

  // ── mount: full page ────────────────────────────────────────────────────
  function mountFull(rootEl) {
    _mode = 'full';
    rootEl.innerHTML =
      '<div class="sc-full">'
      + '<div class="sc-full-left"><div class="sc-full-left-head"><span class="t">💬 Staff Chat <span id="sc-full-unread" style="font-size:11px;color:#888;font-weight:500;"></span></span>'
      + '<button class="sc-icon" data-sc-new title="New chat" style="font-size:18px;">＋</button></div>'
      + '<div id="sc-full-threads"></div></div>'
      + '<div class="sc-full-right"><div class="sc-full-right-head"><span id="sc-full-conv-title">Select a conversation</span></div>'
      + '<div id="sc-full-messages"></div>'
      + composerHtml()
      + '</div></div>';
  }

  // ── events ───────────────────────────────────────────────────────────────
  function wireEvents() {
    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-sc-toggle]')) { setOpen(!_open); return; }
      if (e.target.closest('[data-sc-close]')) { setOpen(false); return; }
      var tabBtn = e.target.closest('[data-sc-tab]'); if (tabBtn) { scSetTab(tabBtn.getAttribute('data-sc-tab')); return; }
      if (e.target.closest('[data-sc-size]')) { scToggleExpanded(); return; }
      var delBtn = e.target.closest('[data-sc-del]');
      if (delBtn) { deleteMessage(delBtn.getAttribute('data-sc-del')); return; }
      // On-demand morning briefing (header button + starter chip). Does NOT touch the
      // once/day auto-brief guard — the user can always pull the briefing up.
      if (e.target.closest('[data-cop-brief]')) { copSend(COP_BRIEF_PROMPT, { briefing: true }); return; }
      // Copilot: send / chips / action-card confirm+dismiss
      if (e.target.closest('[data-cop-send]')) { var ci = document.getElementById('sc-cop-input'); if (ci) { var cv = ci.value; ci.value = ''; copSend(cv); } return; }
      var chip = e.target.closest('[data-cop-chip]');
      if (chip) { var c = chip.getAttribute('data-cop-chip'); if (/\[lead name\]/i.test(c)) { var i2 = document.getElementById('sc-cop-input'); if (i2) { i2.value = 'Summarize '; i2.focus(); } } else copSend(c); return; }
      var cfb = e.target.closest('[data-cop-confirm]'); if (cfb) { copExecAction(cfb.getAttribute('data-cop-confirm')); return; }
      var ccb = e.target.closest('[data-cop-cancel]'); if (ccb) { copCancelAction(ccb.getAttribute('data-cop-cancel')); return; }
      if (e.target.closest('[data-sc-expand]')) { window.location.href = '/admin/chat.html'; return; }
      if (e.target.closest('[data-sc-back]')) { showList(); return; }
      if (e.target.closest('[data-sc-new]')) { showNewChat(); return; }
      if (e.target.closest('[data-sc-send]')) { send(); return; }
      var dlb = e.target.closest('[data-sc-download]'); if (dlb) { downloadAttachment(dlb.getAttribute('data-sc-download'), dlb.getAttribute('data-name')); return; }
      if (e.target.closest('[data-sc-light-close]')) { closeLightbox(); return; }
      /* Backdrop: anywhere inside the overlay that is not the media itself or a
         control. The old test required e.target to BE .sc-light-ov, but
         .sc-light-body covers everything below the bar, so clicks on the dark
         surround never matched and the backdrop appeared dead. */
      var inOv = e.target.closest('#sc-light-ov');
      if (inOv && !e.target.closest('img,video,audio,button')) { closeLightbox(); return; }
      var lb = e.target.closest('[data-sc-light]');
      if (lb) { openLightbox(lb.getAttribute('data-sc-light'), lb.getAttribute('data-name'), lb.getAttribute('data-lkind')); return; }
      if (e.target.closest('[data-sc-attach]')) { var f = document.getElementById('sc-file'); if (f) f.click(); return; }
      if (e.target.closest('[data-sc-record]')) { openRecordMenu(); return; }
      var rm = e.target.closest('[data-sc-tray-remove]'); if (rm) { removePending(rm.getAttribute('data-sc-tray-remove')); return; }
      // record overlay controls
      if (e.target.classList && e.target.classList.contains('sc-rec-ov')) { stopRecording(); closeRecordUi(); return; }
      if (e.target.closest('[data-sc-rec-cancel]')) { stopRecording(); closeRecordUi(); return; }
      var rst = e.target.closest('[data-sc-rec-start]'); if (rst) { beginRecording(rst.getAttribute('data-sc-rec-start')); return; }
      if (e.target.closest('[data-sc-rec-menu]')) { showRecMenu(); return; }
      if (e.target.closest('[data-sc-rec-stop]')) { stopRecording(); return; }
      if (e.target.closest('[data-sc-rec-discard]')) { closeRecordUi(); return; }
      if (e.target.closest('[data-sc-rec-send]')) { sendRecording(); return; }
      var row = e.target.closest('[data-sc-thread]'); if (row) { openThread(row.getAttribute('data-sc-thread')); return; }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.id === 'sc-input') { e.preventDefault(); send(); }
      if (e.key === 'Enter' && e.target && e.target.id === 'sc-cop-input') { e.preventDefault(); var v = e.target.value; e.target.value = ''; copSend(v); }
    });
    document.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'sc-file') { handleFiles(e.target.files); e.target.value = ''; }
    });
    // Persist Copilot action-card textarea edits back to the action model.
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute('data-cop-body')) {
        var a = _copActions[t.getAttribute('data-cop-body')];
        if (a) { if (a.type === 'note') a.text = t.value; else if (a.type === 'appointment') a.notes = t.value; else a.body = t.value; copPersist(); }
      } else if (t && t.getAttribute && t.getAttribute('data-cop-title')) {
        var at = _copActions[t.getAttribute('data-cop-title')]; if (at) { at.title = t.value; copPersist(); }
      } else if (t && t.getAttribute && t.getAttribute('data-cop-subject')) {
        var as = _copActions[t.getAttribute('data-cop-subject')]; if (as) { as.subject = t.value; copPersist(); }
      } else if (t && t.getAttribute && t.getAttribute('data-cop-details')) {
        var ad = _copActions[t.getAttribute('data-cop-details')]; if (ad) { ad.details = t.value; copPersist(); }
      } else if (t && t.getAttribute && t.getAttribute('data-cop-note')) {
        var an = _copActions[t.getAttribute('data-cop-note')]; if (an) { an.note = t.value; copPersist(); }
      }
    });
  }

  // ── init ──────────────────────────────────────────────────────────────
  function start(attempt) {
    attempt = attempt || 0;
    var haveClient = (typeof window.getSupabaseClient === 'function') || !!window._supabaseClient;
    if (!haveClient) { if (attempt < 60) setTimeout(function () { start(attempt + 1); }, 120); return; }  // ~7s cap, then give up quietly
    if (!isStaff()) return;                                    // non-staff → no chat UI
    // Clear the saved Copilot conversation on logout (auth-guard sets adminLogout
    // before injecting this script). sessionStorage clears on browser close anyway.
    if (typeof window.adminLogout === 'function' && !window.adminLogout._copWrapped) {
      var _origLogout = window.adminLogout;
      window.adminLogout = function () { copClearSaved(); return _origLogout.apply(this, arguments); };
      window.adminLogout._copWrapped = true;
    }
    injectCss();
    var root = document.getElementById('staff-chat-fullpage');
    if (root) {
      // Embedded mode (no floating bubble). data-sc-mode="column" → single-column
      // (va-dashboard right rail); otherwise the two-pane full page (chat.html).
      if ((root.getAttribute('data-sc-mode') || 'full') === 'column') mountColumn(root);
      else mountFull(root);
      wireEvents();
      loadThreads().then(function () {
        if (root.getAttribute('data-sc-autoopen') === 'admin') autoOpenAdmin();
      });
    } else {
      mountFloating();                                         // every other admin page → floating bubble
      wireEvents();
      loadThreads();
    }
    startPoll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  /* Session token, no anon fallback. sms-service sends from the business line and
   * checks nothing itself; email-service gates every action but ai_compose. The
   * anon key satisfies only the gateway, which accepts any project-signed JWT. */
  async function _scAuthHeaders(anon) {
    var sb = window._supabaseClient || (window.supabase && window.supabase.auth ? window.supabase : null);
    var jwt = null;
    try { var r = sb && sb.auth ? await sb.auth.getSession() : null; if (r && r.data && r.data.session) jwt = r.data.session.access_token; } catch (e) {}
    if (!jwt) throw new Error('Not signed in — reload the page and sign in again.');
    return { 'Content-Type': 'application/json', 'apikey': anon, 'Authorization': 'Bearer ' + jwt };
  }

})();
