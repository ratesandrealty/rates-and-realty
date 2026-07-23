// Load env.js ONLY when the page didn't already provide window.APP_CONFIG via a
// classic <script src="/api/env.js"> (all admin pages do; the borrower portal does
// not). Guarding this keeps config.js SYNCHRONOUS on pages that preload env.js:
// the previous UNCONDITIONAL top-level `await import("/api/env.js")` suspended this
// module on a network fetch even when APP_CONFIG was already present, turning the
// whole supabase-client chain into an async module. On slow/mobile loads that let
// consumers reach the exported `supabase` client before createClient() had run —
// a temporal-dead-zone throw ("Cannot access 'supabase' before initialization")
// that surfaced as a false "access restricted". Skipping the await when APP_CONFIG
// exists removes that race; pages without a preloaded env.js still lazy-load it.
if (!window.APP_CONFIG || !window.APP_CONFIG.SUPABASE_URL) {
  await import("/api/env.js");
}

const config = window.APP_CONFIG || {};

if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
  console.warn("Supabase config missing. Update /api/env.js before using the app.");
}

export const SUPABASE_URL = config.SUPABASE_URL;
export const SUPABASE_ANON_KEY = config.SUPABASE_ANON_KEY;
export const DOCUMENT_BUCKET = "borrower-documents";
export const ADMIN_EMAILS = Array.isArray(config.ADMIN_EMAILS) ? config.ADMIN_EMAILS : [];
export const ADMIN_USER_IDS = Array.isArray(config.ADMIN_USER_IDS) ? config.ADMIN_USER_IDS : [];
