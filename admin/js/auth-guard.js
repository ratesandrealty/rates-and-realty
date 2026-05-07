(async function () {
  if (window.location.pathname.includes('admin-login')) return;
  var waited = 0;
  while (typeof window.getSupabaseClient !== 'function' && waited < 5000) {
    await new Promise(function (r) { setTimeout(r, 25); });
    waited += 25;
  }
  if (typeof window.getSupabaseClient !== 'function') {
    console.error('[auth-guard] getSupabaseClient not loaded'); return;
  }
  var client = await window.getSupabaseClient();
  if (!client) { console.error('[auth-guard] no client'); return; }
  var sessResp = await client.auth.getSession();
  var session = sessResp && sessResp.data ? sessResp.data.session : null;
  if (!session) {
    var redir = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace('/auth/admin-login.html?redirect=' + redir);
    return;
  }
  window.adminLogout = async function () { await client.auth.signOut(); window.location.href = '/auth/admin-login.html'; };
  window._adminUser = session.user;
  document.addEventListener('DOMContentLoaded', function () {
    var el = document.getElementById('adminUserEmail');
    if (el && session.user && session.user.email) el.textContent = session.user.email;
  });
})();
