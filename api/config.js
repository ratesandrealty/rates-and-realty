await import("/api/env.js");

const config = window.APP_CONFIG || {};

if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
  console.warn("Supabase config missing. Update /api/env.js before using the app.");
}

export const SUPABASE_URL = config.SUPABASE_URL;
export const SUPABASE_ANON_KEY = config.SUPABASE_ANON_KEY;
export const DOCUMENT_BUCKET = "borrower-documents";
export const ADMIN_EMAILS = Array.isArray(config.ADMIN_EMAILS) ? config.ADMIN_EMAILS : [];
export const ADMIN_USER_IDS = Array.isArray(config.ADMIN_USER_IDS) ? config.ADMIN_USER_IDS : [];
