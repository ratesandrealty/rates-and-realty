# Retention — what is kept, for how long, and who may delete it

E Mortgage Capital deferred these decisions to Rene, so this file is the record
of what was decided rather than a summary of what the code happens to do. Where
the code and this file disagree, one of them is a bug; say which.

**Last reviewed: 2026-08-09.**

---

## The default is KEEP

Nothing in this system deletes a borrower's documents on a schedule. There is no
retention timer, no archive job, no expiry. A document uploaded in March 2026 is
still there.

That is deliberate, and it is the opposite of the usual instinct to tidy up:

- Storage is the one store **NOT covered by PITR**. Supabase's physical backups
  restore Postgres, not buckets. A deleted object is gone, and restoring the
  database around it produces a row pointing at nothing.
- Loan files are evidence. A borrower's ID, a gift letter, a signed
  authorisation — the reason to have kept them arrives long after the reason to
  tidy them away.
- Bytes are cheap. The entire `borrower-documents` orphan set is 5.5 MB.

**So: when in doubt, keep. Deleting requires a decision by Rene, recorded here.**

---

## Borrower documents

**Kept indefinitely, including when the contact is gone.**

A document does not stop being a record because the CRM row that pointed at it
was removed. The three ways a contact can disappear behave differently, and only
one of them is safe:

| what happened | contact row | documents |
|---|---|---|
| **Merge** (`contact_merge`) | loser is SOFT-deleted — `merged_into_contact_id` set, row retained | repointed to the survivor, nothing orphaned |
| **Soft delete** (`merged_into_contact_id`) | retained, hidden from lists | untouched, still reachable |
| **Hard delete** (`delete-contacts`) | row gone, FK children CASCADE | **storage objects are NOT deleted and NOT repointed — they become unreferenced bytes** |

That third row is the important one and it is not a hypothetical: twelve
objects under four contact-id prefixes are in exactly that state today, from
contacts hard-deleted between March and June 2026.

**Hard delete does not preserve the link between a document and the person it
belongs to.** The contact-id prefix in the storage path is the only surviving
clue, and once the contact row is gone that uuid resolves to nothing. This is
the strongest argument against hard deletion and for merge/soft-delete.

### Who may delete borrower documents

- **`delete-contacts` is ADMIN-ONLY** — `requireStaff(req, { roles: ['admin'] })`
  before `req.json()`. Not staff, not the VA. The VA login is shared and
  rotating, and a contact delete cascades a borrower's whole tree.
- It writes an **`audit_log` row BEFORE the delete**, and if that write fails the
  contact is **not** deleted (`reason: 'audit_failed'`). "Audited" and "deleted"
  cannot come apart.
- **It does not delete storage objects.** That is a deliberate gap, not an
  oversight: the row goes, the bytes stay.
- The VA can upload documents (via `gdrive-proxy` with a session token) and
  cannot delete them.
- `gdrive-proxy?action=trash-file` refuses to trash anything the service account
  does not own, which is why nothing in the backup tree or a rene@-owned folder
  can be cleaned up through it.

### The 12 orphaned files — retained deliberately

Under `orphaned/` since 2026-08-09. Snapshot with original paths and etags:
`snapshots/borrower-documents-orphans-20260809.json`.

12 objects, 5,546,204 bytes, from four hard-deleted contacts:

| prefix | files | what they are |
|---|---|---|
| `2ed0c434…` | 3 | the same government ID, uploaded three times |
| `a1b87d6a…` | 4 | two copies of a government ID, a gift letter, an insurance standards letter |
| `de79bd19…` | 4 | seller counter-offer, sewer permit, a suspense condition, a pricing sheet |
| `08602380…` | 1 | an SMS-uploaded PDF |

**They are kept, and the reason is that they are real borrower documents whose
owner cannot be re-established.** Deleting them destroys records; keeping them in
place made them look like live data. Moving them under `orphaned/` says what
they are without destroying anything. They are **not** merge losers — all four
merged contacts are soft-deleted and retained, and none of them appears here.

Revisit only if a retention obligation requires disposal, and record that
decision here before acting.

---

## Call recordings and transcripts

**Kept indefinitely. No expiry is configured on the Twilio side or ours.**

- **Recordings** live in Twilio, not in our storage. `calls_log.recording_url`
  is an `api.twilio.com` resource URL that needs account credentials — pasting
  it into a browser gets nothing.
- **Playback is ADMIN-ONLY**, through `twilio-voice ?action=get_recording`,
  which streams the bytes with the credential held server-side and
  `Cache-Control: private, no-store`. The dialer is admin/va/agent/loa;
  playback is narrower on purpose. Widening it should be a decision, not an
  inheritance.
- **Transcripts and AI summaries are ADMIN-ONLY too**, and the enforcement is
  **column grants**, not RLS: `calls_log` RLS is `authenticated USING (true)`,
  so `transcript`, `ai_summary` and `transcript_sid` are simply **not granted**
  to the `authenticated` role. Reading goes through `call-intelligence` `get`.
  `start` and `sync` are admin too — if you may not read a transcript you may
  not commission one.
- A transcript is the same NPI as the recording in a form that can be pasted
  anywhere. Treat it as more sensitive than the audio, not less.
- The **AI summary** is copied into `contact_notes`, which IS visible to the VA
  on a shared lead. The verbatim transcript is never copied there.

If a retention limit is ever imposed on recordings, it has to be applied in
Twilio as well as here, and the transcript is a second copy that outlives the
audio.

---

## E-signature records

**Kept indefinitely. These are legal artifacts.**

- **Going forward**, the record PDF is generated **at completion** and written to
  `signature_requests.final_pdf_path`. It is never overwritten: if an object
  already exists at that path it is left alone and served as-is. A record of
  what was signed must not be silently replaced by a later reconstruction.
- **The 8 historical completed requests have no record PDF and will not get
  one.** They completed before generation-on-completion existed. They are not
  being backfilled, because a PDF produced today would carry today's timestamp
  while attesting to a signature from June, and nothing in the artifact would
  say it was reconstructed seven weeks later.
- **Those 8 are not lost.** The completion email embeds the signed document
  **and** the certificate **inline in the body** — not a link that expires, not
  an attachment that can be stripped — and it was sent to the signer *and* to
  rene@ cc processing@. Confirmed: an `email_log` row exists for all 8. The
  borrower holds a copy and so does the business.
- They can be regenerated if ever needed: `document_html`, `document_hash`,
  timestamps, signers and every `signature_events` row are all still in the
  database, and the stored SHA-256 proves the content matches what was signed.
  **Doing so is Rene's call and possibly E Mortgage's**, because it raises the
  question of what a record produced after the fact attests to.
- Monitoring: `gdrive-health-monitor` alerts on a completed request with no
  `final_pdf_path` after 15 minutes, and on any `record_failed` event in the
  last hour. The 8 are excluded by date (`completed_at > 2026-08-09T06:00:00Z`),
  not by id, so the exclusion states the reason rather than listing constants.

---

## What is NOT covered here

- **Guideline PDFs** (`lender-guidelines`) — lender documents, not borrower data.
- **Video messages** (`video-messages`) — no decision recorded yet.
- **`sms-media`** — outside the reconcile registry entirely; nothing watches it.
- **Backups** — `weekly-backup` writes with rene@'s user token; pg_cron job 2 is
  currently **disabled** pending the R2 sync, so nothing is producing them.
  `backup:last_verified` last moved 2026-08-01. That is a gap in the retention
  story, not a decision.
