/* require-staff — the in-function auth check that `verify_jwt = true` is not.
 *
 * The gateway only checks that the bearer is a JWT signed by this project. The
 * anon key IS a project-signed JWT and it is printed in every page's source, so
 * a function pinned true with no in-function check is open to anyone who reads
 * the HTML. See docs/PINNED-NOT-GUARDED.md.
 *
 * One implementation rather than one per function, for the same reason
 * admin/js/fn-call.js exists on the caller side: the copies are where the
 * divergence hides. calendar-data's requireStaff and communications-admin's
 * requireAdmin are the originals this generalises.
 *
 * TWO THINGS IT MUST GET RIGHT, both learned the hard way:
 *
 * 1. ACCEPT THE SERVICE KEY FROM EITHER HEADER. `esign` calls `email-service`
 *    with `{ apikey: SERVICE }` and NO Authorization header. An
 *    Authorization-only check 401s every e-signature email, and sendRaw swallows
 *    it in a bare catch — silent failure on a legally significant path.
 *
 * 2. RUN BEFORE req.json(). A guard placed after body parsing is a guard that a
 *    later added action can be written in front of by accident.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/* admin and va are the only roles that exist in auth_user_roles today. Both are
 * staff and both do document work, so both are allowed. Named explicitly rather
 * than "any row in auth_user_roles" so adding a future non-staff role does not
 * silently grant access. */
export const STAFF_ROLES = ["admin", "va", "agent", "loa"];

export type StaffCheck = {
  ok: boolean;
  status?: number;
  msg?: string;
  role?: string;
  userId?: string | null;
};

export async function requireStaff(
  req: Request,
  opts?: { roles?: string[]; what?: string },
): Promise<StaffCheck> {
  const roles = opts?.roles || STAFF_ROLES;
  const what = opts?.what || "This endpoint";

  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const apikey = (req.headers.get("apikey") || "").trim();

  // Internal callers: service key in EITHER header. See note 1 above.
  if (SERVICE_KEY && apikey === SERVICE_KEY) return { ok: true, role: "service", userId: null };
  if (SERVICE_KEY && token === SERVICE_KEY) return { ok: true, role: "service", userId: null };

  if (!token) return { ok: false, status: 401, msg: "missing authorization" };

  /* The anon key reaches here and MUST be rejected. getUser() on it returns no
   * user, which is exactly the distinction the gateway cannot make. */
  try {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData?.user;
    if (!user) return { ok: false, status: 401, msg: "invalid session" };

    const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: roleRow } = await sb.from("auth_user_roles")
      .select("role").eq("user_id", user.id).maybeSingle();
    const role = roleRow?.role || "";
    if (!roles.includes(role)) {
      return { ok: false, status: 403, msg: `${what} is available to staff only.`, userId: user.id };
    }
    return { ok: true, role, userId: user.id };
  } catch (_e) {
    return { ok: false, status: 401, msg: "auth check failed" };
  }
}
