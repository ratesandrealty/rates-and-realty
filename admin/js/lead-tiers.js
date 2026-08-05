/* Lead score tiers — THE definition. Do not re-hardcode these numbers.
 *
 * There were NINE independent copies of "80 / 50": seven in people.html
 * (effectiveTier, updateTabCounts, three applyFilters branches, two
 * score-class renderers), one in lead-detail.html and one in pipeline.html.
 * Nine copies of a number is nine chances to disagree, and they did — the Hot
 * TAB counted score >= 80 while the Hot STAT PILL counted a stored
 * lead_temperature column, so the page showed "Hot 4" and "Hot 0" at once.
 *
 * Worse, 80 was unreachable. The highest lead_score in the database is 79, so
 * the Hot tab was structurally always zero and had been since it shipped. The
 * intended threshold is 75.
 *
 * Loaded by people.html, lead-detail.html and pipeline.html. If you add a
 * fourth place that needs a tier, load this rather than copying the numbers. */
(function () {
  var HOT = 75;
  var WARM = 50;

  window.LEAD_TIERS = {
    HOT: HOT,
    WARM: WARM,
    /* 'Hot' | 'Warm' | 'Cold' — capitalised, matching contacts.lead_temperature's
     * stored vocabulary so the two can be compared without normalising. */
    tierOf: function (score) {
      var s = Number(score) || 0;
      return s >= HOT ? 'Hot' : s >= WARM ? 'Warm' : 'Cold';
    },
    // CSS class used by the score chips on every page that shows one.
    classOf: function (score) {
      var s = Number(score) || 0;
      return s >= HOT ? 'score-hot' : s >= WARM ? 'score-warm' : 'score-cold';
    },
  };
})();
