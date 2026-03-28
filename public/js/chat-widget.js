/* ================================================================
   RATES & REALTY — AI Chat Widget
   Self-initialising · injected into every page via <script> tag
   Edge Function: /functions/v1/chat-ai
   ================================================================ */
(function () {
  'use strict';

  // ── Config ─────────────────────────────────────────────────────────
  const EDGE_URL = 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/chat-ai';

  const SUGGESTED_QUESTIONS = [
    'How do I qualify for a mortgage?',
    'What down payment help is available?',
    'What is a DSCR loan?',
    'How can I improve my credit score?',
    'What are today\'s mortgage rates?',
    'How long does buying a home take?'
  ];

  const INITIAL_MESSAGE =
    'Hi! I\'m Rene\'s AI assistant for Rates & Realty. I can answer questions about ' +
    'mortgages, down payment programs, loan types, and the home buying process in ' +
    'Orange County. What\'s on your mind?';

  // ── Session state ───────────────────────────────────────────────────
  let sessionId = sessionStorage.getItem('rr_chat_session');
  if (!sessionId) {
    sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    sessionStorage.setItem('rr_chat_session', sessionId);
  }

  let messages      = [];   // full history sent to AI
  let guestName     = sessionStorage.getItem('rr_guest_name')  || '';
  let guestEmail    = sessionStorage.getItem('rr_guest_email') || '';
  let leadCaptured  = !!guestEmail;
  let isOpen        = false;
  let isTyping      = false;
  let badgeShown    = false;

  // ── Inject CSS ──────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #rr-chat-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483640;
      width: 56px; height: 56px; border-radius: 50%;
      background: #BA7517; border: none; cursor: pointer;
      box-shadow: 0 4px 20px rgba(0,0,0,0.35), 0 0 0 0 rgba(186,117,23,0.5);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s ease, background 0.2s ease;
      padding: 0;
    }
    #rr-chat-btn:hover { background: #d48b20; transform: scale(1.07); }
    #rr-chat-btn svg  { width: 26px; height: 26px; fill: #fff; pointer-events: none; }

    #rr-chat-badge {
      position: absolute; top: -3px; right: -3px;
      width: 18px; height: 18px; border-radius: 50%;
      background: #e24b4a; color: #fff; font-size: 11px; font-weight: 700;
      display: none; align-items: center; justify-content: center;
      border: 2px solid #050505; pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #rr-chat-badge.visible { display: flex; }

    @keyframes rrPulse {
      0%   { box-shadow: 0 4px 20px rgba(0,0,0,0.35), 0 0 0 0 rgba(186,117,23,0.55); }
      70%  { box-shadow: 0 4px 20px rgba(0,0,0,0.35), 0 0 0 12px rgba(186,117,23,0); }
      100% { box-shadow: 0 4px 20px rgba(0,0,0,0.35), 0 0 0 0 rgba(186,117,23,0); }
    }
    #rr-chat-btn.pulse { animation: rrPulse 2s ease-out 3; }

    #rr-chat-window {
      position: fixed; bottom: 90px; right: 24px; z-index: 2147483639;
      width: 360px; max-height: 580px;
      background: #1a1505; border: 1px solid rgba(186,117,23,0.35);
      border-radius: 16px; overflow: hidden;
      display: none; flex-direction: column;
      box-shadow: 0 12px 48px rgba(0,0,0,0.55);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Manrope, sans-serif;
      font-size: 14px;
      touch-action: pan-y;
      overscroll-behavior: contain;
    }
    #rr-chat-window.open { display: flex; }

    /* Header */
    #rr-chat-header {
      background: linear-gradient(135deg, #BA7517, #9a5f0e);
      padding: 13px 14px; display: flex; align-items: center; gap: 10px;
      flex-shrink: 0;
    }
    .rr-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(0,0,0,0.25); color: #fff;
      font-size: 15px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; border: 1px solid rgba(255,255,255,0.2);
    }
    .rr-hdr-info { flex: 1; min-width: 0; }
    .rr-hdr-name  { font-size: 13.5px; font-weight: 700; color: #fff; }
    .rr-hdr-sub   {
      font-size: 11px; color: rgba(255,255,255,0.8);
      display: flex; align-items: center; gap: 5px; margin-top: 1px;
    }
    .rr-online-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #7fff7f; display: inline-block; flex-shrink: 0;
    }
    #rr-hdr-phone { font-size: 11px; color: rgba(255,255,255,0.85); text-decoration: none; font-weight: 600; white-space: nowrap; }
    #rr-hdr-phone:hover { color: #fff; }
    #rr-chat-close {
      background: none; border: none; color: rgba(255,255,255,0.7);
      cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 4px;
      border-radius: 4px; flex-shrink: 0;
    }
    #rr-chat-close:hover { color: #fff; background: rgba(0,0,0,0.15); }

    /* Messages */
    #rr-chat-messages {
      flex: 1; overflow-y: auto; padding: 14px 14px 6px;
      display: flex; flex-direction: column; gap: 10px;
      scroll-behavior: smooth; min-height: 160px;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
    }
    #rr-chat-messages::-webkit-scrollbar { width: 4px; }
    #rr-chat-messages::-webkit-scrollbar-track { background: transparent; }
    #rr-chat-messages::-webkit-scrollbar-thumb { background: rgba(186,117,23,0.3); border-radius: 2px; }

    .rr-msg {
      max-width: 87%; font-size: 13.5px; line-height: 1.55;
      padding: 9px 13px; word-wrap: break-word; white-space: pre-wrap;
    }
    .rr-msg.bot {
      background: #272009; color: #f0e6c8;
      border-radius: 12px 12px 12px 3px;
      border: 1px solid rgba(186,117,23,0.2);
      align-self: flex-start;
    }
    .rr-msg.user {
      background: #BA7517; color: #2a1f00; font-weight: 500;
      border-radius: 12px 12px 3px 12px;
      align-self: flex-end;
    }

    /* Typing dots */
    .rr-typing {
      align-self: flex-start; padding: 10px 14px;
      background: #272009; border: 1px solid rgba(186,117,23,0.2);
      border-radius: 12px 12px 12px 3px;
      display: flex; gap: 5px; align-items: center;
    }
    .rr-typing span {
      width: 6px; height: 6px; border-radius: 50%;
      background: #BA7517; display: block;
      animation: rrBounce 1.2s infinite;
    }
    .rr-typing span:nth-child(2) { animation-delay: 0.18s; }
    .rr-typing span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes rrBounce {
      0%,80%,100% { transform: translateY(0); opacity: 0.35; }
      40%          { transform: translateY(-5px); opacity: 1; }
    }

    /* Suggestions */
    #rr-suggestions {
      padding: 6px 12px 10px; flex-shrink: 0;
      display: flex; flex-direction: column; gap: 5px;
    }
    #rr-suggestions-label {
      font-size: 10px; color: #5a4d28; text-transform: uppercase;
      letter-spacing: 0.07em; padding: 0 2px; margin-bottom: 1px;
    }
    .rr-suggestion {
      font-size: 12.5px; color: #c8a84a; text-align: left;
      background: #211a06; border: 1px solid rgba(186,117,23,0.25);
      border-radius: 8px; padding: 7px 11px; cursor: pointer;
      transition: background 0.13s, border-color 0.13s, color 0.13s;
      font-family: inherit; line-height: 1.3;
    }
    .rr-suggestion:hover { background: #2e2408; border-color: #BA7517; color: #f0c060; }

    /* Lead capture form */
    #rr-lead-form {
      padding: 13px 14px; border-top: 1px solid rgba(186,117,23,0.15);
      background: #131005; flex-shrink: 0; display: none;
    }
    #rr-lead-form p {
      font-size: 12.5px; color: #c8a84a; margin: 0 0 9px; line-height: 1.45;
    }
    .rr-input {
      width: 100%; box-sizing: border-box;
      background: #1e1805; border: 1px solid rgba(186,117,23,0.3);
      border-radius: 8px; color: #f0e6c8; font-size: 13px; font-family: inherit;
      padding: 9px 12px; margin-bottom: 7px; outline: none;
      transition: border-color 0.15s;
    }
    .rr-input:focus { border-color: #BA7517; }
    .rr-input::placeholder { color: #5a4d28; }
    .rr-form-btn {
      width: 100%; padding: 10px; background: #BA7517; color: #2a1f00;
      font-size: 13px; font-weight: 700; border: none; border-radius: 8px;
      cursor: pointer; font-family: inherit; transition: background 0.15s;
    }
    .rr-form-btn:hover { background: #d48b20; }
    #rr-skip-lead {
      width: 100%; text-align: center; margin-top: 6px;
      font-size: 11px; color: #5a4d28; cursor: pointer;
      background: none; border: none; font-family: inherit;
      transition: color 0.12s;
    }
    #rr-skip-lead:hover { color: #8a7850; }

    /* Input row */
    #rr-chat-input-row {
      display: flex; gap: 8px; padding: 10px 12px;
      border-top: 1px solid rgba(186,117,23,0.15); flex-shrink: 0;
      background: #120e03;
    }
    #rr-chat-input {
      flex: 1; background: #1e1805; border: 1px solid rgba(186,117,23,0.3);
      border-radius: 8px; color: #f0e6c8; font-size: 13.5px; font-family: inherit;
      padding: 8px 12px; outline: none; resize: none; max-height: 80px;
      line-height: 1.45; transition: border-color 0.15s;
    }
    #rr-chat-input:focus { border-color: #BA7517; }
    #rr-chat-input::placeholder { color: #5a4d28; }
    #rr-send-btn {
      width: 36px; height: 36px; min-height: 36px;
      background: #BA7517; border: none; border-radius: 8px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; align-self: flex-end;
      transition: background 0.15s, opacity 0.15s;
    }
    #rr-send-btn:hover:not(:disabled) { background: #d48b20; }
    #rr-send-btn:disabled { opacity: 0.4; cursor: default; }
    #rr-send-btn svg { width: 15px; height: 15px; fill: #2a1f00; pointer-events: none; }

    /* Footer disclaimer */
    #rr-chat-footer {
      text-align: center; padding: 5px 12px 9px;
      font-size: 10.5px; color: #3d3318; flex-shrink: 0; background: #120e03;
    }
    #rr-chat-footer a { color: rgba(186,117,23,0.7); text-decoration: none; }
    #rr-chat-footer a:hover { color: #BA7517; }

    /* Mobile */
    @media (max-width: 420px) {
      #rr-chat-window { width: calc(100vw - 20px); right: 10px; bottom: 78px; max-height: 72vh; }
      #rr-chat-btn    { right: 14px; bottom: 14px; }
    }
  `;
  document.head.appendChild(style);

  // ── Inject HTML ─────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.id = 'rr-chat-root';
  wrap.innerHTML = `
    <button id="rr-chat-btn" aria-label="Chat with Rene's AI assistant">
      <div id="rr-chat-badge" aria-hidden="true">1</div>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
      </svg>
    </button>

    <div id="rr-chat-window" role="dialog" aria-label="Chat with Rene's AI assistant">
      <div id="rr-chat-header">
        <div class="rr-avatar" aria-hidden="true">R</div>
        <div class="rr-hdr-info">
          <div class="rr-hdr-name">Rene's AI Assistant</div>
          <div class="rr-hdr-sub">
            <span class="rr-online-dot" aria-hidden="true"></span>
            Rates &amp; Realty &middot; NMLS #1795044
          </div>
        </div>
        <a id="rr-hdr-phone" href="tel:+17144728508" aria-label="Call (714) 472-8508">(714) 472-8508</a>
        <button id="rr-chat-close" aria-label="Close chat">&#x2715;</button>
      </div>

      <div id="rr-chat-messages" aria-live="polite" aria-label="Chat messages"></div>

      <div id="rr-suggestions">
        <div id="rr-suggestions-label">Try asking:</div>
      </div>

      <div id="rr-lead-form">
        <p>Share your info so Rene can follow up with a personalized plan:</p>
        <input class="rr-input" id="rr-name-input"  type="text"  placeholder="Your first name"    autocomplete="given-name">
        <input class="rr-input" id="rr-email-input" type="email" placeholder="Your email address" autocomplete="email">
        <button class="rr-form-btn" id="rr-submit-lead">Get My Personalized Plan →</button>
        <button id="rr-skip-lead">Skip for now</button>
      </div>

      <div id="rr-chat-input-row">
        <textarea id="rr-chat-input" rows="1"
          placeholder="Ask about mortgages, rates, programs…"
          aria-label="Type your message"></textarea>
        <button id="rr-send-btn" aria-label="Send message">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>

      <div id="rr-chat-footer">
        AI assistant &mdash; for official advice call
        <a href="tel:+17144728508">(714) 472-8508</a>
        or <a href="https://cal.com/rene-duarte-rates-realty" target="_blank" rel="noopener">book a call</a>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  // ── Element refs ────────────────────────────────────────────────────
  const chatBtn      = document.getElementById('rr-chat-btn');
  const chatWindow   = document.getElementById('rr-chat-window');
  const closeBtn     = document.getElementById('rr-chat-close');
  const messagesEl   = document.getElementById('rr-chat-messages');
  const suggestionsEl= document.getElementById('rr-suggestions');
  const leadFormEl   = document.getElementById('rr-lead-form');
  const chatInput    = document.getElementById('rr-chat-input');
  const sendBtn      = document.getElementById('rr-send-btn');
  const badge        = document.getElementById('rr-chat-badge');

  // Prevent touch scroll bleed-through to page
  chatWindow.addEventListener('touchmove', function(e) {
    e.stopPropagation();
  }, { passive: true });

  // ── Open / Close ────────────────────────────────────────────────────
  function openChat() {
    isOpen = true;
    chatWindow.classList.add('open');
    badge.classList.remove('visible');
    chatBtn.classList.remove('pulse');
    if (messagesEl.children.length === 0) initChat();
    setTimeout(() => chatInput.focus(), 120);
    // Lock page scroll while chat is open
    document.body.style.overflow = 'hidden';
    // Inject backdrop to block scroll bleed-through on mobile
    if (!document.getElementById('rr-chat-backdrop')) {
      const backdrop = document.createElement('div');
      backdrop.id = 'rr-chat-backdrop';
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:2147483638;touch-action:none;';
      backdrop.addEventListener('click', closeChat);
      backdrop.addEventListener('touchmove', function(e) { e.preventDefault(); }, { passive: false });
      document.body.appendChild(backdrop);
    }
  }

  function closeChat() {
    isOpen = false;
    chatWindow.classList.remove('open');
    document.body.style.overflow = '';
    document.getElementById('rr-chat-backdrop')?.remove();
  }

  chatBtn.addEventListener('click', () => isOpen ? closeChat() : openChat());
  closeBtn.addEventListener('click', closeChat);

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) closeChat();
  });

  // ── Init chat ────────────────────────────────────────────────────────
  function initChat() {
    addMessage('bot', INITIAL_MESSAGE);
    renderSuggestions();
  }

  // Show pulsing badge after 12 s if chat never opened
  setTimeout(() => {
    if (!isOpen && !badgeShown) {
      badgeShown = true;
      badge.classList.add('visible');
      chatBtn.classList.add('pulse');
    }
  }, 12000);

  // ── Render suggestion pills ──────────────────────────────────────────
  function renderSuggestions(items) {
    suggestionsEl.innerHTML = '<div id="rr-suggestions-label">Try asking:</div>';
    (items || SUGGESTED_QUESTIONS).forEach(q => {
      const btn = document.createElement('button');
      btn.className = 'rr-suggestion';
      btn.textContent = q;
      btn.addEventListener('click', () => {
        suggestionsEl.innerHTML = '';
        sendMessage(q);
      });
      suggestionsEl.appendChild(btn);
    });
  }

  // ── Add a chat bubble ────────────────────────────────────────────────
  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = 'rr-msg ' + role;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function showTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'rr-typing';
    div.id = 'rr-typing';
    div.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTypingIndicator() {
    const t = document.getElementById('rr-typing');
    if (t) t.remove();
  }

  // ── Send a message ───────────────────────────────────────────────────
  async function sendMessage(text) {
    const txt = (text || chatInput.value).trim();
    if (!txt || isTyping) return;

    suggestionsEl.innerHTML = '';
    addMessage('user', txt);
    messages.push({ role: 'user', content: txt });

    if (text === undefined) {          // came from input field
      chatInput.value = '';
      chatInput.style.height = 'auto';
    }

    isTyping = true;
    sendBtn.disabled = true;
    showTypingIndicator();

    try {
      const params = new URLSearchParams(location.search);
      const res = await fetch(EDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          session_id:    sessionId,
          guest_name:    guestName  || null,
          guest_email:   guestEmail || null,
          page_url:      window.location.href,
          utm_source:    params.get('utm_source')  || null,
          utm_campaign:  params.get('utm_campaign') || null
        })
      });

      const data = await res.json();
      hideTypingIndicator();
      const reply = data.reply || 'Sorry, something went wrong. Please call Rene at (714) 472-8508.';
      addMessage('bot', reply);
      messages.push({ role: 'assistant', content: reply });

      // After 2 full exchanges, prompt for lead if not captured
      if (!leadCaptured && messages.length >= 4) {
        setTimeout(showLeadForm, 1000);
      }

    } catch (err) {
      hideTypingIndicator();
      addMessage('bot',
        'I had a connection issue. You can reach Rene directly at (714) 472-8508 ' +
        'or book a free call at cal.com/rene-duarte-rates-realty'
      );
    }

    isTyping = false;
    sendBtn.disabled = false;
    if (!text) chatInput.focus();  // re-focus input if typed (not suggestion)
  }

  // ── Input event handlers ─────────────────────────────────────────────
  sendBtn.addEventListener('click', () => sendMessage());

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  chatInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 80) + 'px';
  });

  // ── Lead capture form ────────────────────────────────────────────────
  function showLeadForm() {
    if (leadCaptured) return;
    leadFormEl.style.display = 'block';
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  document.getElementById('rr-submit-lead').addEventListener('click', async () => {
    const nameEl  = document.getElementById('rr-name-input');
    const emailEl = document.getElementById('rr-email-input');
    const name    = nameEl.value.trim();
    const email   = emailEl.value.trim();

    if (!email || !email.includes('@')) {
      emailEl.style.borderColor = '#e24b4a';
      emailEl.focus();
      return;
    }

    guestName    = name;
    guestEmail   = email;
    leadCaptured = true;
    sessionStorage.setItem('rr_guest_name',  name);
    sessionStorage.setItem('rr_guest_email', email);
    leadFormEl.style.display = 'none';

    const firstName = name.split(' ')[0] || 'there';
    const confirmMsg =
      `Thanks ${firstName}! I've saved your info so Rene can follow up with ` +
      `a personalized plan. In the meantime, keep asking — I'm here to help!`;
    addMessage('bot', confirmMsg);
    messages.push({ role: 'assistant', content: confirmMsg });

    // Ping edge function so it can upsert the contact with email
    try {
      await fetch(EDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages:     [{ role: 'user', content: '__lead_capture__' }],
          session_id:   sessionId,
          guest_name:   name,
          guest_email:  email,
          page_url:     window.location.href
        })
      });
    } catch (_) {}
  });

  document.getElementById('rr-skip-lead').addEventListener('click', () => {
    leadFormEl.style.display = 'none';
    leadCaptured = true; // suppress for this session
  });

})();
