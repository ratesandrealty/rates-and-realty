/* ─────────────────────────────────────────────────────────────────────────────
   The dialer — modal, Twilio.Device, outcome logging — extracted from
   admin/lead-detail.html so it can be mounted on every page.

   WHY EXTRACT RATHER THAN BUILD A SECOND, LIGHTER DIALER
   The modal is not a shell around a phone call. It is where the call gets its
   recording announcement, its ringback, its client_ref correlation token, its
   outcome picker and its calls_log row. A second implementation would have to
   reproduce all of that or quietly skip some of it — and "quietly skip some of
   it" is how a call ends up unlogged, or recorded without the disclosure. One
   dialer, one code path, one set of guarantees.

   THE MOVE WAS DELIBERATELY MECHANICAL. The markup, CSS and logic below are the
   bytes that were in lead-detail.html, which had just been proven by a real
   call. The only additions are at the bottom: the shell mount, the dial-pad
   entry and window.RRDialer. lead-detail still calls openCallModal() exactly as
   before — that global is still exported — so its phone link and Call button
   did not change at all.

   COUPLING, all of it either app-wide or already optional:
     window.fnFetch          app-wide (fn-call.js) — required
     window.APP_CONFIG       app-wide
     showToast               optional, guarded
     window.loadNotes        optional, guarded — lead-detail only
     window.loadActivityTab  optional, guarded — lead-detail only
   On a page that is not lead-detail the panel refreshes simply do not fire,
   which is correct: there are no panels to refresh.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  if (window._rrDialerLoaded) return;              // idempotent
  window._rrDialerLoaded = true;

  var DIALER_CSS = `
  /* dial pad — lives inside the same modal, not a second one */
  .cm-pad{display:flex;flex-direction:column;gap:10px;width:100%;}
  .cm-pad-input{width:100%;box-sizing:border-box;background:#0d0d0d;border:1px solid rgba(201,168,76,0.28);border-radius:10px;color:#F5F0E8;padding:11px 12px;font-size:19px;letter-spacing:.5px;text-align:center;font-family:inherit;font-variant-numeric:tabular-nums;}
  .cm-pad-input:focus{outline:none;border-color:rgba(201,168,76,0.7);}
  .cm-pad-note{min-height:15px;font-size:11.5px;line-height:1.4;color:#8a8475;text-align:center;}
  .cm-pad-note.is-err{color:#E05252;}
  .cm-pad-keys{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;}
  .cm-pad-key{height:42px;border-radius:9px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);color:#F5F0E8;font-size:17px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .12s,border-color .12s;}
  .cm-pad-key:hover{background:rgba(201,168,76,0.14);border-color:rgba(201,168,76,0.4);}
  .cm-pad-key:active{transform:scale(.97);}
  .cm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; align-items: center; justify-content: center; z-index: 9999; backdrop-filter: blur(4px); }
  .cm-overlay.open { display: flex; }
  .cm-modal { width: 360px; background: #111111; border: 1px solid rgba(201,168,76,0.18); border-radius: 18px; padding: 24px 22px 20px; position: relative; font-family: 'DM Sans', system-ui, sans-serif; color: #F5F0E8; }
  .cm-close { position: absolute; top: 14px; right: 14px; width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,0.06); border: none; color: #888; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
  .cm-close:hover { background: rgba(255,255,255,0.1); color: #fff; }
  .cm-avatar-wrap { display: flex; justify-content: center; margin: 8px 0 14px; position: relative; }
  .cm-avatar { width: 84px; height: 84px; border-radius: 50%; background: linear-gradient(135deg, #d4b85a, #a8862e); display: flex; align-items: center; justify-content: center; font-family: 'Playfair Display', Georgia, serif; font-size: 28px; font-weight: 600; color: #1a1208; letter-spacing: 0.02em; position: relative; z-index: 2; }
  .cm-pulse { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 84px; height: 84px; border-radius: 50%; border: 2px solid #C9A84C; opacity: 0; }
  .cm-pulse.ringing { animation: cmPulse 1.6s ease-out infinite; }
  .cm-pulse.ringing.delay { animation-delay: 0.8s; }
  @keyframes cmPulse { 0% { width: 84px; height: 84px; opacity: 0.7; } 100% { width: 160px; height: 160px; opacity: 0; } }
  .cm-name { text-align: center; font-family: 'Playfair Display', Georgia, serif; font-size: 22px; font-weight: 500; color: #F5F0E8; margin: 0 0 4px; letter-spacing: 0.01em; }
  .cm-phone { text-align: center; font-family: 'DM Mono', ui-monospace, monospace; font-size: 14px; color: #C9A84C; margin: 0 0 10px; letter-spacing: 0.04em; }
  .cm-status { text-align: center; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; margin: 0 0 18px; height: 14px; }
  .cm-status.ready { color: #888; }
  .cm-status.ringing { color: #C9A84C; }
  .cm-status.connected { color: #4CAF7D; }
  .cm-status.ended { color: #E05454; }
  .cm-status .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
  .cm-status.ringing .dot { background: #C9A84C; animation: cmBlink 1s ease-in-out infinite; }
  .cm-status.connected .dot { background: #4CAF7D; }
  @keyframes cmBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .cm-timer { text-align: center; font-family: 'DM Mono', ui-monospace, monospace; font-size: 32px; font-weight: 400; color: #F5F0E8; margin: 0 0 18px; letter-spacing: 0.08em; height: 38px; }
  .cm-timer.muted { color: #555; }
  .cm-actions { display: flex; justify-content: center; gap: 14px; margin: 4px 0 18px; }
  .cm-btn { width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.15s ease; font-family: inherit; }
  .cm-btn:hover { transform: translateY(-1px); }
  .cm-btn:active { transform: translateY(0) scale(0.96); }
  .cm-btn.secondary { background: rgba(255,255,255,0.06); color: #ccc; }
  .cm-btn.secondary:hover { background: rgba(255,255,255,0.1); color: #fff; }
  .cm-btn.secondary.active { background: rgba(201,168,76,0.2); color: #C9A84C; }
  .cm-btn.call { width: 64px; height: 64px; background: #4CAF7D; color: #06200f; box-shadow: 0 0 0 0 rgba(76,175,125,0.5); }
  .cm-btn.call:hover { background: #5cc28d; }
  .cm-btn.call.pulsing { animation: cmCallPulse 2s ease-out infinite; }
  @keyframes cmCallPulse { 0% { box-shadow: 0 0 0 0 rgba(76,175,125,0.5); } 70% { box-shadow: 0 0 0 14px rgba(76,175,125,0); } 100% { box-shadow: 0 0 0 0 rgba(76,175,125,0); } }
  .cm-btn.hangup { width: 64px; height: 64px; background: #E05454; color: #fff; }
  .cm-btn.hangup:hover { background: #ec6666; }
  .cm-btn-label { font-size: 10px; color: #666; text-align: center; margin-top: 6px; letter-spacing: 0.06em; text-transform: uppercase; }
  .cm-action-group { display: flex; flex-direction: column; align-items: center; }
  .cm-divider { height: 1px; background: rgba(201,168,76,0.1); margin: 0 -22px 14px; }
  .cm-section-label { font-size: 10px; color: #666; letter-spacing: 0.14em; text-transform: uppercase; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
  .cm-section-label svg { width: 12px; height: 12px; opacity: 0.7; }
  .cm-msg-list { display: flex; flex-direction: column; gap: 8px; max-height: 130px; overflow: hidden; }
  .cm-msg { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: rgba(255,255,255,0.03); border-radius: 8px; font-size: 12px; }
  .cm-msg-arrow { color: #C9A84C; flex-shrink: 0; }
  .cm-msg-text { color: #ccc; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cm-msg-time { color: #666; font-family: 'DM Mono', ui-monospace, monospace; font-size: 11px; flex-shrink: 0; }
  .cm-notes { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.03); border: 1px solid rgba(201,168,76,0.12); border-radius: 8px; padding: 10px 12px; color: #F5F0E8; font-family: inherit; font-size: 13px; resize: none; height: 38px; outline: none; transition: border-color 0.15s; }
  .cm-notes:focus { border-color: rgba(201,168,76,0.3); }
  .cm-notes::placeholder { color: #555; }
  .cm-outcome { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0 0 12px; }
  .cm-outcome-btn { padding: 10px 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; color: #ccc; font-size: 12px; cursor: pointer; font-family: inherit; text-align: left; transition: all 0.15s; }
  .cm-outcome-btn:hover { background: rgba(201,168,76,0.08); border-color: rgba(201,168,76,0.25); color: #F5F0E8; }
  .cm-outcome-btn.success { color: #6dd49b; }
  .cm-outcome-btn.danger { color: #f08484; }
  .cm-outcome-btn.selected { background: rgba(201,168,76,0.15); border-color: rgba(201,168,76,0.4); color: #C9A84C; }
  .cm-save { width: 100%; padding: 11px; background: #C9A84C; color: #1a1208; border: none; border-radius: 8px; font-family: inherit; font-size: 13px; font-weight: 500; cursor: pointer; letter-spacing: 0.04em; transition: background 0.15s; }
  .cm-save:hover { background: #d4b85a; }
  /* Shape lock — defeat any inherited button rules that would stretch these into ovals */
  #callModal .cm-btn,
  #callModal .cm-btn.call,
  #callModal .cm-btn.hangup,
  #callModal .cm-btn.secondary {
    width: 52px !important;
    height: 52px !important;
    border-radius: 50% !important;
    padding: 0 !important;
    flex: 0 0 auto !important;
    aspect-ratio: 1 / 1 !important;
  }
  #callModal .cm-btn.call,
  #callModal .cm-btn.hangup {
    width: 64px !important;
    height: 64px !important;
  }`;

  var DIALER_HTML = `<div id="callModal" class="cm-overlay">
  <div class="cm-modal" id="cmModalInner">
    <button class="cm-close" id="cmCloseBtn" aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>
    <div class="cm-avatar-wrap">
      <div class="cm-pulse" id="cmPulse1"></div>
      <div class="cm-pulse delay" id="cmPulse2"></div>
      <div class="cm-avatar" id="cmAvatar">RD</div>
    </div>
    <h3 class="cm-name" id="cmName">Contact Name</h3>
    <p class="cm-phone" id="cmPhone">(000) 000-0000</p>
    <div class="cm-status ready" id="cmStatus"><span class="dot"></span><span id="cmStatusText">Ready to call</span></div>
    <div class="cm-timer muted" id="cmTimer">00:00</div>
    <div class="cm-actions" id="cmActions"></div>
    <div id="cmFooter"></div>
  </div>
</div>

<!-- Voicemail Picker Modal -->
<div id="vm-picker-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10001;align-items:center;justify-content:center;">
  <div style="background:#111;border:2px solid rgba(201,168,76,0.3);border-radius:14px;padding:24px;width:400px;max-width:95vw;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 style="color:#E8D5A3;font-size:15px;">&#x1f399; Voicemail Drop</h3>
      <button onclick="closeVmPicker()" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;">&#x2715;</button>
    </div>
    <div id="vm-library" style="max-height:250px;overflow-y:auto;margin-bottom:12px;"></div>
    <button onclick="recordNewVoicemail()" style="width:100%;padding:10px;background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.3);border-radius:8px;color:#C9A84C;font-size:12px;cursor:pointer;font-family:inherit;">+ Record New Voicemail</button>
  </div>
</div>`;

  /* The modal markup has to exist before bindRefs() looks for it. */
  function mountShell() {
    if (document.getElementById('callModal')) return;
    if (!document.getElementById('rr-dialer-css')) {
      var st = document.createElement('style');
      st.id = 'rr-dialer-css';
      st.textContent = DIALER_CSS;
      document.head.appendChild(st);
    }
    var wrap = document.createElement('div');
    wrap.innerHTML = DIALER_HTML;
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
  }
  if (document.body) mountShell();
  else document.addEventListener('DOMContentLoaded', mountShell);

/* ═══ BROWSER CALLING (Twilio.Device) ═══ */
var VOICE_FN = 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/twilio-voice';
var SUPABASE_BASE = 'https://ljywhvbmsibwnssxpesh.supabase.co';

(function() {
  function getAnon() { return (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_ANON_KEY) || ''; }

  var modal, closeBtn, avatar, nameEl, phoneEl, status, statusText, timer, actions, footer, pulse1, pulse2;
  var device = null, activeCall = null, callStart = null, timerInterval = null;
  var currentCallRef = '';          // correlation token for the row twilio-voice logs at dial time
  var muted = false, speakerOn = false, currentContact = null, selectedOutcome = null, callDuration = 0;

  function bindRefs() {
    modal = document.getElementById('callModal');
    closeBtn = document.getElementById('cmCloseBtn');
    avatar = document.getElementById('cmAvatar');
    nameEl = document.getElementById('cmName');
    phoneEl = document.getElementById('cmPhone');
    status = document.getElementById('cmStatus');
    statusText = document.getElementById('cmStatusText');
    timer = document.getElementById('cmTimer');
    actions = document.getElementById('cmActions');
    footer = document.getElementById('cmFooter');
    pulse1 = document.getElementById('cmPulse1');
    pulse2 = document.getElementById('cmPulse2');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (modal) modal.addEventListener('click', function(e) { if (e.target === modal) closeModal(); });
  }

  function toE164(p) {
    var d = (p || '').replace(/\D/g, '');
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return '+' + d;
  }
  function fmtTime(secs) {
    var m = Math.floor(secs / 60), s = secs % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, function(c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]; });
  }
  function timeAgo(date) {
    var s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s/60) + 'm';
    if (s < 86400) return Math.floor(s/3600) + 'h';
    return Math.floor(s/86400) + 'd';
  }
  function formatDisplayPhone(p) {
    var d = (p || '').replace(/\D/g, '');
    if (d.length === 10) return '(' + d.slice(0,3) + ') ' + d.slice(3,6) + '-' + d.slice(6);
    if (d.length === 11 && d[0] === '1') return '(' + d.slice(1,4) + ') ' + d.slice(4,7) + '-' + d.slice(7);
    return p || '';
  }

  function startTimer() {
    callStart = Date.now();
    timerInterval = setInterval(function() {
      callDuration = Math.floor((Date.now() - callStart) / 1000);
      if (timer) timer.textContent = fmtTime(callDuration);
    }, 1000);
  }
  function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }

  var phoneIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var hangupIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" style="transform: rotate(135deg);"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function micIcon(m) {
    return m
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M1 1l22 22M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6M17 16.95A7 7 0 015 12v-2m7 10v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" stroke-width="2"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }
  function speakerIcon(on) {
    return on
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H2v6h4l5 4V5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H2v6h4l5 4V5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M23 9l-6 6M17 9l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }
  var msgIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  /* ── RECORDING TOGGLE ──────────────────────────────────────────────────────
   * DEFAULT ON. The announcement is what makes recording lawful here, and it
   * plays on every recorded call; the transcript and the AI summary are the
   * product of the recording, so defaulting off would silently remove the
   * feature people actually use. Off is a deliberate act, per call.
   *
   * The state is remembered per user for the NEXT call but always re-shown, so
   * "on because I chose it" and "on because it defaults" look identical at the
   * moment it matters — which is the moment before dialling.
   *
   * VISIBLE DURING THE CALL, not just before it. Once dialling starts the
   * control becomes a read-only badge in the same place, so the answer to "is
   * this being recorded?" is on screen for the whole call rather than being
   * something you had to notice earlier. It stops being editable at that point
   * because nothing here can start or stop a capture mid-call — Twilio supports
   * it, we do not call it, and a switch that silently does nothing mid-call is
   * worse than no switch. */
  var _recOn = true;
  try {
    var _rk = 'rr_call_record:' + ((window._adminUser && (window._adminUser.id || window._adminUser.email)) || 'anon');
    var _rv = localStorage.getItem(_rk);
    if (_rv === 'off') _recOn = false;
  } catch (_) { /* storage blocked — default ON */ }
  function _recPersist() {
    try {
      localStorage.setItem('rr_call_record:' + ((window._adminUser && (window._adminUser.id || window._adminUser.email)) || 'anon'),
        _recOn ? 'on' : 'off');
    } catch (_) {}
  }
  function recToggleHtml(live) {
    var on = _recOn;
    var tip = on
      ? 'This call is announced and recorded. The transcript and AI summary come from that recording.'
      : 'No announcement will play and nothing is captured — and so there is NO transcript and NO AI summary for this call.';
    if (live) {
      return '<div class="cm-rec-badge" title="' + tip + '" style="display:flex;align-items:center;justify-content:center;gap:6px;'
        + 'margin:8px auto 0;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;width:max-content;'
        + (on ? 'background:rgba(224,82,82,.14);border:1px solid rgba(224,82,82,.4);color:#F07878;'
              : 'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);color:#9a948a;') + '">'
        + (on ? '<span style="width:7px;height:7px;border-radius:50%;background:#E5484D;display:inline-block;"></span> Recording'
              : 'Not recorded — no transcript') + '</div>';
    }
    return '<button type="button" id="cmRecToggle" title="' + tip + '" style="display:flex;align-items:center;gap:7px;'
      + 'margin:10px auto 0;padding:5px 11px;border-radius:999px;font-size:11px;font-weight:700;cursor:pointer;width:max-content;'
      + (on ? 'background:rgba(224,82,82,.12);border:1px solid rgba(224,82,82,.38);color:#F07878;'
            : 'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.16);color:#9a948a;') + '">'
      + (on ? '<span style="width:7px;height:7px;border-radius:50%;background:#E5484D;display:inline-block;"></span> Record this call'
            : 'Recording off') + '</button>'
      + '<div style="text-align:center;font-size:10px;line-height:1.4;margin-top:5px;color:'
      + (on ? '#7a746a' : '#C9A84C') + ';">'
      + (on ? 'Announced at the start. Transcript + AI summary after.'
            : 'No announcement, no transcript, no AI summary.') + '</div>';
  }
  function wireRecToggle() {
    var b = document.getElementById('cmRecToggle');
    if (b) b.addEventListener('click', function () { _recOn = !_recOn; _recPersist(); renderReady(); });
  }

  function renderReady() {
    status.className = 'cm-status ready';
    statusText.textContent = 'Ready to call';
    pulse1.classList.remove('ringing'); pulse2.classList.remove('ringing');
    timer.textContent = '00:00'; timer.className = 'cm-timer muted';
    actions.innerHTML =
      '<div class="cm-action-group">' +
        '<button class="cm-btn call pulsing" id="cmStartBtn" aria-label="Start call">' + phoneIcon + '</button>' +
        '<span class="cm-btn-label">Call</span>' +
      '</div>' + recToggleHtml(false);
    document.getElementById('cmStartBtn').addEventListener('click', startCall);
    wireRecToggle();
    renderRecentMessages();
  }

  function renderRecentMessages() {
    footer.innerHTML =
      '<div class="cm-divider"></div>' +
      '<div class="cm-section-label">' + msgIcon + '<span>Recent messages</span></div>' +
      '<div class="cm-msg-list" id="cmMsgList"><div class="cm-msg" style="color:#666;justify-content:center;">Loading…</div></div>';
    if (!currentContact || !currentContact.id) {
      var lst = document.getElementById('cmMsgList');
      if (lst) lst.innerHTML = '<div class="cm-msg" style="color:#555;justify-content:center;">No contact selected</div>';
      return;
    }
    var anon = getAnon();
    fetch(SUPABASE_BASE + '/rest/v1/sms_log?contact_id=eq.' + currentContact.id + '&order=created_at.desc&limit=3&select=body,created_at,direction', {
      headers: { apikey: anon, Authorization: 'Bearer ' + anon }
    }).then(function(r) { return r.json(); }).then(function(msgs) {
      var list = document.getElementById('cmMsgList');
      if (!list) return;
      if (!msgs || !msgs.length) {
        list.innerHTML = '<div class="cm-msg" style="color:#555;justify-content:center;">No messages yet</div>';
        return;
      }
      list.innerHTML = msgs.map(function(m) {
        var ago = timeAgo(new Date(m.created_at));
        var arrow = m.direction === 'outbound' ? '→' : '←';
        return '<div class="cm-msg"><span class="cm-msg-arrow">' + arrow + '</span><span class="cm-msg-text">' + escapeHtml((m.body||'').slice(0,60)) + '</span><span class="cm-msg-time">' + ago + '</span></div>';
      }).join('');
    }).catch(function() {
      var list = document.getElementById('cmMsgList');
      if (list) list.innerHTML = '<div class="cm-msg" style="color:#555;justify-content:center;">Could not load messages</div>';
    });
  }

  function renderRinging() {
    status.className = 'cm-status ringing';
    statusText.textContent = 'Ringing';
    pulse1.classList.add('ringing'); pulse2.classList.add('ringing');
    timer.className = 'cm-timer muted';
    actions.innerHTML =
      '<div class="cm-action-group">' +
        '<button class="cm-btn hangup" id="cmCancelBtn" aria-label="Cancel call">' + hangupIcon + '</button>' +
        '<span class="cm-btn-label">Cancel</span>' +
      '</div>' + recToggleHtml(true);
    document.getElementById('cmCancelBtn').addEventListener('click', hangup);
    footer.innerHTML =
      '<div class="cm-divider"></div>' +
      '<div class="cm-section-label" style="justify-content:center;"><span style="color:#888;">Calling via Twilio</span></div>';
  }

  function renderConnected() {
    status.className = 'cm-status connected';
    statusText.textContent = 'Connected';
    pulse1.classList.remove('ringing'); pulse2.classList.remove('ringing');
    timer.className = 'cm-timer';
    actions.innerHTML =
      '<div class="cm-action-group">' +
        '<button class="cm-btn secondary' + (muted ? ' active' : '') + '" id="btnMute" aria-label="Mute">' + micIcon(muted) + '</button>' +
        '<span class="cm-btn-label">' + (muted ? 'Muted' : 'Mute') + '</span>' +
      '</div>' +
      '<div class="cm-action-group">' +
        '<button class="cm-btn hangup" id="cmEndBtn" aria-label="End call">' + hangupIcon + '</button>' +
        '<span class="cm-btn-label">End</span>' +
      '</div>' +
      '<div class="cm-action-group">' +
        '<button class="cm-btn secondary' + (speakerOn ? ' active' : '') + '" id="btnSpeaker" aria-label="Speaker">' + speakerIcon(speakerOn) + '</button>' +
        '<span class="cm-btn-label">Speaker</span>' +
      '</div>' + recToggleHtml(true);
    document.getElementById('btnMute').addEventListener('click', toggleMute);
    document.getElementById('btnSpeaker').addEventListener('click', toggleSpeaker);
    document.getElementById('cmEndBtn').addEventListener('click', hangup);
    footer.innerHTML =
      '<div class="cm-divider"></div>' +
      '<div class="cm-section-label">Live notes</div>' +
      '<textarea class="cm-notes" id="cmLiveNotes" placeholder="Type call notes — saved with call log..."></textarea>';
  }

  function renderEnded() {
    status.className = 'cm-status ended';
    statusText.textContent = 'Call ended · ' + fmtTime(callDuration);
    pulse1.classList.remove('ringing'); pulse2.classList.remove('ringing');
    timer.className = 'cm-timer';
    /* The badge survives into the ended state: the question "was that call
       recorded?" is asked most often just after hanging up. */
    actions.innerHTML = recToggleHtml(true);
    var liveNotes = (document.getElementById('cmLiveNotes') && document.getElementById('cmLiveNotes').value) || '';
    footer.innerHTML =
      '<div class="cm-divider"></div>' +
      '<div class="cm-section-label">Log outcome</div>' +
      '<div class="cm-outcome" id="cmOutcomeGrid">' +
        '<button class="cm-outcome-btn success" data-outcome="spoke_interested">✓ Spoke — interested</button>' +
        '<button class="cm-outcome-btn" data-outcome="no_answer">No answer</button>' +
        '<button class="cm-outcome-btn" data-outcome="left_voicemail">Left voicemail</button>' +
        '<button class="cm-outcome-btn danger" data-outcome="not_interested">Not interested</button>' +
      '</div>' +
      '<textarea class="cm-notes" id="cmEndNotes" placeholder="Add call notes..." style="height: 56px; margin-bottom: 12px;">' + escapeHtml(liveNotes) + '</textarea>' +
      '<button class="cm-save" id="cmSaveBtn">Save & close</button>';
    document.querySelectorAll('#cmOutcomeGrid .cm-outcome-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('#cmOutcomeGrid .cm-outcome-btn').forEach(function(b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        selectedOutcome = btn.dataset.outcome;
      });
    });
    document.getElementById('cmSaveBtn').addEventListener('click', saveAndClose);
  }

  /* Sends the SIGNED-IN USER via fn-call.js, not the anon key — same helper and
   * pattern as admin/js/crm-comms.js. get_token mints a one-hour Twilio Voice
   * capability JWT that can dial any number from the business line, so the anon
   * key (printed in this page's own source, identifying nobody) was the wrong
   * credential for it by a wide margin.
   *
   * FRONTEND HALF ONLY — twilio-voice still has no guard on its JSON actions, so
   * a mistake here shows up as a dialer that still works rather than an outage.
   * No anon fallback: a fallback authenticates nobody and turns a clear "not
   * signed in" into an unexplainable 401 once the guard lands. */
  function _voiceFetch(payload) {
    if (typeof window.fnFetch !== 'function') {
      return Promise.reject(new Error('fn-call.js is not loaded — cannot call twilio-voice as the signed-in user.'));
    }
    return window.fnFetch('twilio-voice', { method: 'POST', body: JSON.stringify(payload) });
  }

  function fetchToken() {
    return _voiceFetch({ action: 'get_token' }).then(function(r) { return r.json(); });
  }

  /* THE SDK IS LOADED ON DEMAND, not by every page.
   *
   * @twilio/voice-sdk was a <script> tag in lead-detail.html only. Now that the
   * dialer mounts app-wide, that tag would have had to go on all 30 pages —
   * ~90 KB and a third-party connection on every admin page load, for a feature
   * most visits never touch. Loading it at the moment someone actually presses
   * call costs one short wait on the first call of a session and nothing after.
   * lead-detail still has its own tag; this resolves immediately when Twilio is
   * already present. */
  function ensureSdk() {
    if (window.Twilio && window.Twilio.Device) return Promise.resolve();
    if (window._rrTwilioSdkP) return window._rrTwilioSdkP;
    window._rrTwilioSdkP = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.11.3/dist/twilio.min.js';
      s.onload = function () {
        if (window.Twilio && window.Twilio.Device) resolve();
        else reject(new Error('Twilio Voice SDK loaded but Device is missing'));
      };
      s.onerror = function () {
        window._rrTwilioSdkP = null;          // let a later attempt retry
        reject(new Error('Could not load the Twilio Voice SDK'));
      };
      document.head.appendChild(s);
    });
    return window._rrTwilioSdkP;
  }

  function getDevice() {
    if (device && device.state !== 'destroyed') return Promise.resolve(device);
    return ensureSdk().then(fetchToken).then(function(data) {
      if (!data.token) throw new Error(data.error || 'Failed to get Twilio token');
      // v2 SDK: new Device(token, options); explicit register() before connect()
      device = new Twilio.Device(data.token, {
        codecPreferences: ['opus', 'pcmu'],
        logLevel: 'warn'
      });
      device.on('registered', function() { console.log('[twilio] device registered'); });
      device.on('error', function(err) { console.error('[twilio] device error', err); });
      device.on('tokenWillExpire', function() {
        fetchToken().then(function(d) {
          if (d.token) device.updateToken(d.token);
        }).catch(function(e) { console.error('[twilio] token refresh failed', e); });
      });
      return device.register().then(function() { return device; });
    });
  }

  function startCall() {
    if (!currentContact || !currentContact.phone) {
      alert('No phone number for this contact');
      return;
    }
    getDevice().then(function(dev) {
      renderRinging();
      /* Ref is an opaque correlation token, NOT a call id and NOT a credential.
       * Twilio forwards custom connect params to the TwiML app, so the server
       * sees this Ref and the real CallSid in the same signed request; it logs
       * the row there and we echo the Ref back on log_call so it updates that
       * row rather than inserting a second, SID-less one.
       *
       * The browser deliberately does not send a CallSid. It never reliably had
       * one — activeCall is null by the time Save & close runs — and a SID from
       * the browser is a value the server never verified. */
      currentCallRef = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      // v2 SDK: device.connect() returns a Promise that resolves to a Call
      /* Record travels with the dial. The SERVER decides what that means:
       twilio-voice gates canRecord() on it, which drops the record= attribute
       AND the disclosure together. Anything but an explicit 'off' records. */
      return dev.connect({ params: { To: toE164(currentContact.phone), Ref: currentCallRef, Record: _recOn ? 'on' : 'off' } });
    }).then(function(conn) {
      if (!conn) return;
      activeCall = conn;
      conn.on('ringing', function() { /* keep ringing UI */ });
      conn.on('accept', function() { startTimer(); renderConnected(); });
      conn.on('disconnect', function() { stopTimer(); renderEnded(); activeCall = null; });
      conn.on('cancel', function() { stopTimer(); renderEnded(); activeCall = null; });
      conn.on('reject', function() { stopTimer(); renderEnded(); activeCall = null; });
      conn.on('error', function(e) {
        console.error('[twilio call]', e);
        stopTimer();
        renderEnded();
        activeCall = null;
      });
    }).catch(function(e) {
      console.error('[startCall]', e);
      alert('Could not start call: ' + ((e && e.message) || e));
      renderReady();
    });
  }

  function hangup() {
    if (activeCall) {
      try { activeCall.disconnect(); } catch(e) {}
    } else {
      stopTimer();
      renderEnded();
    }
  }
  function toggleMute() {
    muted = !muted;
    if (activeCall) { try { activeCall.mute(muted); } catch(e) {} }
    renderConnected();
  }
  function toggleSpeaker() {
    speakerOn = !speakerOn;
    renderConnected();
  }

  function saveAndClose() {
    var notes = (document.getElementById('cmEndNotes') && document.getElementById('cmEndNotes').value) || '';
    /* No twilio_call_sid is sent any more. It was ALWAYS '' here: this runs from
     * the ended screen, after conn.on('disconnect') set activeCall = null, and
     * window._currentCallSid is only ever assigned ''. The server took the real
     * SID from Twilio's signed webhook at dial time; we send the Ref so it
     * updates that row. */
    var contactIdForRefresh = (currentContact && currentContact.id) || null;

    function refreshPanels() {
      // Refresh sections that may show the new call entry / call note
      if (typeof window.loadNotes === 'function') { try { window.loadNotes(); } catch(_) {} }
      if (typeof window.loadActivityTab === 'function') { try { window.loadActivityTab(); } catch(_) {} }
      try { window.dispatchEvent(new CustomEvent('call-logged', { detail: { contact_id: contactIdForRefresh } })); } catch(_) {}
    }

    _voiceFetch({
      action: 'log_call',
      contact_id: contactIdForRefresh,
      to: (currentContact && currentContact.phone) || null,
      duration: callDuration,
      status: 'completed',
      notes: notes,
      outcome: selectedOutcome,
      client_ref: currentCallRef
    }).then(refreshPanels, function(e) {
      console.warn('[log_call]', e);
      refreshPanels();
    });

    if (typeof showToast === 'function') showToast('Call logged: ' + (selectedOutcome || 'completed').replace(/_/g, ' '));
    closeModal();
  }

  function closeModal() {
    if (activeCall) { try { activeCall.disconnect(); } catch(e) {} activeCall = null; }
    stopTimer();
    callDuration = 0;
    muted = false; speakerOn = false; selectedOutcome = null;
    if (modal) modal.classList.remove('open');
  }

  // Backward-compatible API: accepts either openCallModal({id, first_name, last_name, phone})
  // or legacy openCallModal(name, phone, contactId)
  window.openCallModal = function(arg, phoneArg, contactIdArg) {
    if (!modal) bindRefs();
    var contact;
    if (arg && typeof arg === 'object') {
      contact = arg;
    } else {
      var nameStr = (arg || '').trim();
      var parts = nameStr.split(/\s+/);
      contact = {
        id: contactIdArg || null,
        first_name: parts[0] || nameStr,
        last_name: parts.slice(1).join(' '),
        phone: phoneArg || ''
      };
    }
    currentContact = contact;
    // Expose to legacy voicemail-drop helpers below
    window._callPhone = contact.phone || '';
    window._callContactId = contact.id || null;
    window._currentCallSid = '';

    var initials = ((contact.first_name && contact.first_name[0]) || '').toUpperCase()
                 + ((contact.last_name && contact.last_name[0]) || '').toUpperCase();
    if (!initials) initials = '?';
    avatar.textContent = initials;
    var displayName = ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim() || 'Unknown';
    nameEl.textContent = displayName;
    phoneEl.textContent = formatDisplayPhone(contact.phone || '');

    callDuration = 0;
    muted = false; speakerOn = false; selectedOutcome = null;
    modal.classList.add('open');
    renderReady();
  };

  // Legacy helpers retained for the (now-orphaned) voicemail picker modal
  window.closeCallModal = closeModal;

  // Bind on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindRefs);
  } else {
    bindRefs();
  }
})();
})();

/* ── ad-hoc dial pad ─────────────────────────────────────────────────────────
 *
 * The FAB's Call action. It does NOT open a second modal — it opens the one
 * above with no contact attached, so the avatar, timer, mute, speaker, outcome
 * picker and calls_log write are all the same code a lead-detail call uses. The
 * only difference is that the number is typed rather than looked up.
 *
 * contact_id is null for an ad-hoc number, which calls_log allows: the column is
 * nullable and is already null on every inbound row. actor_user_id still says
 * who dialled, which is the attribution that matters here. */
(function () {
  function padHtml() {
    return '<div class="cm-pad">'
      + '<input id="cmPadNum" class="cm-pad-input" type="tel" inputmode="tel" autocomplete="off" placeholder="(555) 123-4567" aria-label="Phone number to dial">'
      + '<div class="cm-pad-note" id="cmPadNote"></div>'
      + '<div class="cm-pad-keys">'
      +   ['1','2','3','4','5','6','7','8','9','*','0','#']
            .map(function (k) { return '<button type="button" class="cm-pad-key" data-k="' + k + '">' + k + '</button>'; }).join('')
      + '</div></div>';
  }

  function digitsOf(v) { return (v || '').replace(/[^0-9*#]/g, ''); }
  function pretty(v) {
    var d = (v || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length > 6) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6, 10);
    if (d.length > 3) return '(' + d.slice(0, 3) + ') ' + d.slice(3);
    return d;
  }

  window.RRDialer = {
    open: function (contact) { window.openCallModal(contact); },
    openPad: function () {
      window.openCallModal({ id: null, first_name: '', last_name: '', phone: '' });
      var actions = document.getElementById('cmActions');
      var footerEl = document.getElementById('cmFooter');
      var avatar = document.getElementById('cmAvatar');
      var nameEl = document.getElementById('cmName');
      var phoneEl = document.getElementById('cmPhone');
      var statusText = document.getElementById('cmStatusText');
      if (avatar) avatar.textContent = '#';
      if (nameEl) nameEl.textContent = 'New call';
      if (phoneEl) phoneEl.textContent = '';
      if (statusText) statusText.textContent = 'Enter a number';
      if (footerEl) footerEl.innerHTML = '';
      if (!actions) return;

      actions.innerHTML = padHtml()
        + '<div class="cm-action-group" style="margin-top:14px;">'
        +   '<button class="cm-btn call" id="cmPadDial" aria-label="Call">'
        +     '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        +   '</button><span class="cm-btn-label">Call</span></div>';

      var input = document.getElementById('cmPadNum');
      var note = document.getElementById('cmPadNote');
      var dial = document.getElementById('cmPadDial');
      if (input) { input.focus(); input.addEventListener('input', function () { if (note) note.textContent = ''; }); }

      Array.prototype.forEach.call(actions.querySelectorAll('.cm-pad-key'), function (b) {
        b.addEventListener('click', function () {
          if (!input) return;
          input.value = pretty(digitsOf(input.value) + b.getAttribute('data-k'));
          input.focus();
          if (note) note.textContent = '';
        });
      });

      async function go() {
        var raw = digitsOf(input && input.value);
        if (raw.replace(/\D/g, '').length < 10) {
          if (note) { note.className = 'cm-pad-note is-err'; note.textContent = 'Enter a 10-digit number.'; }
          return;
        }
        dial.disabled = true;
        if (note) { note.className = 'cm-pad-note'; note.textContent = 'Checking calling hours…'; }
        /* ASK BEFORE RINGING. twilio-voice checks again when it actually places
           the call — that is the control — but refusing here means the
           recipient's phone never rings and the reason is on screen rather than
           heard as a hangup. */
        try {
          var res = await window.fnFetch('twilio-voice', {
            method: 'POST', body: JSON.stringify({ action: 'dial_precheck', to: raw })
          });
          var v = await res.json();
          if (v && v.allowed === false) {
            dial.disabled = false;
            if (note) { note.className = 'cm-pad-note is-err'; note.textContent = v.reason || 'Outside calling hours.'; }
            return;
          }
          if (v && v.known === false && note) note.textContent = 'Unknown area code — allowed, and logged.';
        } catch (e) {
          dial.disabled = false;
          if (note) { note.className = 'cm-pad-note is-err'; note.textContent = 'Could not check calling hours: ' + ((e && e.message) || 'error'); }
          return;
        }
        window.openCallModal({ id: null, first_name: pretty(raw), last_name: '', phone: raw });
        var startBtn = document.getElementById('cmStartBtn');
        if (startBtn) startBtn.click();
      }

      dial.addEventListener('click', go);
      if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    }
  };

  /* Hidden trigger for the action FAB. The FAB shows a row only when its source
     control exists in the DOM and forwards a click to it — the same inherited
     gate Pin and Chat use — so this is what makes Call appear, and it appears
     only where the dialer is actually mounted. */
  function mountHook() {
    if (document.getElementById('rr-dial-fab')) return;
    var b = document.createElement('button');
    b.id = 'rr-dial-fab';
    b.type = 'button';
    b.setAttribute('aria-hidden', 'true');
    b.style.display = 'none';
    b.addEventListener('click', function () { window.RRDialer.openPad(); });
    document.body.appendChild(b);
  }
  if (document.body) mountHook();
  else document.addEventListener('DOMContentLoaded', mountHook);
})();
