const headerRoot = document.getElementById("site-header");
const footerRoot = document.getElementById("site-footer");
const path = window.location.pathname;
const isAdminPage = path.includes("/dashboard/admin");
const isBorrowerPortal = path.includes("/dashboard/index") || path.includes("/auth/index");
const isPublicPage = !isAdminPage && !isBorrowerPortal;

const LOGO_SRC = "/assets/images/logo.png";
const LOGO_ALT = "Rates & Realty";

function brandHTML() {
  return `
    <a class="brand" href="/">
      <img src="${LOGO_SRC}" alt="${LOGO_ALT}" class="brand-logo"
           onerror="this.onerror=null;this.src='/assets/images/logo.svg';">
      <span class="brand-mark" style="display:none">R</span>
      <span class="brand-text">
        <strong>Rates &amp; Realty</strong>
        <span>AI-Powered Mortgage</span>
      </span>
    </a>
  `;
}

if (headerRoot) {
  let navLinks = "";
  let actions = "";

  if (isAdminPage) {
    navLinks = `
      <a class="nav-link" href="/dashboard/admin.html">Overview</a>
      <a class="nav-link" href="/dashboard/admin.html#pipeline">Pipeline</a>
      <a class="nav-link" href="/dashboard/admin.html#calendar">Calendar</a>
      <a class="nav-link" href="/dashboard/admin.html#analytics">Analytics</a>
    `;
    actions = `
      <a class="btn btn-ghost btn-sm" href="/public/unified-portal.html">Borrower View</a>
      <a class="btn btn-secondary btn-sm" href="/" target="_blank">Public Site</a>
    `;
  } else if (isBorrowerPortal) {
    navLinks = `
      <a class="nav-link" href="/public/unified-portal.html">My Application</a>
      <a class="nav-link" href="/public/apply.html">New Application</a>
    `;
    actions = `
      <a class="btn btn-secondary btn-sm" href="/">Public Site</a>
      <a class="btn btn-primary btn-sm" href="/public/apply.html">Apply Now</a>
    `;
  } else {
    navLinks = `
      <div class="nav-dropdown">
        <button class="nav-link nav-dropdown-trigger" type="button">Loans <span class="nav-chevron">&#9660;</span></button>
        <div class="nav-dropdown-menu">
          <div class="dropdown-col">
            <div class="dropdown-col-title">Purchase</div>
            <a href="/public/fha.html">FHA Loan</a>
            <a href="/public/conventional.html">Conventional</a>
            <a href="/public/va.html">VA Loan</a>
            <a href="/public/jumbo.html">Jumbo Loan</a>
            <a href="/public/bank-statement.html">Bank Statement</a>
            <a href="/public/refinance.html">Refinance</a>
          </div>
          <div class="dropdown-col">
            <div class="dropdown-col-title">Investment</div>
            <a href="/public/dscr.html">DSCR Investor</a>
            <a href="/public/fix-flip.html">Fix &amp; Flip</a>
            <a href="/public/commercial.html">Commercial</a>
          </div>
        </div>
      </div>
      <a class="nav-link" href="/public/search-homes.html">Search Homes</a>
      <a class="nav-link" href="/public/down-payment-assistance.html">Down Payment Help</a>
      <a class="nav-link" href="/public/credit-optimization.html">Credit Optimization</a>
      <a class="nav-link" href="/public/about.html">About</a>
    `;
    actions = `
      <a class="btn btn-secondary btn-sm" href="/public/unified-portal.html" id="mainLoginBtn">Login</a>
      <a class="btn btn-primary btn-sm" href="/public/apply.html">Apply Now</a>
    `;
  }

  headerRoot.innerHTML = `
    <header class="site-header" id="main-header">
      <div class="container">
        ${brandHTML()}
        <nav class="nav-links" id="nav-links-desktop" aria-label="Primary">
          ${navLinks}
        </nav>
        <div class="header-actions" id="header-actions-desktop">
          ${actions}
        </div>
        ${isPublicPage ? `
        <button class="hamburger-btn" id="hamburger-btn" aria-label="Open menu" aria-expanded="false">
          <span></span><span></span><span></span>
        </button>
        ` : ""}
      </div>
    </header>
    ${isPublicPage ? `
    <div class="mobile-nav" id="mobile-nav" aria-hidden="true">
      <div class="mobile-nav-inner">
        <div class="mobile-nav-links">
          <div class="mobile-nav-section-title">Purchase Loans</div>
          <a class="nav-link" href="/public/fha.html">FHA Loan</a>
          <a class="nav-link" href="/public/conventional.html">Conventional</a>
          <a class="nav-link" href="/public/va.html">VA Loan</a>
          <a class="nav-link" href="/public/jumbo.html">Jumbo Loan</a>
          <a class="nav-link" href="/public/bank-statement.html">Bank Statement</a>
          <a class="nav-link" href="/public/refinance.html">Refinance</a>
          <div class="mobile-nav-section-title">Investment Loans</div>
          <a class="nav-link" href="/public/dscr.html">DSCR Investor</a>
          <a class="nav-link" href="/public/fix-flip.html">Fix &amp; Flip</a>
          <a class="nav-link" href="/public/commercial.html">Commercial</a>
          <div class="mobile-nav-section-title">More</div>
          <a class="nav-link" href="/public/search-homes.html">Search Homes</a>
          <a class="nav-link" href="/public/down-payment-assistance.html">Down Payment Help</a>
          <a class="nav-link" href="/public/credit-optimization.html">Credit Optimization</a>
          <a class="nav-link" href="/public/about.html">About</a>
        </div>
        <div class="mobile-nav-actions">
          ${actions}
        </div>
      </div>
    </div>
    <div class="mobile-nav-overlay" id="mobile-nav-overlay"></div>
    ` : ""}
  `;

  // ── Scroll behavior (transparent → solid) ──
  if (isPublicPage) {
    const header = document.getElementById("main-header");
    const updateHeader = () => {
      if (window.scrollY > 60) {
        header?.classList.add("scrolled");
      } else {
        header?.classList.remove("scrolled");
      }
    };
    window.addEventListener("scroll", updateHeader, { passive: true });
    updateHeader();

    // ── Hamburger menu ──
    const hamburger = document.getElementById("hamburger-btn");
    const mobileNav = document.getElementById("mobile-nav");
    const overlay = document.getElementById("mobile-nav-overlay");

    function openMenu() {
      hamburger?.setAttribute("aria-expanded", "true");
      hamburger?.classList.add("is-open");
      mobileNav?.classList.add("is-open");
      overlay?.classList.add("is-visible");
      // Lock scroll and save position to prevent jump on restore
      const scrollY = window.scrollY;
      document.body.dataset.navScrollY = scrollY;
      document.body.style.overflow = "hidden";
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollY}px`;
      document.body.style.width = "100%";
    }
    function closeMenu() {
      hamburger?.setAttribute("aria-expanded", "false");
      hamburger?.classList.remove("is-open");
      mobileNav?.classList.remove("is-open");
      overlay?.classList.remove("is-visible");
      // Restore scroll position
      const scrollY = parseInt(document.body.dataset.navScrollY || "0", 10);
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";
      window.scrollTo(0, scrollY);
    }

    hamburger?.addEventListener("click", () => {
      if (mobileNav?.classList.contains("is-open")) closeMenu();
      else openMenu();
    });
    overlay?.addEventListener("click", closeMenu);
    overlay?.addEventListener("touchmove", function(e) { e.stopPropagation(); }, { passive: true });
    mobileNav?.addEventListener("touchmove", function(e) { e.stopPropagation(); }, { passive: true });
    mobileNav?.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeMenu));

    // ── Loans dropdown (click for touch + keyboard, hover handled by CSS) ──
    const dropdown = document.querySelector(".nav-dropdown");
    const trigger = document.querySelector(".nav-dropdown-trigger");
    if (dropdown && trigger) {
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.classList.toggle("open");
      });
      document.addEventListener("click", () => {
        dropdown.classList.remove("open");
      });
      dropdown.querySelector(".nav-dropdown-menu")?.addEventListener("click", (e) => {
        e.stopPropagation();
      });
    }
  }
}

if (footerRoot) {
  if (isAdminPage) {
    footerRoot.innerHTML = `
      <footer class="site-footer">
        <div class="container">
          <div class="footer-brand">
            ${brandHTML()}
            <p>Internal CRM workspace for Rates &amp; Realty team.</p>
          </div>
          <nav class="footer-col" aria-label="Footer CRM">
            <a href="/dashboard/admin.html">CRM Dashboard</a>
            <a href="/public/unified-portal.html">Borrower Portal</a>
            <a href="/">Public Site</a>
          </nav>
        </div>
        <div class="container">
          <p class="footer-bottom" style="margin-top:24px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06);color:var(--muted);font-size:0.8rem;">
            &copy; ${new Date().getFullYear()} Rates &amp; Realty. Internal use only.
          </p>
        </div>
      </footer>
    `;
  } else {
    footerRoot.innerHTML = `
      <footer class="site-footer" style="background:#060606;border-top:1px solid rgba(255,255,255,0.06);">
        <div class="container" style="padding-top:64px;padding-bottom:40px;">
          <div style="display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:48px;flex-wrap:wrap;">
            <div class="footer-brand">
              ${brandHTML()}
              <p style="color:#b6ab93;font-size:0.84rem;line-height:1.7;margin-top:12px;margin-bottom:0;">AI-powered mortgage and real estate experience for buyers, investors, and referral partners.</p>
              <div style="display:flex;align-items:center;gap:12px;margin-top:20px;">
                <span style="font-size:0.76rem;color:#b6ab93;padding:5px 12px;border:1px solid rgba(255,255,255,0.1);border-radius:999px;">NMLS Licensed</span>
                <span style="font-size:0.76rem;color:#b6ab93;padding:5px 12px;border:1px solid rgba(255,255,255,0.1);border-radius:999px;">Equal Housing Lender</span>
              </div>
            </div>
            <div class="footer-col">
              <span class="footer-col-title">Loan Programs</span>
              <a href="/public/dscr.html">DSCR Loans</a>
              <a href="/public/fha.html">FHA Loans</a>
              <a href="/public/conventional.html">Conventional</a>
              <a href="/public/va.html">VA Loans</a>
              <a href="/public/jumbo.html">Jumbo</a>
              <a href="/public/bank-statement.html">Bank Statement</a>
              <a href="/public/refinance.html">Refinance</a>
            </div>
            <div class="footer-col">
              <span class="footer-col-title">Get Started</span>
              <a href="/public/apply.html">Apply Now</a>
              <a href="/#lead-form">Free Consultation</a>
              <a href="/public/first-time-buyer.html">First-Time Buyer</a>
              <a href="/public/realtor-referral.html">Realtor Partners</a>
              <a href="/public/unified-portal.html">Borrower Portal</a>
            </div>
            <div class="footer-col">
              <span class="footer-col-title">Company</span>
              <a href="/public/about.html">About Us</a>
              <a href="/public/contact.html">Contact</a>
              <a href="/public/search-homes.html">Search Homes</a>
              <a href="/">Home</a>
              <div style="margin-top:16px;">
                <p style="color:#b6ab93;font-size:0.8rem;margin:0 0 4px;">&#128222; Call or Text</p>
                <a href="tel:+17144728508" style="color:#C9A84C;font-size:0.96rem;font-weight:700;text-decoration:none;">(714) 472-8508</a>
                <p style="color:#b6ab93;font-size:0.8rem;margin:8px 0 4px;">&#9993; Email</p>
                <a href="mailto:rene@ratesandrealty.com" style="color:#C9A84C;font-size:0.88rem;font-weight:600;">rene@ratesandrealty.com</a>
              </div>
            </div>
          </div>
        </div>
        <div class="container" style="padding-bottom:32px;">
          <div style="text-align:center;font-size:12px;color:#6b5f40;padding:16px 0;border-top:1px solid rgba(186,117,23,0.1);">
            &copy; ${new Date().getFullYear()} Rates &amp; Realty &middot; Rene Duarte NMLS #1795044 &middot; Equal Housing Lender &middot;
            <a href="https://nmlsconsumeraccess.org" target="_blank" style="color:#BA7517;text-decoration:none;">NMLS Consumer Access</a>
            <br><a href="/auth/admin-login.html" style="color:rgba(255,255,255,0.18);font-size:10px;text-decoration:none;margin-top:10px;display:inline-block;letter-spacing:0.08em;" onmouseover="this.style.color='rgba(201,168,76,0.6)'" onmouseout="this.style.color='rgba(255,255,255,0.18)'">&#x1f512; Team Login</a>
          </div>
        </div>
      </footer>
    `;
  }
}

// ── Logged-in state: update Login button ──
try {
  var u = JSON.parse(localStorage.getItem('portal_user') || localStorage.getItem('borrower_user') || 'null');
  if (u && u.first_name) {
    var loginBtn = document.getElementById('mainLoginBtn');
    if (loginBtn) {
      loginBtn.textContent = '\uD83D\uDC64 ' + u.first_name;
      loginBtn.href = '/public/unified-portal.html';
    }
  }
} catch(e) {}

// ── AI Agent FAB (admin pages only) ──
// Replaces the older green-phone Softphone Widget. The phone icon was
// misleading — the FAB's job is opening the AI assistant chat (the
// #tab-ai-agent panel inside the dashboard SPA, or the AI tab on
// standalone admin pages). Brand-gold sparkle, z-index 90 so modals
// (1000+) cover it cleanly.
if (isAdminPage || path.includes('/admin/')) {
  // Inject scoped CSS once.
  if (!document.getElementById('ai-agent-fab-css')) {
    var fabCss = document.createElement('style');
    fabCss.id = 'ai-agent-fab-css';
    fabCss.textContent =
      // pointer-events:auto !important defends against any wrapper that
      // sets pointer-events:none on body or sticky-overlay containers.
      // The svg child also gets pointer-events:none so clicks land on the
      // button, not the icon path (otherwise event.target.closest in any
      // ancestor delegated listener might misroute).
      '.ai-agent-fab{position:fixed;bottom:20px;right:20px;z-index:90;width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#C9A84C 0%,#B89540 100%);color:#0a0a0a;box-shadow:0 4px 16px rgba(0,0,0,.5),0 0 0 1px rgba(201,168,76,.2);display:flex;align-items:center;justify-content:center;transition:transform .15s ease,box-shadow .15s ease;font-family:inherit;padding:0;pointer-events:auto !important}'
      + '.ai-agent-fab > svg{pointer-events:none}'
      + '.ai-agent-fab:hover{transform:translateY(-2px) scale(1.05);box-shadow:0 6px 20px rgba(201,168,76,.4),0 0 0 1px rgba(201,168,76,.4)}'
      + '.ai-agent-fab:active{transform:translateY(0) scale(1)}'
      + '.ai-agent-fab:focus-visible{outline:2px solid #C9A84C;outline-offset:3px}'
      + '.ai-agent-fab::before{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid rgba(201,168,76,.3);opacity:0;animation:ai-fab-pulse 3s ease-out infinite;pointer-events:none}'
      + '@keyframes ai-fab-pulse{0%{opacity:0;transform:scale(1)}50%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.4)}}'
      + '@media(max-width:720px){.ai-agent-fab{width:48px;height:48px;bottom:16px;right:16px}}'
      + '@media print{.ai-agent-fab{display:none}}'
      // Bottom-of-page clearance so sticky footers / charts / table rows
      // don't sit under the FAB. 90px = 52 button + 20 margin + 18 safety.
      + 'body.has-ai-fab{padding-bottom:90px}'
      + '@media(max-width:720px){body.has-ai-fab{padding-bottom:84px}}'
      // ── CRM Copilot chat panel (opened by the FAB) ──
      // right:436 = clear of the staff-chat panel (right:20, width ~400) + a 16px gap,
      // so both can sit open side-by-side on desktop without overlapping. Width is
      // viewport-capped so it never runs off the left edge; narrow screens fill (below).
      + '.cop-panel{position:fixed;bottom:88px;right:436px;z-index:95;width:min(400px,calc(100vw - 456px));height:520px;max-height:calc(100vh - 120px);background:#0d0d0d;border:1px solid rgba(201,168,76,.28);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden;transform:scale(.95) translateY(12px);opacity:0;pointer-events:none;transition:all .16s cubic-bezier(.4,0,.2,1);transform-origin:bottom right;font-family:inherit}'
      + '.cop-panel.is-open{transform:none;opacity:1;pointer-events:auto}'
      + '.cop-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0}'
      + '.cop-title{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;color:#C9A84C;letter-spacing:.3px}'
      + '.cop-x{background:transparent;border:none;color:#888;font-size:14px;cursor:pointer;padding:4px 7px;border-radius:6px;line-height:1;font-family:inherit}'
      + '.cop-x:hover{color:#fff;background:rgba(255,255,255,.06)}'
      + '.cop-msgs{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}'
      + '.cop-empty{color:#aaa;text-align:center;padding:16px 8px;margin:auto 0}'
      + '.cop-empty-t{font-size:14px;color:#eee;font-weight:600}.cop-empty-s{font-size:12px;color:#888;margin-top:4px}'
      + '.cop-chips{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;margin-top:14px}'
      + '.cop-chip{background:rgba(201,168,76,.1);border:1px solid rgba(201,168,76,.35);color:#C9A84C;font-size:11.5px;font-weight:600;border-radius:14px;padding:6px 12px;cursor:pointer;font-family:inherit}'
      + '.cop-chip:hover{background:rgba(201,168,76,.2)}'
      + '.cop-msg{max-width:88%;font-size:13px;line-height:1.5;padding:9px 12px;border-radius:4px 12px 12px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);color:#e6e6e6;word-break:break-word;align-self:flex-start}'
      + '.cop-msg.mine{align-self:flex-end;background:rgba(201,168,76,.16);border-color:rgba(201,168,76,.3);color:#fff;border-radius:12px 4px 12px 12px;white-space:pre-wrap}'
      + '.cop-msg h3{font-size:14px;margin:8px 0 4px;color:#fff}.cop-msg h4{font-size:13px;margin:6px 0 3px;color:#fff}'
      + '.cop-msg ul{margin:6px 0;padding-left:18px}.cop-msg li{margin:2px 0}'
      + '.cop-msg code{background:rgba(255,255,255,.1);border-radius:4px;padding:1px 5px;font-size:12px}.cop-msg a{color:#C9A84C}'
      + '.cop-msg.cop-think{display:flex;flex-direction:row;gap:4px;align-items:center}'
      + '.cop-think span{width:6px;height:6px;border-radius:50%;background:#C9A84C;animation:cop-blink 1.2s infinite}'
      + '.cop-think span:nth-child(2){animation-delay:.2s}.cop-think span:nth-child(3){animation-delay:.4s}'
      + '@keyframes cop-blink{0%,60%,100%{opacity:.3}30%{opacity:1}}'
      + '.cop-composer{display:flex;gap:6px;align-items:center;padding:10px 12px;border-top:1px solid rgba(255,255,255,.06);flex-shrink:0}'
      + '.cop-composer input{flex:1 1 auto;min-width:0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#eee;font-size:13px;padding:9px 11px;outline:none;font-family:inherit}'
      + '.cop-send{flex:0 0 auto;background:#C9A84C;border:none;color:#111;font-weight:700;font-size:12px;border-radius:8px;padding:0 14px;height:36px;cursor:pointer;font-family:inherit}'
      // Below 900px there isn't room for two panels side-by-side, so the Copilot
      // fills the width (like the staff-chat panel) and opening one closes the other
      // (JS below) — no overlap at any size.
      + '@media(max-width:899px){.cop-panel{left:12px;right:12px;bottom:84px;width:auto;max-height:calc(100vh - 96px)}}';
    document.head.appendChild(fabCss);
  }
  document.body.classList.add('has-ai-fab');

  const fab = document.createElement('button');
  fab.className = 'ai-agent-fab';
  fab.type = 'button';
  fab.setAttribute('data-action', 'open-ai-agent');
  fab.setAttribute('aria-label', 'Open CRM Copilot');
  fab.title = 'Open CRM Copilot';
  // Sparkle icon — communicates "AI" at a glance without the phone-call
  // confusion the old icon caused.
  fab.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg>';
  // ── CRM Copilot: the FAB opens a real AI chat panel. The AI Agent STATS tab
  //    stays reachable via the sidebar "AI Agent" nav link (unchanged). ──
  var _copHistory = [];   // [{role:'user'|'assistant', content:string}] — running conversation
  var _copBusy = false;
  var COP_CHIPS = ["Who should I work today?", "How's my pipeline?", "Who's gone stale?", "Summarize [lead name]"];

  function copEsc(s) { return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Tiny SAFE markdown: escape first, then a limited subset (no raw HTML injection).
  function copMd(text) {
    var h = copEsc(text || '');
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/^### (.+)$/gm, '<h4>$1</h4>').replace(/^## (.+)$/gm, '<h3>$1</h3>').replace(/^# (.+)$/gm, '<h3>$1</h3>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/(?:^|\n)\s*(?:[-*]|\d+\.)\s+(.+)/g, '\n<li>$1</li>');
    h = h.replace(/(<li>[\s\S]*?<\/li>(?:\n<li>[\s\S]*?<\/li>)*)/g, '<ul>$1</ul>');
    h = h.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
    return h;
  }
  function copMount() {
    if (document.getElementById('crm-copilot-panel')) return;
    var p = document.createElement('div'); p.id = 'crm-copilot-panel'; p.className = 'cop-panel';
    p.innerHTML =
      '<div class="cop-head"><span class="cop-title"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/></svg> CRM Copilot</span>'
      + '<button class="cop-x" data-cop-close aria-label="Close">✕</button></div>'
      + '<div class="cop-msgs" id="cop-msgs"></div>'
      + '<div class="cop-composer"><input id="cop-input" type="text" placeholder="Ask about your leads, pipeline…" autocomplete="off"><button class="cop-send" data-cop-send>Send</button></div>';
    document.body.appendChild(p);
    copRender();
  }
  function copRender() {
    var box = document.getElementById('cop-msgs'); if (!box) return;
    if (!_copHistory.length && !_copBusy) {
      box.innerHTML = '<div class="cop-empty"><div class="cop-empty-t">Hi 👋 I\'m your CRM Copilot.</div>'
        + '<div class="cop-empty-s">Ask about your leads, pipeline, and who to work.</div>'
        + '<div class="cop-chips">' + COP_CHIPS.map(function (c) { return '<button class="cop-chip" data-cop-chip="' + copEsc(c) + '">' + copEsc(c) + '</button>'; }).join('') + '</div></div>';
      return;
    }
    var html = _copHistory.map(function (m) {
      var mine = m.role === 'user';
      return '<div class="cop-msg' + (mine ? ' mine' : '') + '">' + (mine ? copEsc(m.content) : copMd(m.content)) + '</div>';
    }).join('');
    if (_copBusy) html += '<div class="cop-msg cop-think"><span></span><span></span><span></span></div>';
    box.innerHTML = html; box.scrollTop = box.scrollHeight;
  }
  async function copToken() {
    try {
      var cl = (typeof window.getSupabaseClient === 'function') ? await window.getSupabaseClient() : window._supabaseClient;
      if (!cl) return null;
      var r = await cl.auth.getSession();
      return (r && r.data && r.data.session) ? r.data.session.access_token : null;
    } catch (e) { return null; }
  }
  async function copSend(text) {
    text = (text || '').trim(); if (!text || _copBusy) return;
    var cfg = window.APP_CONFIG || {};
    _copHistory.push({ role: 'user', content: text });
    _copBusy = true; copRender();
    var token = await copToken();
    if (!token) { _copBusy = false; _copHistory.push({ role: 'assistant', content: 'Please sign in to use the Copilot.' }); copRender(); return; }
    try {
      var prior = _copHistory.slice(0, -1).slice(-10);   // prior turns only (endpoint re-adds the message)
      var res = await fetch((cfg.SUPABASE_URL || '') + '/functions/v1/crm-copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': cfg.SUPABASE_ANON_KEY || '', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ message: text, history: prior })
      });
      var data = await res.json().catch(function () { return {}; });
      _copBusy = false;
      if (data && data.error) {
        _copHistory.push({ role: 'assistant', content: (res.status === 403) ? 'Copilot is available to admin/staff only.' : (data.error || 'Something went wrong.') });
      } else {
        _copHistory.push({ role: 'assistant', content: (data && data.reply) || 'No response — try rephrasing.' });
      }
      copRender();
    } catch (e) {
      _copBusy = false; _copHistory.push({ role: 'assistant', content: 'Network error — please try again.' }); copRender();
    }
  }
  function copSetOpen(v) {
    copMount();
    var p = document.getElementById('crm-copilot-panel'); if (!p) return;
    // Narrow screens can't show both panels side-by-side — close the staff-chat
    // panel when the Copilot opens so they never cover each other.
    if (v && window.innerWidth < 900) { var scp = document.getElementById('staff-chat-panel'); if (scp) scp.classList.remove('is-open'); }
    p.classList.toggle('is-open', v);
    try { sessionStorage.setItem('rnr_copilot_open', v ? '1' : '0'); } catch (e) {}
    if (v) { var i = document.getElementById('cop-input'); if (i) setTimeout(function () { i.focus(); }, 40); }
  }
  function toggleCopilot() {
    var p = document.getElementById('crm-copilot-panel');
    copSetOpen(!(p && p.classList.contains('is-open')));
  }

  fab.addEventListener('click', toggleCopilot);
  document.body.appendChild(fab);

  // Panel controls (close / chips / send / Enter) — delegated, installed once.
  if (!window._copilotWired) {
    window._copilotWired = true;
    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-cop-close]')) { copSetOpen(false); return; }
      var chip = e.target.closest('[data-cop-chip]');
      if (chip) {
        var c = chip.getAttribute('data-cop-chip');
        if (/\[lead name\]/i.test(c)) { var i = document.getElementById('cop-input'); if (i) { i.value = 'Summarize '; i.focus(); } }
        else { copSend(c); }
        return;
      }
      if (e.target.closest('[data-cop-send]')) { var inp = document.getElementById('cop-input'); if (inp) { var v = inp.value; inp.value = ''; copSend(v); } return; }
      // Opening the staff-chat bubble on a narrow screen closes the Copilot (mirror of copSetOpen).
      if (window.innerWidth < 900 && e.target.closest('[data-sc-toggle]')) { var cp = document.getElementById('crm-copilot-panel'); if (cp) cp.classList.remove('is-open'); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.id === 'cop-input') { e.preventDefault(); var v = e.target.value; e.target.value = ''; copSend(v); }
    });
  }

  // Restore the panel's open/closed state within the session.
  try { if (sessionStorage.getItem('rnr_copilot_open') === '1') copSetOpen(true); } catch (e) {}
  // (Staff Chat bubble is mounted from /admin/js/auth-guard.js — the universal
  //  staff-page marker — so it reaches every admin CRM + VA page, not just the
  //  handful that load this layout.js. See auth-guard mountStaffChat().)
}
