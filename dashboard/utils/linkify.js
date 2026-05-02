/**
 * linkify.js — turn raw URLs in plain text into clickable <a> tags.
 *
 * Loaded as a regular script (no build step). Exposes:
 *   window.escapeHtml(s)        — HTML-escape a string
 *   window.linkifyText(text, o) — escape + linkify URLs, returns HTML string
 *   window.renderActivityChip(metadata) — labelled chip for activity_events.metadata.url
 *
 * The output is safe to drop into innerHTML: non-URL spans are HTML-escaped
 * and only matched URL fragments become anchor tags.
 */
(function () {
  // Match http(s):// URLs. Stop at whitespace and a few characters that are
  // never part of a URL but commonly trail one (quotes, brackets, backticks).
  var URL_REGEX = /\bhttps?:\/\/[^\s<>"'`)]+/gi;

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function shortDisplay(cleanUrl) {
    try {
      var u = new URL(cleanUrl);
      var pathTail = u.pathname.split('/').filter(Boolean).slice(-1)[0] || '';
      var disp = pathTail ? u.host + '/…/' + pathTail : u.host;
      if (u.search) disp += '?…';
      return disp;
    } catch (e) {
      return cleanUrl;
    }
  }

  function linkifyText(text, opts) {
    var shorten = !opts || opts.shorten !== false;
    if (!text) return '';
    var parts = [];
    var last = 0;
    var m;
    URL_REGEX.lastIndex = 0;
    while ((m = URL_REGEX.exec(text)) !== null) {
      var url = m[0];
      var start = m.index;
      if (start > last) parts.push(escapeHtml(text.slice(last, start)));

      // Trailing punctuation (".", "," etc) usually isn't part of the URL —
      // peel it off so it stays as plain text after the link.
      var cleanUrl = url;
      while (cleanUrl.length && /[.,;:!?]$/.test(cleanUrl)) {
        cleanUrl = cleanUrl.slice(0, -1);
      }
      var trailing = url.slice(cleanUrl.length);

      var display = cleanUrl;
      if (shorten && cleanUrl.length > 40) display = shortDisplay(cleanUrl);

      parts.push(
        '<a href="' + escapeHtml(cleanUrl) + '"' +
        ' target="_blank" rel="noopener noreferrer"' +
        ' class="msg-link" title="' + escapeHtml(cleanUrl) + '"' +
        ' onclick="event.stopPropagation()">' +
        escapeHtml(display) + '</a>' + escapeHtml(trailing)
      );
      last = start + url.length;
    }
    if (last < text.length) parts.push(escapeHtml(text.slice(last)));
    return parts.join('');
  }

  // Activity events sometimes carry a structured `metadata.url` (e.g. when a
  // borrower clicks a tracked SMS link). Render a labelled gold chip the user
  // can tap to see exactly what the lead saw.
  function renderActivityChip(metadata) {
    var md = metadata;
    if (typeof md === 'string') {
      try { md = JSON.parse(md); } catch (e) { md = null; }
    }
    if (!md || !md.url) return '';
    var label;
    switch (md.label) {
      case 'property_search': label = '🏠 View what they saw'; break;
      case 'book_call':       label = '📅 Booking page';        break;
      case 'calculator':      label = '🧮 Calculator';           break;
      default:                label = '🔗 Open link';
    }
    return '<a href="' + escapeHtml(md.url) + '"' +
      ' target="_blank" rel="noopener noreferrer"' +
      ' class="activity-link-chip"' +
      ' onclick="event.stopPropagation()">' +
      escapeHtml(label) + '</a>';
  }

  // Don't clobber a pre-existing escapeHtml — admin.html already defines one
  // and other code may have captured a reference. Our linkifyText uses the
  // local copy regardless, so coexistence is fine.
  if (typeof window.escapeHtml !== 'function') window.escapeHtml = escapeHtml;
  window.linkifyText = linkifyText;
  window.renderActivityChip = renderActivityChip;
})();
