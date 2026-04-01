const headerRoot = document.getElementById("site-header");
const footerRoot = document.getElementById("site-footer");
const path = window.location.pathname;
const isAdminPage = path.includes("/dashboard/admin");
const isBorrowerPortal = path.includes("/dashboard/index") || path.includes("/auth/index");
const isPublicPage = !isAdminPage && !isBorrowerPortal;

const LOGO_SRC = "/public/images/logo.png";
const LOGO_ALT = "Rates & Realty";

function brandHTML() {
  return `
    <a class="brand" href="/">
      <img src="${LOGO_SRC}" alt="${LOGO_ALT}" class="brand-logo"
           onerror="this.style.display='none';this.nextElementSibling.style.display='grid';">
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
            <br><a href="/dashboard/admin.html" style="color:rgba(255,255,255,0.25);font-size:11px;text-decoration:none;margin-top:8px;display:inline-block;letter-spacing:0.05em;" onmouseover="this.style.color='rgba(255,255,255,0.5)'" onmouseout="this.style.color='rgba(255,255,255,0.25)'">CRM Login</a>
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

