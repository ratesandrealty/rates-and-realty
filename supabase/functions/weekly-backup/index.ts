import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getDriveAccessToken } from '../_shared/google-user-token.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/* THROWS on any auth problem, and resolves the token the same way every other
 * Drive caller does — google_calendar_tokens row first, secret as fallback. It
 * used to read GOOGLE_DRIVE_ACCESS_TOKEN (an access token, one-hour life) and
 * fall back to it silently when the refresh failed, so every run since the
 * refresh token broke proceeded with a credential dead for months. */
async function getValidAccessToken(sbClient: any): Promise<string> {
  const { accessToken } = await getDriveAccessToken(sbClient);
  return accessToken;
}


/* Read the file BACK from Drive and check its size. A 200 from the upload call
 * is not proof the object exists — the whole reason this backup went unnoticed
 * is that nothing ever looked afterwards. Returns the verified byte count. */
async function verifyUploaded(token: string, fileId: string, expectedBytes: number, label: string): Promise<number> {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size,trashed`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Verify failed for ${label}: HTTP ${r.status}`);
  const m = await r.json();
  if (m.trashed) throw new Error(`Verify failed for ${label}: file is trashed`);
  const got = parseInt(m.size || '0', 10);
  /* Drive can normalise line endings, so an exact match is too strict; a file
   * materially smaller than what we sent means a truncated write. */
  if (!got || got < expectedBytes * 0.9) {
    throw new Error(`Verify failed for ${label}: Drive reports ${got} bytes, expected ~${expectedBytes}`);
  }
  return got;
}

async function createDriveFolder(token: string, name: string, parentId: string): Promise<string> {
  try {
    const search = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='${encodeURIComponent(name)}'+and+'${parentId}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id)`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (search.ok) { const d = await search.json(); if (d.files?.length) return d.files[0].id; }
  } catch(e) { console.error('Folder search error:', e); }
  const r = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Failed to create folder: ${JSON.stringify(data)}`);
  return data.id;
}


/* PAGINATE, AND ASSERT COMPLETENESS.
 *
 * PostgREST caps an unbounded select at 1000 rows. The 2026-08-01 run exported
 * exactly 1000 of 1038 contacts and reported success — 38 people silently
 * absent from the backup. Worse, the read-back verification PASSED, because it
 * compared the uploaded file against what was sent rather than against what
 * should have been sent. Verifying the transport while never checking the
 * payload is the same shape as every other failure found this week.
 *
 * So: page through with .range(), then compare the row count against a
 * head:true count of the table and THROW on any mismatch. A backup missing rows
 * must not be able to call itself verified. */
async function fetchAllRows(sb: any, table: string, columns: string): Promise<any[]> {
  const PAGE = 1000;
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  const { count, error: cErr } = await sb.from(table).select('id', { count: 'exact', head: true });
  if (cErr) throw new Error(`${table} count: ${cErr.message}`);
  if (typeof count === 'number' && out.length !== count) {
    throw new Error(`Backup aborted: ${table} exported ${out.length} rows but the table holds ${count}. An incomplete backup must not be recorded as verified.`);
  }
  return out;
}

async function uploadToDrive(token: string, folderId: string, fileName: string, content: string, mimeType: string) {
  /* REPLACE IN PLACE, DO NOT ADD A SECOND FILE WITH THE SAME NAME.
   *
   * Drive is happy to hold many files with identical names in one folder, and
   * a plain POST created a new one every run. After three runs on 2026-08-01
   * the day's folder held three files called contacts_2026-08-01.csv — and the
   * first of them was the truncated 1000-row export from before the pagination
   * fix. A restore picks by luck between a complete backup and one silently
   * missing 38 people, with nothing in the name to tell them apart.
   *
   * So: look for an existing file of this name in this folder and PATCH its
   * media if there is one. Drive keeps the prior content as a revision, so this
   * replaces without destroying. */
  const q = encodeURIComponent(`name='${fileName.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`);
  let existingId = '';
  try {
    const lr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&orderBy=createdTime`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (lr.ok) {
      const ld = await lr.json();
      if (ld.files?.length) existingId = ld.files[0].id;
    }
  } catch (e) {
    console.warn(`[weekly-backup] duplicate lookup failed for ${fileName}:`, String(e));
  }

  let meta: any;
  if (existingId) {
    const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media&fields=id,name`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
      body: content,
    });
    if (!r.ok) throw new Error(`Drive replace failed (${r.status}): ${await r.text()}`);
    meta = await r.json();
  } else {
    const b = 'rrbackup123';
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: fileName, parents: [folderId] })}\r\n--${b}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${b}--`;
    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${b}` }, body
    });
    if (!r.ok) throw new Error(`Drive upload failed (${r.status}): ${await r.text()}`);
    meta = await r.json();
  }

  /* READ IT BACK. A 200 on the upload is not proof the object exists at the
   * size we sent — and "nothing ever looked afterwards" is precisely why this
   * backup went unnoticed for months. */
  const expected = new TextEncoder().encode(content).length;
  const verified = await verifyUploaded(token, meta.id, expected, fileName);
  return { ...meta, sent_bytes: expected, verified_bytes: verified, replaced: !!existingId };
}

