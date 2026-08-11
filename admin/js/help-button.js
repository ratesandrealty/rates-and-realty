/* admin/js/help-button.js
   Universal help-video buttons. Any element with data-help-topic="<key>" gets a
   small ⓘ that opens a popup showing that topic's video + description (from the
   help_topics table). Admins get inline ✎ Edit / Record (reuses window.LoomRecorder).

   Usage:
     <span data-help-topic="crm.lead.pricing" data-help-title="Pricing & Lender">Pricing & Lender</span>
     window.HelpTopic.mount();                    // scan + attach ⓘ (idempotent)
     window.HelpTopic.open('crm.lead.pricing');   // open a topic directly

     data-help-self on the element → wire the click on the element itself instead
     of appending a separate ⓘ (used to repurpose existing info buttons).

   Loaded app-wide by auth-guard.js (like staff-chat.js). Idempotent.
*/
(function () {
  'use strict';
  if (window.HelpTopic) return;

  var LOOM_SRC = '/admin/js/loom-recorder.js?v=742fc14ace';
  var BUCKET = 'video-messages';
  var _cache = {};                 // topic_key -> row
  var _sb = null;

  function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isAdmin() { return (sessionStorage.getItem('rnr_app_role') || '').toLowerCase() === 'admin'; }

  async function client() {
    if (_sb) return _sb;
    try {
      if (typeof window.getSupabaseClient === 'function') _sb = await window.getSupabaseClient();
      else if (window._supabaseClient) _sb = window._supabaseClient;
      else if (window.supabase && window.APP_CONFIG) _sb = window.supabase.createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_ANON_KEY);
    } catch (e) {}
    return _sb;
  }

  function ensureLoom(cb) {
    if (window.LoomRecorder) return cb();
    var ex = document.querySelector('script[src*="/admin/js/loom-recorder.js"]');
    if (ex) { ex.addEventListener('load', cb); return; }
    var s = document.createElement('script'); s.src = LOOM_SRC;
    s.onload = cb; s.onerror = function () { alert('Could not load the recorder.'); };
    document.head.appendChild(s);
  }

  async function fetchTopic(key, force) {
    if (!force && _cache[key]) return _cache[key];
    var cl = await client(); if (!cl) return null;
    try {
      var r = await cl.from('help_topics').select('*').eq('topic_key', key).maybeSingle();
      if (r.error) throw r.error;
      _cache[key] = r.data || { topic_key: key, title: '', description: '', video_url: '', video_slug: '', area: 'both', _new: true };
    } catch (e) {
      console.warn('[help] fetch', key, e && e.message);
      _cache[key] = { topic_key: key, title: '', description: '', video_url: '', video_slug: '', area: 'both', _new: true };
    }
    return _cache[key];
  }

  // ── CSS ─────────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('help-topic-css')) return;
    var s = document.createElement('style'); s.id = 'help-topic-css';
    s.textContent = [
      '.help-i-btn{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-left:6px;padding:0;border-radius:50%;border:1px solid rgba(201,168,76,.55);background:rgba(201,168,76,.12);color:#C9A84C;font-size:11px;font-weight:700;line-height:1;cursor:pointer;font-family:inherit;vertical-align:middle;flex-shrink:0}',
      '.help-i-btn:hover{background:rgba(201,168,76,.24);color:#e6c76a}',
      '.ht-ov{position:fixed;inset:0;z-index:100050;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;padding:18px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.ht-modal{width:min(560px,96vw);max-height:calc(100vh - 40px);overflow:hidden;background:#0d0d0d;border:1px solid rgba(201,168,76,.32);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.6);display:flex;flex-direction:column}',
      '.ht-head{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}',
      '.ht-title{font-size:15px;font-weight:700;color:#C9A84C;flex:1;min-width:0;line-height:1.3}',
      '.ht-x{background:transparent;border:none;color:#888;font-size:17px;cursor:pointer;padding:2px 7px;border-radius:7px;line-height:1;font-family:inherit;flex-shrink:0}',
      '.ht-x:hover{color:#fff;background:rgba(255,255,255,.06)}',
      '.ht-edit{background:transparent;border:1px solid rgba(201,168,76,.4);color:#C9A84C;font-size:11px;font-weight:600;cursor:pointer;padding:3px 9px;border-radius:7px;font-family:inherit;flex-shrink:0}',
      '.ht-edit:hover{background:rgba(201,168,76,.14)}',
      '.ht-body{padding:16px;overflow-y:auto;display:flex;flex-direction:column;gap:12px}',
      '.ht-video{width:100%;border-radius:10px;background:#000;display:block;max-height:52vh}',
      '.ht-desc{font-size:13px;line-height:1.6;color:#dcdcdc;white-space:pre-wrap;word-break:break-word}',
      '.ht-empty{font-size:13px;color:#8a8a8a;text-align:center;padding:10px 0}',
      '.ht-label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#8a8a8a;font-weight:600}',
      '.ht-input,.ht-area{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eee;font-size:13px;padding:9px 11px;outline:none;font-family:inherit}',
      '.ht-input:focus,.ht-ta:focus,.ht-area:focus{border-color:rgba(201,168,76,.5)}',
      '.ht-ta{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eee;font-size:13px;padding:9px 11px;outline:none;font-family:inherit;min-height:96px;resize:vertical;line-height:1.5}',
      '.ht-btns{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.ht-vlbl{font-size:11px;color:#8f8f8f;font-weight:600}',
      '.ht-btn{border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;padding:9px 14px}',
      '.ht-btn.gold{background:#C9A84C;color:#111}.ht-btn.gold:hover{background:#d8ba63}',
      '.ht-btn.gold:disabled{opacity:.55;cursor:default}',
      '.ht-btn.ghost{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);color:#e6e6e6}',
      '.ht-btn.ghost:hover{background:rgba(255,255,255,.12)}',
      '.ht-btn.danger{background:rgba(224,82,82,.14);border:1px solid rgba(224,82,82,.4);color:#ff7b7b}',
      '.ht-err{font-size:12px;color:#f2a5a7;min-height:15px}',
      '.ht-spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(17,17,17,.35);border-top-color:#111;border-radius:50%;animation:ht-spin .7s linear infinite;vertical-align:middle;margin-right:6px}',
      '@keyframes ht-spin{to{transform:rotate(360deg)}}'
    ].join('');
    document.head.appendChild(s);
  }

  // ── mount ───────────────────────────────────────────────────────────────
  function mount(root) {
    injectCss();
    root = root || document;
    var nodes = root.querySelectorAll('[data-help-topic]:not([data-help-mounted])');
    Array.prototype.forEach.call(nodes, function (el) {
      el.setAttribute('data-help-mounted', '1');
      var key = el.getAttribute('data-help-topic');
      var title = el.getAttribute('data-help-title') || '';
      if (el.hasAttribute('data-help-self')) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', function (e) { e.preventDefault(); open(key, title); });
        return;
      }
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'help-i-btn'; btn.setAttribute('aria-label', 'Help'); btn.title = 'Help';
      btn.textContent = 'ⓘ';
      btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); open(key, title); });
      el.appendChild(btn);
    });
  }

  // ── popup ───────────────────────────────────────────────────────────────
  function closePopup() { var ov = document.getElementById('ht-ov'); if (ov) ov.remove(); document.removeEventListener('keydown', _onKey); }
  function _onKey(e) { if (e.key === 'Escape') closePopup(); }

  function shell() {
    closePopup();
    injectCss();
    var ov = document.createElement('div'); ov.className = 'ht-ov'; ov.id = 'ht-ov';
    ov.innerHTML = '<div class="ht-modal"><div class="ht-head"><span class="ht-title" id="ht-title"></span>'
      + '<span id="ht-editslot"></span>'
      + '<button type="button" class="ht-x" data-ht-close aria-label="Close">✕</button></div>'
      + '<div class="ht-body" id="ht-body"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.closest('[data-ht-close]')) closePopup(); });
    document.addEventListener('keydown', _onKey);
    return ov;
  }

  async function open(key, titleHint) {
    shell();
    document.getElementById('ht-title').textContent = titleHint || key;
    document.getElementById('ht-body').innerHTML = '<div class="ht-empty"><span class="ht-spin" style="border-top-color:#C9A84C"></span> Loading…</div>';
    var t = await fetchTopic(key);
    if (!document.getElementById('ht-ov')) return;   // closed while loading
    renderView(key, t, titleHint);
  }

  function renderView(key, t, titleHint) {
    t = t || {};
    document.getElementById('ht-title').textContent = t.title || titleHint || key;
    var slot = document.getElementById('ht-editslot');
    slot.innerHTML = isAdmin() ? '<button type="button" class="ht-edit" data-ht-edit>✎ Edit</button>' : '';
    if (isAdmin()) slot.querySelector('[data-ht-edit]').addEventListener('click', function () { renderEdit(key, t, titleHint); });
    var body = document.getElementById('ht-body');
    var html = '';
    if (t.video_url) html += '<video class="ht-video" controls preload="metadata" playsinline src="' + esc(t.video_url) + '"></video>';
    if (t.description && String(t.description).trim()) html += '<div class="ht-desc">' + esc(t.description) + '</div>';
    if (!t.video_url && !(t.description && String(t.description).trim())) {
      html += '<div class="ht-empty">No help for this topic yet.' + (isAdmin() ? ' Tap ✎ Edit to add a video or description.' : '') + '</div>';
    }
    body.innerHTML = html;
  }

  function renderEdit(key, t, titleHint) {
    t = t || {};
    var draft = { title: t.title || titleHint || '', description: t.description || '', video_url: t.video_url || '', video_slug: t.video_slug || '', area: t.area || 'both' };
    document.getElementById('ht-title').textContent = 'Edit — ' + key;
    document.getElementById('ht-editslot').innerHTML = '';
    var body = document.getElementById('ht-body');
    function paint() {
      var areas = ['va', 'crm', 'both'].map(function (a) { return '<option value="' + a + '"' + (draft.area === a ? ' selected' : '') + '>' + a.toUpperCase() + '</option>'; }).join('');
      body.innerHTML = ''
        + (draft.video_url ? '<video class="ht-video" controls preload="metadata" playsinline src="' + esc(draft.video_url) + '"></video>' : '<div class="ht-empty">No video yet — record or upload one.</div>')
        + '<div><div class="ht-label">Title</div><input type="text" class="ht-input" id="ht-e-title" value="' + esc(draft.title) + '" placeholder="Topic title"></div>'
        + '<div><div class="ht-label">Description</div><textarea class="ht-ta" id="ht-e-desc" placeholder="What does this section do?">' + esc(draft.description) + '</textarea></div>'
        + '<div><div class="ht-label">Area</div><select class="ht-area" id="ht-e-area">' + areas + '</select></div>'
        + '<div class="ht-btns">'
        +   (draft.video_url ? '<span class="ht-vlbl">Replace:</span>' : '')
        +   '<button type="button" class="ht-btn ghost" data-ht-record>🎥 Record</button>'
        +   '<button type="button" class="ht-btn ghost" data-ht-upload>⬆️ Upload</button>'
        +   (draft.video_url ? '<button type="button" class="ht-btn danger" data-ht-delete>🗑 Delete video</button>' : '')
        + '</div>'
        + '<input type="file" accept="video/*" id="ht-e-file" style="display:none">'
        + '<div class="ht-err" id="ht-e-err"></div>'
        + '<div class="ht-btns"><button type="button" class="ht-btn ghost" data-ht-cancel>Cancel</button><span style="flex:1"></span>'
        +   '<button type="button" class="ht-btn gold" id="ht-e-save" data-ht-save>Save</button></div>';
      // sync inputs → draft
      body.querySelector('#ht-e-title').addEventListener('input', function () { draft.title = this.value; });
      body.querySelector('#ht-e-desc').addEventListener('input', function () { draft.description = this.value; });
      body.querySelector('#ht-e-area').addEventListener('change', function () { draft.area = this.value; });
      body.querySelector('[data-ht-cancel]').addEventListener('click', function () { renderView(key, t, titleHint); });
      body.querySelector('[data-ht-record]').addEventListener('click', function () {
        ensureLoom(function () {
          window.LoomRecorder.open({ context: 'help', onSaved: function (v) { applyVideo(key, draft, v.public_url, v.slug || '', paint); } });
        });
      });
      body.querySelector('[data-ht-upload]').addEventListener('click', function () { body.querySelector('#ht-e-file').click(); });
      body.querySelector('#ht-e-file').addEventListener('change', function () {
        var f = this.files && this.files[0]; this.value = '';
        if (f) doUpload(key, f, draft, paint);
      });
      if (body.querySelector('[data-ht-delete]')) body.querySelector('[data-ht-delete]').addEventListener('click', function () { deleteVideo(key, draft, paint); });
      body.querySelector('[data-ht-save]').addEventListener('click', function () { doSave(key, draft, t, titleHint); });
    }
    paint();
  }

  async function doUpload(key, file, draft, repaint) {
    var errEl = document.getElementById('ht-e-err');
    if (file.size > 100 * 1024 * 1024) { if (errEl) errEl.textContent = 'File is over 100 MB.'; return; }
    if (errEl) errEl.innerHTML = '<span class="ht-spin" style="border-top-color:#C9A84C"></span> Uploading…';
    try {
      var cl = await client();
      var ext = ((file.name || '').match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'webm';
      var safe = String(key).replace(/[^a-z0-9._-]/gi, '_');
      var path = 'help/' + safe + '-' + crypto.randomUUID() + '.' + ext.toLowerCase();
      var up = await cl.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'video/webm', upsert: false });
      if (up.error) throw up.error;
      var pub = cl.storage.from(BUCKET).getPublicUrl(path);
      await applyVideo(key, draft, (pub && pub.data && pub.data.publicUrl) || '', '', repaint);   // persist immediately
    } catch (e) { if (errEl) errEl.textContent = '⚠ ' + ((e && e.message) || 'Upload failed'); }
  }

  // Immediately persist a video replace/add — passes null title/description/area so those are
  // KEPT (help_topic_upsert null = no change). Updates the cache + draft, then re-paints.
  async function applyVideo(key, draft, url, slug, repaint) {
    var errEl = document.getElementById('ht-e-err');
    if (errEl) errEl.innerHTML = '<span class="ht-spin" style="border-top-color:#C9A84C"></span> Saving…';
    try {
      var cl = await client();
      var r = await cl.rpc('help_topic_upsert', { p_key: key, p_title: null, p_description: null, p_video_url: url, p_video_slug: slug || null, p_area: null });
      if (r.error) throw r.error;
      if (_cache[key]) { _cache[key].video_url = url; _cache[key].video_slug = slug || ''; }
      draft.video_url = url; draft.video_slug = slug || '';
      if (errEl) errEl.textContent = '';
      if (repaint) repaint();
    } catch (e) { if (errEl) errEl.textContent = '⚠ ' + ((e && e.message) || 'Save failed'); }
  }
  // Delete the video (video_url='') — keeps the topic row + title/description. Best-effort storage remove.
  async function deleteVideo(key, draft, repaint) {
    if (!confirm('Remove this help video?')) return;
    var errEl = document.getElementById('ht-e-err');
    if (errEl) errEl.innerHTML = '<span class="ht-spin" style="border-top-color:#C9A84C"></span> Removing…';
    try {
      var cl = await client();
      var r = await cl.rpc('help_topic_upsert', { p_key: key, p_title: null, p_description: null, p_video_url: '', p_video_slug: null, p_area: null });
      if (r.error) throw r.error;
      var p = _htBucketPath(draft.video_url); if (p) { try { await cl.storage.from(BUCKET).remove([p]); } catch (_) {} }
      if (_cache[key]) { _cache[key].video_url = ''; _cache[key].video_slug = ''; }
      draft.video_url = ''; draft.video_slug = '';
      if (errEl) errEl.textContent = '';
      if (repaint) repaint();
    } catch (e) { if (errEl) errEl.textContent = '⚠ ' + ((e && e.message) || 'Delete failed'); }
  }
  function _htBucketPath(url) {
    var u = String(url || ''), marker = '/storage/v1/object/public/' + BUCKET + '/', i = u.indexOf(marker);
    if (i === -1) return null; return decodeURIComponent(u.slice(i + marker.length).split('?')[0]);
  }

  async function doSave(key, draft, t, titleHint) {
    var btn = document.getElementById('ht-e-save'), errEl = document.getElementById('ht-e-err');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ht-spin"></span>Saving…'; }
    if (errEl) errEl.textContent = '';
    try {
      var cl = await client();
      var r = await cl.rpc('help_topic_upsert', {
        p_key: key, p_title: draft.title || '', p_description: draft.description || '',
        p_video_url: draft.video_url || '', p_video_slug: draft.video_slug || '', p_area: draft.area || 'both'
      });
      if (r.error) throw r.error;
      var saved = { topic_key: key, title: draft.title || '', description: draft.description || '', video_url: draft.video_url || '', video_slug: draft.video_slug || '', area: draft.area || 'both' };
      _cache[key] = saved;
      renderView(key, saved, titleHint);
    } catch (e) {
      if (errEl) errEl.textContent = '⚠ ' + ((e && e.message) || 'Save failed');
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  }

  window.HelpTopic = { mount: mount, open: open, close: closePopup, _cache: _cache };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mount(); });
  else mount();
})();
