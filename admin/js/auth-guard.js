// Rates & Realty CRM — Supabase Auth Guard
(async function() {
  // Load Supabase if not already loaded
  if (typeof window.supabase === 'undefined') {
    await new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      script.onload = resolve;
      document.head.appendChild(script);
    });
  }

  // Load env config if not already loaded
  if (!window.APP_CONFIG) {
    await new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = '/api/env.js';
      script.onload = resolve;
      document.head.appendChild(script);
    });
  }

  const client = window.supabase.createClient(
    window.APP_CONFIG.SUPABASE_URL,
    window.APP_CONFIG.SUPABASE_ANON_KEY
  );
  window._supabaseClient = client;

  const { data: { session } } = await client.auth.getSession();

  if (!session) {
    const currentPage = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace('/auth/admin-login.html?redirect=' + currentPage);
    return;
  }

  // Expose logout function globally
  window.adminLogout = async function() {
    await client.auth.signOut();
    window.location.href = '/auth/admin-login.html';
  };

  // Expose session user for display
  window._adminUser = session.user;

  // Update any logout buttons with user email
  document.addEventListener('DOMContentLoaded', function() {
    const emailDisplay = document.getElementById('adminUserEmail');
    if (emailDisplay && session.user?.email) {
      emailDisplay.textContent = session.user.email;
    }
  });
})();
