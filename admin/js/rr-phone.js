/* ─────────────────────────────────────────────────────────────────────────────
   One phone helper for the whole CRM. Display formatting, and — more
   importantly — the single place that decides whether a value is a number you
   may dial.

   ── THE LIVE DEFECT THIS EXISTS TO KILL ────────────────────────────────────
   contacts_secure hands a `va` mask_phone(phone), which keeps the LAST TWO
   DIGITS:

       mask_phone('7149254342')  ->  '(•••) •••-••42'

   dialer.js then stripped non-digits and fell through to '+' + digits for
   anything that was not 10 or 11 long, so the VA pressing Call dialled '+28'.
   Six live contacts currently mask to (•••) •••-••28. The call could not
   connect, nothing said why, and — because the outbound leg had no status
   callback — the calls_log row sat at 'ringing' for ever. The masking was
   working exactly as designed; the dialer was treating a redaction as a phone
   number. power-dialer.html was worse: it passed lead.phone to connect() raw,
   with no formatting at all.

   THE FIX IS AT THE SOURCE, NOT IN THE FORMATTER. A formatter that "handles"
   a masked value still produces something a dial path will happily send. So
   dialable() REFUSES, with a reason a human can act on, and every dial, text
   and voicemail path asks it first.

   ── DISPLAY IS A SEPARATE JOB, AND NEVER TOUCHES STORAGE ───────────────────
   One card showed "818 272 7418", "8185548206" and "818 408 2101" — three
   formats for three numbers on one screen, from four separate per-page
   formatters (dialer.js, power-dialer.html, sms-activity.html,
   dashboard/admin.html) that had already drifted apart.

   format() is for RENDER ONLY. Stored digits are what resolveContactByPhone,
   is_phone_suppressed, the calling-hours area-code lookup and Twilio all match
   on, so nothing here is ever written back. Format on render, strip on save —
   digits() is the strip.

   ── THE RULE THAT MATTERS MOST HERE ────────────────────────────────────────
   A MASKED VALUE PASSES THROUGH format() UNTOUCHED. Reformatting
   '(•••) •••-••28' would either mangle the mask or, worse, "tidy" it into
   something that reads like a real number. The mask is not a phone number and
   must not be treated as one anywhere in this file except by isMasked().
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  if (window.RRPhone) return;                      // idempotent, like RRTime

  /* ⚠️ IN STEP WITH mask_phone() IN POSTGRES.
     That function emits U+2022 BULLET and nothing else does — stored numbers
     never contain one. Detection is therefore exact rather than heuristic. If
     mask_phone ever changes its filler, change this with it; a mask this file
     does not recognise is a mask that reaches a dial path again. */
  var MASK_CHAR = '•';

  function str(v) { return (v == null) ? '' : String(v); }

  function isMasked(v) { return str(v).indexOf(MASK_CHAR) >= 0; }

  /* Digits only. Used for storage and for comparisons; NEVER call this on a
     masked value expecting a number — that is the original bug, and dialable()
     is the guard that stops it. */
  function digits(v) { return str(v).replace(/\D/g, ''); }

  /* DISPLAY. (818) 272-7418.
       10 digits            -> (818) 272-7418
       11 leading 1         -> same, the 1 dropped
       masked               -> unchanged
       anything else        -> unchanged, and deliberately so. An extension, a
                               partial number mid-entry or an international
                               number are all things a guess would damage, and
                               a wrong-looking number is better than a
                               confidently wrong one. */
  function format(v) {
    var s = str(v);
    if (!s) return '';
    if (isMasked(s)) return s;
    var d = digits(s);
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    if (d.length !== 10) return s;
    return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  }

  /* CAN THIS BE DIALLED, AND IF NOT, WHY.
     Returns { ok:true, e164 } or { ok:false, reason, message }.
     `message` is written to be shown to the person who clicked, so it says what
     they can do about it rather than naming a field. */
  function dialable(v) {
    var s = str(v).trim();
    if (!s) {
      return { ok: false, reason: 'empty', message: 'No phone number on file for this lead.' };
    }
    if (isMasked(s)) {
      return {
        ok: false, reason: 'masked',
        message: "This lead's number is hidden for your role, so it can't be dialled from here. Ask an admin to place the call.",
      };
    }
    /* Already E.164 and plausible — pass it through rather than re-deriving,
       so a genuine international number is not mangled into a US one. */
    if (s.charAt(0) === '+') {
      var e = digits(s);
      if (e.length >= 11 && e.length <= 15) return { ok: true, e164: '+' + e };
      return { ok: false, reason: 'unusable', message: 'That number is not a phone number we can dial: ' + s };
    }
    var d = digits(s);
    if (d.length === 10) return { ok: true, e164: '+1' + d };
    if (d.length === 11 && d.charAt(0) === '1') return { ok: true, e164: '+' + d };
    /* NO FALLBACK. '+' + d is what turned a two-digit mask into a dialled
       number; anything unrecognised is refused and named. */
    return {
      ok: false, reason: 'unusable',
      message: 'That number does not look like a US phone number, so it was not dialled: ' + s,
    };
  }

  /* Convenience for call sites that only want the string. Null when refused —
     callers that ignore null get no call rather than a wrong one. */
  function toE164(v) { var r = dialable(v); return r.ok ? r.e164 : null; }

  window.RRPhone = {
    MASK_CHAR: MASK_CHAR,
    isMasked: isMasked,
    digits: digits,
    format: format,
    dialable: dialable,
    toE164: toE164,
  };

  /* ── tel: LINKS — ONE GUARD RATHER THAN THIRTY-ONE EDITS ─────────────────
     `tel:` is a dial path too: it hands the number to the OS dialer, which on a
     laptop with a paired phone really does place the call. There are ~31 of
     them across the admin pages, several rendering a CONTACT phone, which on a
     va's page is masked.

     Editing all 31 would work today and drift tomorrow — the thirty-second one
     gets written without the check, exactly as the four phone formatters
     drifted apart. A single capture-phase listener covers every existing link,
     every future one, and every link built by innerHTML after this file ran.

     Deliberately narrow: it blocks ONLY hrefs carrying the mask character.
     A normal tel: link is untouched, so this cannot become a reason calls stop
     working for anyone whose number is real. */
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href^="tel:"]') : null;
    if (!a) return;
    if (!isMasked(a.getAttribute('href') || '')) return;
    ev.preventDefault();
    ev.stopPropagation();
    var msg = "This lead's number is hidden for your role, so it can't be dialled from here. Ask an admin to place the call.";
    if (typeof window.showToast === 'function') window.showToast(msg, true);
    else if (typeof window.toast === 'function') window.toast(msg, true);
    else alert(msg);
  }, true);
})();