function toCSV(rows: any[], headers: string[]): string {
  const lines = [headers.join(',')];
  rows.forEach(r => lines.push(headers.map(h => {
    const v = r[h];
    const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join(';') : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  }).join(',')));
  return lines.join('\n');
}

const SITE_ORIGIN = 'https://beta.ratesandrealty.com';

/* admin/contacts.html and admin/leads.html are gone from this list: neither has
 * ever existed in this repo. The site answers an unknown path with the
 * marketing homepage and a 200, so both backed up as byte-identical copies of
 * index.html — three names, one 114,987-byte file, and the run reported
 * errors: 0.
 *
 * admin/people.html and admin/pipeline.html replace them — the real contacts
 * and leads pages. Each was checked against the site root before being added
 * (people 197,321 bytes / bca4932d22ae, pipeline 15,406 / 0bbad69e542b, root
 * 114,987 / 1dba3c54bc93) and each matches its repo file byte for byte.
 * pipeline.html is genuinely small; that is the page, not a truncated fetch.
 *
 * This list is a stopgap in any case. Fetching site files over HTTP backs up
 * whatever the edge happens to serve, which is why a soft 404 could pass for a
 * page. The R2 sync must read them FROM THE REPO instead — see CLAUDE.md. */
const SITE_FILES = [
  'index.html',
  'admin/people.html', 'admin/pipeline.html', 'admin/lead-detail.html',
  'admin/lenders.html',
  'public/apply.html',
  'api/env.js',
];

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ASSERT THE PAYLOAD, NOT THE STATUS CODE.
 *
 * A 200 is not proof the file exists. This site serves the marketing homepage
 * for any path the Worker does not recognise, so the old check — `if (r.ok)` —
 * happily stored the homepage under four different names and called it seven
 * files backed up with zero errors. Verifying the transport while never looking
 * at the bytes is the same failure the Drive read-back and the row-count
 * assertion were each added to close; this is the third instance of it.
 *
 * So the root is fetched ONCE and every other path is compared against it.
 * Bytes identical to the site root under a different name is a failure, not a
 * file. index.html is exempt for the obvious reason: it IS the root. An empty
 * body is a failure too — there is no file here worth backing up. */
