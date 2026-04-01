(function () {
  'use strict';

  const _SB = 'https://ljywhvbmsibwnssxpesh.supabase.co';
  const _SK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqeXdodmJtc2lid25zc3hwZXNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM2MjgzNDIsImV4cCI6MjA1OTIwNDM0Mn0.JEMDMlSo1OSmOLJnnqP3wZq0GFjDfMqcHEHGY-rVfI4';
  const _AUTH_URL = _SB + '/functions/v1/portal-auth';

  let _callback = null;
  let _overlay, _card, _tabSignup, _tabLogin, _formSignup, _formLogin, _successView;
  let _errSignup, _errLogin, _btnSignup, _btnLogin;

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #pa-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,.7);
        z-index: 10000; display: none;
        align-items: center; justify-content: center;
      }
      #pa-overlay.pa-visible { display: flex; }
      #pa-card {
        position: relative; max-width: 480px; width: 92%; background: #111;
        border: 1px solid #222; border-radius: 16px; padding: 32px;
        color: #eee; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        max-height: 90vh; overflow-y: auto;
      }
      #pa-close {
        position: absolute; top: 12px; right: 16px; background: none; border: none;
        color: #888; font-size: 24px; cursor: pointer; line-height: 1;
      }
      #pa-close:hover { color: #eee; }
      .pa-tabs { display: flex; gap: 24px; margin-bottom: 24px; border-bottom: 1px solid #222; }
      .pa-tab {
        background: none; border: none; color: #888; font-size: 15px; padding: 8px 0;
        cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
        font-weight: 500;
      }
      .pa-tab.pa-active { color: #C9A84C; border-bottom-color: #C9A84C; }
      .pa-tab:hover { color: #eee; }
      .pa-input {
        display: block; width: 100%; padding: 10px 12px; margin-bottom: 12px;
        background: #1a1a1a; border: 1px solid #222; border-radius: 8px;
        color: #fff; font-size: 14px; box-sizing: border-box;
        outline: none; transition: border-color .2s;
      }
      .pa-input:focus { border-color: #C9A84C; }
      .pa-input::placeholder { color: #666; }
      .pa-label { display: block; font-size: 13px; color: #888; margin-bottom: 4px; }
      .pa-row { display: flex; gap: 12px; }
      .pa-row > div { flex: 1; }
      .pa-checkbox-wrap {
        display: flex; align-items: flex-start; gap: 8px; margin: 16px 0;
        font-size: 13px; color: #888;
      }
      .pa-checkbox-wrap input { margin-top: 2px; accent-color: #C9A84C; }
      .pa-btn {
        display: block; width: 100%; padding: 12px; border: none; border-radius: 8px;
        background: #C9A84C; color: #0a0a0a; font-size: 15px; font-weight: 600;
        cursor: pointer; text-align: center; transition: opacity .2s;
      }
      .pa-btn:hover { opacity: .9; }
      .pa-btn:disabled { opacity: .6; cursor: not-allowed; }
      .pa-link {
        display: block; text-align: center; margin-top: 16px;
        color: #888; font-size: 13px; cursor: pointer;
      }
      .pa-link:hover { color: #C9A84C; }
      .pa-link span { color: #C9A84C; }
      .pa-error { color: #e74c3c; font-size: 13px; margin-bottom: 12px; display: none; }
      .pa-hidden { display: none !important; }
      #pa-success {
        text-align: center; padding: 24px 0;
      }
      #pa-success .pa-check {
        width: 56px; height: 56px; border-radius: 50%; background: #C9A84C;
        display: flex; align-items: center; justify-content: center;
        margin: 0 auto 16px; font-size: 28px; color: #0a0a0a;
      }
      #pa-success h2 { margin: 0 0 8px; font-size: 22px; color: #eee; }
      #pa-success p { color: #888; font-size: 14px; margin: 0 0 24px; }
    `;
    document.head.appendChild(style);
  }

  function injectHTML() {
    const div = document.createElement('div');
    div.innerHTML = `
      <div id="pa-overlay">
        <div id="pa-card">
          <button id="pa-close">&times;</button>

          <div id="pa-tabs" class="pa-tabs">
            <button class="pa-tab pa-active" data-tab="signup">Create Account</button>
            <button class="pa-tab" data-tab="login">Sign In</button>
          </div>

          <form id="pa-form-signup">
            <div class="pa-row">
              <div>
                <label class="pa-label">First Name *</label>
                <input class="pa-input" name="first_name" required placeholder="First Name">
              </div>
              <div>
                <label class="pa-label">Last Name</label>
                <input class="pa-input" name="last_name" placeholder="Last Name">
              </div>
            </div>
            <label class="pa-label">Email *</label>
            <input class="pa-input" name="email" type="email" required placeholder="you@example.com">
            <label class="pa-label">Phone</label>
            <input class="pa-input" name="phone" type="tel" placeholder="(555) 555-5555">
            <label class="pa-label">Password</label>
            <input class="pa-input" name="password" type="password" placeholder="Leave blank for auto-generated">
            <div class="pa-checkbox-wrap">
              <input type="checkbox" id="pa-alerts" checked>
              <label for="pa-alerts">I agree to receive property alerts and mortgage updates</label>
            </div>
            <div id="pa-err-signup" class="pa-error"></div>
            <button type="submit" class="pa-btn" id="pa-btn-signup">Create My Account</button>
            <div class="pa-link" id="pa-to-login">Already have an account? <span>Sign In</span></div>
          </form>

          <form id="pa-form-login" class="pa-hidden">
            <label class="pa-label">Email</label>
            <input class="pa-input" name="email" type="email" required placeholder="you@example.com">
            <label class="pa-label">Password</label>
            <input class="pa-input" name="password" type="password" required placeholder="Password">
            <div id="pa-err-login" class="pa-error"></div>
            <button type="submit" class="pa-btn" id="pa-btn-login">Sign In</button>
            <div class="pa-link" id="pa-to-signup">Don't have an account? <span>Create one free</span></div>
          </form>

          <div id="pa-success" class="pa-hidden">
            <div class="pa-check">&#10003;</div>
            <h2>Account created!</h2>
            <p>Check your email for login details</p>
            <button class="pa-btn" id="pa-go-portal">Go to My Portal</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(div.firstElementChild);
  }

  function bindElements() {
    _overlay = document.getElementById('pa-overlay');
    _card = document.getElementById('pa-card');
    _tabSignup = document.querySelector('.pa-tab[data-tab="signup"]');
    _tabLogin = document.querySelector('.pa-tab[data-tab="login"]');
    _formSignup = document.getElementById('pa-form-signup');
    _formLogin = document.getElementById('pa-form-login');
    _successView = document.getElementById('pa-success');
    _errSignup = document.getElementById('pa-err-signup');
    _errLogin = document.getElementById('pa-err-login');
    _btnSignup = document.getElementById('pa-btn-signup');
    _btnLogin = document.getElementById('pa-btn-login');
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.style.display = 'block';
  }

  function clearErrors() {
    _errSignup.style.display = 'none';
    _errLogin.style.display = 'none';
    _errSignup.textContent = '';
    _errLogin.textContent = '';
  }

  function switchTab(tab) {
    clearErrors();
    _successView.classList.add('pa-hidden');
    if (tab === 'signup') {
      _tabSignup.classList.add('pa-active');
      _tabLogin.classList.remove('pa-active');
      _formSignup.classList.remove('pa-hidden');
      _formLogin.classList.add('pa-hidden');
    } else {
      _tabLogin.classList.add('pa-active');
      _tabSignup.classList.remove('pa-active');
      _formLogin.classList.remove('pa-hidden');
      _formSignup.classList.add('pa-hidden');
    }
  }

  function showModal(tab) {
    switchTab(tab || 'signup');
    _formSignup.reset();
    _formLogin.reset();
    _successView.classList.add('pa-hidden');
    document.getElementById('pa-tabs').classList.remove('pa-hidden');
    clearErrors();
    _btnSignup.disabled = false;
    _btnSignup.textContent = 'Create My Account';
    _btnLogin.disabled = false;
    _btnLogin.textContent = 'Sign In';
    _overlay.classList.add('pa-visible');
  }

  function hideModal() {
    _overlay.classList.remove('pa-visible');
    _callback = null;
  }

  function onAuthSuccess(user, isSignup) {
    localStorage.setItem('portal_user', JSON.stringify(user));
    syncShowingCart(user);
    if (isSignup) {
      _formSignup.classList.add('pa-hidden');
      _formLogin.classList.add('pa-hidden');
      document.getElementById('pa-tabs').classList.add('pa-hidden');
      _successView.classList.remove('pa-hidden');
    } else {
      hideModal();
    }
    if (_callback) {
      var cb = _callback;
      _callback = null;
      cb(user);
    }
  }

  function syncShowingCart(user) {
    try {
      var cart = JSON.parse(localStorage.getItem('showingCart') || '[]');
      if (cart.length > 0 && user && user.id) {
        fetch(_SB + '/rest/v1/showings', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': _SK,
            'Authorization': 'Bearer ' + _SK,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ contact_id: user.id })
        }).catch(function () { /* fire and forget */ });
      }
    } catch (e) { /* ignore */ }
  }

  async function apiCall(body) {
    var resp = await fetch(_AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': _SK
      },
      body: JSON.stringify(body)
    });
    return resp.json();
  }

  function bindEvents() {
    // Close modal
    _overlay.addEventListener('click', function (e) {
      if (e.target === _overlay) hideModal();
    });
    document.getElementById('pa-close').addEventListener('click', hideModal);

    // Tabs
    _tabSignup.addEventListener('click', function () { switchTab('signup'); });
    _tabLogin.addEventListener('click', function () { switchTab('login'); });
    document.getElementById('pa-to-login').addEventListener('click', function () { switchTab('login'); });
    document.getElementById('pa-to-signup').addEventListener('click', function () { switchTab('signup'); });

    // Signup submit
    _formSignup.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearErrors();
      var fd = new FormData(_formSignup);
      var email = (fd.get('email') || '').trim();
      var first_name = (fd.get('first_name') || '').trim();
      if (!email || !first_name) {
        showError(_errSignup, 'First name and email are required.');
        return;
      }
      _btnSignup.disabled = true;
      _btnSignup.textContent = 'Creating account...';
      try {
        var body = {
          action: 'signup',
          email: email,
          first_name: first_name,
          last_name: (fd.get('last_name') || '').trim(),
          phone: (fd.get('phone') || '').trim(),
          password: (fd.get('password') || '').trim() || undefined
        };
        var data = await apiCall(body);
        if (data.error) {
          showError(_errSignup, data.error);
          _btnSignup.disabled = false;
          _btnSignup.textContent = 'Create My Account';
        } else if (data.success && data.user) {
          onAuthSuccess(data.user, true);
        } else {
          showError(_errSignup, 'Unexpected response. Please try again.');
          _btnSignup.disabled = false;
          _btnSignup.textContent = 'Create My Account';
        }
      } catch (err) {
        showError(_errSignup, 'Network error. Please try again.');
        _btnSignup.disabled = false;
        _btnSignup.textContent = 'Create My Account';
      }
    });

    // Login submit
    _formLogin.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearErrors();
      var fd = new FormData(_formLogin);
      var email = (fd.get('email') || '').trim();
      var password = (fd.get('password') || '').trim();
      if (!email || !password) {
        showError(_errLogin, 'Email and password are required.');
        return;
      }
      _btnLogin.disabled = true;
      _btnLogin.textContent = 'Signing in...';
      try {
        var data = await apiCall({ action: 'login', email: email, password: password });
        if (data.error) {
          showError(_errLogin, data.error);
          _btnLogin.disabled = false;
          _btnLogin.textContent = 'Sign In';
        } else if (data.success && data.user) {
          onAuthSuccess(data.user, false);
        } else {
          showError(_errLogin, 'Unexpected response. Please try again.');
          _btnLogin.disabled = false;
          _btnLogin.textContent = 'Sign In';
        }
      } catch (err) {
        showError(_errLogin, 'Network error. Please try again.');
        _btnLogin.disabled = false;
        _btnLogin.textContent = 'Sign In';
      }
    });

    // Go to portal button
    document.getElementById('pa-go-portal').addEventListener('click', function () {
      window.location.href = '/public/portal.html';
    });
  }

  function init() {
    injectStyles();
    injectHTML();
    bindElements();
    bindEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API
  window.PortalAuth = {
    requireAuth: function (callback) {
      var user = this.getUser();
      if (user) {
        callback(user);
      } else {
        _callback = callback;
        showModal('signup');
      }
    },
    showSignup: function (callback) {
      _callback = callback || null;
      showModal('signup');
    },
    showLogin: function (callback) {
      _callback = callback || null;
      showModal('login');
    },
    getUser: function () {
      try {
        return JSON.parse(localStorage.getItem('portal_user')) || null;
      } catch (e) {
        return null;
      }
    },
    logout: function () {
      localStorage.removeItem('portal_user');
      window.location.href = '/public/search-homes.html';
    },
    isLoggedIn: function () {
      return !!this.getUser();
    }
  };
})();
