/* ─────────────────────────────────────────────────────────────────────────────
   One clock for the whole CRM: America/Los_Angeles, always, labelled PT.

   THE BUG THIS EXISTS TO KILL
   A calls_log row stored 2026-08-07 22:12:29+00 (15:12 PT) rendered in the lead
   timeline as "10:12 PM" — the UTC wall clock on a 12-hour face, seven hours
   wrong. The cause was not one bad formatter. It was 127 separate
   toLocaleTimeString / toLocaleDateString / toLocaleString calls across 32
   files, none of which passed a timeZone, so every one of them rendered in
   whatever zone the viewer's machine happened to be set to. lead-detail.html
   alone had TWO functions both named fmtDateTime — one scoped and correct, one
   global and unzoned — and the timeline resolved to the global one.

   Rendering in the viewer's zone is the defect even when it happens to look
   right. The same borrower call would read 3:12 PM to Rene in California and
   6:12 AM to the VA in Manila, with nothing on screen to say which. Two people
   working one record cannot talk about it.

   ── PACIFIC FOR EVERYONE, INCLUDING THE VA. ────────────────────────────────
   This is a decision, not a default. The VA is UTC+8.

   Business records are stamped in the business's zone. Lock expirations,
   funding dates, TCPA calling windows, disclosure deadlines and every date a
   borrower is ever quoted are Pacific, because the company operates in
   California. A record that renders differently per viewer is not a shared
   record. And the codebase already leans this way: ai-sms-bot computes quiet
   hours in America/Los_Angeles, esign stamps signatures 'PT', crm-copilot tells
   the model the Pacific time.

   The VA therefore sees Pacific — and sees "PT" on it, so it is never mistaken
   for their own clock. An unlabelled 3:12 is worse than an obviously foreign
   one, which is why the label is not optional here.

   THE EXCEPTION, and it is a real one: admin/js/presence.js shows the VA's
   working hours in BOTH Manila and PT. That is correct and deliberately left
   alone — presence is about a person's own day, not about a shared record.
   Personal-schedule surfaces show both zones; business records show Pacific.

   ── NAIVE TIMESTAMPS ───────────────────────────────────────────────────────
   A second, quieter bug this fixes. Some columns are `timestamptz` and come
   back as 2026-08-07T22:12:29+00:00; others are plain `timestamp` and come back
   as 2026-08-07 20:29:32.168204 with no offset at all. new Date() parses the
   second form as LOCAL time, so those columns were wrong by the viewer's own
   UTC offset before any formatting happened. Everything here is stored in UTC,
   so a string with no zone marker is read as UTC rather than as local.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  if (window.RRTime) return;                       // idempotent

  var ZONE = 'America/Los_Angeles';
  var LABEL = 'PT';

  /* Parse to an absolute instant. The only interesting case is a bare
     "YYYY-MM-DD HH:MM:SS[.ffffff]" with no Z and no ±HH:MM — that is a Postgres
     `timestamp` column, stored UTC, and must not be read as the viewer's local
     time. Anything already carrying a zone is left exactly as it is. */
  function toDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') return new Date(v);
    var s = String(v).trim();
    var zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
    if (!zoned && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T') + 'Z';
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function fmt(v, opts, withLabel) {
    var d = toDate(v);
    if (!d) return '';
    var o = { timeZone: ZONE };
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    try {
      var out = d.toLocaleString('en-US', o);
      return withLabel ? out + ' ' + LABEL : out;
    } catch (e) {
      // Never let a formatting failure blank a timestamp entirely.
      try { return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; } catch (_) { return ''; }
    }
  }

  /* DROP-IN FOR new Date(v).
   *
   * toDate() returns null for unparseable input, which is right for formatting
   * (render nothing) and WRONG as a blanket replacement for new Date(): callers
   * that go straight to .getTime() would get a null dereference where they used
   * to get NaN. parse() always returns a Date, Invalid when it has to be, so it
   * behaves exactly like new Date() EXCEPT that a zone-less string is read as
   * UTC instead of as the viewer's local time. That difference is the whole bug.
   *
   * Safe on tz-aware strings too — identical result — so a call site does not
   * need to know which column it is reading. */
  function parse(v) {
    var d = toDate(v);
    return d || new Date(NaN);
  }

  var RRTime = {
    ZONE: ZONE,
    LABEL: LABEL,
    toDate: toDate,
    parse: parse,

    /** "Aug 7, 3:12 PM PT" — the default for anything with a clock time. */
    dateTime: function (v) {
      return fmt(v, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }, true);
    },
    /** "Aug 7, 2026, 3:12 PM PT" — when the year matters. */
    dateTimeFull: function (v) {
      return fmt(v, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }, true);
    },
    /** "3:12 PM PT" */
    time: function (v) {
      return fmt(v, { hour: 'numeric', minute: '2-digit', hour12: true }, true);
    },
    /** "Aug 7, 2026" — no label; a date alone is not a clock reading. */
    date: function (v) {
      return fmt(v, { month: 'short', day: 'numeric', year: 'numeric' }, false);
    },
    /** "Aug 7" */
    dateShort: function (v) {
      return fmt(v, { month: 'short', day: 'numeric' }, false);
    },
    /** "Thursday, Aug 7" — a day heading, no clock so no label. */
    weekday: function (v) {
      return fmt(v, { weekday: 'long', month: 'short', day: 'numeric' }, false);
    },
    /** "2026-08-07" IN PACIFIC — for comparing calendar days. Using the viewer's
     *  own date would label an event "Today" or not depending on where they sit,
     *  which is the same bug one level up. */
    dateShortIso: function (v) {
      var d = toDate(v);
      if (!d) return '';
      var p = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
      return p.format(d);
    },
    /** Relative for recent things, absolute (and zoned) once it stops being obvious. */
    relative: function (v) {
      var d = toDate(v);
      if (!d) return '';
      var diff = Math.floor((Date.now() - d.getTime()) / 1000);
      if (diff < 0) return RRTime.dateTime(d);
      if (diff < 60) return 'Just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      if (diff < 172800) return 'Yesterday ' + RRTime.time(d);
      if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
      return RRTime.dateShort(d);
    }
  };

  window.RRTime = RRTime;
})();
