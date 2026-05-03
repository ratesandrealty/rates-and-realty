/* tour-builder.js — Tour Builder Modal (PR 2)
 *
 * Public API:
 *   window.openTourBuilder({ batch_id?, contact_id?, prefill_stop?, onClose? })
 *   window.handleAddToTour(mlsNumber, opts?)
 *
 * Pages using it: admin/showings.html, admin/lead-detail.html,
 *   public/search-homes.html, public/property-detail.html
 *
 * The builder is a 3-tab modal (Setup / Stops / Send). All Setup-tab fields
 * and per-stop fields save on blur (debounced) via tours-admin update_tour /
 * update_stop. Reminder toggles save on toggle. Only "Send now" is an
 * explicit confirm action — UX decision #3.
 */
(function () {
  'use strict';

  // -------- Config ---------------------------------------------------------
  var SUPABASE_URL = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_URL) ||
    'https://ljywhvbmsibwnssxpesh.supabase.co';
  var ANON_KEY = (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_ANON_KEY) ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqeXdodmJtc2lid25zc3hwZXNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNjE2NTUsImV4cCI6MjA4OTYzNzY1NX0.QaewUhTWdATj35VewvmfQcHB_b3I9FhhwXSRuqNBKvw';
  var TOUR_BASE = window.location.origin + '/tour/';

  // -------- State ----------------------------------------------------------
  // Single open builder at a time. Re-entrant openTourBuilder() closes prior.
  var state = null;

  function makeState(opts) {
    return {
      opts: opts || {},
      tour: null,                  // full tour record from get_tour
      stops: [],                   // array of stops
      contact: null,               // resolved contact for summary
      activeTab: 'setup',
      saveTimers: {},              // field -> debounce timer id
      pendingSaves: 0,             // count of in-flight saves for indicator
      lastSavedAt: null,
      mlsPreviewProperty: null,    // pending MLS lookup result
      isClosing: false,
    };
  }

  // -------- Utilities -----------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(action, payload, endpoint) {
    var ep = endpoint || 'tours-admin';
    return fetch(SUPABASE_URL + '/functions/v1/' + ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ANON_KEY },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    }).then(function (r) { return r.json(); }).catch(function (e) { return { error: e.message }; });
  }

  // Direct PostgREST select on contacts (people-admin lacks search_contacts).
  function searchContactsDirect(query) {
    var q = String(query || '').trim();
    if (!q) return Promise.resolve([]);
    var safe = q.replace(/[,()*]/g, ' ');
    var url = SUPABASE_URL + '/rest/v1/contacts'
      + '?select=id,first_name,last_name,email,phone'
      + '&or=(' + 'first_name.ilike.*' + encodeURIComponent(safe) + '*'
      + ',last_name.ilike.*' + encodeURIComponent(safe) + '*'
      + ',email.ilike.*' + encodeURIComponent(safe) + '*'
      + ',phone.ilike.*' + encodeURIComponent(safe) + '*' + ')'
      + '&limit=8';
    return fetch(url, {
      headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY },
    }).then(function (r) { return r.json(); }).catch(function () { return []; });
  }

  function getContactById(id) {
    if (!id) return Promise.resolve(null);
    var url = SUPABASE_URL + '/rest/v1/contacts'
      + '?select=id,first_name,last_name,email,phone'
      + '&id=eq.' + encodeURIComponent(id);
    return fetch(url, {
      headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY },
    }).then(function (r) { return r.json(); })
      .then(function (rows) { return Array.isArray(rows) && rows[0] ? rows[0] : null; })
      .catch(function () { return null; });
  }

  function fmtMoney(n) {
    if (n == null || n === '') return '';
    var num = Number(n);
    if (!isFinite(num)) return '';
    return '$' + num.toLocaleString();
  }

  function fmtNumber(n) {
    if (n == null || n === '') return '';
    var num = Number(n);
    if (!isFinite(num)) return '';
    return num.toLocaleString();
  }

  function fmtDateLong(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  // tours-admin returns scheduled_start as ISO with timezone. The form uses
  // separate <input type=date> + <input type=time>. Convert without timezone
  // shifting that would happen with toISOString().
  function splitScheduledStart(iso) {
    if (!iso) return { date: '', time: '' };
    var d = new Date(iso);
    if (isNaN(d.getTime())) return { date: '', time: '' };
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return {
      date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
      time: pad(d.getHours()) + ':' + pad(d.getMinutes()),
    };
  }

  function joinScheduledStart(date, time) {
    if (!date) return null;
    var t = time && /^\d{2}:\d{2}/.test(time) ? time : '09:00';
    return date + 'T' + t + ':00';
  }

  // arrival_time can be ISO timestamp or HH:MM — extract HH:MM for the input.
  function extractTime(s) {
    if (!s) return '';
    if (typeof s === 'string' && /^\d{2}:\d{2}/.test(s)) return s.slice(0, 5);
    var m = String(s).match(/T(\d{2}:\d{2})/);
    if (m) return m[1];
    return '';
  }

  function debounce(key, fn, ms) {
    if (state.saveTimers[key]) clearTimeout(state.saveTimers[key]);
    state.saveTimers[key] = setTimeout(fn, ms || 600);
  }

  function setSaveIndicator(text, kind) {
    var el = $('.tb-save-indicator');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.kind = kind || '';
  }

  function startSave() {
    state.pendingSaves++;
    setSaveIndicator('Saving…', 'pending');
  }

  function endSave(error) {
    state.pendingSaves = Math.max(0, state.pendingSaves - 1);
    if (error) {
      setSaveIndicator('⚠ Save failed — ' + error, 'error');
      return;
    }
    state.lastSavedAt = Date.now();
    if (state.pendingSaves === 0) setSaveIndicator('✓ Saved', 'ok');
  }

  // -------- CSS injection -------------------------------------------------
  function injectStyles() {
    if (document.getElementById('tb-styles')) return;
    var css = `
      .tb-modal{position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;font-family:'Segoe UI',Arial,sans-serif}
      .tb-card{background:#141414;border:1px solid #2a2a2a;border-radius:14px;width:100%;max-width:780px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.6);color:#e8e8e8;overflow:hidden}
      .tb-head{padding:16px 22px;border-bottom:1px solid #1f1f1f;display:flex;align-items:center;justify-content:space-between}
      .tb-head .tb-title{font-size:1.05rem;font-weight:700;color:#eee;margin:0;line-height:1.2}
      .tb-head .tb-sub{font-size:.7rem;color:#C9A84C;text-transform:uppercase;letter-spacing:.1em;font-weight:700;margin-bottom:4px}
      .tb-x{background:none;border:none;color:#888;font-size:1.25rem;cursor:pointer;padding:0 6px;line-height:1}
      .tb-x:hover{color:#eee}
      .tb-tabs{display:flex;border-bottom:1px solid #1f1f1f;padding:0 12px;gap:4px;flex-shrink:0}
      .tb-tab{background:none;border:none;color:#666;padding:11px 18px;font-size:.85rem;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;font-family:inherit}
      .tb-tab:hover{color:#aaa}
      .tb-tab.active{color:#C9A84C;border-bottom-color:#C9A84C}
      .tb-tab .tb-tab-count{display:inline-block;background:rgba(201,168,76,.15);color:#C9A84C;border-radius:10px;padding:1px 7px;font-size:.7rem;margin-left:5px;font-weight:700}
      .tb-body{padding:18px 22px;overflow-y:auto;flex:1;min-height:240px}
      .tb-foot{padding:9px 22px;border-top:1px solid #1f1f1f;font-size:.72rem;color:#666;flex-shrink:0;display:flex;align-items:center;gap:10px;min-height:34px}
      .tb-save-indicator{font-size:.72rem;color:#666}
      .tb-save-indicator[data-kind=ok]{color:#6ed47e}
      .tb-save-indicator[data-kind=error]{color:#ff8888}
      .tb-save-indicator[data-kind=pending]{color:#C9A84C}
      .tb-form-row{margin-bottom:16px}
      .tb-form-row label{display:block;font-size:.72rem;color:#888;text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:6px}
      .tb-form-row label .tb-hint{font-weight:400;color:#555;text-transform:none;letter-spacing:0;margin-left:6px}
      .tb-form-row input[type=text],.tb-form-row input[type=date],.tb-form-row input[type=time],.tb-form-row textarea{width:100%;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:8px;padding:9px 12px;color:#e8e8e8;font-size:.86rem;font-family:inherit;outline:none}
      .tb-form-row input:focus,.tb-form-row textarea:focus{border-color:#C9A84C}
      #tour-builder-modal input[type=date],#tour-builder-modal input[type=time]{color-scheme:dark;cursor:pointer;position:relative}
      #tour-builder-modal input[type=date]::-webkit-calendar-picker-indicator,#tour-builder-modal input[type=time]::-webkit-calendar-picker-indicator{filter:invert(.7) sepia(.5) saturate(2.5) hue-rotate(15deg);cursor:pointer;opacity:.85;padding:6px;margin-left:4px;transition:opacity .15s,transform .15s}
      #tour-builder-modal input[type=date]::-webkit-calendar-picker-indicator:hover,#tour-builder-modal input[type=time]::-webkit-calendar-picker-indicator:hover{opacity:1;transform:scale(1.15)}
      #tour-builder-modal input[type=date]:hover,#tour-builder-modal input[type=time]:hover{border-color:rgba(201,168,76,.5)}
      .tb-form-row textarea{resize:vertical;min-height:60px}
      .tb-form-row-split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .tb-contact-picker{position:relative}
      .tb-contact-results{position:absolute;top:100%;left:0;right:0;background:#0d0d0d;border:1px solid #2a2a2a;border-top:none;border-radius:0 0 8px 8px;max-height:240px;overflow-y:auto;z-index:10}
      .tb-contact-result{padding:10px 12px;cursor:pointer;border-bottom:1px solid #1a1a1a;font-size:.82rem}
      .tb-contact-result:last-child{border-bottom:none}
      .tb-contact-result:hover{background:#1a1a1a}
      .tb-contact-result .tb-cr-name{color:#e8e8e8;font-weight:600}
      .tb-contact-result .tb-cr-meta{color:#666;font-size:.72rem;margin-top:2px}
      .tb-contact-summary{background:#0d0d0d;border:1px solid #2a2a2a;border-radius:8px;padding:12px 14px;display:flex;align-items:center;gap:12px}
      .tb-contact-summary .tb-cs-name{font-weight:700;color:#e8e8e8}
      .tb-contact-summary .tb-cs-meta{font-size:.74rem;color:#888;margin-top:3px}
      .tb-link{background:none;border:none;color:#C9A84C;font-size:.78rem;cursor:pointer;padding:0;text-decoration:underline;margin-left:auto}
      .tb-btn{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer;border:none;font-family:inherit;transition:all .15s}
      .tb-btn-primary{background:#C9A84C;color:#000}.tb-btn-primary:hover{background:#e8c96a}.tb-btn-primary:disabled{opacity:.5;cursor:not-allowed}
      .tb-btn-secondary{background:#1a1a1a;border:1px solid #2a2a2a;color:#e8e8e8}.tb-btn-secondary:hover{border-color:#C9A84C;color:#C9A84C}
      .tb-btn-danger{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ff8888}.tb-btn-danger:hover{background:rgba(239,68,68,.2)}
      .tb-add-stop-bar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
      .tb-add-stop-bar input{flex:1;min-width:200px;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:8px;padding:9px 12px;color:#e8e8e8;font-size:.86rem;outline:none;font-family:inherit}
      .tb-add-stop-bar input:focus{border-color:#C9A84C}
      .tb-mls-preview{background:#0d0d0d;border:1px solid #C9A84C44;border-radius:10px;padding:12px;margin-bottom:14px;display:flex;gap:12px;align-items:flex-start}
      .tb-mls-preview img{width:120px;height:90px;object-fit:cover;border-radius:6px;flex-shrink:0;background:#1a1a1a}
      .tb-mls-preview .tb-mp-body{flex:1;min-width:0}
      .tb-mls-preview .tb-mp-addr{font-weight:700;color:#e8e8e8;font-size:.92rem}
      .tb-mls-preview .tb-mp-meta{font-size:.78rem;color:#888;margin-top:4px}
      .tb-mls-preview .tb-mp-agent{font-size:.74rem;color:#C9A84C;margin-top:4px}
      .tb-mls-preview .tb-mp-actions{display:flex;flex-direction:column;gap:6px;flex-shrink:0}
      .tb-stops-list{display:flex;flex-direction:column;gap:10px}
      .tb-stop{background:#0d0d0d;border:1px solid #2a2a2a;border-radius:10px;padding:10px;display:grid;grid-template-columns:18px 28px 90px 1fr auto auto;gap:10px;align-items:center;transition:border-color .15s,opacity .15s}
      .tb-stop.tb-drop-above{border-top:2px solid #C9A84C}
      .tb-stop.tb-drop-below{border-bottom:2px solid #C9A84C}
      .tb-stop .tb-handle{cursor:grab;color:#444;font-size:1rem;letter-spacing:-2px;user-select:none;text-align:center}
      .tb-stop .tb-handle:active{cursor:grabbing}
      .tb-stop .tb-num{background:rgba(201,168,76,.15);color:#C9A84C;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:.78rem;font-weight:700}
      .tb-stop .tb-photo,.tb-stop .tb-photo-ph{width:90px;height:64px;object-fit:cover;border-radius:6px;background:#1a1a1a;display:flex;align-items:center;justify-content:center;color:#444;font-size:1.4rem;flex-shrink:0}
      .tb-stop .tb-summary{min-width:0;display:flex;flex-direction:column;gap:3px}
      .tb-stop .tb-addr{font-weight:600;color:#e8e8e8;font-size:.86rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .tb-stop .tb-loc{font-size:.74rem;color:#888}
      .tb-stop .tb-meta{font-size:.72rem;color:#888;display:flex;flex-wrap:wrap;gap:8px}
      .tb-stop .tb-meta .tb-badge{background:rgba(201,168,76,.1);color:#C9A84C;border-radius:4px;padding:1px 6px;font-weight:600;font-size:.7rem}
      .tb-stop .tb-meta .tb-price{color:#C9A84C;font-weight:700}
      .tb-stop .tb-agent{font-size:.72rem;color:#C9A84C;display:flex;align-items:center;gap:6px}
      .tb-stop .tb-agent a{color:#C9A84C;text-decoration:none}
      .tb-stop .tb-agent a:hover{text-decoration:underline}
      .tb-stop .tb-notes-disp{font-size:.72rem;color:#aaa;background:rgba(110,212,126,.06);border-left:2px solid #6ed47e;padding:4px 8px;border-radius:0 4px 4px 0}
      .tb-stop .tb-notes-disp .tb-notes-label{color:#6ed47e;font-weight:600}
      .tb-stop .tb-time-controls{display:flex;flex-direction:column;gap:4px}
      .tb-stop .tb-time-controls input,.tb-stop .tb-time-controls select{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:6px;color:#e8e8e8;font-size:.74rem;padding:5px 7px;outline:none;font-family:inherit}
      .tb-stop .tb-time-controls input:focus,.tb-stop .tb-time-controls select:focus{border-color:#C9A84C}
      .tb-stop .tb-actions{display:flex;flex-direction:column;gap:4px}
      .tb-stop .tb-actions button,.tb-stop .tb-actions a{background:#1a1a1a;border:1px solid #2a2a2a;color:#888;border-radius:6px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:.84rem;text-decoration:none}
      .tb-stop .tb-actions button:hover,.tb-stop .tb-actions a:hover{border-color:#C9A84C;color:#C9A84C}
      .tb-stop .tb-actions .tb-act-danger:hover{border-color:#ff8888;color:#ff8888}
      .tb-empty{text-align:center;padding:36px 16px;color:#555;background:#0d0d0d;border:1px dashed #2a2a2a;border-radius:10px}
      .tb-empty .tb-empty-icon{font-size:1.8rem;display:block;margin-bottom:8px}
      .tb-stop-notes-editor{background:#0d0d0d;border:1px solid #C9A84C44;border-radius:10px;padding:14px;margin:8px 0}
      .tb-stop-notes-editor h4{font-size:.82rem;color:#C9A84C;margin:0 0 10px;font-weight:700}
      .tb-stop-notes-editor .tb-actions-row{display:flex;gap:8px;margin-top:10px}
      .tb-send-preview{background:#0d0d0d;border:1px solid #2a2a2a;border-radius:10px;padding:14px;margin-bottom:16px}
      .tb-preview-section{margin-bottom:14px}
      .tb-preview-section:last-child{margin-bottom:0}
      .tb-preview-label{font-size:.7rem;color:#666;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:5px}
      .tb-preview-bubble{background:#1a1a1a;border-radius:14px;padding:10px 14px;font-size:.82rem;color:#ddd;line-height:1.5;white-space:pre-wrap}
      .tb-preview-subject{font-size:.86rem;color:#e8e8e8;font-weight:600;margin-bottom:8px}
      .tb-preview-summary{font-size:.78rem;color:#888;line-height:1.6}
      .tb-preview-summary code{background:#1a1a1a;padding:1px 5px;border-radius:3px;font-size:.74rem}
      .tb-channels{margin-bottom:12px;display:flex;flex-direction:column;gap:8px}
      .tb-check-row{display:flex;align-items:center;gap:8px;font-size:.82rem;color:#ddd;cursor:pointer}
      .tb-check-row input[type=checkbox]{accent-color:#C9A84C;width:16px;height:16px;flex-shrink:0}
      .tb-advanced{background:#0d0d0d;border:1px solid #1f1f1f;border-radius:8px;padding:12px 14px;margin-bottom:14px}
      .tb-advanced summary{cursor:pointer;font-size:.78rem;color:#888;font-weight:600;list-style:none;padding:0;outline:none}
      .tb-advanced summary::-webkit-details-marker{display:none}
      .tb-advanced summary::before{content:'▸';margin-right:6px;display:inline-block;transition:transform .2s}
      .tb-advanced[open] summary::before{transform:rotate(90deg)}
      .tb-advanced summary:hover{color:#C9A84C}
      .tb-advanced .tb-reminder-group{padding-top:10px;display:flex;flex-direction:column;gap:7px}
      .tb-advanced .tb-reminder-group .tb-hint{font-size:.74rem;color:#666;line-height:1.5;margin:0 0 6px}
      .tb-warnings{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);color:#f59e0b;padding:10px 12px;border-radius:8px;font-size:.8rem;margin-bottom:14px;display:none}
      .tb-warnings.active{display:block}
      .tb-warnings ul{margin:6px 0 0 18px;padding:0}
      .tb-send-actions{display:flex;gap:10px;justify-content:flex-end;border-top:1px solid #1f1f1f;padding-top:14px}
      .tb-toast{position:fixed;bottom:24px;right:24px;z-index:10001;background:#0a1a0a;border:1px solid rgba(110,212,126,.3);color:#6ed47e;border-radius:10px;padding:11px 16px;font-size:.82rem;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:380px;display:flex;align-items:center;gap:10px;font-family:'Segoe UI',Arial,sans-serif}
      .tb-toast[data-kind=error]{background:#1a0d0d;border-color:rgba(255,136,136,.3);color:#ff8888}
      .tb-toast .tb-toast-action{background:rgba(255,255,255,.08);color:inherit;border:none;border-radius:6px;padding:5px 10px;font-size:.76rem;font-weight:700;cursor:pointer;font-family:inherit}
      .tb-toast .tb-toast-action:hover{background:rgba(255,255,255,.15)}
      .tb-mini-modal{position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(2px);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;font-family:'Segoe UI',Arial,sans-serif}
      .tb-mini-card{background:#141414;border:1px solid #2a2a2a;border-radius:12px;width:100%;max-width:480px;max-height:80vh;display:flex;flex-direction:column;color:#e8e8e8;box-shadow:0 24px 60px rgba(0,0,0,.6)}
      .tb-mini-head{padding:14px 18px;border-bottom:1px solid #1f1f1f;display:flex;align-items:center;justify-content:space-between}
      .tb-mini-head h3{font-size:.96rem;font-weight:700;margin:0}
      .tb-mini-body{padding:14px 18px;overflow-y:auto;flex:1}
      .tb-mini-foot{padding:10px 18px;border-top:1px solid #1f1f1f;display:flex;gap:8px;justify-content:flex-end}
      .tb-tour-option{background:#0d0d0d;border:1px solid #2a2a2a;border-radius:8px;padding:11px 14px;margin-bottom:8px;cursor:pointer;transition:border-color .15s}
      .tb-tour-option:hover{border-color:#C9A84C}
      .tb-tour-option .tb-to-title{color:#e8e8e8;font-weight:600;font-size:.86rem}
      .tb-tour-option .tb-to-meta{color:#666;font-size:.74rem;margin-top:3px}
      @media(max-width:640px){
        .tb-modal{padding:0;align-items:stretch;justify-content:stretch}
        .tb-card{max-width:100%;max-height:100vh;border-radius:0;border:none}
        .tb-tabs{padding:0 4px}
        .tb-tab{padding:11px 12px;font-size:.78rem}
        .tb-body{padding:14px}
        .tb-stop{grid-template-columns:18px 28px 1fr;gap:8px}
        .tb-stop .tb-photo,.tb-stop .tb-photo-ph{display:none}
        .tb-stop .tb-time-controls,.tb-stop .tb-actions{grid-column:1/-1;flex-direction:row}
        .tb-form-row-split{grid-template-columns:1fr}
      }
      /* ── Stops tab: browse + cart layout ── */
      #tour-builder-modal .stops-panel{height:100%;display:flex;flex-direction:column}
      #tour-builder-modal .stops-card-modal-mode{max-width:1100px}
      #tour-builder-modal .stops-view-toggle{display:none}
      #tour-builder-modal .stops-grid{display:grid;grid-template-columns:1fr 360px;gap:14px;flex:1;min-height:520px}
      #tour-builder-modal .browse-pane,#tour-builder-modal .cart-pane{display:flex;flex-direction:column;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:10px;padding:12px;overflow:hidden;min-height:0}
      #tour-builder-modal .browse-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px}
      #tour-builder-modal .browse-header h3,#tour-builder-modal .cart-header h3{font-size:.74rem;color:#C9A84C;text-transform:uppercase;letter-spacing:.1em;margin:0;font-weight:700}
      #tour-builder-modal .cart-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #1f1f1f;gap:6px;flex-wrap:wrap}
      #tour-builder-modal .cart-badge{background:#C9A84C;color:#0a0a0a;font-size:.68rem;padding:1px 7px;border-radius:10px;font-weight:700;margin-left:4px}
      #tour-builder-modal .cart-hint{font-size:.66rem;color:#666}
      #tour-builder-modal .search-filters{background:#141414;border:1px solid #1f1f1f;border-radius:8px;padding:10px;margin-bottom:10px}
      #tour-builder-modal .filter-row{margin-bottom:8px}
      #tour-builder-modal .filter-row:last-child{margin-bottom:0}
      #tour-builder-modal .filter-row label{display:block;font-size:.66rem;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;font-weight:700}
      #tour-builder-modal .filter-row input,#tour-builder-modal .filter-row select{width:100%;padding:7px 9px;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:6px;color:#e8e8e8;font-size:.8rem;font-family:inherit;outline:none}
      #tour-builder-modal .filter-row input:focus,#tour-builder-modal .filter-row select:focus{border-color:#C9A84C}
      #tour-builder-modal .filter-row-split{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      #tour-builder-modal .btn-search{width:100%;margin-top:4px;padding:9px 14px;background:#C9A84C;color:#000;border:none;border-radius:6px;font-size:.82rem;font-weight:700;cursor:pointer;font-family:inherit}
      #tour-builder-modal .btn-search:hover{background:#e8c96a}
      #tour-builder-modal .search-results{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;padding-right:4px;align-content:start}
      #tour-builder-modal .search-result-card{background:#141414;border:1px solid #2a2a2a;border-radius:8px;overflow:hidden;display:flex;flex-direction:column;transition:border-color .15s,transform .15s}
      #tour-builder-modal .search-result-card:hover{border-color:rgba(201,168,76,.5);transform:translateY(-2px)}
      #tour-builder-modal .search-result-card.added{border-color:#6ed47e}
      #tour-builder-modal .result-photo{width:100%;height:104px;object-fit:cover;background:#1a1a1a;display:block}
      #tour-builder-modal .result-photo-ph{height:104px;background:#1a1a1a;display:flex;align-items:center;justify-content:center;color:#444;font-size:1.4rem}
      #tour-builder-modal .result-body{padding:8px 10px;flex:1;display:flex;flex-direction:column;gap:3px}
      #tour-builder-modal .result-price{color:#C9A84C;font-weight:700;font-size:.92rem}
      #tour-builder-modal .result-address{font-size:.74rem;color:#ddd;line-height:1.3}
      #tour-builder-modal .result-meta{font-size:.7rem;color:#888;margin-bottom:6px;flex:1}
      #tour-builder-modal .btn-add-to-cart{background:rgba(201,168,76,.12);color:#C9A84C;border:1px solid rgba(201,168,76,.4);border-radius:5px;padding:6px 8px;font-size:.74rem;font-weight:700;cursor:pointer;width:100%;font-family:inherit;transition:all .15s}
      #tour-builder-modal .btn-add-to-cart:hover{background:rgba(201,168,76,.2)}
      #tour-builder-modal .btn-add-to-cart.added{background:rgba(110,212,126,.12);color:#6ed47e;border-color:rgba(110,212,126,.4);cursor:default}
      #tour-builder-modal .btn-add-to-cart:disabled{cursor:wait;opacity:.7}
      #tour-builder-modal .cart-list{flex:1;overflow-y:auto;padding-right:4px;min-height:120px}
      #tour-builder-modal .search-empty,#tour-builder-modal .cart-empty,#tour-builder-modal .search-loading{text-align:center;padding:30px 16px;color:#666;font-size:.8rem;line-height:1.5;grid-column:1/-1}
      #tour-builder-modal .empty-icon{font-size:1.8rem;display:block;margin-bottom:6px}
      #tour-builder-modal .quick-mls-form{display:flex;gap:6px;align-items:center;background:#141414;border:1px solid #1f1f1f;border-radius:8px;padding:9px;margin-bottom:10px}
      #tour-builder-modal .quick-mls-form input{flex:1;padding:6px 9px;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:5px;color:#e8e8e8;font-size:.8rem;font-family:inherit;outline:none}
      #tour-builder-modal .quick-mls-form input:focus{border-color:#C9A84C}
      #tour-builder-modal .btn-link{background:none;border:none;color:#C9A84C;font-size:.74rem;cursor:pointer;padding:2px 4px;font-family:inherit;text-decoration:underline}
      #tour-builder-modal .btn-link:hover{color:#e8c96a}
      #tour-builder-modal .btn-sm{padding:5px 10px;font-size:.74rem}
      #tour-builder-modal .search-load-more{grid-column:1/-1;text-align:center;padding:10px}
      #tour-builder-modal .search-load-more button{background:#1a1a1a;border:1px solid #2a2a2a;color:#e8e8e8;border-radius:6px;padding:8px 16px;font-size:.78rem;font-weight:600;cursor:pointer;font-family:inherit}
      #tour-builder-modal .search-load-more button:hover{border-color:#C9A84C;color:#C9A84C}
      /* The stops tab gets a wider modal so the browse+cart layout breathes. */
      #tour-builder-modal[data-active-tab=stops] .tb-card{max-width:1100px}
      @media(max-width:720px){
        #tour-builder-modal .stops-grid{grid-template-columns:1fr;grid-template-rows:1fr;min-height:auto}
        #tour-builder-modal .stops-view-toggle{display:flex;gap:8px;margin-bottom:10px}
        #tour-builder-modal .view-toggle{flex:1;background:#141414;border:1px solid #2a2a2a;color:#888;padding:9px;border-radius:8px;font-size:.78rem;font-weight:700;cursor:pointer;font-family:inherit}
        #tour-builder-modal .view-toggle.active{background:rgba(201,168,76,.12);border-color:rgba(201,168,76,.5);color:#C9A84C}
        #tour-builder-modal [data-view-pane=browse]:not(.active),#tour-builder-modal [data-view-pane=cart]:not(.active){display:none}
        #tour-builder-modal .search-results{grid-template-columns:1fr 1fr}
      }
    `;
    var style = document.createElement('style');
    style.id = 'tb-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // -------- Toast / mini modal helpers ------------------------------------
  function showToast(msg, kind) {
    var prev = document.getElementById('tb-toast');
    if (prev) prev.remove();
    var t = document.createElement('div');
    t.id = 'tb-toast';
    t.className = 'tb-toast';
    if (kind) t.dataset.kind = kind;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentElement) t.remove(); }, 5000);
    return t;
  }

  function showToastWithAction(msg, actionLabel, actionFn) {
    var t = showToast(msg);
    var btn = document.createElement('button');
    btn.className = 'tb-toast-action';
    btn.type = 'button';
    btn.textContent = actionLabel;
    btn.addEventListener('click', function () {
      try { actionFn(); } finally { if (t.parentElement) t.remove(); }
    });
    t.appendChild(btn);
    return t;
  }

  // Generic mini-modal builder. Returns { close, root }. Opener supplies the
  // body element. Closes on backdrop click + ESC + manual close().
  function openMiniModal(title, bodyEl, footerBtns) {
    var overlay = document.createElement('div');
    overlay.className = 'tb-mini-modal';
    var card = document.createElement('div');
    card.className = 'tb-mini-card';
    var head = document.createElement('div');
    head.className = 'tb-mini-head';
    head.innerHTML = '<h3>' + esc(title) + '</h3><button class="tb-x" type="button" aria-label="Close">✕</button>';
    var body = document.createElement('div');
    body.className = 'tb-mini-body';
    body.appendChild(bodyEl);
    var foot = document.createElement('div');
    foot.className = 'tb-mini-foot';
    if (footerBtns) footerBtns.forEach(function (b) { foot.appendChild(b); });
    card.appendChild(head); card.appendChild(body);
    if (footerBtns && footerBtns.length) card.appendChild(foot);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    var close = function () { if (overlay.parentElement) overlay.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    head.querySelector('.tb-x').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return { close: close, root: overlay };
  }

  // -------- Contact picker (mini modal) -----------------------------------
  function pickContactDialog() {
    return new Promise(function (resolve) {
      var body = document.createElement('div');
      body.innerHTML =
        '<div class="tb-form-row" style="margin-bottom:0">'
        + '<label>Search lead by name, phone, or email</label>'
        + '<div class="tb-contact-picker">'
        + '<input type="text" data-role="search" autocomplete="off" placeholder="Start typing…" />'
        + '<div class="tb-contact-results" hidden></div>'
        + '</div>'
        + '</div>';
      var modal = openMiniModal('Pick a lead', body);
      var input = body.querySelector('[data-role=search]');
      var results = body.querySelector('.tb-contact-results');
      var debTimer = null;
      var doSearch = function () {
        var q = input.value.trim();
        if (q.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
        searchContactsDirect(q).then(function (rows) {
          if (!Array.isArray(rows) || !rows.length) {
            results.hidden = false;
            results.innerHTML = '<div class="tb-contact-result" style="cursor:default"><div class="tb-cr-meta">No matches.</div></div>';
            return;
          }
          results.hidden = false;
          results.innerHTML = rows.map(function (c, i) {
            var name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || '(unnamed)';
            var meta = [c.phone, c.email].filter(Boolean).join(' · ');
            return '<div class="tb-contact-result" data-i="' + i + '">'
              + '<div class="tb-cr-name">' + esc(name) + '</div>'
              + (meta ? '<div class="tb-cr-meta">' + esc(meta) + '</div>' : '')
              + '</div>';
          }).join('');
          [].slice.call(results.querySelectorAll('.tb-contact-result')).forEach(function (el) {
            el.addEventListener('click', function () {
              var idx = Number(el.dataset.i);
              modal.close();
              resolve(rows[idx]);
            });
          });
        });
      };
      input.addEventListener('input', function () {
        if (debTimer) clearTimeout(debTimer);
        debTimer = setTimeout(doSearch, 250);
      });
      // Cancel resolves with null
      var origClose = modal.close;
      modal.close = function () { origClose(); resolve(null); };
      var head = modal.root.querySelector('.tb-mini-head .tb-x');
      head.removeEventListener('click', origClose);
      head.addEventListener('click', modal.close);
      modal.root.addEventListener('click', function (e) { if (e.target === modal.root) modal.close(); });
      setTimeout(function () { input.focus(); }, 50);
    });
  }

  // -------- Choose-existing-tour dialog -----------------------------------
  // Returns 'new' to create a new tour, a batch_id, or null on cancel.
  function chooseTourDialog(drafts) {
    return new Promise(function (resolve) {
      var body = document.createElement('div');
      var lines = drafts.map(function (t, i) {
        var title = t.title || ('Tour started ' + new Date(t.created_at).toLocaleDateString());
        var meta = (t.stop_count || 0) + ' stop' + (t.stop_count === 1 ? '' : 's')
          + (t.scheduled_start ? ' · ' + fmtDateLong(t.scheduled_start) : '')
          + ' · status: ' + esc(t.status);
        return '<div class="tb-tour-option" data-bid="' + esc(t.batch_id) + '">'
          + '<div class="tb-to-title">' + esc(title) + '</div>'
          + '<div class="tb-to-meta">' + meta + '</div>'
          + '</div>';
      }).join('');
      body.innerHTML =
        '<div style="font-size:.82rem;color:#aaa;line-height:1.5;margin-bottom:12px">This lead has open draft tours. Add to one of them, or create a fresh tour:</div>'
        + lines
        + '<div class="tb-tour-option" data-new="1" style="border-style:dashed">'
        + '<div class="tb-to-title">+ Create a new tour</div>'
        + '<div class="tb-to-meta">Start fresh — this stop becomes the first one</div>'
        + '</div>';
      var modal = openMiniModal('Add to which tour?', body);
      [].slice.call(body.querySelectorAll('.tb-tour-option')).forEach(function (el) {
        el.addEventListener('click', function () {
          modal.close();
          if (el.dataset.new) resolve('new');
          else resolve(el.dataset.bid);
        });
      });
      var origClose = modal.close;
      modal.close = function () { origClose(); resolve(null); };
      var head = modal.root.querySelector('.tb-mini-head .tb-x');
      head.removeEventListener('click', origClose);
      head.addEventListener('click', modal.close);
      modal.root.addEventListener('click', function (e) { if (e.target === modal.root) modal.close(); });
    });
  }

  // -------- Builder modal: open + close ------------------------------------
  function close(skipDirtyCheck) {
    if (!state || state.isClosing) return;
    if (!skipDirtyCheck && hasPendingSave()) {
      if (!confirm('A field is still saving. Close anyway and discard the in-flight change?')) return;
    }
    state.isClosing = true;
    // Flush any debounced saves before tearing down state.
    Object.keys(state.saveTimers || {}).forEach(function (k) { clearTimeout(state.saveTimers[k]); });
    var modal = document.getElementById('tour-builder-modal');
    if (modal && modal.parentElement) modal.remove();
    document.removeEventListener('keydown', onEscapeKey);
    var onClose = state.opts && state.opts.onClose;
    state = null;
    if (typeof onClose === 'function') {
      try { onClose(); } catch (e) { /* ignore */ }
    }
  }

  function hasPendingSave() {
    if (!state) return false;
    if (state.pendingSaves > 0) return true;
    return Object.keys(state.saveTimers || {}).length > 0;
  }

  function onEscapeKey(e) {
    if (e.key === 'Escape') close();
  }

  function ensureMounted() {
    var existing = document.getElementById('tour-builder-modal');
    if (existing) existing.remove();
    var modal = document.createElement('div');
    modal.id = 'tour-builder-modal';
    modal.className = 'tb-modal';
    modal.dataset.activeTab = 'setup';
    modal.innerHTML =
      '<div class="tb-card" role="dialog" aria-modal="true">'
      + '<div class="tb-head">'
      +   '<div>'
      +     '<div class="tb-sub">Tour Builder</div>'
      +     '<h2 class="tb-title" data-role="head-title">New Tour</h2>'
      +   '</div>'
      +   '<button class="tb-x" type="button" data-act="close" aria-label="Close">✕</button>'
      + '</div>'
      + '<div class="tb-tabs">'
      +   '<button class="tb-tab active" data-tab="setup">Setup</button>'
      +   '<button class="tb-tab" data-tab="stops">Stops <span class="tb-tab-count" data-role="stop-count">0</span></button>'
      +   '<button class="tb-tab" data-tab="send">Send</button>'
      + '</div>'
      + '<div class="tb-body" data-role="body"></div>'
      + '<div class="tb-foot">'
      +   '<span class="tb-save-indicator">—</span>'
      + '</div>'
      + '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) close();
      var act = e.target.closest('[data-act=close]');
      if (act) close();
    });
    [].slice.call(modal.querySelectorAll('.tb-tab')).forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
    });
    document.addEventListener('keydown', onEscapeKey);
    return modal;
  }

  function switchTab(name) {
    if (!state) return;
    state.activeTab = name;
    var modal = document.getElementById('tour-builder-modal');
    if (!modal) return;
    modal.dataset.activeTab = name;
    [].slice.call(modal.querySelectorAll('.tb-tab')).forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    renderActivePanel();
  }

  function renderActivePanel() {
    var body = document.querySelector('#tour-builder-modal [data-role=body]');
    if (!body) return;
    body.innerHTML = '';
    if (state.activeTab === 'setup') renderSetupTab(body);
    else if (state.activeTab === 'stops') renderStopsTab(body);
    else if (state.activeTab === 'send') renderSendTab(body);
  }

  function refreshHead() {
    var modal = document.getElementById('tour-builder-modal');
    if (!modal) return;
    var titleEl = modal.querySelector('[data-role=head-title]');
    var stopCountEl = modal.querySelector('[data-role=stop-count]');
    if (titleEl) {
      var t = state.tour;
      var contactName = state.contact
        ? ((state.contact.first_name || '') + ' ' + (state.contact.last_name || '')).trim()
        : '';
      var label = (t && t.title) || (contactName ? 'Tour for ' + contactName : 'New Tour');
      titleEl.textContent = label;
    }
    if (stopCountEl) stopCountEl.textContent = String(state.stops.length);
  }

  // -------- Tour load/create --------------------------------------------
  function loadTour(batchId) {
    return api('get_tour', { batch_id: batchId }).then(function (d) {
      if (d && d.success && d.tour) {
        state.tour = d.tour;
        state.stops = (d.stops || []).slice().sort(function (a, b) {
          return (a.stop_order || 0) - (b.stop_order || 0);
        });
        return d;
      }
      throw new Error((d && d.error) || 'Failed to load tour');
    });
  }

  function createDraft(contactId) {
    return api('create_tour', { contact_id: contactId, status: 'draft' }).then(function (d) {
      if (d && d.success && (d.tour || d.batch_id)) {
        var tour = d.tour || { id: d.batch_id, contact_id: contactId, status: 'draft' };
        state.tour = tour;
        state.stops = [];
        return tour;
      }
      throw new Error((d && d.error) || 'Failed to create tour');
    });
  }

  // -------- Setup tab -----------------------------------------------------
  function renderSetupTab(root) {
    var t = state.tour || {};
    var sched = splitScheduledStart(t.scheduled_start);
    var hasContact = !!(t.contact_id || (state.contact && state.contact.id));
    var html = '<section data-panel="setup">';

    if (!hasContact) {
      html +=
        '<div class="tb-form-row">'
        + '<label>Lead</label>'
        + '<div class="tb-contact-picker">'
        + '<input type="text" data-field="contact-search" placeholder="Search by name, phone, or email…" autocomplete="off" />'
        + '<div class="tb-contact-results" hidden></div>'
        + '</div>'
        + '</div>';
    } else {
      var c = state.contact || {};
      var name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || '(no name)';
      html +=
        '<div class="tb-form-row">'
        + '<label>Lead</label>'
        + '<div class="tb-contact-summary">'
        + '<div style="flex:1;min-width:0">'
        +   '<div class="tb-cs-name">' + esc(name) + '</div>'
        +   '<div class="tb-cs-meta">' + esc([c.phone, c.email].filter(Boolean).join(' · ') || '—') + '</div>'
        + '</div>'
        + '<button class="tb-link" type="button" data-act="change-contact">Change</button>'
        + '</div>'
        + '</div>';
    }

    html +=
      '<div class="tb-form-row">'
      +   '<label>Tour title <span class="tb-hint">(optional, helps you find it later)</span></label>'
      +   '<input type="text" data-field="title" value="' + esc(t.title || '') + '" placeholder="e.g. Garden Grove Saturday morning" />'
      + '</div>'
      + '<div class="tb-form-row tb-form-row-split">'
      +   '<div><label>Date</label><input type="date" data-field="scheduled_date" value="' + esc(sched.date) + '" /></div>'
      +   '<div><label>Start time</label><input type="time" data-field="scheduled_time" value="' + esc(sched.time) + '" /></div>'
      + '</div>'
      + '<div class="tb-form-row">'
      +   '<label>Notes for the lead <span class="tb-hint">(shown on the itinerary they receive)</span></label>'
      +   '<textarea data-field="notes_for_lead" rows="3" placeholder="Looking forward to walking these with you. The first one is my favorite — wait until you see the backyard.">' + esc(t.notes_for_lead || '') + '</textarea>'
      + '</div>'
      + '<div class="tb-form-row">'
      +   '<label>Internal notes <span class="tb-hint">(only you see these)</span></label>'
      +   '<textarea data-field="notes_internal" rows="3" placeholder="Budget 850k, prefers single-story, school district matters">' + esc(t.notes_internal || '') + '</textarea>'
      + '</div>';

    html += '</section>';
    root.innerHTML = html;

    if (!hasContact) {
      var input = root.querySelector('[data-field=contact-search]');
      var results = root.querySelector('.tb-contact-results');
      var deb = null;
      input.addEventListener('input', function () {
        if (deb) clearTimeout(deb);
        deb = setTimeout(function () {
          var q = input.value.trim();
          if (q.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
          searchContactsDirect(q).then(function (rows) {
            if (!Array.isArray(rows) || !rows.length) {
              results.hidden = false;
              results.innerHTML = '<div class="tb-contact-result" style="cursor:default"><div class="tb-cr-meta">No matches.</div></div>';
              return;
            }
            results.hidden = false;
            results.innerHTML = rows.map(function (c, i) {
              var name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || '(unnamed)';
              var meta = [c.phone, c.email].filter(Boolean).join(' · ');
              return '<div class="tb-contact-result" data-i="' + i + '">'
                + '<div class="tb-cr-name">' + esc(name) + '</div>'
                + (meta ? '<div class="tb-cr-meta">' + esc(meta) + '</div>' : '')
                + '</div>';
            }).join('');
            [].slice.call(results.querySelectorAll('.tb-contact-result')).forEach(function (el) {
              el.addEventListener('click', function () {
                var idx = Number(el.dataset.i);
                pickedContact(rows[idx]);
              });
            });
          });
        }, 250);
      });
    } else {
      var changeBtn = root.querySelector('[data-act=change-contact]');
      if (changeBtn) changeBtn.addEventListener('click', function () {
        // Don't actually delete the tour — just unset contact in UI to allow
        // re-pick. Saving a new contact_id will repoint the tour.
        if (!confirm('Pick a different lead for this tour?')) return;
        state.contact = null;
        if (state.tour) state.tour.contact_id = null;
        renderActivePanel();
      });
    }

    [].slice.call(root.querySelectorAll('[data-field=title], [data-field=notes_for_lead], [data-field=notes_internal]')).forEach(function (el) {
      el.addEventListener('blur', function () { saveTourField(el.dataset.field, el.value); });
    });
    var dateEl = root.querySelector('[data-field=scheduled_date]');
    var timeEl = root.querySelector('[data-field=scheduled_time]');
    var saveSchedule = function () {
      var iso = joinScheduledStart(dateEl.value, timeEl.value);
      saveTourField('scheduled_start', iso);
    };
    if (dateEl) dateEl.addEventListener('change', saveSchedule);
    if (timeEl) timeEl.addEventListener('change', saveSchedule);

    // Force the native date/time picker open on click. The icon area already
    // does this; this extension makes the entire input field clickable, which
    // matters on dark backgrounds where the picker indicator is easy to miss.
    [].slice.call(root.querySelectorAll('input[type=date], input[type=time]')).forEach(function (input) {
      input.addEventListener('click', function () {
        if (typeof input.showPicker === 'function') {
          try { input.showPicker(); } catch (e) { /* ignore — Safari < 16.4 */ }
        }
      });
    });
  }

  function pickedContact(c) {
    if (!c) return;
    state.contact = c;
    var ensureTour;
    if (!state.tour) {
      ensureTour = createDraft(c.id);
    } else if (state.tour.contact_id !== c.id) {
      ensureTour = api('update_tour', { batch_id: state.tour.id, contact_id: c.id })
        .then(function () { state.tour.contact_id = c.id; });
    } else {
      ensureTour = Promise.resolve();
    }
    startSave();
    ensureTour.then(function () { endSave(); refreshHead(); renderActivePanel(); })
      .catch(function (e) { endSave(e.message || 'Failed'); });
  }

  function saveTourField(field, value) {
    if (!state.tour || !state.tour.id) return;
    debounce('tour-' + field, function () {
      var payload = { batch_id: state.tour.id };
      payload[field] = value;
      startSave();
      api('update_tour', payload).then(function (d) {
        if (d && d.error) { endSave(d.error); return; }
        if (d && d.tour) state.tour = Object.assign(state.tour, d.tour);
        else state.tour[field] = value;
        endSave();
        if (field === 'title') refreshHead();
      }).catch(function (e) { endSave(e.message || 'Failed'); });
    });
  }

  // -------- Stops tab — browse + cart layout ------------------------------
  // Left pane: filter form + photo-card search results (Trestle live search).
  // Right pane: the cart (stops in this tour) — drag-reorderable, edit inline.
  // A Quick MLS+ disclosure swaps in for paste-an-MLS workflow. The whole
  // shebang collapses to a single pane with a toggle on phones.
  var CITY_SUGGESTIONS = [
    'Garden Grove', 'Westminster', 'Huntington Beach', 'Costa Mesa', 'Santa Ana',
    'Anaheim', 'Fountain Valley', 'Irvine', 'Newport Beach', 'Long Beach',
  ];
  var SEARCH_PAGE_SIZE = 12;

  function renderStopsTab(root) {
    var modal = document.getElementById('tour-builder-modal');
    if (modal) modal.dataset.activeTab = 'stops';

    var datalist = '<datalist id="tb-city-suggestions">'
      + CITY_SUGGESTIONS.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('')
      + '</datalist>';

    var html =
      '<section data-panel="stops" class="stops-panel">'
      + '<div class="stops-view-toggle">'
      +   '<button class="view-toggle active" data-view="browse" type="button">🔍 Browse</button>'
      +   '<button class="view-toggle" data-view="cart" type="button">🛒 Cart (<span data-field="cart-count">0</span>)</button>'
      + '</div>'
      + '<div class="stops-grid">'
      +   '<div class="browse-pane active" data-view-pane="browse">'
      +     '<div class="browse-header">'
      +       '<h3>Find homes</h3>'
      +       '<button class="btn-link" data-act="quick-mls-toggle" type="button">+ Paste MLS #</button>'
      +     '</div>'
      +     '<div class="quick-mls-form" hidden>'
      +       '<input type="text" data-field="quick-mls-input" placeholder="OC26095667" />'
      +       '<button class="tb-btn tb-btn-primary btn-sm" data-act="quick-mls-add" type="button">Add</button>'
      +       '<button class="btn-link btn-sm" data-act="quick-mls-cancel" type="button">Cancel</button>'
      +     '</div>'
      +     '<div class="search-filters">'
      +       '<div class="filter-row">'
      +         '<label>City</label>'
      +         '<input type="text" data-field="filter-city" placeholder="e.g. Garden Grove" list="tb-city-suggestions" />'
      +         datalist
      +       '</div>'
      +       '<div class="filter-row filter-row-split">'
      +         '<div><label>Min price</label><input type="number" data-field="filter-min-price" placeholder="500000" step="50000" /></div>'
      +         '<div><label>Max price</label><input type="number" data-field="filter-max-price" placeholder="1500000" step="50000" /></div>'
      +       '</div>'
      +       '<div class="filter-row filter-row-split">'
      +         '<div><label>Min beds</label><select data-field="filter-min-beds">'
      +           '<option value="">Any</option><option value="1">1+</option><option value="2">2+</option><option value="3">3+</option><option value="4">4+</option><option value="5">5+</option>'
      +         '</select></div>'
      +         '<div><label>Min baths</label><select data-field="filter-min-baths">'
      +           '<option value="">Any</option><option value="1">1+</option><option value="2">2+</option><option value="3">3+</option>'
      +         '</select></div>'
      +       '</div>'
      +       '<button class="btn-search" data-act="run-search" type="button">🔍 Search homes</button>'
      +     '</div>'
      +     '<div class="search-results" data-role="search-results">'
      +       '<div class="search-empty">'
      +         '<span class="empty-icon">🏘️</span>'
      +         '<div>Set your filters and click Search to find homes for this tour.</div>'
      +       '</div>'
      +     '</div>'
      +     '<div data-role="mls-preview-slot" style="margin-top:10px"></div>'
      +   '</div>'
      +   '<div class="cart-pane" data-view-pane="cart">'
      +     '<div class="cart-header">'
      +       '<h3>Tour cart <span class="cart-badge" data-field="cart-count-header">0</span></h3>'
      +       '<span class="cart-hint">Drag to reorder · 📝 add notes</span>'
      +     '</div>'
      +     '<div class="cart-list" id="stops-list" data-role="stops-slot"></div>'
      +   '</div>'
      + '</div>'
      + '</section>';

    root.innerHTML = html;
    renderStopsList(root.querySelector('[data-role=stops-slot]'));
    updateCartBadge();

    // Filter form
    root.querySelector('[data-act=run-search]').addEventListener('click', function () { runSearch(false); });
    [].slice.call(root.querySelectorAll('[data-field^=filter-]')).forEach(function (el) {
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); runSearch(false); }
      });
    });

    // Quick MLS+ disclosure
    root.querySelector('[data-act=quick-mls-toggle]').addEventListener('click', function () {
      var form = root.querySelector('.quick-mls-form');
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('input').focus();
    });
    root.querySelector('[data-act=quick-mls-cancel]').addEventListener('click', function () {
      root.querySelector('.quick-mls-form').hidden = true;
    });
    root.querySelector('[data-act=quick-mls-add]').addEventListener('click', quickMlsAdd);
    root.querySelector('[data-field=quick-mls-input]').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); quickMlsAdd(); }
    });

    // Mobile pane toggle
    [].slice.call(root.querySelectorAll('.view-toggle')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        [].slice.call(root.querySelectorAll('.view-toggle')).forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var view = btn.dataset.view;
        [].slice.call(root.querySelectorAll('[data-view-pane]')).forEach(function (p) {
          p.classList.toggle('active', p.dataset.viewPane === view);
        });
      });
    });

    // Search-results event delegation: + Add to cart and Load more
    var resultsEl = root.querySelector('[data-role=search-results]');
    resultsEl.addEventListener('click', onSearchResultsClick);

    // Re-render last search results if user switches tabs and returns
    if (state.lastSearchListings && state.lastSearchListings.length) {
      paintSearchResults(state.lastSearchListings, false);
    }
    if (state.mlsPreviewProperty) renderMlsPreview();
  }

  // ---- Browse pane: search ---------------------------------------------
  function buildSearchParams(append) {
    var modal = document.getElementById('tour-builder-modal');
    var get = function (sel) { var el = modal.querySelector(sel); return el ? el.value : ''; };
    var city = String(get('[data-field=filter-city]')).trim();
    var minP = parseInt(get('[data-field=filter-min-price]'), 10);
    var maxP = parseInt(get('[data-field=filter-max-price]'), 10);
    var minB = parseInt(get('[data-field=filter-min-beds]'), 10);
    var minBa = parseInt(get('[data-field=filter-min-baths]'), 10);

    var filters = ["StandardStatus eq 'Active'", "PropertyType eq 'Residential'"];
    if (city) filters.push("City eq '" + city.replace(/'/g, "''") + "'");
    if (isFinite(minP)) filters.push('ListPrice ge ' + minP);
    if (isFinite(maxP)) filters.push('ListPrice le ' + maxP);
    if (isFinite(minB)) filters.push('BedroomsTotal ge ' + minB);
    if (isFinite(minBa)) filters.push('BathroomsTotalInteger ge ' + minBa);

    if (!append) state.searchSkip = 0;
    state.searchSkip = state.searchSkip || 0;

    return {
      '$top': String(SEARCH_PAGE_SIZE),
      '$skip': append ? String(state.searchSkip) : '0',
      '$filter': filters.join(' and '),
      '$select': 'ListingId,ListingKey,UnparsedAddress,City,StateOrProvince,PostalCode,Latitude,Longitude,ListPrice,BedroomsTotal,BathroomsTotalInteger,LivingArea,PropertyType,YearBuilt,ListAgentFullName,ListAgentStateLicense,ListAgentEmail,ListAgentPreferredPhone,ListOfficeName,ListOfficePhone,ShowingContactName,ShowingContactPhone,ShowingInstructions',
      '$expand': TRESTLE_MEDIA_EXPAND,
      '$orderby': 'ListPrice asc',
    };
  }

  function runSearch(append) {
    var modal = document.getElementById('tour-builder-modal');
    if (!modal) return;
    var resultsEl = modal.querySelector('[data-role=search-results]');
    if (!resultsEl) return;
    var params = buildSearchParams(append);
    state.lastSearchParams = params;

    if (!append) {
      resultsEl.innerHTML = '<div class="search-loading"><span class="empty-icon">⏳</span><div>Searching…</div></div>';
    } else {
      var more = resultsEl.querySelector('.search-load-more button');
      if (more) { more.disabled = true; more.textContent = 'Loading…'; }
    }

    trestleSearch(params).then(function (d) {
      if (d && d.error) {
        resultsEl.innerHTML = '<div class="search-empty"><span class="empty-icon">⚠️</span><div>Search failed: ' + esc(d.error) + '</div></div>';
        return;
      }
      var listings = (d && d.value) || [];
      if (!append && !listings.length) {
        resultsEl.innerHTML = '<div class="search-empty"><span class="empty-icon">🤷</span><div>No listings match those filters.<br/>Try widening price or removing the city.</div></div>';
        state.lastSearchListings = [];
        return;
      }
      state.searchSkip = (state.searchSkip || 0) + listings.length;
      if (!append) state.lastSearchListings = listings;
      else state.lastSearchListings = (state.lastSearchListings || []).concat(listings);
      paintSearchResults(listings, append);
    });
  }

  function paintSearchResults(listings, append) {
    var modal = document.getElementById('tour-builder-modal');
    if (!modal) return;
    var resultsEl = modal.querySelector('[data-role=search-results]');
    if (!resultsEl) return;
    var existingMore = resultsEl.querySelector('.search-load-more');
    if (existingMore) existingMore.remove();
    if (!append) resultsEl.innerHTML = '';

    var cartMls = {};
    state.stops.forEach(function (s) { if (s.mls_number) cartMls[s.mls_number] = true; });

    var frag = document.createDocumentFragment();
    listings.forEach(function (p) {
      frag.appendChild(buildResultCard(p, !!cartMls[p.ListingId]));
    });
    resultsEl.appendChild(frag);

    if (listings.length === SEARCH_PAGE_SIZE) {
      var more = document.createElement('div');
      more.className = 'search-load-more';
      more.innerHTML = '<button type="button" data-act="load-more">Load more results</button>';
      resultsEl.appendChild(more);
    }
  }

  function buildResultCard(p, alreadyAdded) {
    var card = document.createElement('div');
    card.className = 'search-result-card' + (alreadyAdded ? ' added' : '');
    card.dataset.mls = p.ListingId || '';
    var photoUrl = p.Media && p.Media[0] && p.Media[0].MediaURL;
    var specs = [
      p.BedroomsTotal != null ? p.BedroomsTotal + ' bd' : null,
      p.BathroomsTotalInteger != null ? p.BathroomsTotalInteger + ' ba' : null,
      p.LivingArea ? fmtNumber(p.LivingArea) + ' sqft' : null,
    ].filter(Boolean).join(' · ');
    card.innerHTML =
      (photoUrl
        ? '<img class="result-photo" src="' + esc(photoUrl) + '" loading="lazy" alt="' + esc(p.UnparsedAddress || '') + '" />'
        : '<div class="result-photo-ph">🏠</div>')
      + '<div class="result-body">'
      +   '<div class="result-price">' + fmtMoney(p.ListPrice || 0) + '</div>'
      +   '<div class="result-address">' + esc(p.UnparsedAddress || '') + (p.City ? '<br/>' + esc(p.City) : '') + '</div>'
      +   '<div class="result-meta">' + esc(specs || '—') + '</div>'
      +   '<button class="btn-add-to-cart' + (alreadyAdded ? ' added' : '') + '" type="button" data-act="add-to-cart">'
      +     (alreadyAdded ? '✓ In cart' : '+ Add to cart')
      +   '</button>'
      + '</div>';
    // Cache the property payload on the DOM node so click-handler doesn't
    // need to re-fetch from Trestle.
    card._tbProperty = p;
    return card;
  }

  function onSearchResultsClick(e) {
    var addBtn = e.target.closest('[data-act=add-to-cart]');
    var loadMore = e.target.closest('[data-act=load-more]');
    if (addBtn) {
      if (addBtn.classList.contains('added') || addBtn.disabled) return;
      var card = addBtn.closest('.search-result-card');
      var p = card && card._tbProperty;
      if (!p) return;
      addBtn.disabled = true;
      addBtn.textContent = 'Adding…';
      addStopFromTrestleProperty(p).then(function (ok) {
        if (ok) {
          addBtn.classList.add('added');
          addBtn.textContent = '✓ In cart';
          card.classList.add('added');
        } else {
          addBtn.textContent = '+ Add to cart';
        }
        addBtn.disabled = false;
      });
    } else if (loadMore) {
      runSearch(true);
    }
  }

  function quickMlsAdd() {
    var modal = document.getElementById('tour-builder-modal');
    var input = modal.querySelector('[data-field=quick-mls-input]');
    var mls = String(input.value || '').trim();
    if (!mls) return;
    if (!state.tour || !state.tour.id) {
      showToast('Pick a lead on the Setup tab first', 'error');
      switchTab('setup');
      return;
    }
    var btn = modal.querySelector('[data-act=quick-mls-add]');
    btn.disabled = true; btn.textContent = 'Looking up…';
    var fields = [
      'ListingId', 'ListingKey', 'UnparsedAddress', 'City', 'StateOrProvince', 'PostalCode',
      'Latitude', 'Longitude', 'ListPrice', 'BedroomsTotal', 'BathroomsTotalInteger',
      'LivingArea', 'PropertyType', 'YearBuilt',
      'ListAgentFullName', 'ListAgentStateLicense', 'ListAgentEmail', 'ListAgentPreferredPhone',
      'ListOfficeName', 'ListOfficePhone',
      'ShowingContactName', 'ShowingContactPhone', 'ShowingInstructions',
    ].join(',');
    trestleProperty("ListingId eq '" + mls.replace(/'/g, "''") + "'", fields).then(function (d) {
      var p = d && d.value && d.value[0];
      if (!p) {
        btn.disabled = false; btn.textContent = 'Add';
        showToast('MLS # ' + mls + ' not found', 'error');
        return;
      }
      addStopFromTrestleProperty(p).then(function (ok) {
        btn.disabled = false; btn.textContent = 'Add';
        if (ok) {
          input.value = '';
          modal.querySelector('.quick-mls-form').hidden = true;
          showToast('Added ' + (p.UnparsedAddress || 'home'));
        }
      });
    });
  }

  // Add a stop from a fully-hydrated Trestle Property record. Returns a
  // promise resolving to true on success, false on error.
  function addStopFromTrestleProperty(p) {
    if (!state.tour || !state.tour.id) {
      showToast('Pick a lead on the Setup tab first', 'error');
      switchTab('setup');
      return Promise.resolve(false);
    }
    var showingPhone = p.ShowingContactPhone || p.ListAgentPreferredPhone || p.ListOfficePhone || null;
    var photo = (p.Media && p.Media[0] && p.Media[0].MediaURL) || null;
    startSave();
    return api('add_stop', {
      batch_id: state.tour.id,
      mls_number: p.ListingId,
      listing_key: p.ListingKey,
      address: p.UnparsedAddress,
      city: p.City,
      state: p.StateOrProvince,
      zip: p.PostalCode,
      latitude: p.Latitude,
      longitude: p.Longitude,
      price: p.ListPrice,
      beds: p.BedroomsTotal,
      baths: p.BathroomsTotalInteger,
      sqft: p.LivingArea,
      property_type: p.PropertyType,
      year_built: p.YearBuilt,
      photo_url: photo,
      listing_url: p.ListingId ? ('https://beta.ratesandrealty.com/public/property-detail.html?id=' + p.ListingId) : null,
      listing_agent_name: p.ListAgentFullName,
      listing_agent_phone: showingPhone,
      listing_agent_email: p.ListAgentEmail,
      listing_agent_office: p.ListOfficeName,
    }).then(function (d) {
      if (d && d.error) { endSave(d.error); showToast('Add failed: ' + d.error, 'error'); return false; }
      endSave();
      return loadTour(state.tour.id).then(function () {
        renderStopsList();
        refreshHead();
        updateCartBadge();
        return true;
      });
    });
  }

  function updateCartBadge() {
    var modal = document.getElementById('tour-builder-modal');
    if (!modal) return;
    var n = state.stops.length;
    [].slice.call(modal.querySelectorAll('[data-field=cart-count], [data-field=cart-count-header]')).forEach(function (el) {
      el.textContent = String(n);
    });
    var stopTab = modal.querySelector('[data-role=stop-count]');
    if (stopTab) stopTab.textContent = String(n);
  }

  function renderStopsList(slot) {
    if (!slot) slot = $('#tour-builder-modal [data-role=stops-slot]');
    if (!slot) { updateCartBadge(); return; }
    if (!state.stops.length) {
      slot.innerHTML =
        '<div class="cart-empty">'
        + '<span class="empty-icon">🛒</span>'
        + '<div>Cart is empty.<br/>Search homes on the left and click + Add to build the tour.</div>'
        + '</div>';
      updateCartBadge();
      return;
    }
    slot.innerHTML =
      '<div class="tb-stops-list">'
      + state.stops.map(stopCardHtml).join('')
      + '</div>';
    attachStopHandlers(slot);
    updateCartBadge();
    // Re-mark any visible search-result cards that match cart MLS #s so the
    // user sees green ✓ badges even if a stop was added by quick-mls or by
    // a paste flow that didn't go through the visible browse pane.
    var modal = document.getElementById('tour-builder-modal');
    if (modal) {
      var cartMls = {};
      state.stops.forEach(function (s) { if (s.mls_number) cartMls[s.mls_number] = true; });
      [].slice.call(modal.querySelectorAll('.search-result-card')).forEach(function (card) {
        var mls = card.dataset.mls;
        var btn = card.querySelector('.btn-add-to-cart');
        if (cartMls[mls]) {
          card.classList.add('added');
          if (btn) { btn.classList.add('added'); btn.textContent = '✓ In cart'; }
        } else {
          card.classList.remove('added');
          if (btn) { btn.classList.remove('added'); btn.textContent = '+ Add to cart'; }
        }
      });
    }
  }

  function stopCardHtml(stop, idx) {
    var addr = stop.property_address || '(address)';
    var loc = [stop.property_city, stop.state || stop.property_state, stop.zip || stop.property_zip].filter(Boolean).join(', ');
    var meta = [];
    if (stop.mls_number) meta.push('<span class="tb-badge">MLS #' + esc(stop.mls_number) + '</span>');
    if (stop.property_price) meta.push('<span class="tb-price">' + fmtMoney(stop.property_price) + '</span>');
    if (stop.property_beds != null) meta.push('<span>' + stop.property_beds + ' bd</span>');
    if (stop.property_baths != null) meta.push('<span>' + stop.property_baths + ' ba</span>');
    if (stop.property_sqft) meta.push('<span>' + fmtNumber(stop.property_sqft) + ' sqft</span>');

    var agentLine = '';
    if (stop.listing_agent_name) {
      agentLine = '<div class="tb-agent">'
        + '<span>🏢 ' + esc(stop.listing_agent_name) + '</span>'
        + (stop.listing_agent_phone ? ' <a href="tel:' + esc(String(stop.listing_agent_phone).replace(/[^0-9+]/g, '')) + '" title="Call">📞</a>' : '')
        + (stop.listing_agent_email ? ' <a href="mailto:' + esc(stop.listing_agent_email) + '" title="Email">✉</a>' : '')
        + '</div>';
    }
    var notes = stop.agent_notes_for_lead
      ? '<div class="tb-notes-disp"><span class="tb-notes-label">Note to lead:</span> ' + esc(stop.agent_notes_for_lead) + '</div>'
      : '';
    var photo = stop.property_photo
      ? '<img class="tb-photo" src="' + esc(stop.property_photo) + '" loading="lazy" alt="" />'
      : '<div class="tb-photo-ph">📷</div>';

    var stUrl = stop.mls_number
      ? 'https://app.showingtime.com/scheduler/?mlsId=crmls&listingId=' + encodeURIComponent(stop.mls_number)
      : '';

    var arrival = extractTime(stop.arrival_time);
    var dur = stop.duration_minutes || 30;

    return ''
      + '<div class="tb-stop" draggable="true" data-stop-id="' + esc(stop.id) + '">'
      +   '<div class="tb-handle" title="Drag to reorder">⋮⋮</div>'
      +   '<div class="tb-num">' + (idx + 1) + '</div>'
      +   photo
      +   '<div class="tb-summary">'
      +     '<div class="tb-addr">' + esc(addr) + '</div>'
      +     (loc ? '<div class="tb-loc">' + esc(loc) + '</div>' : '')
      +     (meta.length ? '<div class="tb-meta">' + meta.join('') + '</div>' : '')
      +     agentLine
      +     notes
      +   '</div>'
      +   '<div class="tb-time-controls">'
      +     '<input type="time" data-field="arrival" data-stop-id="' + esc(stop.id) + '" value="' + esc(arrival) + '" title="Arrival time" />'
      +     '<select data-field="duration" data-stop-id="' + esc(stop.id) + '" title="Duration">'
      +       [15, 30, 45, 60, 90].map(function (m) {
                return '<option value="' + m + '"' + (m === dur ? ' selected' : '') + '>' + m + ' min</option>';
              }).join('')
      +     '</select>'
      +   '</div>'
      +   '<div class="tb-actions">'
      +     '<button data-act="edit-stop-notes" data-stop-id="' + esc(stop.id) + '" title="Notes for lead">📝</button>'
      +     (stUrl ? '<a href="' + esc(stUrl) + '" target="_blank" rel="noopener" title="ShowingTime">📅</a>' : '')
      +     '<button data-act="remove-stop" class="tb-act-danger" data-stop-id="' + esc(stop.id) + '" title="Remove stop">🗑</button>'
      +   '</div>'
      + '</div>';
  }

  function attachStopHandlers(scope) {
    [].slice.call(scope.querySelectorAll('[data-field=arrival]')).forEach(function (el) {
      el.addEventListener('blur', function () { saveStopField(el.dataset.stopId, 'arrival_time', el.value || null); });
    });
    [].slice.call(scope.querySelectorAll('[data-field=duration]')).forEach(function (el) {
      el.addEventListener('change', function () { saveStopField(el.dataset.stopId, 'duration_minutes', Number(el.value)); });
    });
    [].slice.call(scope.querySelectorAll('[data-act=edit-stop-notes]')).forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); openStopNotesEditor(el.dataset.stopId); });
    });
    [].slice.call(scope.querySelectorAll('[data-act=remove-stop]')).forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); removeStop(el.dataset.stopId); });
    });
    attachDragHandlers(scope);
  }

  function attachDragHandlers(scope) {
    var dragged = null;
    [].slice.call(scope.querySelectorAll('.tb-stop')).forEach(function (card) {
      card.addEventListener('dragstart', function (e) {
        dragged = card; card.style.opacity = '0.5';
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', card.dataset.stopId); } catch (err) {}
      });
      card.addEventListener('dragend', function () {
        if (dragged) dragged.style.opacity = '';
        dragged = null;
        [].slice.call(scope.querySelectorAll('.tb-stop')).forEach(function (c) {
          c.classList.remove('tb-drop-above', 'tb-drop-below');
        });
      });
      card.addEventListener('dragover', function (e) {
        e.preventDefault();
        if (!dragged || dragged === card) return;
        var rect = card.getBoundingClientRect();
        var after = (e.clientY - rect.top) > rect.height / 2;
        card.classList.toggle('tb-drop-above', !after);
        card.classList.toggle('tb-drop-below', after);
      });
      card.addEventListener('dragleave', function () {
        card.classList.remove('tb-drop-above', 'tb-drop-below');
      });
      card.addEventListener('drop', function (e) {
        e.preventDefault();
        card.classList.remove('tb-drop-above', 'tb-drop-below');
        if (!dragged || dragged === card) return;
        var list = card.parentElement;
        var cards = [].slice.call(list.children);
        var fromIdx = cards.indexOf(dragged);
        var toIdx = cards.indexOf(card);
        if (fromIdx < toIdx) list.insertBefore(dragged, card.nextSibling);
        else list.insertBefore(dragged, card);
        // Re-number badges (visual only — arrival_time intentionally unchanged)
        [].slice.call(list.children).forEach(function (el, i) {
          var nEl = el.querySelector('.tb-num');
          if (nEl) nEl.textContent = String(i + 1);
        });
        // Reorder local state to match
        var ids = [].slice.call(list.children).map(function (el) { return el.dataset.stopId; });
        state.stops.sort(function (a, b) { return ids.indexOf(a.id) - ids.indexOf(b.id); });
        // Persist
        startSave();
        api('reorder_stops', { batch_id: state.tour.id, showing_ids: ids })
          .then(function (d) { endSave(d && d.error ? d.error : null); })
          .catch(function (err) { endSave(err.message || 'Failed'); });
      });
    });
  }

  function saveStopField(stopId, field, value) {
    debounce('stop-' + stopId + '-' + field, function () {
      startSave();
      var payload = { batch_id: state.tour.id, showing_id: stopId };
      payload[field] = value;
      api('update_stop', payload).then(function (d) {
        if (d && d.error) { endSave(d.error); return; }
        // Update local stop
        var s = state.stops.find(function (x) { return x.id === stopId; });
        if (s) s[field] = value;
        endSave();
      }).catch(function (e) { endSave(e.message || 'Failed'); });
    });
  }

  function removeStop(stopId) {
    if (!confirm('Remove this stop from the tour?')) return;
    startSave();
    api('remove_stop', { batch_id: state.tour.id, showing_id: stopId }).then(function (d) {
      if (d && d.error) { endSave(d.error); return; }
      state.stops = state.stops.filter(function (s) { return s.id !== stopId; });
      endSave();
      renderStopsList();
      refreshHead();
    });
  }

  function addBlankStop() {
    if (!state.tour || !state.tour.id) {
      showToast('Pick a lead on the Setup tab first', 'error');
      switchTab('setup');
      return;
    }
    startSave();
    api('add_stop', {
      batch_id: state.tour.id,
      address: '',
      city: '',
    }).then(function (d) {
      if (d && d.error) { endSave(d.error); return; }
      endSave();
      return loadTour(state.tour.id).then(function () {
        renderStopsList();
        refreshHead();
      });
    });
  }

  // -------- MLS lookup ----------------------------------------------------
  // OData quirk: Media is a navigation property, so $select alone doesn't
  // include it — it has to be $expand'd. Without expand, p.Media comes back
  // undefined and stop cards render with a 📷 placeholder.
  var TRESTLE_MEDIA_EXPAND = 'Media($top=1;$select=MediaURL,Order)';

  function trestleProperty(filter, selectFields) {
    return fetch(SUPABASE_URL + '/functions/v1/trestle-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ANON_KEY },
      body: JSON.stringify({
        endpoint: 'Property',
        params: { '$top': '1', '$filter': filter, '$select': selectFields, '$expand': TRESTLE_MEDIA_EXPAND },
      }),
    }).then(function (r) { return r.json(); }).catch(function (e) { return { error: e.message }; });
  }

  function trestleSearch(params) {
    return fetch(SUPABASE_URL + '/functions/v1/trestle-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ANON_KEY },
      body: JSON.stringify({ endpoint: 'Property', params: params }),
    }).then(function (r) { return r.json(); }).catch(function (e) { return { error: e.message }; });
  }

  function doMlsLookup(raw) {
    var mls = String(raw || '').trim();
    if (!mls) return;
    if (!state.tour || !state.tour.id) {
      showToast('Pick a lead on the Setup tab first', 'error');
      switchTab('setup');
      return;
    }
    setSaveIndicator('Looking up MLS…', 'pending');
    var fields = [
      'ListingId', 'ListingKey', 'UnparsedAddress', 'City', 'StateOrProvince', 'PostalCode',
      'Latitude', 'Longitude', 'ListPrice', 'BedroomsTotal', 'BathroomsTotalInteger',
      'LivingArea', 'PropertyType', 'YearBuilt',
      'ListAgentFullName', 'ListAgentStateLicense', 'ListAgentEmail', 'ListAgentPreferredPhone',
      'ListOfficeName', 'ListOfficePhone',
      'ShowingContactName', 'ShowingContactPhone', 'ShowingInstructions',
    ].join(',');
    trestleProperty("ListingId eq '" + mls.replace(/'/g, "''") + "'", fields).then(function (d) {
      var p = (d && d.value && d.value[0]) || null;
      if (!p) {
        setSaveIndicator('No listing found for ' + mls, 'error');
        return;
      }
      setSaveIndicator('', '');
      state.mlsPreviewProperty = p;
      renderMlsPreview();
    });
  }

  function renderMlsPreview() {
    var slot = $('#tour-builder-modal [data-role=mls-preview-slot]');
    if (!slot) return;
    var p = state.mlsPreviewProperty;
    if (!p) { slot.innerHTML = ''; return; }
    var photo = (p.Media && p.Media[0] && p.Media[0].MediaURL) || '';
    var meta = [];
    if (p.ListPrice) meta.push(fmtMoney(p.ListPrice));
    if (p.BedroomsTotal != null) meta.push(p.BedroomsTotal + ' bd');
    if (p.BathroomsTotalInteger != null) meta.push(p.BathroomsTotalInteger + ' ba');
    if (p.LivingArea) meta.push(fmtNumber(p.LivingArea) + ' sqft');
    var showingPhone = p.ShowingContactPhone || p.ListAgentPreferredPhone || p.ListOfficePhone || '';
    var agentLine = p.ListAgentFullName
      ? p.ListAgentFullName + (showingPhone ? ' · ' + showingPhone : '')
      : '';
    slot.innerHTML =
      '<div class="tb-mls-preview">'
      + (photo ? '<img src="' + esc(photo) + '" alt="" />' : '<div class="tb-photo-ph" style="width:120px;height:90px;border-radius:6px;background:#1a1a1a;display:flex;align-items:center;justify-content:center;color:#444;font-size:1.4rem">📷</div>')
      + '<div class="tb-mp-body">'
      +   '<div class="tb-mp-addr">' + esc(p.UnparsedAddress || '') + '</div>'
      +   '<div class="tb-mp-meta">' + esc(meta.join(' · ') + (p.City ? ' · ' + p.City : '')) + '</div>'
      +   (agentLine ? '<div class="tb-mp-agent">🏢 ' + esc(agentLine) + '</div>' : '')
      + '</div>'
      + '<div class="tb-mp-actions">'
      +   '<button class="tb-btn tb-btn-primary" data-act="confirm-add-stop">Add as stop</button>'
      +   '<button class="tb-btn tb-btn-secondary" data-act="cancel-preview">Cancel</button>'
      + '</div>'
      + '</div>';
    slot.querySelector('[data-act=confirm-add-stop]').addEventListener('click', commitMlsStop);
    slot.querySelector('[data-act=cancel-preview]').addEventListener('click', function () {
      state.mlsPreviewProperty = null;
      slot.innerHTML = '';
    });
  }

  function commitMlsStop() {
    var p = state.mlsPreviewProperty;
    if (!p || !state.tour) return;
    var showingPhone = p.ShowingContactPhone || p.ListAgentPreferredPhone || p.ListOfficePhone || null;
    var photo = (p.Media && p.Media[0] && p.Media[0].MediaURL) || null;
    startSave();
    api('add_stop', {
      batch_id: state.tour.id,
      mls_number: p.ListingId,
      listing_key: p.ListingKey,
      address: p.UnparsedAddress,
      city: p.City,
      state: p.StateOrProvince,
      zip: p.PostalCode,
      latitude: p.Latitude,
      longitude: p.Longitude,
      price: p.ListPrice,
      beds: p.BedroomsTotal,
      baths: p.BathroomsTotalInteger,
      sqft: p.LivingArea,
      property_type: p.PropertyType,
      year_built: p.YearBuilt,
      photo_url: photo,
      listing_url: p.ListingId ? ('https://beta.ratesandrealty.com/public/property-detail.html?id=' + p.ListingId) : null,
      listing_agent_name: p.ListAgentFullName,
      listing_agent_phone: showingPhone,
      listing_agent_email: p.ListAgentEmail,
      listing_agent_office: p.ListOfficeName,
    }).then(function (d) {
      if (d && d.error) { endSave(d.error); return; }
      state.mlsPreviewProperty = null;
      var slot = $('#tour-builder-modal [data-role=mls-preview-slot]');
      if (slot) slot.innerHTML = '';
      var input = $('#tour-builder-modal [data-field=mls-input]');
      if (input) input.value = '';
      endSave();
      return loadTour(state.tour.id).then(function () {
        renderStopsList();
        refreshHead();
      });
    });
  }

  // -------- Stop notes editor (inline mini-modal) -------------------------
  function openStopNotesEditor(stopId) {
    var stop = state.stops.find(function (s) { return s.id === stopId; });
    if (!stop) return;
    var idx = state.stops.indexOf(stop);
    var body = document.createElement('div');
    body.innerHTML =
      '<div class="tb-form-row">'
      +   '<label>Note for the lead <span class="tb-hint">(shown on their itinerary)</span></label>'
      +   '<textarea data-field="agent_notes_for_lead" rows="3" placeholder="My favorite — wait until you see the backyard.">' + esc(stop.agent_notes_for_lead || '') + '</textarea>'
      + '</div>'
      + '<div class="tb-form-row" style="margin-bottom:0">'
      +   '<label>Internal note <span class="tb-hint">(only you)</span></label>'
      +   '<textarea data-field="agent_internal_notes" rows="2" placeholder="Owner accepting 825k, motivated">' + esc(stop.agent_internal_notes || '') + '</textarea>'
      + '</div>';
    var saveBtn = document.createElement('button');
    saveBtn.className = 'tb-btn tb-btn-primary';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'tb-btn tb-btn-secondary';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    var modal = openMiniModal('Notes for stop ' + (idx + 1), body, [cancelBtn, saveBtn]);
    cancelBtn.addEventListener('click', modal.close);
    saveBtn.addEventListener('click', function () {
      var nfl = body.querySelector('[data-field=agent_notes_for_lead]').value;
      var nin = body.querySelector('[data-field=agent_internal_notes]').value;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      api('update_stop', {
        batch_id: state.tour.id,
        showing_id: stopId,
        agent_notes_for_lead: nfl,
        agent_internal_notes: nin,
      }).then(function (d) {
        if (d && d.error) {
          saveBtn.disabled = false; saveBtn.textContent = 'Save';
          showToast('Save failed: ' + d.error, 'error');
          return;
        }
        stop.agent_notes_for_lead = nfl;
        stop.agent_internal_notes = nin;
        modal.close();
        renderStopsList();
        showToast('Notes saved');
      });
    });
  }

  // -------- Send tab ------------------------------------------------------
  function renderSendTab(root) {
    var t = state.tour || {};
    var c = state.contact || {};
    var firstName = (c.first_name || 'lead');
    var stopCount = state.stops.length;
    var totalDuration = state.stops.reduce(function (acc, s) { return acc + (s.duration_minutes || 30); }, 0);
    var token = t.share_token || '';

    var smsBody = buildSmsPreview(t, state.stops, c);
    var emailSubj = 'Your home tour itinerary' + (t.scheduled_start ? ' — ' + fmtDateLong(t.scheduled_start) : '');

    var rDayBefore = t.reminder_day_before_enabled !== false;
    var rMorningOf = t.reminder_morning_of_enabled !== false;
    var rPostTour = t.reminder_post_tour_enabled !== false;

    var html =
      '<section data-panel="send">'
      + '<div class="tb-send-preview">'
      +   '<div class="tb-preview-section">'
      +     '<div class="tb-preview-label">SMS preview</div>'
      +     '<div class="tb-preview-bubble">' + esc(smsBody) + '</div>'
      +   '</div>'
      +   '<div class="tb-preview-section">'
      +     '<div class="tb-preview-label">Email subject</div>'
      +     '<div class="tb-preview-subject">' + esc(emailSubj) + '</div>'
      +     '<div class="tb-preview-label">Email body summary</div>'
      +     '<div class="tb-preview-summary">'
      +       stopCount + ' stop' + (stopCount === 1 ? '' : 's') + ' · '
      +       (totalDuration ? Math.round(totalDuration / 60 * 10) / 10 + 'h total · ' : '')
      +       'link to itinerary at <code>' + esc('beta.ratesandrealty.com/tour/' + (token || 'XXX')) + '</code>'
      +     '</div>'
      +   '</div>'
      + '</div>'
      + '<div class="tb-channels">'
      +   '<label class="tb-check-row"><input type="checkbox" data-channel="sms" ' + (c.phone ? 'checked' : '') + (c.phone ? '' : ' disabled') + ' /> <span>Send SMS to <strong>' + esc(c.phone || '(no phone on file)') + '</strong></span></label>'
      +   '<label class="tb-check-row"><input type="checkbox" data-channel="email" ' + (c.email ? 'checked' : '') + (c.email ? '' : ' disabled') + ' /> <span>Send email itinerary to <strong>' + esc(c.email || '(no email on file)') + '</strong></span></label>'
      + '</div>'
      + '<details class="tb-advanced">'
      +   '<summary>Advanced reminder settings</summary>'
      +   '<div class="tb-reminder-group">'
      +     '<p class="tb-hint">Reminders are sent automatically based on the tour\'s scheduled time.</p>'
      +     '<label class="tb-check-row"><input type="checkbox" data-reminder="day_before"' + (rDayBefore ? ' checked' : '') + ' /> <span>Day before, 5pm PT — SMS + Email</span></label>'
      +     '<label class="tb-check-row"><input type="checkbox" data-reminder="morning_of"' + (rMorningOf ? ' checked' : '') + ' /> <span>Day of tour, 8am PT — SMS + Email</span></label>'
      +     '<label class="tb-check-row"><input type="checkbox" data-reminder="post_tour"' + (rPostTour ? ' checked' : '') + ' /> <span>Day after, 9am PT — SMS only (feedback ask)</span></label>'
      +   '</div>'
      + '</details>'
      + '<div class="tb-warnings" data-role="warnings"></div>'
      + '<div class="tb-send-actions">'
      +   '<button class="tb-btn tb-btn-secondary" data-act="save-draft">Save & close</button>'
      +   '<button class="tb-btn tb-btn-primary" data-act="send-now">📤 Send now to ' + esc(firstName) + '</button>'
      + '</div>'
      + '</section>';
    root.innerHTML = html;

    [].slice.call(root.querySelectorAll('[data-reminder]')).forEach(function (el) {
      el.addEventListener('change', function () {
        var key = 'reminder_' + el.dataset.reminder + '_enabled';
        saveTourField(key, el.checked);
      });
    });
    root.querySelector('[data-act=save-draft]').addEventListener('click', function () { close(); });
    root.querySelector('[data-act=send-now]').addEventListener('click', sendTourNow);
    validateSend();
  }

  function buildSmsPreview(tour, stops, contact) {
    var first = (contact && contact.first_name) || 'there';
    var n = stops.length;
    var when = tour.scheduled_start ? fmtDateLong(tour.scheduled_start) : 'soon';
    var token = tour.share_token || 'XXX';
    return 'Hi ' + first + ', here\'s the itinerary for our ' + n + '-home tour ' + when + '. '
      + 'Open: https://beta.ratesandrealty.com/tour/' + token + ' — Rene';
  }

  function validateSend() {
    var warnings = [];
    var t = state.tour || {};
    var c = state.contact || {};
    if (!state.stops.length) warnings.push('Add at least one stop before sending.');
    if (!t.scheduled_start) warnings.push('Set a date and time on the Setup tab before sending.');
    var smsChecked = $('#tour-builder-modal [data-channel=sms]:checked');
    var emailChecked = $('#tour-builder-modal [data-channel=email]:checked');
    if (emailChecked && !c.email) warnings.push('Lead has no email on file — uncheck Email or pick a different lead.');
    if (smsChecked && !c.phone) warnings.push('Lead has no phone on file — uncheck SMS or pick a different lead.');
    var w = $('#tour-builder-modal [data-role=warnings]');
    if (!w) return warnings;
    if (warnings.length) {
      w.innerHTML = '<strong>Cannot send yet:</strong><ul>' + warnings.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>';
      w.classList.add('active');
    } else {
      w.classList.remove('active');
      w.innerHTML = '';
    }
    return warnings;
  }

  function sendTourNow() {
    var warnings = validateSend();
    if (warnings.length) { showToast(warnings[0], 'error'); return; }
    var channels = [];
    if ($('#tour-builder-modal [data-channel=sms]:checked')) channels.push('sms');
    if ($('#tour-builder-modal [data-channel=email]:checked')) channels.push('email');
    if (!channels.length) { showToast('Pick at least one channel (SMS or Email)', 'error'); return; }

    var c = state.contact || {};
    var first = c.first_name || 'lead';

    // Persist reminder settings
    var rDay = $('#tour-builder-modal [data-reminder=day_before]').checked;
    var rMorn = $('#tour-builder-modal [data-reminder=morning_of]').checked;
    var rPost = $('#tour-builder-modal [data-reminder=post_tour]').checked;
    var queued = (rDay ? 1 : 0) + (rMorn ? 1 : 0) + (rPost ? 1 : 0);

    if (!confirm('Send tour itinerary to ' + first + ' via ' + channels.join(' + ') + '?\n\nThis will fire SMS/email immediately and queue ' + queued + ' reminder' + (queued === 1 ? '' : 's') + '.')) return;

    var btn = $('#tour-builder-modal [data-act=send-now]');
    btn.disabled = true;
    var origText = btn.textContent;
    btn.textContent = 'Sending…';

    api('update_tour', {
      batch_id: state.tour.id,
      reminder_day_before_enabled: rDay,
      reminder_morning_of_enabled: rMorn,
      reminder_post_tour_enabled: rPost,
    }).then(function () {
      return api('send_to_lead', { batch_id: state.tour.id, channels: channels });
    }).then(function (r) {
      if (r && r.success) {
        showToast('✓ Sent via ' + channels.join(' + ') + (r.reminders_queued != null ? ' · ' + r.reminders_queued + ' reminders queued' : ''));
        if (typeof window.loadTours === 'function') window.loadTours();
        if (typeof window.loadContactShowings === 'function') window.loadContactShowings();
        close();
      } else {
        btn.disabled = false; btn.textContent = origText;
        showToast('Send failed: ' + ((r && r.error) || 'unknown error'), 'error');
      }
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = origText;
      showToast('Send failed: ' + (e.message || 'unknown'), 'error');
    });
  }

  // -------- Public: openTourBuilder ---------------------------------------
  function openTourBuilder(opts) {
    opts = opts || {};
    injectStyles();
    if (state) close(true);
    state = makeState(opts);
    ensureMounted();
    setSaveIndicator('—', '');

    var bootstrap;
    if (opts.batch_id) {
      bootstrap = loadTour(opts.batch_id).then(function () {
        return getContactById(state.tour.contact_id).then(function (c) { state.contact = c; });
      });
    } else if (opts.contact_id) {
      bootstrap = getContactById(opts.contact_id).then(function (c) {
        state.contact = c;
        return createDraft(opts.contact_id);
      }).then(function () {
        if (opts.prefill_stop) return addStopFromPrefill(opts.prefill_stop);
      });
    } else {
      // Empty new tour — Setup tab will show contact picker
      bootstrap = Promise.resolve();
    }

    bootstrap.then(function () {
      refreshHead();
      renderActivePanel();
    }).catch(function (e) {
      showToast('Open failed: ' + (e.message || 'unknown'), 'error');
      close();
    });
  }

  function addStopFromPrefill(p) {
    if (!state.tour || !state.tour.id || !p) return Promise.resolve();
    return api('add_stop', {
      batch_id: state.tour.id,
      mls_number: p.mls_number,
      address: p.address,
      city: p.city,
      state: p.state,
      zip: p.zip,
      latitude: p.latitude,
      longitude: p.longitude,
      price: p.price,
      beds: p.beds,
      baths: p.baths,
      sqft: p.sqft,
      photo_url: p.photo_url,
      listing_url: p.listing_url,
      listing_agent_name: p.listing_agent_name,
      listing_agent_phone: p.listing_agent_phone,
      listing_agent_email: p.listing_agent_email,
      listing_agent_office: p.listing_agent_office,
    }).then(function () {
      return loadTour(state.tour.id);
    });
  }

  // -------- Public: handleAddToTour (search-homes / property-detail) ------
  function handleAddToTour(mlsNumber, opts) {
    opts = opts || {};
    if (!mlsNumber) { showToast('Missing MLS number', 'error'); return; }

    // Step 1: pick contact
    pickContactDialog().then(function (contact) {
      if (!contact) return;
      // Step 2: list contact's draft tours
      api('list_tours_for_contact', { contact_id: contact.id, limit: 10 }).then(function (d) {
        var drafts = ((d && d.tours) || []).filter(function (t) {
          return t.status === 'draft' || t.status === 'scheduled';
        });
        var pick = drafts.length
          ? chooseTourDialog(drafts)
          : Promise.resolve('new');
        return pick.then(function (choice) {
          if (!choice) return;
          var ensureBatch;
          if (choice === 'new') {
            ensureBatch = api('create_tour', { contact_id: contact.id, status: 'draft' }).then(function (cd) {
              if (!cd || !cd.success) throw new Error((cd && cd.error) || 'Failed to create tour');
              return (cd.tour && cd.tour.id) || cd.batch_id;
            });
          } else {
            ensureBatch = Promise.resolve(choice);
          }
          return ensureBatch.then(function (batchId) {
            return lookupAndAddStop(batchId, mlsNumber).then(function (res) {
              showToastWithAction(
                'Added ' + (res.address || 'home') + ' to tour for ' + (contact.first_name || 'lead'),
                'Open builder',
                function () { openTourBuilder({ batch_id: batchId }); }
              );
            });
          });
        });
      });
    });
  }

  function lookupAndAddStop(batchId, mlsNumber) {
    return fetch(SUPABASE_URL + '/functions/v1/trestle-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ANON_KEY },
      body: JSON.stringify({
        endpoint: 'Property',
        params: {
          '$top': '1',
          '$filter': "ListingId eq '" + mlsNumber.replace(/'/g, "''") + "'",
          '$select': 'ListingId,ListingKey,UnparsedAddress,City,StateOrProvince,PostalCode,Latitude,Longitude,ListPrice,BedroomsTotal,BathroomsTotalInteger,LivingArea,PropertyType,YearBuilt,ListAgentFullName,ListAgentEmail,ListAgentPreferredPhone,ListOfficeName,ListOfficePhone,ShowingContactPhone',
          '$expand': TRESTLE_MEDIA_EXPAND,
        },
      }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      var p = d && d.value && d.value[0];
      if (!p) {
        showToast('MLS lookup failed for ' + mlsNumber, 'error');
        throw new Error('MLS lookup failed');
      }
      var showingPhone = p.ShowingContactPhone || p.ListAgentPreferredPhone || p.ListOfficePhone || null;
      var photo = (p.Media && p.Media[0] && p.Media[0].MediaURL) || null;
      return api('add_stop', {
        batch_id: batchId,
        mls_number: p.ListingId,
        listing_key: p.ListingKey,
        address: p.UnparsedAddress,
        city: p.City,
        state: p.StateOrProvince,
        zip: p.PostalCode,
        latitude: p.Latitude,
        longitude: p.Longitude,
        price: p.ListPrice,
        beds: p.BedroomsTotal,
        baths: p.BathroomsTotalInteger,
        sqft: p.LivingArea,
        property_type: p.PropertyType,
        year_built: p.YearBuilt,
        photo_url: photo,
        listing_url: p.ListingId ? ('https://beta.ratesandrealty.com/public/property-detail.html?id=' + p.ListingId) : null,
        listing_agent_name: p.ListAgentFullName,
        listing_agent_phone: showingPhone,
        listing_agent_email: p.ListAgentEmail,
        listing_agent_office: p.ListOfficeName,
      }).then(function (ar) {
        if (ar && ar.error) throw new Error(ar.error);
        return { address: p.UnparsedAddress, listingId: p.ListingId };
      });
    });
  }

  // -------- Admin detection (unhides tb-admin-only elements on admin pages) ----
  // search-homes.html ships the "+ Tour" buttons in markup but hidden by CSS.
  // When an admin email session is detected we add `tb-is-admin` to <body>;
  // a CSS selector then unhides them.
  function detectAdmin() {
    try {
      if (typeof window.supabase === 'undefined') return;
      var emails = (window.APP_CONFIG && window.APP_CONFIG.ADMIN_EMAILS) || [];
      if (!emails.length) return;
      var client = window.supabase.createClient(SUPABASE_URL, ANON_KEY);
      client.auth.getSession().then(function (r) {
        var email = r && r.data && r.data.session && r.data.session.user && r.data.session.user.email;
        if (!email) return;
        var lc = String(email).toLowerCase();
        if (emails.map(function (e) { return String(e).toLowerCase(); }).indexOf(lc) >= 0) {
          document.body.classList.add('tb-is-admin');
        }
      });
    } catch (e) { /* ignore */ }
  }

  function injectAdminVisibilityCss() {
    if (document.getElementById('tb-admin-css')) return;
    var s = document.createElement('style');
    s.id = 'tb-admin-css';
    s.textContent = '.tb-admin-only{display:none}body.tb-is-admin .tb-admin-only{display:inline-flex}';
    document.head.appendChild(s);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectAdminVisibilityCss(); detectAdmin(); });
  } else {
    injectAdminVisibilityCss();
    detectAdmin();
  }

  // -------- Exports ------------------------------------------------------
  window.openTourBuilder = openTourBuilder;
  window.handleAddToTour = handleAddToTour;
  window.tourBuilderClose = close;
})();
