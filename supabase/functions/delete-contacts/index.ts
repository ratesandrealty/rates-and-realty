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
 * Still no in-function authorization — verify_jwt = false, service role.
 * That is the NEXT change, deliberately separate: this one must not alter
 * who can call it while we are proving the reporting is honest.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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
    const { contact_ids } = await req.json();
    if (!Array.isArray(contact_ids) || !contact_ids.length)
      return new Response(JSON.stringify({ success: false, error: 'contact_ids array required' }), { status: 400, headers: cors });

    console.log(`[delete-contacts] Deleting ${contact_ids.length}:`, contact_ids.join(', '));
    const results: any[] = [];

    for (const id of contact_ids) {
      try {
        /* PREFLIGHT. Deliberately before the PATCHes below.
         *
         * The old order nulled other contacts' referred_by_contact_id and
         * primary_borrower_contact_id FIRST, then attempted the delete. When the
         * delete failed on an FK, those edits stayed — a refused delete silently
         * detached the contact's referrals and co-borrower links anyway. Checking
         * first means a blocked contact is left exactly as it was found. */
        const blockers = await findBlockers(id);
        if (blockers.length) {
          const detail = blockers
            .map(b => `${b.rows < 0 ? '?' : b.rows} row(s) in ${b.table} (${b.note})`)
            .join('; ');
          console.error(`[delete-contacts] BLOCKED ${id}: ${detail}`);
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
          results.push({
            id, deleted: false, reason: 'prestep_failed', status: badPatch.status,
            error: `Could not ${badPatch.what} (HTTP ${badPatch.status}): ${badPatch.body.slice(0, 300)}`,
          });
          continue;
        }

        // The delete itself. Everything remaining is ON DELETE CASCADE.
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
