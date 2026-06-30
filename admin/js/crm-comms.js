/* ─────────────────────────────────────────────────────────────────────────────
   Shared CRM communications — one place for Call / SMS / Email so every button
   across the app hits the live edge functions consistently.
     • Call  → click-to-call  (rings Rene's cell, bridges to the lead via 866; logged)
     • SMS   → sms-service     (sends from the 866 business line; logged)
     • Email → email-service   (sends FROM rene@ratesandrealty.com; tracked)
   All POST JSON with the anon key as apikey + Authorization: Bearer.
   Pages that already have rich composers keep them — those composers already call
   sms-service / email-service. This module powers the simpler buttons + a fallback
   compose modal for pages without one.
   ───────────────────────────────────────────────────────────────────────────── */
(function(){
  var FN = 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/';
  function _key(){ return (window.APP_CONFIG && window.APP_CONFIG.SUPABASE_ANON_KEY) || ''; }
  function _toast(msg, isErr){
    if (typeof window.showToast === 'function') return window.showToast(msg, isErr);
    if (typeof window.toast === 'function') return window.toast(msg, isErr);
    try { (isErr ? console.error : console.log)(msg); } catch(_){}
  }
  function _esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  async function _post(name, body){
    var k = _key();
    var res = await fetch(FN + name, { method:'POST', headers:{ 'Content-Type':'application/json', 'apikey':k, 'Authorization':'Bearer ' + k }, body: JSON.stringify(body) });
    var data; try { data = await res.json(); } catch(_){ data = {}; }
    if (!res.ok && data.success !== true) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  /* ── CALL: click-to-call ── */
  window.crmCall = async function(contactId, toPhone, name, btn){
    if (!toPhone){ _toast('No phone on file', true); return; }
    var orig; if (btn){ orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="crm-spin"></span>'; }
    try {
      var d = await _post('click-to-call', { contact_id: contactId || null, to_phone: toPhone });
      if (d && d.success === false) throw new Error(d.error || 'Call failed');
      _toast('📞 Calling… your cell will ring — pick up to connect' + (name ? (' to ' + name) : '') + '.');
    } catch(e){ _toast('Call failed: ' + (e.message || 'error'), true); }
    finally { if (btn){ btn.disabled = false; btn.innerHTML = orig; } }
  };

  /* ── SMS: raw send via sms-service ── */
  window.crmSendSms = function(contactId, toPhone, message){
    return _post('sms-service', { trigger:'custom', to_phone: toPhone, contact_id: contactId || null, params: { message: message } });
  };
  /* SMS compose modal (fallback for pages without their own composer). */
  window.crmText = function(contactId, toPhone, name){
    if (!toPhone){ _toast('No phone on file', true); return; }
    _ensureStyles();
    _modal('💬 Text ' + (name || toPhone),
      '<textarea id="crmSmsBody" rows="4" placeholder="Type your message…" style="width:100%;box-sizing:border-box;background:#0d0d0d;border:1px solid #333;border-radius:8px;color:#eee;padding:10px;font-size:13px;font-family:inherit;resize:vertical;"></textarea>' +
      '<div style="font-size:11px;color:#888;margin-top:6px;">To ' + _esc(toPhone) + ' · from the 866 business line</div>',
      'Send', async function(send){
        var msg = (document.getElementById('crmSmsBody').value || '').trim();
        if (!msg){ _toast('Type a message first', true); return false; }
        send.disabled = true; send.textContent = 'Sending…';
        try { await window.crmSendSms(contactId, toPhone, msg); _toast('Text sent ✓'); return true; }
        catch(e){ _toast('Send failed: ' + (e.message || 'error'), true); send.disabled = false; send.textContent = 'Send'; return false; }
      });
    setTimeout(function(){ var t = document.getElementById('crmSmsBody'); if (t) t.focus(); }, 50);
  };

  /* ── EMAIL: raw send via email-service (CRM sender) ── */
  window.crmSendEmail = function(opts){
    return _post('email-service', { action:'send', to_email: opts.to_email || '', to_name: opts.to_name || '', subject: opts.subject || '', html: opts.html || '', contact_id: opts.contact_id || null, reply_to: opts.reply_to || 'rene@ratesandrealty.com' });
  };
  /* Email compose modal (fallback for pages without their own composer). */
  window.crmEmail = function(opts){
    opts = opts || {};
    _ensureStyles();
    var to = opts.to_email || '', name = opts.to_name || '';
    _modal('✉️ Email ' + (name || to || ''),
      '<input id="crmEmTo" type="email" value="' + _esc(to) + '" placeholder="recipient@email.com" style="width:100%;box-sizing:border-box;background:#0d0d0d;border:1px solid #333;border-radius:8px;color:#eee;padding:9px;font-size:13px;margin-bottom:8px;">' +
      '<input id="crmEmSubj" type="text" value="' + _esc(opts.subject || '') + '" placeholder="Subject" style="width:100%;box-sizing:border-box;background:#0d0d0d;border:1px solid #333;border-radius:8px;color:#eee;padding:9px;font-size:13px;margin-bottom:8px;">' +
      '<textarea id="crmEmBody" rows="6" placeholder="Write your message…" style="width:100%;box-sizing:border-box;background:#0d0d0d;border:1px solid #333;border-radius:8px;color:#eee;padding:10px;font-size:13px;font-family:inherit;resize:vertical;"></textarea>' +
      '<div style="font-size:11px;color:#888;margin-top:6px;">Sends from rene@ratesandrealty.com (tracked)</div>',
      'Send', async function(send){
        var toEmail = (document.getElementById('crmEmTo').value || '').trim();
        var subj = (document.getElementById('crmEmSubj').value || '').trim();
        var bodyTxt = (document.getElementById('crmEmBody').value || '').trim();
        if (!toEmail){ _toast('Recipient email required', true); return false; }
        if (!subj){ _toast('Subject required', true); return false; }
        send.disabled = true; send.textContent = 'Sending…';
        try {
          var html = '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222;white-space:pre-wrap;">' + _esc(bodyTxt) + '</div>';
          await window.crmSendEmail({ to_email: toEmail, to_name: name, subject: subj, html: html, contact_id: opts.contact_id });
          _toast('Email sent ✓'); return true;
        } catch(e){ _toast('Send failed: ' + (e.message || 'error'), true); send.disabled = false; send.textContent = 'Send'; return false; }
      });
  };

  /* ── tiny modal builder + styles ── */
  function _modal(title, innerHtml, sendLabel, onSend){
    var ov = document.createElement('div'); ov.className = 'crm-comms-ov';
    ov.innerHTML = '<div class="crm-comms-box"><div class="crm-comms-hd"><span>' + _esc(title) + '</span><button class="crm-comms-x" type="button">&times;</button></div>' +
      '<div class="crm-comms-bd">' + innerHtml + '</div>' +
      '<div class="crm-comms-ft"><button class="crm-comms-cancel" type="button">Cancel</button><button class="crm-comms-send" type="button">' + _esc(sendLabel) + '</button></div></div>';
    document.body.appendChild(ov);
    function close(){ ov.remove(); }
    ov.addEventListener('click', function(e){ if (e.target === ov) close(); });
    ov.querySelector('.crm-comms-x').addEventListener('click', close);
    ov.querySelector('.crm-comms-cancel').addEventListener('click', close);
    ov.querySelector('.crm-comms-send').addEventListener('click', async function(){ var ok = await onSend(this); if (ok !== false) close(); });
    return ov;
  }
  function _ensureStyles(){
    if (document.getElementById('crm-comms-styles')) return;
    var st = document.createElement('style'); st.id = 'crm-comms-styles';
    st.textContent = '.crm-comms-ov{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:20px;}' +
      '.crm-comms-box{background:#15140f;border:1px solid rgba(201,168,76,0.3);border-radius:14px;width:min(460px,95vw);box-shadow:0 24px 70px rgba(0,0,0,0.6);overflow:hidden;}' +
      '.crm-comms-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.08);color:#fff;font-weight:700;font-size:14px;}' +
      '.crm-comms-hd button{background:none;border:none;color:#888;font-size:22px;cursor:pointer;line-height:1;}' +
      '.crm-comms-bd{padding:16px 18px;}' +
      '.crm-comms-ft{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid rgba(255,255,255,0.06);}' +
      '.crm-comms-ft button{border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid #333;}' +
      '.crm-comms-cancel{background:transparent;color:#aaa;}' +
      '.crm-comms-send{background:#C9A84C;color:#111;border-color:#C9A84C;}' +
      '.crm-spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,0.45);border-top-color:#fff;border-radius:50%;animation:crmspin .7s linear infinite;vertical-align:-1px;}' +
      '@keyframes crmspin{to{transform:rotate(360deg);}}';
    document.head.appendChild(st);
  }
})();
