/* delete-contacts — bulk contact delete.
 *
 * REPORTS PER ID. There is no aggregate "success" any more.
 *
 * WHY THIS WAS REWRITTEN (2026-08-07)
 * Rene selected two contacts. One deleted. The other —
 * 93724c8a-8e26-453d-bf1c-7a335fc9845e — did not, because three rows in
 * signature_signers reference it via person_contact_id with delete_rule
 * NO ACTION, so Postgres raised 23503. The UI said "Deleted 1 contact" in
 * green and the surviving contact just sat there in the list.
 *
 * Nothing here threw. The old code recorded { success: res.ok } per id
 * correctly, then flattened it to { deleted, total } with NO top-level
 * success flag and NO error, and returned HTTP 200. admin/people.html only
 * treated deleted === 0 as failure, so a partial delete was indistinguishable
 * from a complete one. The truth was in results[] and nothing read it.
 *
 * FOUR TABLES BLOCK A CONTACT DELETE (delete_rule NO ACTION):
 *   calls_log.contact_id, lead_source_stats.lead_id,
 *   saved_listings.contact_id, signature_signers.person_contact_id
 * Everything else is ON DELETE CASCADE.
 *
 * These are deliberately NOT being changed to CASCADE. signature_signers
 * holds e-signature audit records that are likely subject to retention;
 * shredding them as a side effect of tidying a contact list is worse than
 * refusing the delete. The constraint is doing its job. What was broken was
 * the reporting.
 *
 * GUARDED 2026-08-07 (requireStaff, ADMIN ONLY) and every outcome is now
 * written to audit_log with the verified uid before anything is destroyed.
 * verify_jwt stays pinned false: the anon key is a project-signed JWT printed
 * in every page, so the pin is a stability control, not an access one.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/require-staff.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const h = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
};

/* The known NO ACTION referrers, with the column that points at contacts.id
 * and a plain-English label for the toast. Used for a PREFLIGHT count so we
 * can refuse before mutating anything, and to put a row count on the error.
 *
 * This list can go stale — a fifth NO ACTION FK added tomorrow will not be in
 * it. That is why parseFkError() below also reads the table name straight out
 * of the Postgres error text. The map makes the common case specific; the
 * parser makes the unknown case still honest. */
const BLOCKERS: Record<string, { col: string; note: string }> = {
  signature_signers: { col: 'person_contact_id', note: 'e-signature audit records' },
  calls_log:         { col: 'contact_id',        note: 'call history' },
  lead_source_stats: { col: 'lead_id',           note: 'lead attribution stats' },
  saved_listings:    { col: 'contact_id',        note: 'saved listings' },
};

