/* attachment-viewer — one attachment viewer for every surface.
 *
 * WHY THIS EXISTS
 * The viewer lived inside inbox.js's IIFE and depended on that closure's
 * fetchAttachment, its hover-card state, and its gm-* CSS. No page loads both
 * inbox.js and staff-chat.js, so staff chat could not reach it — which is why
 * a PDF in staff chat downloaded instead of previewing, and why staff chat grew
 * its own half-built lightbox with broken exits.
 *
 * WHAT THE HOST SUPPLIES
 *   AttachmentViewer.open({
 *     name, mime,                        // what to render
 *     fetch: async () => ({ blob, mime, name, size }),
 *     onOpen,                            // optional, before the overlay appears
 *     onDownload,                        // optional, replaces the default save
 *   })
 *
 * fetch() is injected rather than the viewer reaching for data itself. inbox
 * fetches through the Gmail edge function and caches by message/part id; staff
 * chat mints a signed storage URL. Neither contract belongs in here. Note the
 * host does its OWN caching — inbox's fetchAttachment reads four data-att-*
 * attributes off a button and memoises the decoded blob, and inheriting that
 * DOM contract is exactly what would have made this unusable from staff chat.
 *
 * FOUR WAYS OUT, always: X button, backdrop click, Escape, and nothing touching
 * history so browser Back is never required (and never leaves the page).
 *
 * loadPdfJs is EXPOSED because inbox renders PDF hover-card thumbnails with the
 * same library. One pdf.js instance in the app, memoised on window.__pdfjsLib —
 * that was true before the extraction and has to stay true after it.
 */
