// auth-persist.js — Rates & Realty shared auth state
window.RRAuth = {
  _keys: ['portal_user','borrower_user'],
  getUser: function() {
    for (var i = 0; i < this._keys.length; i++) {
      try { var raw = localStorage.getItem(this._keys[i]); if (raw) { var u = JSON.parse(raw); if (u && u.email) return u; } } catch(e) {}
    }
    var email = localStorage.getItem('borrower_email') || localStorage.getItem('user_email');
    if (email) return { email: email, first_name: localStorage.getItem('borrower_first_name') || '', borrower_id: localStorage.getItem('borrower_id') || '' };
    return null;
  },
  setUser: function(user) {
    if (!user) return;
    var json = JSON.stringify(user);
    localStorage.setItem('portal_user', json);
    localStorage.setItem('borrower_user', json);
    localStorage.setItem('borrower_email', user.email || '');
    localStorage.setItem('borrower_first_name', user.first_name || '');
    localStorage.setItem('user_email', user.email || '');
    if (user.borrower_id) localStorage.setItem('borrower_id', user.borrower_id);
  },
  clearUser: function() {
    ['portal_user','borrower_user','borrower_email','borrower_first_name','user_email','user_name','borrower_id','borrower_token'].forEach(function(k) { localStorage.removeItem(k); });
  },
  isLoggedIn: function() { return !!this.getUser(); },
  updateNav: function() {
    var user = this.getUser();
    if (!user) return;
    var portalLinks = document.querySelectorAll('#navPortalLink, [data-portal-link]');
    portalLinks.forEach(function(el) {
      el.style.display = 'inline-flex';
      el.textContent = '\uD83D\uDC64 ' + (user.first_name || 'My Portal');
      if (el.tagName === 'A') el.href = '/public/unified-portal.html';
    });
  }
};
document.addEventListener('DOMContentLoaded', function() { window.RRAuth.updateNav(); });
window.getPortalUser = function() { return window.RRAuth.getUser(); };
