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
      await rpc('staff_message_send', { p_thread: _active, p_body: body, p_attachments: atts });
      if (inp) inp.value = '';
      _pending = []; renderTray(); updateSendState();
      await reloadActive(); await rpc('staff_thread_mark_read', { p_thread: _active }); loadThreads();
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
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'staff_messages', filter: 'thread_id=eq.' + threadId },
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
      var atts = Array.isArray(m.attachments) ? m.attachments : [];
      var bodyHtml = m.body ? '<div class="sc-msgbubble">' + esc(m.body) + '</div>' : '';
      var attHtml = atts.length ? '<div class="sc-att-wrap">' + atts.map(attPlaceholderHtml).join('') + '</div>' : '';
      return '<div class="sc-msg' + (mine ? ' mine' : '') + '">'
        + (mine ? '' : '<div class="sc-msg-who">' + esc(localPart(m.sender_email)) + '</div>')
        + bodyHtml + attHtml
        + '<div class="sc-msg-time">' + esc(rel(m.created_at)) + '</div></div>';
    }).join('');
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
  function setOpen(v) { _open = v; var p = document.getElementById('staff-chat-panel'); if (p) p.classList.toggle('is-open', v); if (v) { showList(); loadThreads(); } }

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
  function attViewHtml(kind, mime, url, name, size) {
    var k = kind || kindOf(mime);
    if (k === 'image') return '<a href="' + esc(url) + '" target="_blank" rel="noopener"><img class="sc-att-img" src="' + esc(url) + '" alt="' + esc(name) + '"></a>';
    if (k === 'video' || k === 'recording') return '<video class="sc-att-media" controls preload="metadata" src="' + esc(url) + '"></video>';
    if (k === 'audio') return '<audio class="sc-att-audio" controls preload="metadata" src="' + esc(url) + '"></audio>';
    return '<a class="sc-att-file" href="' + esc(url) + '" target="_blank" rel="noopener"><span class="sc-att-fic">📄</span><span class="sc-att-fmeta"><span class="sc-att-fname">' + esc(name) + '</span><span class="sc-att-fsize">' + esc(humanSize(size)) + '</span></span></a>';
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
        node.innerHTML = attViewHtml(node.getAttribute('data-kind'), node.getAttribute('data-mime'), url, node.getAttribute('data-name'), +node.getAttribute('data-size'));
        var host = node.closest('.sc-messages, #sc-full-messages'); if (host) host.scrollTop = host.scrollHeight;
      }).catch(function () {
        node.innerHTML = '<div class="sc-att-err">⚠ Couldn\'t load ' + esc(node.getAttribute('data-name')) + '</div>';
      });
    });
  }

  // ── recording (camera/mic or screen) ─────────────────────────────────────
  function openRecordMenu() {
    if (!_active) { scToast('Open a conversation first'); return; }
    closeRecordUi();
    var ov = document.createElement('div'); ov.className = 'sc-rec-ov'; ov.id = 'sc-rec-ov';
    ov.innerHTML = '<div class="sc-rec-box"><div class="sc-rec-head"><span>Record</span><button type="button" class="sc-icon" data-sc-rec-cancel>✕</button></div>'
      + '<div class="sc-rec-menu">'
      + '<button type="button" class="sc-rec-opt" data-sc-rec-start="camera">🎥 Record video</button>'
      + '<button type="button" class="sc-rec-opt" data-sc-rec-start="screen">🖥 Record screen</button>'
      + '</div></div>';
    document.body.appendChild(ov);
  }
  function stopTracks() { if (_rec && _rec.stream) { try { _rec.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {} } }
  function closeRecordUi() {
    stopTracks();
    if (_rec && _rec.timer) { clearInterval(_rec.timer); }
    if (_rec && _rec.previewUrl) { try { URL.revokeObjectURL(_rec.previewUrl); } catch (_) {} }
    var ov = document.getElementById('sc-rec-ov'); if (ov) ov.remove();
    _rec = null;
  }
  async function beginRecording(kind) {
    var box = document.querySelector('#sc-rec-ov .sc-rec-box'); if (!box) return;
    var stream;
    try {
      stream = (kind === 'screen')
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        : await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      scToast(kind === 'screen' ? 'Screen recording was blocked or cancelled' : 'Camera / microphone permission denied');
      return;
    }
    var mime = (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('video/webm')) ? 'video/webm' : '';
    var recorder;
    try { recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch (e) { scToast('Recording is not supported in this browser'); try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {} return; }
    var chunks = [];
    recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = function () { showRecPreview(new Blob(chunks, { type: 'video/webm' })); };
    _rec = { recorder: recorder, stream: stream, kind: kind, timer: null, blob: null, previewUrl: null };
    box.innerHTML = '<div class="sc-rec-head"><span>Recording…</span><button type="button" class="sc-icon" data-sc-rec-cancel>✕</button></div>'
      + '<video class="sc-rec-preview" autoplay muted playsinline></video>'
      + '<div class="sc-rec-ctrl"><span class="sc-rec-dot"></span><span id="sc-rec-timer">0:00</span>'
      + '<button type="button" class="sc-rec-stop" data-sc-rec-stop>■ Stop</button></div>';
    var v = box.querySelector('.sc-rec-preview'); if (v) v.srcObject = stream;
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
    var url = URL.createObjectURL(blob);
    _rec.blob = blob; _rec.previewUrl = url;
    box.innerHTML = '<div class="sc-rec-head"><span>Preview</span><button type="button" class="sc-icon" data-sc-rec-cancel>✕</button></div>'
      + '<video class="sc-rec-preview" controls playsinline src="' + url + '"></video>'
      + '<div class="sc-rec-ctrl"><button type="button" class="sc-rec-opt sc-rec-discard" data-sc-rec-discard>Discard</button>'
      + '<button type="button" class="sc-send" data-sc-rec-send>Send recording</button></div>';
  }
  async function sendRecording() {
    if (!_rec || !_rec.blob) return;
    var blob = _rec.blob, label = (_rec.kind === 'screen') ? 'screen' : 'video';
    var file = new File([blob], label + '-' + Date.now() + '.webm', { type: 'video/webm' });
    closeRecordUi();
    await stageFile(file, 'recording');
    send();
  }

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
      '.sc-panel{position:fixed;bottom:84px;right:20px;z-index:95;width:340px;max-width:calc(100vw - 32px);height:460px;max-height:calc(100vh - 120px);background:#0d0d0d;border:1px solid rgba(201,168,76,.28);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden;transform:scale(.94) translateY(14px);opacity:0;pointer-events:none;transition:all .18s cubic-bezier(.4,0,.2,1);transform-origin:bottom right;font-family:inherit}',
      '.sc-panel.is-open{transform:none;opacity:1;pointer-events:auto}',
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
      '.sc-msg-who{font-size:10px;color:#C9A84C;font-weight:700;margin-bottom:2px}',
      '.sc-msgbubble{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);color:#e6e6e6;padding:7px 11px;border-radius:4px 12px 12px 12px;font-size:13px;line-height:1.4;word-break:break-word;white-space:pre-wrap}',
      '.sc-msg.mine .sc-msgbubble{background:rgba(201,168,76,.16);border-color:rgba(201,168,76,.3);color:#fff;border-radius:12px 4px 12px 12px}',
      '.sc-msg-time{font-size:9px;color:#666;margin-top:2px}',
      '.sc-composer{display:flex;gap:6px;align-items:center;padding:10px 12px}',
      '.sc-composer input{flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eee;font-size:13px;padding:8px 11px;outline:none;font-family:inherit}',
      '.sc-send{background:#C9A84C;border:none;color:#111;font-weight:700;font-size:12px;border-radius:8px;padding:0 14px;cursor:pointer;font-family:inherit}',
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
      '.sc-att-img{max-width:220px;max-height:240px;width:auto;border-radius:8px;display:block;cursor:pointer;border:1px solid rgba(255,255,255,.1)}',
      '.sc-att-media{max-width:260px;width:100%;border-radius:8px;background:#000;display:block}',
      '.sc-att-audio{width:230px;max-width:100%;display:block}',
      '.sc-att-file{display:flex;align-items:center;gap:8px;text-decoration:none;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 10px;color:#e6e6e6;max-width:240px}',
      '.sc-att-file:hover{background:rgba(255,255,255,.1)}',
      '.sc-att-fic{font-size:18px;flex-shrink:0}',
      '.sc-att-fmeta{display:flex;flex-direction:column;min-width:0}',
      '.sc-att-fname{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-att-fsize{font-size:10px;color:#888}',
      '.sc-msg.mine .sc-att-file{background:rgba(201,168,76,.14);border-color:rgba(201,168,76,.3)}',
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
    btn.setAttribute('aria-label', 'Staff chat'); btn.setAttribute('data-sc-toggle', '');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true"><path d="M4 5h16a1 1 0 011 1v10a1 1 0 01-1 1H9l-4 4v-4H4a1 1 0 01-1-1V6a1 1 0 011-1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 9.5h8M8 12.5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span id="staff-chat-badge" class="sc-badge"></span>';
    document.body.appendChild(btn);

    var panel = document.createElement('div');
    panel.id = 'staff-chat-panel'; panel.className = 'sc-panel';
    panel.innerHTML =
      '<div class="sc-panel-head"><span class="sc-panel-title">💬 Staff Chat</span>'
      + '<span class="sc-head-actions">'
      + '<button class="sc-icon" data-sc-new title="New chat">＋</button>'
      + '<button class="sc-icon" data-sc-expand title="Open full page">⤢</button>'
      + '<button class="sc-icon" data-sc-close title="Close">✕</button></span></div>'
      + '<div class="sc-panel-body">'
      + '<div id="sc-list-view" class="sc-list-view"><div id="sc-thread-list" class="sc-thread-list"></div></div>'
      + '<div id="sc-conv-view" class="sc-conv-view">'
      + '<div class="sc-conv-head"><button class="sc-icon" data-sc-back title="Back">‹</button><span id="sc-conv-title" class="sc-conv-title"></span></div>'
      + '<div id="sc-messages" class="sc-messages"></div>'
      + composerHtml()
      + '</div></div>';
    document.body.appendChild(panel);

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
      if (e.target.closest('[data-sc-expand]')) { window.location.href = '/admin/chat.html'; return; }
      if (e.target.closest('[data-sc-back]')) { showList(); return; }
      if (e.target.closest('[data-sc-new]')) { showNewChat(); return; }
      if (e.target.closest('[data-sc-send]')) { send(); return; }
      if (e.target.closest('[data-sc-attach]')) { var f = document.getElementById('sc-file'); if (f) f.click(); return; }
      if (e.target.closest('[data-sc-record]')) { openRecordMenu(); return; }
      var rm = e.target.closest('[data-sc-tray-remove]'); if (rm) { removePending(rm.getAttribute('data-sc-tray-remove')); return; }
      // record overlay controls
      if (e.target.classList && e.target.classList.contains('sc-rec-ov')) { stopRecording(); closeRecordUi(); return; }
      if (e.target.closest('[data-sc-rec-cancel]')) { stopRecording(); closeRecordUi(); return; }
      var rst = e.target.closest('[data-sc-rec-start]'); if (rst) { beginRecording(rst.getAttribute('data-sc-rec-start')); return; }
      if (e.target.closest('[data-sc-rec-stop]')) { stopRecording(); return; }
      if (e.target.closest('[data-sc-rec-discard]')) { closeRecordUi(); return; }
      if (e.target.closest('[data-sc-rec-send]')) { sendRecording(); return; }
      var row = e.target.closest('[data-sc-thread]'); if (row) { openThread(row.getAttribute('data-sc-thread')); return; }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.id === 'sc-input') { e.preventDefault(); send(); }
    });
    document.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'sc-file') { handleFiles(e.target.files); e.target.value = ''; }
    });
  }

  // ── init ──────────────────────────────────────────────────────────────
  function start(attempt) {
    attempt = attempt || 0;
    var haveClient = (typeof window.getSupabaseClient === 'function') || !!window._supabaseClient;
    if (!haveClient) { if (attempt < 60) setTimeout(function () { start(attempt + 1); }, 120); return; }  // ~7s cap, then give up quietly
    if (!isStaff()) return;                                    // non-staff → no chat UI
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
})();
