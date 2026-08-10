/* Reconciliation between database rows and the storage objects they name.
 *
 * WHY THIS EXISTS
 * Nothing ties a row to its bytes. There are ZERO foreign keys referencing
 * storage.objects — Postgres cannot, since the object is a row in another
 * schema managed by the storage API — so a path column is a claim, checked by
 * nobody, until a borrower clicks a link and gets nothing.
 *
 * Two directions, and they are NOT symmetric:
 *
 *   A. DANGLING REFERENCE — a row names an object that is not there.
 *      The CRM shows the borrower a document that does not exist. This is the
 *      state a database restore creates: restore to last Tuesday and every row
 *      deleted since comes back, pointing at objects that were removed and are
 *      not restored with it (Supabase physical backups do not include storage).
 *      Alert on ANY.
 *
 *   B. ORPHANED OBJECT — bytes with no row.
 *      Invisible rather than broken: the file exists, nothing references it, no
 *      surface lists it. Fourteen of these sat in borrower-documents since
 *      March, thirteen of them real borrower files. Alert only ABOVE A RECORDED
 *      BASELINE, so the known fourteen do not cry wolf hourly while a fifteenth
 *      still does.
 */

export type RegistryEntry = {
  table: string;
  column: string;
  bucket: string;
  /** Rows may legitimately have a null path; only non-null rows are checked. */
  note?: string;
};

/* Only columns holding BUCKET-RELATIVE paths belong here. Verified against live
 * data — a column storing a full https:// URL cannot be compared to
 * storage.objects.name without parsing, and a parser that guesses wrong reports
 * false dangling references, which is worse than not checking. */
export const REGISTRY: RegistryEntry[] = [
  { table: "uploaded_documents", column: "file_path", bucket: "borrower-documents" },
  { table: "uploaded_documents", column: "storage_path", bucket: "borrower-documents" },
  { table: "lender_guidelines", column: "storage_path", bucket: "lender-guidelines" },
  { table: "esign_documents", column: "storage_path", bucket: "esign",
    note: "executed signature documents — legal artifacts" },
  /* Added 2026-08-09. These three were the reason six esign objects counted as
   * orphans: the signed output of a request had NO column watching it, because
   * the only registered esign column was esign_documents.storage_path, which
   * points at documents/ — the unsigned source, not the signed result.
   *
   * That is a worse failure than an orphan reads as. Four completed signature
   * requests had their signed PDF sitting in the bucket with nothing in the
   * database pointing at it: every final_pdf_path, combined_pdf_path and
   * final_pdf_url on all 16 requests was null. Deleting them as "litter" would
   * have destroyed the only copy of a borrower's executed signature and
   * produced NO dangling reference afterwards, because no row referred to them.
   * Undetectable loss, in the one store PITR does not cover.
   *
   * Verified before registering: 4 non-null, 0 would dangle. */
  { table: "signature_requests", column: "final_pdf_path", bucket: "esign",
    note: "the signed PDF for a completed request — legal artifact" },
  { table: "signature_requests", column: "combined_pdf_path", bucket: "esign",
    note: "multi-document envelopes, merged" },
  { table: "esign_documents", column: "final_pdf_path", bucket: "esign" },
  { table: "videos", column: "storage_path", bucket: "video-messages" },
  /* Added with paste-to-upload, 2026-08-10, and in the SAME change deliberately.
   * chat-attachments had no watcher: an upload that succeeded while its
   * staff_message_attachments row failed left a file nobody could reach and
   * nobody could see. That was a latent gap while the only route in was a file
   * picker one file at a time. Paste makes it an active one — pasting a
   * screenshot is the cheapest possible way to put bytes in a bucket, and it
   * will be used constantly.
   * Verified bucket-relative before registering: 7 rows, 0 full URLs,
   * '<uuid>/<uuid>-<name>'. */
  { table: "staff_message_attachments", column: "storage_path", bucket: "chat-attachments" },
];

/* Deliberately NOT in the registry, with the reason, so a future reader does
 * not assume they were forgotten:
 *   sms_log.media_url        — stores a full public URL, not a path
 *   email_log.attachments    — jsonb array, no single path column
 *   approval-letters bucket  — extract-conditions returns the URL to its caller
 *                              and no column stores the path
 *   task-screenshots         — no owning table found
 *   cma-photos               — generate-cma stores public URLs
 * Each needs a schema change before it can be reconciled, not a smarter query.
 */

export type ReconcileResult = {
  ok: boolean;
  dangling: { entry: string; count: number; samples: string[] }[];
  orphans: { bucket: string; count: number; baseline: number; over: number }[];
  checked_at: string;
};

export async function reconcileStorage(sb: any): Promise<ReconcileResult> {
  const dangling: ReconcileResult["dangling"] = [];
  const orphans: ReconcileResult["orphans"] = [];

  // ── A. rows whose object is missing ──
  for (const e of REGISTRY) {
    const { data, error } = await sb.rpc("storage_dangling_refs", {
      p_table: e.table, p_column: e.column, p_bucket: e.bucket,
    });
    if (error) {
      dangling.push({ entry: `${e.table}.${e.column}`, count: -1, samples: [`check failed: ${error.message}`] });
      continue;
    }
    const rows = (data || []) as { path: string }[];
    if (rows.length) {
      dangling.push({
        entry: `${e.table}.${e.column} -> ${e.bucket}`,
        count: rows.length,
        samples: rows.slice(0, 5).map((r) => r.path),
      });
    }
  }

  // ── B. objects with no owning row, against a recorded baseline ──
  const buckets = [...new Set(REGISTRY.map((r) => r.bucket))];
  for (const bucket of buckets) {
    const cols = REGISTRY.filter((r) => r.bucket === bucket);
    const { data, error } = await sb.rpc("storage_orphan_objects", {
      p_bucket: bucket,
      p_refs: cols.map((c) => `${c.table}.${c.column}`),
    });
    if (error) continue;
    const count = Number((data as any) ?? 0);
    const { data: bl } = await sb.from("system_state")
      .select("value").eq("key", `reconcile_baseline:${bucket}`).maybeSingle();
    /* No baseline yet means today's count IS the baseline — recording it rather
     * than alerting avoids a first run that screams about history nobody caused
     * this hour. A NEW orphan still trips it tomorrow. */
    const baseline = Number((bl?.value as any)?.count ?? -1);
    if (baseline < 0) {
      await sb.from("system_state").upsert({
        key: `reconcile_baseline:${bucket}`,
        value: { count, recorded_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      });
      orphans.push({ bucket, count, baseline: count, over: 0 });
    } else {
      orphans.push({ bucket, count, baseline, over: Math.max(0, count - baseline) });
    }
  }

  const anyDangling = dangling.some((d) => d.count !== 0);
  const anyNewOrphans = orphans.some((o) => o.over > 0);
  return { ok: !anyDangling && !anyNewOrphans, dangling, orphans, checked_at: new Date().toISOString() };
}
