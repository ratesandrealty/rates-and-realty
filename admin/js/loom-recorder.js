/* admin/js/loom-recorder.js
   Shared, reusable "Loom-style" video recorder. Any staff page can call:

     window.LoomRecorder.open({
       context:    'va_help' | 'sms' | 'email' | 'chat' | ...,   // free-form tag stored on the video
       contact_id: '<uuid>' | null,                              // optional lead association
       onSaved:    function ({ slug, public_url, title, watch_url }) { ... }
     });

   Record modes:
     • 🎥 camera  — getUserMedia camera + mic
     • 🖥️ screen  — getDisplayMedia screen (+ mic mixed in)
     • 🎙️ audio   — mic only
     • ✨ loom    — screen + camera BUBBLE composited on a <canvas> (true Loom)

   On save: upload the webm to the PUBLIC 'video-messages' bucket at
   videos/<uuid>.webm, resolve the public URL, then call the live backend RPC
   video_create(...) which mints a shareable slug. onSaved gets the slug +
   watch_url ( `${location.origin}/watch.html?v=<slug>` ).

   Self-contained (no external deps beyond the page's Supabase client) and
   idempotent — safe to include on any admin/staff page.
*/
(function () {
  'use strict';
  if (window.LoomRecorder) return;

  var BUCKET = 'video-messages';
  var MAX_BYTES = 100 * 1024 * 1024;                 // 100 MB bucket ceiling
  // Watch links go to the PUBLIC apex host (not the admin host the recorder runs on),
  // so links shared to borrowers point at the public site.
  var WATCH_BASE = 'https://ratesandrealty.com';
  var _rec = null;                                   // active recording/session state
  var _opts = {};                                    // caller options for the open session

  function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // Session-aware client: prefer the canonical getter, then the one auth-guard
  // publishes, then a bare anon client (video_create still enforces auth server-side).
  var _sb = null;
  async function client() {
    if (_sb) return _sb;
    try {
      if (typeof window.getSupabaseClient === 'function') _sb = await window.getSupabaseClient();
      else if (window._supabaseClient) _sb = window._supabaseClient;
      else if (window.supabase && window.APP_CONFIG) _sb = window.supabase.createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_ANON_KEY);
    } catch (e) { /* fall through */ }
    return _sb;
  }

  function bestMime(isAudio) {
    var list = isAudio
      ? ['audio/webm;codecs=opus', 'audio/webm']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (var i = 0; i < list.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(list[i])) return list[i];
    }
    return '';
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('loom-recorder-css')) return;
    var s = document.createElement('style'); s.id = 'loom-recorder-css';
    s.textContent = [
      '.lr-ov{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:18px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.lr-box{width:min(560px,96vw);max-height:calc(100vh - 36px);overflow:hidden;background:#0d0d0d;border:1px solid rgba(201,168,76,.32);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.6);display:flex;flex-direction:column}',
      '.lr-head{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.08);font-size:14px;font-weight:700;color:#C9A84C;flex-shrink:0}',
      '.lr-x{background:transparent;border:none;color:#888;font-size:17px;cursor:pointer;padding:4px 8px;border-radius:7px;line-height:1;font-family:inherit}',
      '.lr-x:hover{color:#fff;background:rgba(255,255,255,.06)}',
      '.lr-body{padding:16px;overflow-y:auto;display:flex;flex-direction:column;gap:10px}',
      '.lr-menu{display:flex;flex-direction:column;gap:9px}',
      '.lr-opt{display:flex;align-items:center;gap:12px;text-align:left;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);color:#eee;border-radius:11px;padding:14px 15px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.lr-opt:hover{background:rgba(201,168,76,.12);border-color:rgba(201,168,76,.4)}',
      '.lr-opt .lr-ic{font-size:20px;flex-shrink:0}',
      '.lr-opt .lr-sub{display:block;font-size:11px;font-weight:500;color:#8f8f8f;margin-top:2px}',
      '.lr-stage{background:#000;border-radius:11px;overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:180px;max-height:52vh}',
      '.lr-stage video,.lr-stage canvas{width:100%;max-height:52vh;display:block;object-fit:contain;background:#000}',
      '.lr-audio{display:flex;align-items:center;justify-content:center;gap:12px;padding:44px 18px;color:#ddd;font-size:14px;font-weight:600}',
      '.lr-dot{width:11px;height:11px;border-radius:50%;background:#E5484D;animation:lr-blink 1s steps(2,start) infinite;flex-shrink:0}',
      '@keyframes lr-blink{50%{opacity:.25}}',
      '.lr-ctrl{display:flex;align-items:center;gap:10px}',
      '.lr-timer{font-size:13px;color:#ddd;flex:1;font-variant-numeric:tabular-nums}',
      '.lr-btn{border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;padding:10px 16px}',
      '.lr-btn.gold{background:#C9A84C;color:#111}.lr-btn.gold:hover{background:#d8ba63}',
      '.lr-btn.gold:disabled{opacity:.55;cursor:default}',
      '.lr-btn.stop{background:#E5484D;color:#fff}',
      '.lr-btn.ghost{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);color:#e6e6e6}',
      '.lr-btn.ghost:hover{background:rgba(255,255,255,.12)}',
      '.lr-title{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);border-radius:9px;color:#fff;font-size:13.5px;font-family:inherit;padding:10px 12px;outline:none}',
      '.lr-title:focus{border-color:rgba(201,168,76,.55)}',
      '.lr-label{font-size:11px;color:#8f8f8f;font-weight:600}',
      '.lr-msg{padding:22px 16px;color:#e6c9a0;font-size:13px;line-height:1.55;text-align:center}',
      '.lr-err{color:#f2a5a7;font-size:12.5px;text-align:center;min-height:16px}',
      '.lr-spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(17,17,17,.35);border-top-color:#111;border-radius:50%;animation:lr-spin .7s linear infinite;vertical-align:middle;margin-right:6px}',
      '@keyframes lr-spin{to{transform:rotate(360deg)}}',
      '.lr-foot{display:flex;align-items:center;gap:10px;padding:13px 16px;border-top:1px solid rgba(255,255,255,.08);flex-shrink:0}'
    ].join('');
    document.head.appendChild(s);
  }

  // ── overlay scaffolding ─────────────────────────────────────────────────────
  function ensureOverlay() {
    var ov = document.getElementById('lr-ov');
    if (ov) return ov;
    ov = document.createElement('div'); ov.className = 'lr-ov'; ov.id = 'lr-ov';
    ov.innerHTML = '<div class="lr-box"><div class="lr-head"><span id="lr-title-h">Record a video</span>'
      + '<button type="button" class="lr-x" data-lr-close aria-label="Close">✕</button></div>'
      + '<div class="lr-body" id="lr-body"></div></div>';
    document.body.appendChild(ov);
    return ov;
  }
  function setHead(txt) { var h = document.getElementById('lr-title-h'); if (h) h.textContent = txt; }
  function body() { return document.getElementById('lr-body'); }

  // ── mode picker ─────────────────────────────────────────────────────────────
  function showMenu() {
    teardownStreams();
    setHead('Record a video');
    body().innerHTML =
      '<div class="lr-menu">'
      + opt('loom', '✨', 'Screen + camera bubble', 'Your screen with your face in a circle — the full Loom')
      + opt('screen', '🖥️', 'Screen only', 'Share a tab, window, or your whole screen (with mic)')
      + opt('camera', '🎥', 'Camera + mic', 'Just you, talking to the camera')
      + opt('audio', '🎙️', 'Audio only', 'Voice note — no video')
      + '</div>';
  }
  function opt(mode, ic, title, sub) {
    return '<button type="button" class="lr-opt" data-lr-start="' + mode + '"><span class="lr-ic">' + ic + '</span>'
      + '<span>' + esc(title) + '<span class="lr-sub">' + esc(sub) + '</span></span></button>';
  }

  function permError(mode, detail) {
    teardownStreams();
    setHead('Permission needed');
    var msg = (mode === 'screen' || mode === 'loom')
      ? 'Screen sharing was blocked or cancelled. For "screen + camera" you also need to allow the camera & microphone.'
      : 'Allow the camera & microphone for this site in your browser settings, then try again.';
    body().innerHTML = '<div class="lr-msg">🔒 ' + esc(msg) + '</div>'
      + (detail ? '<div class="lr-err">' + esc(detail) + '</div>' : '')
      + '<div class="lr-ctrl"><button type="button" class="lr-btn ghost" data-lr-menu style="flex:1">← Back</button></div>';
  }

  // ── start a recording ───────────────────────────────────────────────────────
  async function start(mode) {
    if (mode === 'loom') return startLoom();
    var isAudio = (mode === 'audio'), isScreen = (mode === 'screen'), stream;
    try {
      if (isScreen) {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        try { var mic = await navigator.mediaDevices.getUserMedia({ audio: true }); mic.getAudioTracks().forEach(function (t) { stream.addTrack(t); }); } catch (e) { /* mic optional for screen */ }
      } else if (isAudio) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      }
    } catch (e) { permError(mode, e && e.message); return; }
    beginRecorder(stream, stream, mode, isAudio, null);
    renderRecordingUi(mode, isAudio, isScreen ? null : stream, null);
    // Auto-stop if the user ends screen sharing from the browser chrome.
    if (isScreen) watchScreenEnd(stream);
  }

  // ── LOOM: screen + camera bubble composited on a canvas ─────────────────────
  async function startLoom() {
    var screenStream, camStream;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e) { permError('loom', e && e.message); return; }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      try { screenStream.getTracks().forEach(function (t) { t.stop(); }); } catch (x) {}
      permError('loom', (e && e.message) || 'Camera/mic unavailable'); return;
    }

    var screenVid = document.createElement('video'); screenVid.muted = true; screenVid.playsInline = true; screenVid.srcObject = screenStream;
    var camVid = document.createElement('video'); camVid.muted = true; camVid.playsInline = true; camVid.srcObject = camStream;
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');

    try { await screenVid.play(); } catch (e) {}
    try { await camVid.play(); } catch (e) {}
    // Wait for the screen dimensions so the canvas matches.
    await new Promise(function (res) {
      if (screenVid.videoWidth) return res();
      screenVid.addEventListener('loadedmetadata', function () { res(); }, { once: true });
      setTimeout(res, 1500); // safety
    });
    var sw = screenVid.videoWidth || 1280, sh = screenVid.videoHeight || 720;
    if (sw > 1920) { sh = Math.round(sh * (1920 / sw)); sw = 1920; }
    canvas.width = sw; canvas.height = sh;

    // Composite draw loop (screen full-frame + camera circle, bottom-left).
    function drawFrame() {
      if (!_rec || _rec.stopped) return;
      try { ctx.drawImage(screenVid, 0, 0, canvas.width, canvas.height); } catch (e) {}
      if (camVid.videoWidth) {
        var r = Math.round(Math.min(canvas.width, canvas.height) * 0.16);
        var margin = Math.round(r * 0.55);
        var cx = margin + r, cy = canvas.height - margin - r;
        var vw = camVid.videoWidth, vh = camVid.videoHeight, side = Math.min(vw, vh);
        var sx = (vw - side) / 2, sy = (vh - side) / 2;
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        try { ctx.drawImage(camVid, sx, sy, side, side, cx - r, cy - r, r * 2, r * 2); } catch (e) {}
        ctx.restore();
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(2, r * 0.05); ctx.strokeStyle = 'rgba(201,168,76,.92)'; ctx.stroke();
      }
      _rec && (_rec.raf = requestAnimationFrame(drawFrame));
    }

    var canvasStream = canvas.captureStream(30);
    // Mix the mic audio in.
    try { camStream.getAudioTracks().forEach(function (t) { canvasStream.addTrack(t); }); } catch (e) {}

    // extraStreams get torn down on stop; the live canvas is the preview.
    beginRecorder(canvasStream, canvasStream, 'loom', false, {
      screenStream: screenStream, camStream: camStream, screenVid: screenVid, camVid: camVid
    });
    _rec.raf = requestAnimationFrame(drawFrame);
    renderRecordingUi('loom', false, null, canvas);
    watchScreenEnd(screenStream);
  }

  function watchScreenEnd(stream) {
    try {
      var vt = stream.getVideoTracks()[0];
      if (vt) vt.addEventListener('ended', function () { if (_rec && !_rec.stopped) stopRecording(); });
    } catch (e) {}
  }

  // ── recorder wiring shared by all modes ─────────────────────────────────────
  function beginRecorder(recordStream, primaryStream, mode, isAudio, extra) {
    var mime = bestMime(isAudio);
    var recorder;
    try { recorder = mime ? new MediaRecorder(recordStream, { mimeType: mime }) : new MediaRecorder(recordStream); }
    catch (e) { permError(mode, 'Recording is not supported in this browser'); try { recordStream.getTracks().forEach(function (t) { t.stop(); }); } catch (x) {} return; }
    var chunks = [];
    recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = function () {
      var blob = new Blob(chunks, { type: isAudio ? 'audio/webm' : 'video/webm' });
      var dur = _rec ? Math.max(1, Math.round((performance.now() - _rec.startedAt) / 1000)) : 0;
      showPreview(blob, dur, mode, isAudio);
    };
    _rec = {
      recorder: recorder, mode: mode, isAudio: isAudio, stopped: false, raf: null,
      recordStream: recordStream, primaryStream: primaryStream, extra: extra || null,
      startedAt: 0, timer: null, blob: null, previewUrl: null
    };
    try { recorder.start(); _rec.startedAt = performance.now(); }
    catch (e) { permError(mode, 'Could not start recording'); teardownStreams(); return; }
  }

  function renderRecordingUi(mode, isAudio, previewStream, canvasEl) {
    setHead('Recording…');
    var stageInner = isAudio
      ? '<div class="lr-audio"><span class="lr-dot"></span> Recording audio…</div>'
      : '<div class="lr-stage" id="lr-stage"></div>';
    body().innerHTML = stageInner
      + '<div class="lr-ctrl"><span class="lr-dot"></span><span class="lr-timer" id="lr-timer">0:00</span>'
      + '<button type="button" class="lr-btn stop" data-lr-stop>■ Stop</button></div>';
    var stage = document.getElementById('lr-stage');
    if (stage) {
      if (canvasEl) { stage.appendChild(canvasEl); }         // loom: show the live composite
      else if (previewStream) {
        var v = document.createElement('video'); v.autoplay = true; v.muted = true; v.playsInline = true;
        v.srcObject = previewStream; stage.appendChild(v);
      } else {
        // screen mode: don't mirror the capture (avoids a hall-of-mirrors when the
        // shared surface is this tab) — show a simple live indicator instead.
        stage.innerHTML = '<div class="lr-audio"><span class="lr-dot"></span> Recording your screen…</div>';
      }
    }
    var secs = 0;
    _rec.timer = setInterval(function () {
      secs++; var t = document.getElementById('lr-timer');
      if (t) t.textContent = Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2);
    }, 1000);
  }

  function stopRecording() {
    if (!_rec || _rec.stopped) return;
    _rec.stopped = true;
    if (_rec.raf) { cancelAnimationFrame(_rec.raf); _rec.raf = null; }
    if (_rec.timer) { clearInterval(_rec.timer); _rec.timer = null; }
    try { if (_rec.recorder && _rec.recorder.state !== 'inactive') _rec.recorder.stop(); } catch (e) {}
    stopTracks();
  }

  // Stop only capture tracks (keep _rec so onstop can build the preview).
  function stopTracks() {
    if (!_rec) return;
    [_rec.recordStream, _rec.primaryStream].forEach(function (s) { if (s) try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} });
    if (_rec.extra) {
      [_rec.extra.screenStream, _rec.extra.camStream].forEach(function (s) { if (s) try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} });
    }
  }
  // Full teardown (streams + object URL); used on close/menu/re-record.
  function teardownStreams() {
    if (!_rec) return;
    if (_rec.raf) { cancelAnimationFrame(_rec.raf); _rec.raf = null; }
    if (_rec.timer) { clearInterval(_rec.timer); _rec.timer = null; }
    try { if (_rec.recorder && _rec.recorder.state !== 'inactive') { _rec.stopped = true; _rec.recorder.onstop = null; _rec.recorder.stop(); } } catch (e) {}
    stopTracks();
    if (_rec.previewUrl) { try { URL.revokeObjectURL(_rec.previewUrl); } catch (e) {} }
    _rec = null;
  }

  // ── preview + title + save ──────────────────────────────────────────────────
  function showPreview(blob, duration, mode, isAudio) {
    if (!_rec) return;
    var url = URL.createObjectURL(blob);
    _rec.blob = blob; _rec.previewUrl = url; _rec.duration = duration; _rec.kind = mode;
    setHead('Review & save');
    var media = isAudio
      ? '<div class="lr-audio" style="padding:24px 18px"><audio controls src="' + url + '" style="width:100%"></audio></div>'
      : '<div class="lr-stage"><video controls playsinline src="' + url + '"></video></div>';
    body().innerHTML = media
      + '<div class="lr-label">Title</div>'
      + '<input type="text" class="lr-title" id="lr-title-in" placeholder="' + esc(defaultTitle(mode)) + '" value="' + esc(defaultTitle(mode)) + '">'
      + '<div class="lr-err" id="lr-err"></div>'
      + '<div class="lr-ctrl"><button type="button" class="lr-btn ghost" data-lr-menu style="flex:0 0 auto">↺ Re-record</button>'
      + '<span style="flex:1"></span>'
      + '<button type="button" class="lr-btn gold" id="lr-save" data-lr-save>Save &amp; get link</button></div>';
    var inp = document.getElementById('lr-title-in'); if (inp) setTimeout(function () { inp.focus(); inp.select(); }, 40);
  }

  function defaultTitle(mode) {
    var d = new Date();
    var base = mode === 'loom' ? 'Screen + camera' : mode === 'screen' ? 'Screen recording' : mode === 'audio' ? 'Voice note' : 'Video message';
    return base + ' · ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  async function save() {
    if (!_rec || !_rec.blob) return;
    var btn = document.getElementById('lr-save'), errEl = document.getElementById('lr-err');
    var inp = document.getElementById('lr-title-in');
    var title = (inp && inp.value.trim()) || defaultTitle(_rec.kind);
    if (_rec.blob.size > MAX_BYTES) { if (errEl) errEl.textContent = 'Recording is over 100 MB — record a shorter clip.'; return; }
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="lr-spin"></span>Uploading…'; }
    if (errEl) errEl.textContent = '';
    try {
      var cl = await client();
      if (!cl) throw new Error('Not signed in');
      var uuid = crypto.randomUUID();
      var path = 'videos/' + uuid + '.webm';
      var file = new File([_rec.blob], uuid + '.webm', { type: _rec.isAudio ? 'audio/webm' : 'video/webm' });
      var up = await cl.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (up.error) throw up.error;
      var pub = cl.storage.from(BUCKET).getPublicUrl(path);
      var publicUrl = pub && pub.data && pub.data.publicUrl;
      if (!publicUrl) throw new Error('Could not resolve public URL');
      var r = await cl.rpc('video_create', {
        p_title: title, p_storage_path: path, p_public_url: publicUrl,
        p_duration: _rec.duration || 0, p_size: file.size, p_kind: _rec.kind,
        p_contact_id: _opts.contact_id || null, p_context: _opts.context || null
      });
      if (r.error) throw r.error;
      var data = r.data || {};
      var slug = data.slug || '';
      var watchUrl = WATCH_BASE + '/watch.html?v=' + encodeURIComponent(slug);
      var saved = { slug: slug, public_url: data.public_url || publicUrl, title: data.title || title, watch_url: watchUrl };
      closeOverlay();
      if (typeof _opts.onSaved === 'function') { try { _opts.onSaved(saved); } catch (e) { console.error('[loom] onSaved threw', e); } }
    } catch (e) {
      console.error('[loom] save failed', e);
      if (errEl) errEl.textContent = '⚠ ' + ((e && e.message) || 'Save failed — try again');
      if (btn) { btn.disabled = false; btn.innerHTML = 'Save &amp; get link'; }
    }
  }

  // ── open / close ────────────────────────────────────────────────────────────
  function openRecorder(opts) {
    _opts = opts || {};
    injectCss();
    ensureOverlay();
    showMenu();
  }
  function closeOverlay() {
    teardownStreams();
    var ov = document.getElementById('lr-ov'); if (ov) ov.remove();
  }

  // ── events (delegated, scoped to the overlay) ───────────────────────────────
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !document.getElementById('lr-ov')) return;
    if (!e.target.closest('#lr-ov')) return;
    if (e.target.closest('[data-lr-close]')) { closeOverlay(); return; }
    var st = e.target.closest('[data-lr-start]'); if (st) { start(st.getAttribute('data-lr-start')); return; }
    if (e.target.closest('[data-lr-menu]')) { showMenu(); return; }
    if (e.target.closest('[data-lr-stop]')) { stopRecording(); return; }
    if (e.target.closest('[data-lr-save]')) { save(); return; }
  });

  window.LoomRecorder = { open: openRecorder, close: closeOverlay };
})();