(function () {
  'use strict';
  if (window.AttachmentViewer) return;

  var PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
  var _pdfjsPromise = null;

  function loadPdfJs() {
    if (window.__pdfjsLib) return Promise.resolve(window.__pdfjsLib);
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = import(PDFJS_SRC).then(function (mod) {
      mod.GlobalWorkerOptions.workerSrc = window.PDFJS_WORKER_URL || PDFJS_WORKER;
      window.__pdfjsLib = mod;
      return mod;
    });
    return _pdfjsPromise;
  }

  var CSS = [
    '.av-ov{position:fixed;inset:0;background:rgba(0,0,0,.86);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px}',
    '.av-card{width:1000px;max-width:97vw;height:92vh;background:#111;border:1px solid rgba(255,255,255,.16);border-radius:13px;display:flex;flex-direction:column;overflow:hidden}',
    '.av-hd{display:flex;align-items:center;gap:7px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}',
    '.av-name{font-size:13px;font-weight:700;color:#eee;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.av-pg{font-size:11.5px;color:#888;flex-shrink:0}',
    '.av-btn{background:rgba(201,168,76,.12);border:1px solid rgba(201,168,76,.4);color:#C9A84C;border-radius:8px;padding:5px 10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}',
    '.av-btn:hover{background:rgba(201,168,76,.22)}',
    '.av-btn.plain{background:transparent;border-color:rgba(255,255,255,.14);color:#aaa}',
    '.av-btn:disabled{opacity:.4;cursor:default}',
    /* 44px minimum: this is reachable on touch, where hover does not exist and a
       20px glyph is not a target. The staff-chat lightbox shipped with a 15px
       #888 X on a near-black backdrop and read as having no close control. */
    '.av-x{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.28);color:#fff;font-size:18px;line-height:1;cursor:pointer;border-radius:10px;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:inherit}',
    '.av-x:hover{background:rgba(255,255,255,.22)}',
    '.av-body{flex:1;min-height:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:16px;background:#0a0a0a}',
    '.av-canvas{background:#fff;border-radius:6px;box-shadow:0 6px 26px rgba(0,0,0,.5);max-width:100%}',
    '.av-img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px}',
    '.av-media{max-width:100%;max-height:100%;background:#000;border-radius:6px;outline:none}',
    '.av-msg{color:#999;font-size:13px;padding:32px;text-align:center}',
    '.av-msg.err{color:#fca5a5}'
  ].join('');

  function injectCss() {
    if (document.getElementById('av-css')) return;
    var st = document.createElement('style'); st.id = 'av-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function open(opts) {
    opts = opts || {};
    injectCss();
    if (typeof opts.onOpen === 'function') { try { opts.onOpen(); } catch (e) {} }

    var name = opts.name || 'attachment';
    var mime = opts.mime || '';
    var isPdf = /pdf/i.test(mime) || /\.pdf$/i.test(name);
    var isImg = /^image\//i.test(mime) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
    var isVid = /^video\//i.test(mime) || /\.(mp4|webm|mov|m4v)$/i.test(name);
    var isAud = /^audio\//i.test(mime) || /\.(mp3|wav|ogg|m4a)$/i.test(name);

    var ov = document.createElement('div');
    ov.className = 'av-ov';
    ov.innerHTML =
      '<div class="av-card">' +
        '<div class="av-hd">' +
          '<span class="av-name"></span>' +
          '<span class="av-pg" data-av="pg"></span>' +
          '<span style="flex:1"></span>' +
          '<button class="av-btn plain" data-av="prev" title="Previous page">&lsaquo;</button>' +
          '<button class="av-btn plain" data-av="next" title="Next page">&rsaquo;</button>' +
          '<button class="av-btn plain" data-av="zout" title="Zoom out">&minus;</button>' +
          '<button class="av-btn plain" data-av="zin" title="Zoom in">+</button>' +
          '<button class="av-btn" data-av="dl">Download</button>' +
          '<button class="av-x" data-av="x" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="av-body" data-av="body"><div class="av-msg">Loading&hellip;</div></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.querySelector('.av-name').textContent = name;

    var q = function (n) { return ov.querySelector('[data-av="' + n + '"]'); };
    var pdf = null, pageNo = 1, zoom = 1, objUrl = null;

    function go(d) { if (!pdf) return; var n = pageNo + d; if (n >= 1 && n <= pdf.numPages) { pageNo = n; draw(); } }

    function close() {
      document.removeEventListener('keydown', onKey, true);
      // Stop playback explicitly — removing the node alone can leave audio running.
      try { Array.prototype.forEach.call(ov.querySelectorAll('video,audio'), function (m) { try { m.pause(); } catch (e) {} }); } catch (e) {}
      if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (e) {} objUrl = null; }
      ov.remove();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (isPdf && e.key === 'ArrowRight') go(1);
      else if (isPdf && e.key === 'ArrowLeft') go(-1);
    }
    document.addEventListener('keydown', onKey, true);
    q('x').addEventListener('click', close);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });

    function hideNav() { ['pg', 'prev', 'next', 'zout', 'zin'].forEach(function (n) { q(n).style.display = 'none'; }); }
    function fail(msg) {
      q('body').innerHTML = '<div class="av-msg err"></div>';
      q('body').firstChild.textContent = msg;
    }

    var rec = null;
    try {
      rec = await opts.fetch();
      if (!rec || !rec.blob) throw new Error('No file data came back');
    } catch (e) {
      hideNav();
      fail((e && e.message) || 'Could not open this attachment');
      return;
    }

    q('dl').addEventListener('click', function () {
      if (typeof opts.onDownload === 'function') { opts.onDownload(rec); return; }
      var u = URL.createObjectURL(rec.blob);
      var a = document.createElement('a'); a.href = u; a.download = rec.name || name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(u); } catch (e2) {} }, 30000);
    });

    if (isImg) {
      hideNav();
      objUrl = URL.createObjectURL(rec.blob);
      q('body').innerHTML = '';
      var im = document.createElement('img'); im.className = 'av-img'; im.src = objUrl; im.alt = name;
      q('body').appendChild(im);
      return;
    }
    if (isVid || isAud) {
      hideNav();
      objUrl = URL.createObjectURL(rec.blob);
      q('body').innerHTML = '';
      var mv = document.createElement(isVid ? 'video' : 'audio');
      mv.className = 'av-media'; mv.src = objUrl; mv.controls = true; mv.autoplay = true;
      if (isVid) mv.playsInline = true;
      q('body').appendChild(mv);
      return;
    }
    if (!isPdf) {
      hideNav();
      q('body').innerHTML = '<div class="av-msg">No preview for this file type &mdash; use Download.</div>';
      return;
    }

    try {
      var lib = await loadPdfJs();
      pdf = await lib.getDocument({ data: await rec.blob.arrayBuffer() }).promise;
    } catch (e) {
      hideNav();
      fail('Could not read this PDF: ' + ((e && e.message) || e));
      return;
    }
    var canvas = document.createElement('canvas');
    canvas.className = 'av-canvas';
    q('body').innerHTML = ''; q('body').appendChild(canvas);

    async function draw() {
      var page = await pdf.getPage(pageNo);
      var base = page.getViewport({ scale: 1 });
      var fitW = Math.min(900, Math.max(320, q('body').clientWidth - 32));
      var vp = page.getViewport({ scale: (fitW / base.width) * zoom });
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      q('pg').textContent = 'Page ' + pageNo + ' / ' + pdf.numPages;
      q('prev').disabled = pageNo <= 1;
      q('next').disabled = pageNo >= pdf.numPages;
    }
    q('prev').addEventListener('click', function () { go(-1); });
    q('next').addEventListener('click', function () { go(1); });
    q('zin').addEventListener('click', function () { zoom = Math.min(3, zoom * 1.25); draw(); });
    q('zout').addEventListener('click', function () { zoom = Math.max(0.4, zoom / 1.25); draw(); });
    draw();
  }

  window.AttachmentViewer = { open: open, loadPdfJs: loadPdfJs, esc: esc };
})();
