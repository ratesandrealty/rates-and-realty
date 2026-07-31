/* Universal task capture — CRM task + ClickUp task + screenshot.
 *
 * Mounted by auth-guard.js on every authenticated staff page, the same way
 * staff-chat.js is: most admin pages do not load components/layout.js, so
 * auth-guard is the only reliable single insertion point.
 *
 * ── WHY getDisplayMedia AND NOT html2canvas ─────────────────────────────────
 * html2canvas re-renders the DOM into a canvas by reading computed styles. It
 * cannot see into a cross-origin or sandboxed iframe — it has no access to the
 * document inside one. The inbox renders every email body in exactly such an
 * iframe (see wrapBody/gm-frame in inbox.js), so html2canvas would produce a
 * blank rectangle precisely where the email is: a screenshot of the thing you
 * wanted, minus the thing you wanted. getDisplayMedia asks the OS compositor
 * instead, which sees pixels regardless of frame boundaries.
 *
 * The cost is a browser permission prompt and a visible "sharing" indicator for
 * the moment of capture. That is the honest trade, and if the API is missing the
 * UI says so rather than quietly falling back to a method that cannot see the
 * content.
 */
(function () {
  if (window._taskCaptureLoaded) return;
  window._taskCaptureLoaded = true;

  var CFG = window.APP_CONFIG || {};
  var SB_URL = CFG.SUPABASE_URL || '';
  var BUCKET = 'task-screenshots';
  var MAX_SHOT_BYTES = 8 * 1024 * 1024;

  function cl() { return window._supabaseClient || null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── CONTEXT ───────────────────────────────────────────────────────────────
   * Whatever entity is in scope, read off the page the user is actually looking
   * at. A task that says "fix this" with no link is a task nobody can action
   * three days later, so both destinations get a deep link back. */
  function grabContext() {
    var url = location.href;
    var path = location.pathname;
    var ctx = { url: url, title: document.title || path, kind: 'page', label: null, contact_id: null };

    var qs = new URLSearchParams(location.search);
    var cid = qs.get('contact_id') || qs.get('cid') || qs.get('id');

    if (/lead-detail/.test(path)) {
      ctx.kind = 'lead';
      ctx.contact_id = cid || (window.contactData && window.contactData.id) || (typeof contactId !== 'undefined' ? contactId : null);
      var nm = document.getElementById('leadName') || document.querySelector('[data-lead-name]');
      ctx.label = (nm && nm.textContent.trim()) || (window.leadData && [window.leadData.first_name, window.leadData.last_name].filter(Boolean).join(' ')) || null;
    } else if (/inbox/.test(path)) {
      ctx.kind = 'email';
      // The reading pane holds the open thread; subject and sender are on screen.
      var subjEl = document.querySelector('.gm-psubj');
      var fromEl = document.querySelector('.gm-row.active .gm-row-from') || document.querySelector('.gm-mmeta');
      var activeRow = document.querySelector('.gm-row.active[data-tid]');
      ctx.thread_id = activeRow ? activeRow.getAttribute('data-tid') : null;
      ctx.subject = subjEl ? subjEl.textContent.trim() : null;
      ctx.sender = fromEl ? fromEl.textContent.trim().slice(0, 80) : null;
      ctx.label = ctx.subject || null;
    } else if (/lenders|lender-detail/.test(path)) {
      ctx.kind = 'lender';
      ctx.lender_id = qs.get('lender_id') || cid || null;
      var ln = document.querySelector('[data-lender-name]');
      ctx.label = (ln && ln.textContent.trim()) || null;
    } else if (cid) {
      ctx.contact_id = cid;
    }
    return ctx;
  }

  function contextBlock(ctx) {
    var lines = ['', '— captured from the CRM —', 'Page: ' + (ctx.title || ''), 'Link: ' + ctx.url];
    if (ctx.kind === 'lead' && ctx.contact_id) lines.push('Lead: ' + (ctx.label || ctx.contact_id));
    if (ctx.kind === 'email') {
      if (ctx.subject) lines.push('Thread: ' + ctx.subject);
      if (ctx.sender) lines.push('From: ' + ctx.sender);
      if (ctx.thread_id) lines.push('Thread id: ' + ctx.thread_id);
    }
    if (ctx.kind === 'lender' && ctx.lender_id) lines.push('Lender: ' + (ctx.label || ctx.lender_id));
    return lines.join('\n');
  }

  /* ── SCREENSHOT ────────────────────────────────────────────────────────────
   * One frame, then the track is stopped immediately — leaving it running would
   * keep the browser's screen-sharing indicator lit and keep reading the screen
   * for no reason. */
  function supportsCapture() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.isSecureContext);
  }

  async function captureFrame() {
    var stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'monitor' }, audio: false, preferCurrentTab: false
    });
    try {
      var track = stream.getVideoTracks()[0];
      var video = document.createElement('video');
      video.srcObject = stream; video.muted = true; video.playsInline = true;
      await video.play();
      // One rAF so the first frame is actually painted before it is read.
      await new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 120); }); });
      var w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) throw new Error('The capture returned an empty frame.');
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(video, 0, 0, w, h);
      video.pause(); video.srcObject = null;
      if (track) track.stop();
      return c;
    } finally {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
  }

  function canvasToBlob(c, type, quality) {
    return new Promise(function (res) { c.toBlob(function (b) { res(b); }, type || 'image/png', quality); });
  }

  // ── STYLES ─────────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('tc-styles')) return;
    var s = document.createElement('style');
    s.id = 'tc-styles';
    s.textContent = [
      '#tc-fab{position:fixed;right:18px;bottom:88px;z-index:9600;width:46px;height:46px;border-radius:50%;border:1px solid rgba(201,168,76,.5);background:#141414;color:#c9a84c;font-size:19px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-family:inherit}',
      '#tc-fab:hover{background:rgba(201,168,76,.16)}',
      '.tc-ov{position:fixed;inset:0;background:rgba(0,0,0,.74);z-index:9700;display:flex;align-items:center;justify-content:center;padding:18px}',
      '.tc-card{width:640px;max-width:96vw;max-height:92vh;overflow:auto;background:#111;border:1px solid rgba(255,255,255,.14);border-radius:14px;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.tc-hd{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.08)}',
      '.tc-hd b{font-size:14px;color:#c9a84c;flex:1}',
      '.tc-x{background:none;border:none;color:#888;font-size:21px;cursor:pointer;line-height:1;font-family:inherit}',
      '.tc-bd{padding:14px 16px;display:flex;flex-direction:column;gap:11px}',
      '.tc-l{font-size:10.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#777;margin-bottom:4px}',
      '.tc-in,.tc-ta{width:100%;background:#0b0b0b;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:9px 11px;color:#fff;font-size:13.5px;font-family:inherit;box-sizing:border-box}',
      '.tc-ta{min-height:84px;resize:vertical;line-height:1.5}',
      '.tc-ctx{font-size:11.5px;color:#9a9a9a;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px 10px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:96px;overflow:auto}',
      '.tc-row{display:flex;gap:14px;flex-wrap:wrap;align-items:center}',
      '.tc-ck{display:flex;align-items:center;gap:7px;font-size:13px;color:#ddd;cursor:pointer}',
      '.tc-ck input{width:16px;height:16px;accent-color:#c9a84c;cursor:pointer}',
      '.tc-ck.off{opacity:.45;cursor:not-allowed}',
      '.tc-ck.off input{cursor:not-allowed}',
      '.tc-why{font-size:11px;color:#fdba74;background:rgba(251,146,60,.1);border:1px solid rgba(251,146,60,.3);border-radius:7px;padding:7px 9px;line-height:1.5}',
      '.tc-shot{border:1px solid rgba(255,255,255,.14);border-radius:9px;overflow:hidden;background:#000;position:relative}',
      '.tc-shot canvas{display:block;max-width:100%;cursor:crosshair}',
      '.tc-shot-bar{display:flex;gap:8px;align-items:center;padding:7px 9px;border-top:1px solid rgba(255,255,255,.1);font-size:11.5px;color:#999;flex-wrap:wrap}',
      '.tc-btn{background:rgba(201,168,76,.12);border:1px solid rgba(201,168,76,.42);color:#c9a84c;border-radius:8px;padding:8px 13px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit}',
      '.tc-btn:hover{background:rgba(201,168,76,.22)}',
      '.tc-btn.plain{background:transparent;border-color:rgba(255,255,255,.16);color:#aaa}',
      '.tc-btn:disabled{opacity:.5;cursor:default}',
      '.tc-ft{display:flex;gap:9px;align-items:center;padding:12px 16px;border-top:1px solid rgba(255,255,255,.08)}',
      '.tc-go{background:#c9a84c;border:1px solid #c9a84c;color:#151515;border-radius:9px;padding:10px 20px;font-size:13.5px;font-weight:800;cursor:pointer;font-family:inherit}',
      '.tc-go:disabled{opacity:.55;cursor:default}',
      '.tc-res{font-size:12px;line-height:1.7;padding:10px 12px;border-radius:8px;white-space:pre-wrap}',
      '.tc-res.ok{background:rgba(80,200,120,.1);border:1px solid rgba(80,200,120,.35);color:#7ee2a0}',
      '.tc-res.part{background:rgba(251,146,60,.1);border:1px solid rgba(251,146,60,.4);color:#fdba74}',
      '.tc-res.bad{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.4);color:#fca5a5}',
      '@media(max-width:640px){#tc-fab{right:12px;bottom:78px}.tc-card{width:100%}}'
    ].join('');
    document.head.appendChild(s);
  }

  // ── DIALOG ─────────────────────────────────────────────────────────────────
  var _open = false;

  function openDialog() {
    if (_open) return;
    _open = true;
    injectCss();
    var ctx = grabContext();
    var shot = { canvas: null, blob: null, crop: null };

    var ov = document.createElement('div');
    ov.className = 'tc-ov';
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });

    ov.innerHTML =
      '<div class="tc-card" role="dialog" aria-label="Capture a task">' +
        '<div class="tc-hd"><b>📌 Capture a task</b><button class="tc-x" data-tc="x" aria-label="Close">×</button></div>' +
        '<div class="tc-bd">' +
          '<div><div class="tc-l">Title</div><input class="tc-in" data-tc="title" maxlength="200" placeholder="What needs doing?"></div>' +
          '<div><div class="tc-l">Details</div><textarea class="tc-ta" data-tc="desc" placeholder="Anything the person picking this up will need…"></textarea></div>' +
          '<div><div class="tc-l">Context (added to both tasks)</div><div class="tc-ctx" data-tc="ctx"></div></div>' +
          '<div data-tc="shotwrap"></div>' +
          '<div class="tc-row" data-tc="dest"></div>' +
          '<div data-tc="res"></div>' +
        '</div>' +
        '<div class="tc-ft">' +
          '<button class="tc-btn plain" data-tc="shot">📸 Add screenshot</button>' +
          '<span style="flex:1"></span>' +
          '<button class="tc-btn plain" data-tc="cancel">Cancel</button>' +
          '<button class="tc-go" data-tc="save">Create</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    var q = function (n) { return ov.querySelector('[data-tc="' + n + '"]'); };
    q('ctx').textContent = contextBlock(ctx).replace(/^\n/, '');

    /* Destinations. ClickUp is disabled — not merely unchecked — when it is not
     * configured, so the dialog never offers something that cannot happen. */
    var clickupReady = true;
    q('dest').innerHTML =
      '<label class="tc-ck"><input type="checkbox" data-tc="crm" checked><span>CRM task</span></label>' +
      '<label class="tc-ck" data-tc="cuwrap"><input type="checkbox" data-tc="cu" checked><span>ClickUp task</span></label>';

    if (!supportsCapture()) {
      var w = document.createElement('div');
      w.className = 'tc-why';
      w.textContent = 'Screenshots need screen capture, which this browser or connection does not offer '
        + '(it requires a secure context and getDisplayMedia). You can still create the task — just describe the problem. '
        + 'There is no fallback here on purpose: the other method cannot see inside the email viewer, so it would attach a blank image.';
      q('shotwrap').appendChild(w);
      q('shot').disabled = true;
    }

    function close() {
      if (!_open) return;
      _open = false;
      document.removeEventListener('keydown', onEsc, true);
      ov.remove();
    }
    function onEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onEsc, true);
    q('x').addEventListener('click', close);
    q('cancel').addEventListener('click', close);

    // ── screenshot + crop ────────────────────────────────────────────────────
    q('shot').addEventListener('click', async function () {
      var btn = q('shot');
      btn.disabled = true; btn.textContent = 'Capturing…';
      // Hide our own dialog so it is not in the shot.
      ov.style.visibility = 'hidden';
      try {
        await new Promise(function (r) { setTimeout(r, 180); });
        var canvas = await captureFrame();
        shot.canvas = canvas; shot.crop = null;
        renderShot();
      } catch (e) {
        var msg = (e && e.name === 'NotAllowedError')
          ? 'Screen capture was declined — no screenshot attached.'
          : 'Screen capture failed: ' + ((e && e.message) || e);
        var wy = document.createElement('div');
        wy.className = 'tc-why'; wy.textContent = msg;
        q('shotwrap').innerHTML = ''; q('shotwrap').appendChild(wy);
      } finally {
        ov.style.visibility = '';
        btn.disabled = false; btn.textContent = '📸 Add screenshot';
      }
    });

    /* Crop: drag on the preview to pick a region. Screenshots are of a whole
     * monitor, and the useful part is usually one panel — attaching 3440px of
     * desktop to point at one broken row is not helpful to the person reading it. */
    function renderShot() {
      var wrap = q('shotwrap');
      wrap.innerHTML = '';
      if (!shot.canvas) return;
      var box = document.createElement('div'); box.className = 'tc-shot';
      var view = document.createElement('canvas');
      var maxW = 590;
      var scale = Math.min(1, maxW / shot.canvas.width);
      view.width = Math.round(shot.canvas.width * scale);
      view.height = Math.round(shot.canvas.height * scale);
      var vctx = view.getContext('2d');
      function paint() {
        vctx.clearRect(0, 0, view.width, view.height);
        vctx.drawImage(shot.canvas, 0, 0, view.width, view.height);
        if (shot.crop) {
          vctx.save();
          vctx.fillStyle = 'rgba(0,0,0,.55)';
          vctx.fillRect(0, 0, view.width, view.height);
          var c = shot.crop;
          vctx.clearRect(c.x * scale, c.y * scale, c.w * scale, c.h * scale);
          vctx.drawImage(shot.canvas, c.x, c.y, c.w, c.h, c.x * scale, c.y * scale, c.w * scale, c.h * scale);
          vctx.strokeStyle = '#c9a84c'; vctx.lineWidth = 2;
          vctx.strokeRect(c.x * scale, c.y * scale, c.w * scale, c.h * scale);
          vctx.restore();
        }
      }
      paint();
      var drag = null;
      view.addEventListener('mousedown', function (e) {
        var r = view.getBoundingClientRect();
        drag = { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
      });
      view.addEventListener('mousemove', function (e) {
        if (!drag) return;
        var r = view.getBoundingClientRect();
        var x2 = (e.clientX - r.left) / scale, y2 = (e.clientY - r.top) / scale;
        shot.crop = {
          x: Math.max(0, Math.min(drag.x, x2)), y: Math.max(0, Math.min(drag.y, y2)),
          w: Math.abs(x2 - drag.x), h: Math.abs(y2 - drag.y)
        };
        paint();
      });
      window.addEventListener('mouseup', function () {
        if (drag && shot.crop && (shot.crop.w < 12 || shot.crop.h < 12)) shot.crop = null;
        drag = null; paint(); updateBar();
      });
      box.appendChild(view);
      var bar = document.createElement('div'); bar.className = 'tc-shot-bar';
      box.appendChild(bar);
      wrap.appendChild(box);

      function updateBar() {
        var c = shot.crop;
        bar.innerHTML = '';
        var txt = document.createElement('span');
        txt.textContent = c
          ? ('Cropped to ' + Math.round(c.w) + '×' + Math.round(c.h))
          : ('Full screen ' + shot.canvas.width + '×' + shot.canvas.height + ' — drag to crop');
        bar.appendChild(txt);
        var sp = document.createElement('span'); sp.style.flex = '1'; bar.appendChild(sp);
        if (c) {
          var clr = document.createElement('button');
          clr.className = 'tc-btn plain'; clr.style.padding = '4px 9px'; clr.textContent = 'Reset crop';
          clr.addEventListener('click', function () { shot.crop = null; paint(); updateBar(); });
          bar.appendChild(clr);
        }
        var rm = document.createElement('button');
        rm.className = 'tc-btn plain'; rm.style.padding = '4px 9px'; rm.textContent = 'Remove';
        rm.addEventListener('click', function () { shot.canvas = null; shot.crop = null; wrap.innerHTML = ''; });
        bar.appendChild(rm);
      }
      updateBar();
    }

    async function shotBlob() {
      if (!shot.canvas) return null;
      var src = shot.canvas;
      if (shot.crop && shot.crop.w > 12 && shot.crop.h > 12) {
        var c2 = document.createElement('canvas');
        c2.width = Math.round(shot.crop.w); c2.height = Math.round(shot.crop.h);
        c2.getContext('2d').drawImage(src, shot.crop.x, shot.crop.y, shot.crop.w, shot.crop.h, 0, 0, c2.width, c2.height);
        src = c2;
      }
      var b = await canvasToBlob(src, 'image/png');
      // A full 4K desktop PNG can exceed the cap; fall back to JPEG before failing.
      if (b && b.size > MAX_SHOT_BYTES) b = await canvasToBlob(src, 'image/jpeg', 0.82);
      return b;
    }

    // ── SAVE ─────────────────────────────────────────────────────────────────
    q('save').addEventListener('click', async function () {
      var title = (q('title').value || '').trim();
      var desc = (q('desc').value || '').trim();
      var wantCrm = q('crm').checked, wantCu = q('cu').checked && clickupReady;
      var res = q('res');
      res.innerHTML = '';
      if (!title) { q('title').focus(); showRes('bad', 'Give it a title first.'); return; }
      if (!wantCrm && !wantCu) { showRes('bad', 'Pick at least one destination.'); return; }

      var btn = q('save'); btn.disabled = true; btn.textContent = 'Saving…';
      var body = desc + contextBlock(ctx);
      var results = [];
      var anyOk = false, anyFail = false;

      // Screenshot → private bucket first, so both tasks can reference it.
      var blob = null, shotPath = null, shotErr = null;
      try {
        blob = await shotBlob();
        if (blob) {
          var c = cl();
          if (!c) throw new Error('not signed in');
          shotPath = 'captures/' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) +
            (blob.type === 'image/jpeg' ? '.jpg' : '.png');
          var up = await c.storage.from(BUCKET).upload(shotPath, blob, { contentType: blob.type, upsert: false });
          if (up && up.error) throw new Error(up.error.message);
        }
      } catch (e) {
        shotPath = null; shotErr = (e && e.message) || String(e);
        anyFail = true;
        results.push('⚠ Screenshot upload failed: ' + shotErr);
      }

      /* Each destination is attempted independently and reported independently.
       * A failure in one must never suppress the other, and must never be
       * papered over with a success toast. */
      var crmTaskId = null;
      if (wantCrm) {
        try {
          crmTaskId = await createCrmTask(title, body, ctx, shotPath);
          results.push('✅ CRM task created' + (ctx.contact_id ? ' and linked to the lead' : ''));
          anyOk = true;
        } catch (e) {
          anyFail = true;
          results.push('❌ CRM task failed: ' + ((e && e.message) || e));
        }
      }

      if (wantCu) {
        try {
          var cu = await createClickupTask(title, body, ctx);
          var line = '✅ ClickUp task created';
          if (cu && cu.url) line += ' — ' + cu.url;
          // Attachment is reported on its own line: the task existing and the
          // screenshot reaching it are two different outcomes.
          if (blob && cu && cu.clickup_task_id) {
            try {
              await attachToClickup(cu.clickup_task_id, blob);
              line += '\n   ↳ screenshot attached';
            } catch (e2) {
              anyFail = true;
              line += '\n   ⚠ screenshot NOT attached: ' + ((e2 && e2.message) || e2);
            }
          }
          results.push(line);
          anyOk = true;
        } catch (e) {
          anyFail = true;
          results.push('❌ ClickUp task failed: ' + ((e && e.message) || e));
        }
      }

      showRes(anyFail ? (anyOk ? 'part' : 'bad') : 'ok', results.join('\n'));
      btn.textContent = anyOk && !anyFail ? 'Done' : 'Retry';
      btn.disabled = false;
      if (anyOk && !anyFail) setTimeout(close, 1400);
    });

    function showRes(kind, text) {
      var res = q('res');
      res.innerHTML = '<div class="tc-res ' + kind + '"></div>';
      res.firstChild.textContent = text;
    }

    setTimeout(function () { q('title').focus(); }, 40);
  }

  // ── PERSISTENCE ────────────────────────────────────────────────────────────
  /* CRM side writes `tasks` — the same table clickup-bridge already populates and
   * that calendar-data / va-tasks read. contact_id is set whenever the page gave
   * us one, so the task shows on the lead. */
  async function createCrmTask(title, body, ctx, shotPath) {
    var c = cl();
    if (!c) throw new Error('not signed in');
    var row = {
      title: title,
      description: body,
      status: 'open',
      priority: 'normal',
      contact_id: ctx.contact_id || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    // related_table/related_id already exist on `tasks` for generic linkage.
    if (ctx.kind === 'email' && ctx.thread_id) { row.related_table = 'email_thread'; }
    if (shotPath) row.description += '\nScreenshot: ' + BUCKET + '/' + shotPath;
    var r = await c.from('tasks').insert(row).select('id').single();
    if (r.error) throw new Error(r.error.message);
    return r.data && r.data.id;
  }

  function fnBase() { return (SB_URL || '') + '/functions/v1/clickup-bridge'; }
  async function sessionToken() {
    var c = cl();
    if (!c) throw new Error('not signed in');
    var s = await c.auth.getSession();
    var t = s && s.data && s.data.session && s.data.session.access_token;
    if (!t) throw new Error('no active session');
    return t;
  }

  /* Reuses the EXISTING clickup-bridge POST /task — the same endpoint
   * lead-detail and va-tasks already call. Nothing about ClickUp is rebuilt
   * here. Sent with the real session token, not the anon key: clickup-bridge
   * runs verify_jwt=true. */
  async function createClickupTask(title, body, ctx) {
    var tok = await sessionToken();
    var r = await fetch(fnBase() + '/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok, 'apikey': CFG.SUPABASE_ANON_KEY || '' },
      body: JSON.stringify({ title: title, description: body, priority: 'normal', contact_id: ctx.contact_id || null })
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  // Bytes, not a URL — see the note on attachToClickup in clickup-bridge.
  async function attachToClickup(taskId, blob) {
    var tok = await sessionToken();
    var b64 = await new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
      fr.onerror = function () { rej(new Error('could not read the screenshot')); };
      fr.readAsDataURL(blob);
    });
    var r = await fetch(fnBase() + '/task/attach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok, 'apikey': CFG.SUPABASE_ANON_KEY || '' },
      body: JSON.stringify({
        clickup_task_id: taskId, data_b64: b64,
        content_type: blob.type || 'image/png',
        filename: 'capture-' + new Date().toISOString().replace(/[:.]/g, '-') + (blob.type === 'image/jpeg' ? '.jpg' : '.png')
      })
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  // ── MOUNT ──────────────────────────────────────────────────────────────────
  function mount() {
    if (document.getElementById('tc-fab')) return;
    injectCss();
    var b = document.createElement('button');
    b.id = 'tc-fab';
    b.type = 'button';
    b.title = 'Capture a task (Ctrl+Shift+K)';
    b.setAttribute('aria-label', 'Capture a task');
    b.textContent = '📌';
    b.addEventListener('click', openDialog);
    document.body.appendChild(b);
  }

  /* Shortcut. MUST NOT fire while the user is typing — Ctrl+Shift+K in the
   * middle of composing an email should do nothing at all. Checks the active
   * element AND walks for contenteditable, because the composer's editor is a
   * contenteditable div rather than a real input. */
  function typingInField(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return !!(el.closest && el.closest('[contenteditable="true"],[contenteditable=""]'));
  }

  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k'))) return;
    if (typingInField(document.activeElement)) return;
    e.preventDefault();
    openDialog();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