async function fetchSiteRoot(): Promise<{ body: string; hash: string } | null> {
  try {
    const r = await fetch(`${SITE_ORIGIN}/`, {
      headers: { 'User-Agent': 'RatesRealty-Backup/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { console.error(`Site root fetch failed: ${r.status}`); return null; }
    const body = await r.text();
    return { body, hash: await sha256Hex(body) };
  } catch (e) {
    console.error('Site root fetch error:', e);
    return null;
  }
}

async function fetchSiteFile(path: string, rootHash: string | null): Promise<{ content?: string; error?: string }> {
  try {
    const r = await fetch(`${SITE_ORIGIN}/${path}`, {
      headers: { 'User-Agent': 'RatesRealty-Backup/1.0' },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const content = await r.text();
    if (!content.trim()) return { error: 'empty body' };
    if (rootHash && path !== 'index.html' && await sha256Hex(content) === rootHash) {
      return { error: `served the site root (${content.length} bytes) — path does not exist` };
    }
    return { content };
  } catch(e) {
    return { error: `fetch error: ${String(e)}` };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const token = await getValidAccessToken(sb);
    const rootFolder = Deno.env.get('GOOGLE_DRIVE_BACKUP_FOLDER_ID') || '';

    if (!token) return new Response(JSON.stringify({ error: 'Missing GOOGLE_DRIVE_ACCESS_TOKEN' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!rootFolder) return new Response(JSON.stringify({ error: 'Missing GOOGLE_DRIVE_BACKUP_FOLDER_ID' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const results: Record<string, any> = {};

    console.log('Starting backup for', dateStr);

    // Create folder structure
    const dateFolder = await createDriveFolder(token, `Backup_${dateStr}`, rootFolder);
    const dataFolder = await createDriveFolder(token, '📊 Database', dateFolder);
    const siteFolder = await createDriveFolder(token, '🌐 Website Files', dateFolder);
    const adminFolder = await createDriveFolder(token, 'admin', siteFolder);
    const publicFolder = await createDriveFolder(token, 'public', siteFolder);

    console.log('Folders created');

    // 1. CONTACTS — use actual column names
    try {
      const contacts = await fetchAllRows(sb, 'contacts', 'id,first_name,last_name,email,phone,secondary_phone,contact_type,source,funnel_source,credit_score,monthly_income,annual_income,employer_name,job_title,address,city,state,zip,county,tags,notes,company,loan_type,loan_amount,lead_score,score_tier,lead_temperature,appointment_set,appointment_date,created_at,updated_at');
      if (contacts?.length) {
        const h = ['id','first_name','last_name','email','phone','secondary_phone','contact_type','source','funnel_source','credit_score','monthly_income','annual_income','employer_name','job_title','address','city','state','zip','county','tags','notes','company','loan_type','loan_amount','lead_score','score_tier','lead_temperature','appointment_set','appointment_date','created_at','updated_at'];
        const upC = await uploadToDrive(token, dataFolder, `contacts_${dateStr}.csv`, toCSV(contacts, h), 'text/csv');
        results.contacts = { count: contacts.length, file: upC.id, sent_bytes: upC.sent_bytes, verified_bytes: upC.verified_bytes, replaced: upC.replaced };
        console.log(`Contacts backed up: ${contacts.length}`);
      } else {
        results.contacts = { count: 0 };
      }
    } catch(e: any) { console.error('Contacts backup error:', e); results.contacts = { error: e.message }; }

    // 2. LEADS
    try {
      const leads = await fetchAllRows(sb, 'leads', 'id,contact_id,status,source,loan_type,loan_amount,property_address,property_type,property_value,score,notes,created_at,updated_at');
      if (leads?.length) {
        const h = ['id','contact_id','status','source','loan_type','loan_amount','property_address','property_type','property_value','score','notes','created_at','updated_at'];
        const upL = await uploadToDrive(token, dataFolder, `leads_${dateStr}.csv`, toCSV(leads, h), 'text/csv');
        results.leads = { count: leads.length, file: upL.id, sent_bytes: upL.sent_bytes, verified_bytes: upL.verified_bytes, replaced: upL.replaced };
        console.log(`Leads backed up: ${leads.length}`);
      } else { results.leads = { count: 0 }; }
    } catch(e: any) { console.error('Leads backup error:', e); results.leads = { error: e.message }; }

    // 3. MORTGAGE APPLICATIONS
    try {
      const apps = await fetchAllRows(sb, 'mortgage_applications', 'id,contact_id,loan_type,loan_amount,property_address,created_at');
      if (apps?.length) {
        const h = ['id','contact_id','loan_type','loan_amount','property_address','created_at'];
        const upA = await uploadToDrive(token, dataFolder, `applications_${dateStr}.csv`, toCSV(apps, h), 'text/csv');
        results.applications = { count: apps.length, file: upA.id, sent_bytes: upA.sent_bytes, verified_bytes: upA.verified_bytes, replaced: upA.replaced };
        console.log(`Applications backed up: ${apps.length}`);
      } else { results.applications = { count: 0 }; }
    } catch(e: any) { console.error('Applications backup error:', e); results.applications = { error: e.message }; }

    // 4. LENDERS
    try {
      const lenders = await fetchAllRows(sb, 'lenders', 'id,name,lender_type,programs,tags,min_credit_score,max_ltv,website,contact_name,contact_email,contact_phone,rep_name,rep_phone,rep_email,channel,priority,is_active,clickup_task_id,last_synced_at');
      if (lenders?.length) {
        const h = ['id','name','lender_type','programs','tags','min_credit_score','max_ltv','website','contact_name','contact_email','contact_phone','rep_name','rep_phone','rep_email','channel','priority','is_active','clickup_task_id','last_synced_at'];
        const upD = await uploadToDrive(token, dataFolder, `lenders_${dateStr}.csv`, toCSV(lenders, h), 'text/csv');
        results.lenders = { count: lenders.length, file: upD.id, sent_bytes: upD.sent_bytes, verified_bytes: upD.verified_bytes, replaced: upD.replaced };
        console.log(`Lenders backed up: ${lenders.length}`);
      } else { results.lenders = { count: 0 }; }
    } catch(e: any) { console.error('Lenders backup error:', e); results.lenders = { error: e.message }; }

    // 5. LENDER SUBMISSIONS
    try {
      const subs = await fetchAllRows(sb, 'lead_lender_submissions', 'id,lead_id,contact_id,lender_id,status,submitted_at,notes,created_at');
      if (subs?.length) {
        const h = ['id','lead_id','contact_id','lender_id','status','submitted_at','notes','created_at'];
        await uploadToDrive(token, dataFolder, `lender_submissions_${dateStr}.csv`, toCSV(subs, h), 'text/csv');
        results.lender_submissions = { count: subs.length };
      }
    } catch(e: any) { console.error('Submissions backup error:', e); }

    // 6. WEBSITE HTML FILES
    let siteCount = 0;
    const siteErrors: string[] = [];
    /* Fetched once, up front. If the root itself cannot be fetched the soft-404
     * comparison is impossible, so that is recorded rather than silently
     * skipped — otherwise a failed root fetch would quietly restore the old
     * status-only behaviour for the whole run. */
    const root = await fetchSiteRoot();
    if (!root) siteErrors.push('site root: unreachable — soft-404 detection disabled for this run');
    for (const path of SITE_FILES) {
      const got = await fetchSiteFile(path, root?.hash ?? null);
      if (got.content) {
        const folder = path.startsWith('admin/') ? adminFolder : path.startsWith('public/') ? publicFolder : siteFolder;
        const fname = path.split('/').pop() || path;
        const mime = path.endsWith('.js') ? 'application/javascript' : 'text/html';
        try {
          await uploadToDrive(token, folder, fname, got.content, mime);
          siteCount++;
          console.log(`Site file backed up: ${path}`);
        } catch(e: any) { siteErrors.push(`${path}: ${e.message}`); }
      } else {
        console.log(`Site file rejected: ${path} — ${got.error}`);
        siteErrors.push(`${path}: ${got.error}`);
      }
    }
    results.website = { files_backed_up: siteCount, errors: siteErrors.length, error_list: siteErrors };

    /* ── 7. GATE: any failed section fails the whole run ──────────────────
     *
     * Each export above is wrapped in its own try/catch that records
     * results.<table> = { error } and carries on. That is reasonable for
     * getting the other tables out, but until now execution fell straight
     * through to writing status 'success' and backup:last_verified — so a
     * table that threw was recorded as a verified backup anyway.
     *
     * That is the same swallow the pagination fix was meant to close, one
     * layer down: fetchAllRows throws when a table exports fewer rows than it
     * holds, and this catch turned the throw back into success. A partial
     * backup must be visible as partial. */
    const failed: string[] = [];
    for (const [name, r] of Object.entries(results)) {
      if (name === 'website') continue;
      if (r && typeof r === 'object' && 'error' in (r as any)) failed.push(`${name}: ${(r as any).error}`);
    }
    if (siteErrors.length) failed.push(`website: ${siteErrors.length} file(s) failed`);

    await sb.from('backup_logs').upsert({
      backup_date: dateStr, results,
      status: failed.length ? 'failed' : 'success',
      created_at: now.toISOString()
    }, { onConflict: 'backup_date' });

    if (failed.length) {
      console.error('[weekly-backup] INCOMPLETE, not marking verified:', failed.join(' | '));
      return new Response(JSON.stringify({
        success: false, date: dateStr, folder: `Backup_${dateStr}`, failed, results,
        note: 'backup:last_verified was NOT updated — this backup is incomplete.',
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    /* A marker the hourly monitor reads. backup_logs already existed and said
     * "success" for a run whose Drive writes were never checked, so a separate
     * key records only VERIFIED completion — every file read back from Drive at
     * the expected size. */
    await sb.from('system_state').upsert({
      key: 'backup:last_verified',
      value: { date: dateStr, at: now.toISOString(), results },
      updated_at: now.toISOString(),
    });

    console.log('Backup complete:', JSON.stringify(results));
    return new Response(JSON.stringify({ success: true, date: dateStr, folder: `Backup_${dateStr}`, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    console.error('Backup fatal error:', err);
    /* Record the failure. Previously a fatal error returned a 500 to pg_cron,
     * which discards the body — so a failing backup left no trace anywhere. */
    try {
      const sb2 = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      await sb2.from('backup_logs').upsert({
        backup_date: new Date().toISOString().slice(0, 10),
        results: { error: String(err?.message || err).slice(0, 500) },
        status: 'failed', created_at: new Date().toISOString(),
      }, { onConflict: 'backup_date' });
    } catch (_) { /* nothing left to try */ }
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
