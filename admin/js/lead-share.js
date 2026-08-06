/* lead-share.js — the ONE way to read or grant a VA's access to a lead.
 *
 * WHY THIS EXISTS
 * Sharing is not an RPC or an edge function. It is a direct PostgREST write to
 * the join table lead_shares, allowed only to admins by RLS:
 *
 *     insert { contact_id, shared_with_user_id, shared_by }
 *
 * That write lived inline in admin/lead-detail.html and nowhere else. The
 * unshared-lead nudge needs to share from a popup that can appear on any page,
 * and the obvious shortcut — paste the insert into the popup — would make two
 * share paths that can drift. This module is the extraction, so there stays
 * exactly one.
 *
 * DATA LAYER ONLY. The lead-detail toggle keeps its own markup and messages; it
 * just stops owning the query. A module that also drew UI could not serve both
 * a toggle and a popup without one of them bending to the other's shape.
 *
 * WHO CAN SHARE: share_targets() returns rows only for admins — an empty result
 * IS the "not an admin" signal, which is why target() returning null must be
 * treated as "hide the affordance" rather than as an error.
 */
(function () {
  'use strict';
  if (window.LeadShare) return;

  var _targetCache = undefined;   // undefined = not looked up; null = none/not admin

  async function client() {
    try {
      if (typeof window._waitForAuthClient === 'function') return await window._waitForAuthClient();
      if (typeof window.getSupabaseClient === 'function') return await window.getSupabaseClient();
    } catch (e) { /* fall through */ }
    return window._supabaseClient || null;
  }

  /* The VA to share with. Cached per page load: share_targets() is a role lookup
     that cannot change mid-session, and the popup may ask for it repeatedly. */
  async function target() {
    if (_targetCache !== undefined) return _targetCache;
    _targetCache = null;
    try {
      var c = await client();
      if (!c) return null;
      var r = await c.rpc('share_targets');
      if (r.error) { console.warn('[lead-share] share_targets failed:', r.error.message); return null; }
      var rows = Array.isArray(r.data) ? r.data : [];
      _targetCache = rows.find(function (t) { return t.role === 'va'; }) || null;
    } catch (e) {
      console.warn('[lead-share] target error:', e && e.message);
      _targetCache = null;
    }
    return _targetCache;
  }

  /* Is this lead already shared with that VA? Returns a boolean, or null when
     the question could not be answered — which is NOT the same as false and must
     not be rendered as "not shared". */
  async function state(contactId) {
    if (!contactId) return null;
    try {
      var c = await client();
      var va = await target();
      if (!c || !va) return null;
      var r = await c.from('lead_shares').select('id')
        .eq('contact_id', contactId).eq('shared_with_user_id', va.user_id).maybeSingle();
      if (r.error) { console.warn('[lead-share] state lookup failed:', r.error.message); return null; }
      return !!r.data;
    } catch (e) {
      console.warn('[lead-share] state error:', e && e.message);
      return null;
    }
  }

  /* Grant. Throws on failure so the caller can show it — the toggle reverts its
     switch, the popup keeps its button live. Silence here would leave a UI
     claiming a share that never happened. */
  async function grant(contactId) {
    var c = await client();
    if (!c) throw new Error('Not signed in');
    var va = await target();
    if (!va) throw new Error('No VA configured to share with');
    var u = await c.auth.getUser();
    var uid = u && u.data && u.data.user && u.data.user.id;
    if (!uid) throw new Error('Not signed in');
    var r = await c.from('lead_shares')
      .insert({ contact_id: contactId, shared_with_user_id: va.user_id, shared_by: uid });
    if (r.error) throw r.error;
    return va;
  }

  async function revoke(contactId) {
    var c = await client();
    if (!c) throw new Error('Not signed in');
    var va = await target();
    if (!va) throw new Error('No VA configured to share with');
    var r = await c.from('lead_shares').delete()
      .eq('contact_id', contactId).eq('shared_with_user_id', va.user_id);
    if (r.error) throw r.error;
    return va;
  }

  window.LeadShare = { target: target, state: state, grant: grant, revoke: revoke };
})();