/** Count rows in each known blocking table that reference this contact. */
async function findBlockers(id: string) {
  const found: Array<{ table: string; column: string; rows: number; note: string }> = [];
  await Promise.all(Object.entries(BLOCKERS).map(async ([table, { col, note }]) => {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?${col}=eq.${id}&select=${col}`,
        { headers: { ...h, 'Prefer': 'count=exact', 'Range': '0-0' } },
      );
      // PostgREST puts the count after the slash in Content-Range: 0-0/3
      const cr = res.headers.get('content-range') || '';
      const n = parseInt(cr.split('/')[1] || '0', 10);
      if (Number.isFinite(n) && n > 0) found.push({ table, column: col, rows: n, note });
    } catch (e) {
      // A failed probe must not read as "nothing blocking" — say so instead.
      found.push({ table, column: col, rows: -1, note: `count failed: ${(e as Error).message}` });
    }
  }));
  return found;
}

/* ── WHO DELETED WHAT ─────────────────────────────────────────────────────────
 *
 * This function had NO record of its own actions beyond console.log, which is
 * why the seven contacts removed in April–May are unanswerable: nothing says
 * who asked, or whether a given removal was a borrower's erasure request or
 * routine list cleanup. Those are different obligations and we could not tell
 * them apart after the fact.
 *
 * USES THE EXISTING audit_log TABLE — no new table. It already carries exactly
 * this shape (table_name, row_id, operation, old_data, new_data, changed_by,
 * changed_at) and already holds 1,163 rows for six other tables via the
 * fn_audit_row() trigger.
 *
 * WHY NOT JUST PUT fn_audit_row ON contacts AS A TRIGGER. Two reasons, and both
 * are disqualifying on their own:
 *   1. It stamps changed_by = auth.uid(), which is NULL for an edge function
 *      holding the service role — so "who", the entire point, would be lost.
 *   2. A DELETE trigger only fires when a row is actually deleted. It can never
 *      record a refusal, and fk_blocked / not_found are precisely the outcomes
 *      we need to distinguish from a real deletion.
 * So the row is written here, explicitly, with the uid from the verified JWT.
 *
 * IT CANNOT SILENTLY FAIL. The audit row is written BEFORE the delete, and if
 * the write fails the delete does not happen — that ordering is the only one
 * where "audited" and "deleted" cannot come apart. A post-hoc audit that fails
 * leaves a destroyed record with no trace, which is the situation this exists
 * to end. */
async function writeAudit(
  actorUid: string | null,
  id: string,
  operation: string,
  snapshot: any,
  detail: Record<string, unknown>,
): Promise<{ ok: boolean; auditId?: number; error?: string }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { ...h, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        table_name: 'contacts',
        row_id: String(id),
        operation,
        old_data: snapshot || null,
        new_data: detail,
        changed_by: actorUid,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `audit_log HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    const rows = await res.json().catch(() => []);
    return { ok: true, auditId: Array.isArray(rows) && rows[0] ? rows[0].id : undefined };
  } catch (e) {
    return { ok: false, error: `audit_log unreachable: ${String((e as Error)?.message || e)}` };
  }
}

/** Correct an audit row when the delete failed AFTER it was written. */
async function amendAudit(auditId: number | undefined, detail: Record<string, unknown>) {
  if (!auditId) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log?id=eq.${auditId}`, {
      method: 'PATCH', headers: h, body: JSON.stringify({ new_data: detail }),
    });
  } catch (e) {
    // Loud: an uncorrected row would claim a deletion that did not happen.
    console.error('[delete-contacts] AUDIT AMEND FAILED', auditId, String(e));
  }
}

/** The snapshot stored in old_data — enough to answer "which person was this". */
async function contactSnapshot(id: string): Promise<any | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/contacts?id=eq.${id}&select=id,first_name,last_name,email,phone,pipeline_status,lead_source,created_at`,
      { headers: h },
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (_) { return null; }
}

/** Pull the referencing table + constraint out of a PostgREST 23503 body. */
function parseFkError(raw: string): { code?: string; table?: string; constraint?: string; message: string } {
  let body: any = null;
  try { body = JSON.parse(raw); } catch (_) { /* not JSON — fall through */ }
  const message = (body && (body.message || body.details || body.hint)) || raw || 'unknown error';
  const blob = `${body?.message || ''} ${body?.details || ''}`;
  // details: 'Key (id)=(…) is still referenced from table "signature_signers".'
  const table = blob.match(/referenced from table "([^"]+)"/)?.[1]
             || blob.match(/on table "([^"]+)"/)?.[1];
  const constraint = blob.match(/foreign key constraint "([^"]+)"/)?.[1];
  return { code: body?.code, table, constraint, message };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    /* GUARDED. Placed before req.json() — see require-staff's note 2: a check
     * after body parsing is one a later action can be written in front of.
     *
     * ADMIN ONLY, deliberately, and this is a POLICY CALL FOR RENE, not an
     * engineering default. The VA login is shared and rotating, and a contact
     * delete cascades the borrower's whole tree with no undo. Starting closed is
     * the reversible choice: widening this to ['admin','va'] later is one word,
     * un-deleting a borrower is nothing.
     *
     * verify_jwt stays pinned false. The pin is a STABILITY control, not an
     * access one — the anon key is a project-signed JWT printed in every page,
     * so flipping it would add nothing this check does not already do. */
    const staff = await requireStaff(req, { roles: ['admin'], what: 'Deleting contacts' });
    if (!staff.ok) {
      console.error('[delete-contacts] REJECTED:', staff.status, staff.msg);
      return new Response(JSON.stringify({ success: false, error: staff.msg || 'unauthorized' }),
        { status: staff.status || 403, headers: cors });
    }
    const actorUid = staff.userId || null;

    const { contact_ids } = await req.json();
    if (!Array.isArray(contact_ids) || !contact_ids.length)
      return new Response(JSON.stringify({ success: false, error: 'contact_ids array required' }), { status: 400, headers: cors });

    console.log(`[delete-contacts] ${contact_ids.length} requested by ${actorUid}:`, contact_ids.join(', '));
    const results: any[] = [];

    for (const id of contact_ids) {
      try {
        /* Snapshot BEFORE anything. Once the row is gone we cannot describe who
           it was, and "which borrower was contact 93724c8a" is the question an
           audit trail exists to answer. */
        const snap = await contactSnapshot(id);
        /* PREFLIGHT. Deliberately before the PATCHes below.
         *
         * The old order nulled other contacts' referred_by_contact_id and
         * primary_borrower_contact_id FIRST, then attempted the delete. When the
         * delete failed on an FK, those edits stayed — a refused delete silently
         * detached the contact's referrals and co-borrower links anyway. Checking
         * first means a blocked contact is left exactly as it was found. */
        /* Does it exist at all? Asked FIRST, and asked here rather than inferred
         * from the DELETE, because PostgREST's DELETE + return=representation
         * answered 200 with an empty array for a row it had just deleted — so a
         * real deletion reported as not_found. Verified live on 2026-08-07: the
         * contact was gone from the table while the response said nothing was
         * removed. An existence check before the delete does not depend on that
         * behaviour at all. */
        const exists = await fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${id}&select=id`, {
          headers: { ...h, 'Prefer': 'count=exact', 'Range': '0-0' },
        });
        const existsCount = parseInt((exists.headers.get('content-range') || '').split('/')[1] || '0', 10);
        if (exists.ok && existsCount === 0) {
          console.error(`[delete-contacts] NOT FOUND ${id}`);
          const a = await writeAudit(actorUid, id, 'DELETE_NOT_FOUND', snap, { outcome: 'not_found' });
          if (!a.ok) {
            results.push({ id, deleted: false, reason: 'audit_failed', error: `Refused: the audit record could not be written (${a.error}). Nothing was deleted.` });
            continue;
          }
          results.push({
            id, deleted: false, reason: 'not_found',
            error: 'No contact with this id — nothing was deleted. It may already have been removed.',
          });
          continue;
        }

        const blockers = await findBlockers(id);
        if (blockers.length) {
          const detail = blockers
            .map(b => `${b.rows < 0 ? '?' : b.rows} row(s) in ${b.table} (${b.note})`)
            .join('; ');
          console.error(`[delete-contacts] BLOCKED ${id}: ${detail}`);
          const a = await writeAudit(actorUid, id, 'DELETE_BLOCKED', snap, { outcome: 'fk_blocked', blocked_by: blockers });
          if (!a.ok) {
            results.push({ id, deleted: false, reason: 'audit_failed', error: `Refused: the audit record could not be written (${a.error}). Nothing was deleted.` });
            continue;
          }
          results.push({
            id, deleted: false, reason: 'fk_blocked', blocked_by: blockers,
            error: `Blocked by ${detail}. These references are retained on purpose, so the contact cannot be deleted while they exist.`,
          });
          continue;
        }

        /* Self-referential FKs on OTHER contacts are SET NULL by hand.
         * These were Promise.allSettled, which discards rejections AND non-2xx
         * responses — a PATCH could 500 and the delete would carry on as if the
         * links were cleared. Both responses are now checked, and a failure here
         * aborts this id rather than proceeding on a false premise. */
        const patches = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/contacts?referred_by_contact_id=eq.${id}`, {
            method: 'PATCH', headers: h,
            body: JSON.stringify({ referred_by_contact_id: null }),
          }).then(async r => ({ what: 'clear referred_by_contact_id', ok: r.ok, status: r.status, body: r.ok ? '' : await r.text() }))
            .catch(e => ({ what: 'clear referred_by_contact_id', ok: false, status: 0, body: e.message })),
          fetch(`${SUPABASE_URL}/rest/v1/contacts?primary_borrower_contact_id=eq.${id}`, {
            method: 'PATCH', headers: h,
            body: JSON.stringify({ primary_borrower_contact_id: null, is_co_borrower: false }),
          }).then(async r => ({ what: 'clear primary_borrower_contact_id', ok: r.ok, status: r.status, body: r.ok ? '' : await r.text() }))
            .catch(e => ({ what: 'clear primary_borrower_contact_id', ok: false, status: 0, body: e.message })),
        ]);
        const badPatch = patches.find(p => !p.ok);
        if (badPatch) {
          console.error(`[delete-contacts] PRESTEP FAILED ${id}: ${badPatch.what} (${badPatch.status}) ${badPatch.body}`);
          await writeAudit(actorUid, id, 'DELETE_FAILED', snap, { outcome: 'prestep_failed', what: badPatch.what, status: badPatch.status });
          results.push({
            id, deleted: false, reason: 'prestep_failed', status: badPatch.status,
            error: `Could not ${badPatch.what} (HTTP ${badPatch.status}): ${badPatch.body.slice(0, 300)}`,
          });
          continue;
        }

        /* The delete itself. Everything remaining is ON DELETE CASCADE.
         * The row was confirmed to exist above and nothing blocks it, so a 2xx
         * here means it went. */
        /* AUDIT BEFORE DELETE. If this write fails, the contact is NOT deleted
           — an unaudited deletion is the failure this whole change exists to
           prevent, and refusing is recoverable where deleting is not. */
        const audit = await writeAudit(actorUid, id, 'DELETE', snap, { outcome: 'deleted' });
        if (!audit.ok) {
          console.error(`[delete-contacts] AUDIT FAILED, NOT DELETING ${id}: ${audit.error}`);
          results.push({
            id, deleted: false, reason: 'audit_failed',
            error: `Refused: the audit record could not be written (${audit.error}). Nothing was deleted.`,
          });
          continue;
        }

        const res = await fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${id}`, { method: 'DELETE', headers: h });

        if (res.ok) {
          console.log(`[delete-contacts] ✓ deleted ${id}`);
          results.push({ id, deleted: true, status: res.status });
          continue;
        }

        // Failed anyway — surface the REAL Postgres error, not a generic one.
        let errText = '';
        try { errText = await res.text(); } catch (_) { /* body already consumed / empty */ }
        const fk = parseFkError(errText);
        const isFk = fk.code === '23503';
        const known = fk.table ? BLOCKERS[fk.table] : undefined;
        const human = isFk
          ? `Blocked by rows in ${fk.table || 'an unknown table'}${known ? ` (${known.note})` : ''}` +
            `${fk.constraint ? `, constraint ${fk.constraint}` : ''}. ${fk.message}`
          : fk.message;
        console.error(`[delete-contacts] FAILED ${id} (${res.status}) ${fk.code || ''}: ${errText}`);
        /* The audit row already says 'deleted'. It is not true — correct it
           rather than leave a record claiming a deletion that never happened. */
        await amendAudit(audit.auditId, {
          outcome: isFk ? 'fk_blocked' : 'delete_failed',
          pg_code: fk.code, table: fk.table, message: fk.message,
        });
        results.push({
          id, deleted: false, reason: isFk ? 'fk_blocked' : 'delete_failed',
          status: res.status, pg_code: fk.code,
          blocked_by: isFk && fk.table ? [{ table: fk.table, column: known?.col, rows: null, note: known?.note || '' }] : undefined,
          error: human,
        });

      } catch (e: any) {
        console.error(`[delete-contacts] Exception for ${id}:`, e.message);
        results.push({ id, deleted: false, reason: 'exception', error: e.message });
      }
    }

    const deleted = results.filter(r => r.deleted).length;
    const failed = results.length - deleted;
    console.log(`[delete-contacts] Done: ${deleted} deleted, ${failed} failed of ${contact_ids.length}`);

    /* 200 only when every id went. 207 Multi-Status when some did — note 207 is
     * still 2xx, so res.ok stays true and a caller that reads only res.ok is not
     * silently broken; it is `success` that tells the truth. 409 when none did,
     * which is the one case where res.ok is false and a bare throw is right. */
    const status = failed === 0 ? 200 : (deleted === 0 ? 409 : 207);
    return new Response(JSON.stringify({
      success: failed === 0,
      deleted, failed, total: contact_ids.length,
      error: failed === 0 ? undefined
        : `${deleted} of ${contact_ids.length} deleted; ${failed} could not be deleted.`,
      results,
    }), { status, headers: cors });

  } catch (e: any) {
    console.error('[delete-contacts] Fatal:', e);
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: cors });
  }
});
