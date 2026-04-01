(function() {
  var user = (function() { try { var p = localStorage.getItem('portal_user') || localStorage.getItem('borrower_user'); return p ? JSON.parse(p) : null; } catch(e) { return null; } })();
  var portalLabel = user ? ('\uD83D\uDC64 ' + (user.first_name || 'My Portal')) : 'My Portal';
  var portalDisplay = user ? 'inline-flex' : 'none';

  var nav = ''
  + '<nav style="display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:58px;background:#0d0d0d;border-bottom:1px solid #222;position:sticky;top:0;z-index:300;box-shadow:0 2px 20px rgba(0,0,0,.5)">'
  + '  <a href="/" style="display:flex;align-items:center;gap:10px;text-decoration:none">'
  + '    <img src="/assets/images/logo.png" alt="Rates &amp; Realty" style="height:34px" onerror="this.onerror=null;this.src=\'/assets/images/logo.svg\'">'
  + '    <div>'
  + '      <div style="font-size:.95rem;font-weight:700;color:#C9A84C;line-height:1.2">Rates &amp; Realty</div>'
  + '      <div style="font-size:.58rem;color:#666;text-transform:uppercase;letter-spacing:.1em">AI-Powered Mortgage</div>'
  + '    </div>'
  + '  </a>'
  + '  <div style="display:flex;align-items:center;gap:12px">'
  + '    <a href="/public/search-homes.html" style="color:#888;text-decoration:none;font-size:.83rem;transition:color .2s" onmouseover="this.style.color=\'#C9A84C\'" onmouseout="this.style.color=\'#888\'">Search Homes</a>'
  + '    <a href="/public/apply.html" style="color:#888;text-decoration:none;font-size:.83rem;transition:color .2s" onmouseover="this.style.color=\'#C9A84C\'" onmouseout="this.style.color=\'#888\'">Apply Now</a>'
  + '    <a href="/public/unified-portal.html" id="navPortalLink" style="display:' + portalDisplay + ';align-items:center;gap:6px;background:rgba(201,168,76,.12);border:1px solid rgba(201,168,76,.3);color:#C9A84C;padding:5px 13px;border-radius:16px;font-size:.78rem;text-decoration:none">' + portalLabel + '</a>'
  + '    <a href="https://rene-duarte-rates-realty.cal.com/30min" target="_blank" style="background:#C9A84C;color:#000;padding:7px 16px;border-radius:18px;font-weight:700;font-size:.8rem;text-decoration:none">Schedule a Call</a>'
  + '  </div>'
  + '</nav>';

  var existing = document.querySelector('nav.shared-nav');
  if (existing) { existing.outerHTML = nav; }
  else { document.body.insertAdjacentHTML('afterbegin', nav); }
})();
