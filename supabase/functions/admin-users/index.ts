import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

// admin-users: staff/user management for the Settings page. Admin-only.
// Creates Supabase auth logins + auth_user_roles rows, stores admin-set temp
// passwords (revealable until the user next signs in), and supports role change,
// deactivate/reactivate, and delete. Guards prevent locking out the last admin.
// v3: signin_link (admin "View as" — mint a one-time magic sign-in link for a staff user).

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

// Roles manageable from the Settings UI (borrower logins are portal users, excluded).
const STAFF_ROLES = ['admin', 'va', 'loa', 'agent', 'lender', 'staff'];
const DEFAULT_VIEW_AS_REDIRECT = 'https://admin.ratesandrealty.com/admin/people.html';

const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: cors });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    // ---- authenticate caller + require admin ----
    const authz = req.headers.get('Authorization') || '';
    const token = authz.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'missing_token' }, 401);
    const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
    const caller = callerData?.user;
    if (callerErr || !caller) return json({ error: 'invalid_token' }, 401);
    const { data: callerRole } = await admin.from('auth_user_roles').select('role').eq('user_id', caller.id).maybeSingle();
    if (!callerRole || callerRole.role !== 'admin') return json({ error: 'forbidden', message: 'Admin access required.' }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    // helper: is the given user the only remaining admin?
    const isLastAdmin = async (userId: string): Promise<boolean> => {
      const { data: tr } = await admin.from('auth_user_roles').select('role').eq('user_id', userId).maybeSingle();
      if (!tr || tr.role !== 'admin') return false;
      const { count } = await admin.from('auth_user_roles').select('user_id', { count: 'exact', head: true }).eq('role', 'admin');
      return (count || 0) <= 1;
    };

    // ============ LIST ============
    if (action === 'list') {
      const { data: roleRows } = await admin.from('auth_user_roles').select('user_id,role,contact_id').in('role', STAFF_ROLES);
      const { data: tempRows } = await admin.from('user_temp_credentials').select('user_id,temp_password,set_at');
      const tempById: Record<string, any> = {};
      for (const t of (tempRows || [])) tempById[t.user_id] = t;

      const { data: usersPage } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const authById: Record<string, any> = {};
      for (const u of (usersPage?.users || [])) authById[u.id] = u;

      const users = (roleRows || []).map((r: any) => {
        const au = authById[r.user_id] || {};
        const temp = tempById[r.user_id];
        const lastSignIn = au.last_sign_in_at || null;
        // revealable while the temp password the admin set hasn't been used yet
        const pending = !!temp && (!lastSignIn || new Date(temp.set_at) > new Date(lastSignIn));
        return {
          user_id: r.user_id,
          email: au.email || null,
          role: r.role,
          contact_id: r.contact_id || null,
          created_at: au.created_at || null,
          last_sign_in_at: lastSignIn,
          has_logged_in: !!lastSignIn,
          banned: !!au.banned_until && new Date(au.banned_until) > new Date(),
          temp_password: pending ? temp.temp_password : null,
          is_self: r.user_id === caller.id,
        };
      }).sort((a: any, b: any) => (a.role === 'admin' ? -1 : 1) - (b.role === 'admin' ? -1 : 1));

      return json({ success: true, users });
    }

    // ============ CREATE ============
    if (action === 'create') {
      const email = String(body.email || '').trim().toLowerCase();
      const role = String(body.role || '').trim();
      const temp_password = String(body.temp_password || '');
      const contact_id = body.contact_id || null;
      if (!email || !email.includes('@')) return json({ error: 'invalid_email' }, 400);
      if (!STAFF_ROLES.includes(role)) return json({ error: 'invalid_role' }, 400);
      if (temp_password.length < 8) return json({ error: 'weak_password', message: 'Temp password must be at least 8 characters.' }, 400);

      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password: temp_password, email_confirm: true,
      });
      if (cErr || !created?.user) {
        const msg = (cErr?.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('registered') || msg.includes('exists'))
          return json({ error: 'email_exists', message: 'A user with that email already exists.' }, 409);
        return json({ error: 'create_failed', message: cErr?.message || 'Could not create user.' }, 400);
      }
      const uid = created.user.id;
      const { error: rErr } = await admin.from('auth_user_roles').upsert({ user_id: uid, role, contact_id, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (rErr) { await admin.auth.admin.deleteUser(uid); return json({ error: 'role_failed', message: rErr.message }, 400); }
      await admin.from('user_temp_credentials').upsert({ user_id: uid, temp_password, set_by: caller.id, set_at: new Date().toISOString() }, { onConflict: 'user_id' });
      return json({ success: true, user_id: uid, email, role });
    }

    // ============ RESET PASSWORD ============
    if (action === 'reset_password') {
      const user_id = String(body.user_id || '');
      const temp_password = String(body.temp_password || '');
      if (!user_id) return json({ error: 'missing_user_id' }, 400);
      if (temp_password.length < 8) return json({ error: 'weak_password', message: 'Temp password must be at least 8 characters.' }, 400);
      const { error: uErr } = await admin.auth.admin.updateUserById(user_id, { password: temp_password });
      if (uErr) return json({ error: 'reset_failed', message: uErr.message }, 400);
      await admin.from('user_temp_credentials').upsert({ user_id, temp_password, set_by: caller.id, set_at: new Date().toISOString() }, { onConflict: 'user_id' });
      return json({ success: true });
    }

    // ============ UPDATE ROLE ============
    if (action === 'update_role') {
      const user_id = String(body.user_id || '');
      const role = String(body.role || '').trim();
      if (!user_id) return json({ error: 'missing_user_id' }, 400);
      if (!STAFF_ROLES.includes(role)) return json({ error: 'invalid_role' }, 400);
      if (role !== 'admin' && await isLastAdmin(user_id)) return json({ error: 'last_admin', message: 'You cannot remove the last admin.' }, 400);
      const { error } = await admin.from('auth_user_roles').update({ role, updated_at: new Date().toISOString() }).eq('user_id', user_id);
      if (error) return json({ error: 'update_failed', message: error.message }, 400);
      return json({ success: true });
    }

    // ============ DEACTIVATE / REACTIVATE ============
    if (action === 'set_active') {
      const user_id = String(body.user_id || '');
      const active = !!body.active;
      if (!user_id) return json({ error: 'missing_user_id' }, 400);
      if (user_id === caller.id) return json({ error: 'self_action', message: 'You cannot deactivate your own account.' }, 400);
      if (!active && await isLastAdmin(user_id)) return json({ error: 'last_admin', message: 'You cannot deactivate the last admin.' }, 400);
      const { error } = await admin.auth.admin.updateUserById(user_id, { ban_duration: active ? 'none' : '876000h' });
      if (error) return json({ error: 'set_active_failed', message: error.message }, 400);
      return json({ success: true });
    }

    // ============ DELETE ============
    if (action === 'delete') {
      const user_id = String(body.user_id || '');
      if (!user_id) return json({ error: 'missing_user_id' }, 400);
      if (user_id === caller.id) return json({ error: 'self_action', message: 'You cannot delete your own account.' }, 400);
      if (await isLastAdmin(user_id)) return json({ error: 'last_admin', message: 'You cannot delete the last admin.' }, 400);
      const { error } = await admin.auth.admin.deleteUser(user_id);
      if (error) return json({ error: 'delete_failed', message: error.message }, 400);
      // auth_user_roles + user_temp_credentials cascade on auth.users delete
      return json({ success: true });
    }

    // ============ VIEW AS / SIGN-IN LINK ============
    // Mints a one-time Supabase magic sign-in link for a staff user so an admin can
    // view the portal as them. Admin-gated (enforced above) + audited. The link, when
    // opened, establishes the TARGET user's session in that browser — intended to be
    // opened in a private/incognito window so it doesn't replace the admin's own session.
    if (action === 'signin_link') {
      const user_id = String(body.user_id || '');
      if (!user_id) return json({ error: 'missing_user_id' }, 400);
      if (user_id === caller.id) return json({ error: 'self_action', message: 'You are already signed in as yourself.' }, 400);

      const { data: targetRole } = await admin.from('auth_user_roles').select('role').eq('user_id', user_id).maybeSingle();
      if (!targetRole || !STAFF_ROLES.includes(targetRole.role)) return json({ error: 'not_staff', message: 'Target is not a managed staff user.' }, 400);

      const { data: targetUser, error: tErr } = await admin.auth.admin.getUserById(user_id);
      const email = targetUser?.user?.email;
      if (tErr || !email) return json({ error: 'target_not_found', message: tErr?.message || 'Target user not found.' }, 404);

      const redirectTo = (typeof body.redirect_to === 'string' && body.redirect_to.startsWith('https://')) ? body.redirect_to : DEFAULT_VIEW_AS_REDIRECT;

      const { data: linkData, error: lErr } = await admin.auth.admin.generateLink({
        type: 'magiclink', email, options: { redirectTo },
      });
      const actionLink = linkData?.properties?.action_link;
      if (lErr || !actionLink) return json({ error: 'link_failed', message: lErr?.message || 'Could not generate sign-in link.' }, 400);

      // audit (non-fatal)
      await admin.from('staff_view_as_log').insert({
        admin_user_id: caller.id, target_user_id: user_id, target_email: email, redirect_to: redirectTo,
      });

      return json({ success: true, action_link: actionLink, target_email: email, role: targetRole.role, redirect_to: redirectTo });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (e: any) {
    console.error('[admin-users] error:', e?.message || e);
    return json({ error: 'server_error', message: e?.message || 'Server error' }, 500);
  }
});
