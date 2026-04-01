import { ADMIN_EMAILS, ADMIN_USER_IDS } from "/api/config.js";
import { supabase } from "/api/supabase-client.js";

export async function signUpBorrower({ email, password, firstName, lastName, phone }) {
  const redirectTo = `${window.location.origin}/public/unified-portal.html`;
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: redirectTo,
      data: {
        first_name: firstName,
        last_name: lastName,
        phone
      }
    }
  });

  if (error) throw error;

  if (data.user) {
    await supabase.from("borrower_profiles").upsert({
      user_id: data.user.id,
      first_name: firstName,
      last_name: lastName,
      email,
      phone
    }, { onConflict: "user_id" });
  }

  return data;
}

export async function signInBorrower({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOutBorrower() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function requireUser() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const user = data.session?.user;
  if (!user) {
    window.location.href = "/public/unified-portal.html";
    throw new Error("Authentication required.");
  }
  return user;
}

export function isAdminUser(user) {
  if (!user) return false;

  const allowedEmails = ADMIN_EMAILS.map((value) => String(value).toLowerCase());
  const emailMatch = user.email ? allowedEmails.includes(user.email.toLowerCase()) : false;
  const idMatch = ADMIN_USER_IDS.includes(user.id);
  const metadataRole = user.app_metadata?.role === "admin" || user.user_metadata?.role === "admin";

  return emailMatch || idMatch || metadataRole;
}

export async function requireAdmin() {
  const user = await requireUser();

  if (!isAdminUser(user)) {
    window.location.href = "/public/unified-portal.html";
    throw new Error("Admin access required.");
  }

  return user;
}
