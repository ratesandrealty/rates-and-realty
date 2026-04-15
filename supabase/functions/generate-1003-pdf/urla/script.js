/* URLA 1003 — Client-side fill logic
 * Reads window.URLA_DATA (injected by the edge function) and populates
 * every [data-field] element + all checkbox spans.
 */

const URLA = {
  fill(data) {
    if (!data) return;

    // Populate data-field targets — supports nested paths like "borrower.fullName"
    document.querySelectorAll('[data-field]').forEach((el) => {
      const path = el.getAttribute('data-field');
      let val = this.getPath(data, path);
      if (val === undefined || val === null) val = '';

      // Apply formatting hints
      const fmt = el.getAttribute('data-format');
      if (fmt === 'currency') val = this.formatCurrency(val);
      else if (fmt === 'date') val = this.formatDate(val);
      else if (fmt === 'ssn') val = this.formatSSN(val);
      else if (fmt === 'percent' && val) val = val + '%';

      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = val;
      else el.textContent = val;
    });

    this.fillCheckboxes(data);
  },

  getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  },

  setCb(id, on) {
    const el = document.getElementById(id);
    if (el) el.textContent = on ? '\u2611' : '\u2610'; // ☑ / ☐
  },

  fillCheckboxes(data) {
    const b = data.borrower || {};
    const l = data.loan || {};
    const decl = data.declarations || {};

    // Citizenship
    const cit = String(b.citizenship || '').toLowerCase().replace(/[^a-z]/g, '');
    this.setCb('cb-citizen', cit === 'uscitizen' || cit === 'usacitizen');
    this.setCb('cb-perm', cit === 'permanentresidentalien' || cit === 'permanentresident');
    this.setCb('cb-nonperm', cit === 'nonpermanentresidentalien' || cit === 'nonpermanentresident');

    // Credit type (individual/joint)
    const hasCoBorrower = !!(data.coBorrower && data.coBorrower.fullName);
    this.setCb('cb-credit-individual', !hasCoBorrower);
    this.setCb('cb-credit-joint', hasCoBorrower);

    // Marital Status
    const ms = String(b.maritalStatus || '').toLowerCase();
    this.setCb('cb-married', ms === 'married');
    this.setCb('cb-separated', ms === 'separated');
    this.setCb('cb-unmarried', ms.includes('unmarried') || ms.includes('single') || ms.includes('divorced'));

    // Housing (current address)
    const housing = String((b.currentAddress || {}).housing || '').toLowerCase();
    this.setCb('cb-housing-noexpense', housing.includes('no primary') || housing.includes('noexpense'));
    this.setCb('cb-housing-own', housing === 'own');
    this.setCb('cb-housing-rent', housing === 'rent');

    // Loan Purpose
    const lp = String(l.purpose || '').toLowerCase();
    this.setCb('cb-purchase', lp === 'purchase');
    this.setCb('cb-refinance', lp === 'refinance');
    this.setCb('cb-purpose-other', lp === 'other');

    // Occupancy
    const occ = String((l.property || {}).occupancy || '').toLowerCase();
    this.setCb('cb-primary', occ.includes('primary'));
    this.setCb('cb-second', occ.includes('second'));
    this.setCb('cb-investment', occ.includes('invest'));
    this.setCb('cb-fha-secondary', occ.includes('fha secondary'));

    // Mixed use / Manufactured
    this.setCb('cb-mixed-yes', !!(l.property && l.property.mixedUse));
    this.setCb('cb-mixed-no', !(l.property && l.property.mixedUse));
    this.setCb('cb-manufactured-yes', !!(l.property && l.property.manufactured));
    this.setCb('cb-manufactured-no', !(l.property && l.property.manufactured));

    // Loan Type
    const lt = String(l.type || '');
    this.setCb('cb-conventional', lt === 'Conventional');
    this.setCb('cb-fha', lt === 'FHA');
    this.setCb('cb-va', lt === 'VA');
    this.setCb('cb-usda', lt === 'USDA-RD' || lt === 'USDA');

    // Employment status (current)
    const emp = (data.employment || {}).current || {};
    this.setCb('cb-emp-company', !emp.selfEmployed);
    this.setCb('cb-emp-self', !!emp.selfEmployed);
    this.setCb('cb-emp-family', !!emp.familyEmployer);

    // Military
    const mil = !!b.militaryService;
    this.setCb('cb-military-no', !mil);
    this.setCb('cb-military-yes', mil);
    const milSt = String(b.militaryStatus || '');
    this.setCb('cb-mil-active', milSt === 'Currently serving');
    this.setCb('cb-mil-retired', milSt === 'Veteran');
    this.setCb('cb-mil-reserve', milSt === 'Reserve/National Guard');
    this.setCb('cb-mil-surviving', milSt === 'Surviving spouse');

    // Declarations A through M (including D.1 and D.2)
    ['a','b','c','d1','d2','e','f','g','h','i','j','k','l','m'].forEach((key) => {
      const v = decl[key];
      this.setCb('decl-' + key + '-yes', !!v);
      this.setCb('decl-' + key + '-no', !v);
    });

    // Bankruptcy chapters
    const bk = String(decl.bankruptcyType || '');
    this.setCb('cb-bk-7', bk.includes('7'));
    this.setCb('cb-bk-11', bk.includes('11'));
    this.setCb('cb-bk-12', bk.includes('12'));
    this.setCb('cb-bk-13', bk.includes('13'));
  },

  formatCurrency(val) {
    if (val == null || val === '') return '';
    const n = parseFloat(String(val).replace(/[$,]/g, ''));
    if (isNaN(n)) return String(val);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  formatDate(val) {
    if (!val) return '';
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
  },

  formatSSN(val) {
    if (!val) return '';
    const s = String(val).replace(/\D/g, '');
    return s.length === 9 ? 'XXX-XX-' + s.slice(5) : String(val);
  },
};

// Auto-fill from window.URLA_DATA if present
(function () {
  if (typeof window !== 'undefined' && window.URLA_DATA) {
    try { URLA.fill(window.URLA_DATA); } catch (e) { console.error('[URLA] fill error', e); }
  }
})();
