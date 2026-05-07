window.getSupabaseClient = async function () {
  if (window._supabaseClient) return window._supabaseClient;
  var waited = 0;
  while ((!window.APP_CONFIG || !window.supabase) && waited < 5000) {
    await new Promise(function (r) { setTimeout(r, 25); });
    waited += 25;
  }
  if (!window.APP_CONFIG || !window.supabase) {
    console.error('[supabase-client] APP_CONFIG or supabase-js not loaded after 5s');
    return null;
  }
  window._supabaseClient = window.supabase.createClient(
    window.APP_CONFIG.SUPABASE_URL,
    window.APP_CONFIG.SUPABASE_ANON_KEY,
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'sb-rrcrm-auth' } }
  );
  return window._supabaseClient;
};
