/* admin/js/dtmf-pad.js
   A DTMF keypad for a call that is ALREADY CONNECTED.

     window.DTMFPad.attach(buttonEl, function () { return theActiveCall; });

   WHAT THIS IS FOR, because the distinction matters:
   it sends tones into somebody ELSE'S phone menu — "press 1 to connect" on a
   vendor's IVR — and it is not a menu of ours. The dialer already has a pad for
   TYPING a number before you dial (.cm-pad); that one composes a string and
   never touches a live call. This one sends a tone down a call in progress and
   composes nothing.

   TWO DIALERS, ONE KEYPAD. admin/js/dialer.js holds its live Call in
   `activeCall`; admin/power-dialer.html holds its own in `_call` and never
   migrated to the shared dialer despite that file's header. Rather than write
   the pad twice, both pass a GETTER — the connection is read at the moment a key
   is pressed, so a pad left open across a hangup cannot send into a dead call.

   IT MUST NOT INTERRUPT THE CALL. Every handler here calls exactly one SDK
   method, sendDigits(), and nothing else. Clicks are stopPropagation'd because
   on both hosts the pad sits inside a container whose own click handlers end or
   close the call.

   THE FAILURE MODE IS SILENCE. A keypad that renders and sends nothing looks
   identical to one that works, so every press is ECHOED back on screen and
   counted, and a press with no live connection says so instead of doing nothing.
*/
(function () {
  'use strict';
  if (window.DTMFPad) return;

  var KEYS = [
    ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
    ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
    ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
    ['*', ''], ['0', '+'], ['#', '']
  ];

  var CSS = [
    '.rrdt-pop{position:absolute;z-index:10060;width:212px;background:#151515;',
    '  border:1px solid rgba(201,168,76,.42);border-radius:12px;padding:10px;',
    '  box-shadow:0 18px 44px rgba(0,0,0,.62);font-family:inherit}',
    '.rrdt-hd{font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;',
    '  color:#8a8475;margin-bottom:6px;text-align:center}',
    /* The echo line is the whole point — see the header. min-height so the pad
       does not jump the first time a digit lands. */
    '.rrdt-sent{min-height:20px;background:#0b0b0b;border:1px solid rgba(255,255,255,.10);',
    '  border-radius:7px;padding:3px 8px;margin-bottom:8px;font-size:15px;color:#F5F0E8;',
    '  letter-spacing:3px;text-align:center;font-variant-numeric:tabular-nums;overflow:hidden}',
    '.rrdt-sent.empty{color:#5f5a51;font-size:10.5px;letter-spacing:0}',
    '.rrdt-sent.err{color:#E05252;font-size:10.5px;letter-spacing:0}',
    '.rrdt-keys{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}',
    '.rrdt-key{height:40px;border-radius:8px;border:1px solid rgba(255,255,255,.09);',
    '  background:rgba(255,255,255,.035);color:#F5F0E8;cursor:pointer;font-family:inherit;',
    '  display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1}',
    '.rrdt-key b{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}',
    '.rrdt-key i{font-size:7.5px;font-style:normal;color:#7d776b;letter-spacing:.5px;margin-top:2px}',
    '.rrdt-key:hover{background:rgba(201,168,76,.16);border-color:rgba(201,168,76,.45)}',
    '.rrdt-key:active{transform:scale(.96)}',
    '.rrdt-foot{margin-top:7px;display:flex;gap:6px}',
    '.rrdt-foot button{flex:1;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.12);',
    '  background:transparent;color:#a9a296;font-size:10.5px;font-weight:600;cursor:pointer;font-family:inherit}',
    '.rrdt-foot button:hover{background:rgba(255,255,255,.07);color:#fff}'
  ].join('');

  function css() {
    if (document.getElementById('rrdt-css')) return;
    var s = document.createElement('style');
    s.id = 'rrdt-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  var open = null;   // { el, getConn, sent, onKey, onDoc }

  function close() {
    if (!open) return;
    document.removeEventListener('keydown', open.onKey, true);
    document.removeEventListener('mousedown', open.onDoc, true);
    if (open.el.parentNode) open.el.parentNode.removeChild(open.el);
    open = null;
  }

  /* THE ONE SDK CALL. Everything else here is chrome.
     Returns 'sent' | 'no-call' | 'unsupported' | 'threw:<msg>' so the caller —
     and the harness — can tell the four apart. window.__rrDtmfLog records every
     attempt for the same reason: a silent pad is the defect being prevented. */
  function send(getConn, d) {
    var conn = null;
    try { conn = getConn && getConn(); } catch (_) { conn = null; }
    var result;
    if (!conn) result = 'no-call';
    else if (typeof conn.sendDigits !== 'function') result = 'unsupported';
    else {
      try { conn.sendDigits(String(d)); result = 'sent'; }
      catch (e) { result = 'threw:' + ((e && e.message) || e); }
    }
    try {
      window.__rrDtmfLog = window.__rrDtmfLog || [];
      window.__rrDtmfLog.push({ digit: String(d), result: result, at: Date.now() });
    } catch (_) {}
    return result;
  }

  function paint() {
    if (!open) return;
    var box = open.el.querySelector('.rrdt-sent');
    if (open.err) { box.className = 'rrdt-sent err'; box.textContent = open.err; return; }
    if (!open.sent.length) { box.className = 'rrdt-sent empty'; box.textContent = 'Press a key to send a tone'; return; }
    box.className = 'rrdt-sent';
    box.textContent = open.sent.join('');
  }

  function press(d) {
    var r = send(open.getConn, d);
    if (r === 'sent') { open.err = ''; open.sent.push(d); if (open.sent.length > 24) open.sent.shift(); }
    else if (r === 'no-call') open.err = 'No active call — nothing sent.';
    else if (r === 'unsupported') open.err = 'This call cannot send tones.';
    else open.err = 'Could not send: ' + r.slice(6);
    paint();
  }

  /**
   * attach(buttonEl, getConn) — wires a host's own button to toggle the pad.
   * getConn is called on EVERY press, never cached.
   */
  function attach(btn, getConn) {
    if (!btn || btn._rrdtWired) return;
    btn._rrdtWired = true;
    css();
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      /* The dialer modal and the power-dialer call bar both have click handlers
         above this button. Opening a keypad must never reach them. */
      e.stopPropagation();
      if (open) { close(); return; }

      var el = document.createElement('div');
      el.className = 'rrdt-pop';
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', 'Keypad — send tones to the call');
      el.innerHTML =
        '<div class="rrdt-hd">Send tones</div>' +
        '<div class="rrdt-sent empty">Press a key to send a tone</div>' +
        '<div class="rrdt-keys">' +
          KEYS.map(function (k) {
            return '<button type="button" class="rrdt-key" data-d="' + k[0] + '">' +
              '<b>' + k[0] + '</b>' + (k[1] ? '<i>' + k[1] + '</i>' : '') + '</button>';
          }).join('') +
        '</div>' +
        '<div class="rrdt-foot"><button type="button" data-act="clear">Clear</button>' +
        '<button type="button" data-act="close">Done</button></div>';

      /* Positioned against the button in PAGE coordinates and appended to body,
         so an overflow:hidden or transformed ancestor cannot clip it — both
         hosts have one. */
      var r = btn.getBoundingClientRect();
      el.style.left = Math.max(8, Math.min(window.innerWidth - 220,
                        r.left + window.scrollX + (r.width / 2) - 106)) + 'px';
      el.style.top = (r.bottom + window.scrollY + 8) + 'px';
      document.body.appendChild(el);

      /* If it would run off the bottom, flip above the button. */
      var pr = el.getBoundingClientRect();
      if (pr.bottom > window.innerHeight - 8) {
        el.style.top = (r.top + window.scrollY - pr.height - 8) + 'px';
      }

      el.addEventListener('click', function (ev) { ev.stopPropagation(); });
      el.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });

      open = { el: el, getConn: getConn, sent: [], err: '' };

      Array.prototype.forEach.call(el.querySelectorAll('.rrdt-key'), function (k) {
        k.addEventListener('click', function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          press(k.getAttribute('data-d'));
        });
      });
      el.querySelector('[data-act="clear"]').addEventListener('click', function (ev) {
        ev.stopPropagation(); open.sent = []; open.err = ''; paint();
      });
      el.querySelector('[data-act="close"]').addEventListener('click', function (ev) {
        ev.stopPropagation(); close();
      });

      /* Typing works too — an IVR read aloud is faster to type than to click.
         Capture phase so the dialer's own key handling does not eat it, and
         Escape closes the PAD only, never the call. */
      open.onKey = function (ev) {
        if (!open) return;
        if (ev.key === 'Escape') { ev.stopPropagation(); close(); return; }
        if (/^[0-9*#]$/.test(ev.key)) {
          ev.preventDefault(); ev.stopPropagation();
          press(ev.key);
        }
      };
      document.addEventListener('keydown', open.onKey, true);

      // Click anywhere else closes the pad. Never touches the call.
      open.onDoc = function (ev) {
        if (!open) return;
        if (el.contains(ev.target) || btn.contains(ev.target)) return;
        close();
      };
      document.addEventListener('mousedown', open.onDoc, true);

      paint();
    });
  }

  window.DTMFPad = { attach: attach, close: close, _send: send };
})();
