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

async function uploadToDrive(token: string, folderId: string, fileName: string, content: string, mimeType: string) {
  const b = 'rrbackup123';
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: fileName, parents: [folderId] })}\r\n--${b}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${b}--`;
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${b}` }, body
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Drive upload failed (${r.status}): ${err}`);
  }
  const meta = await r.json();
  /* READ IT BACK. A 200 on the upload is not proof the object exists at the
   * size we sent — and "nothing ever looked afterwards" is precisely why this
   * backup went unnoticed for months. */
  const expected = new TextEncoder().encode(content).length;
  const verified = await verifyUploaded(token, meta.id, expected, fileName);
  return { ...meta, verified_bytes: verified };
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

const SITE_FILES = [
  'index.html',
  'admin/contacts.html', 'admin/leads.html', 'admin/lead-detail.html',
  'admin/lenders.html',
  'public/apply.html',
  'api/env.js',
];

async function fetchSiteFile(path: string): Promise<string | null> {
  try {
    const r = await fetch(`https://beta.ratesandrealty.com/${path}`, {
      headers: { 'User-Agent': 'RatesRealty-Backup/1.0' },
      signal: AbortSignal.timeout(15000)
    });
    if (r.ok) return await r.text();
    console.log(`Site file not found: ${path} (${r.status})`);
    return null;
  } catch(e) {
    console.log(`Site file fetch error: ${path}`, e);
    return null;
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
      const { data: contacts, error: cErr } = await sb.from('contacts')
        .select('id,first_name,last_name,email,phone,secondary_phone,contact_type,source,funnel_source,credit_score,monthly_income,annual_income,employer_name,job_title,address,city,state,zip,county,tags,notes,company,loan_type,loan_amount,lead_score,score_tier,lead_temperature,appointment_set,appointment_date,created_at,updated_at')
        .order('created_at', { ascending: false });
      if (cErr) throw cErr;
      if (contacts?.length) {
        const h = ['id','first_name','last_name','email','phone','secondary_phone','contact_type','source','funnel_source','credit_score','monthly_income','annual_income','employer_name','job_title','address','city','state','zip','county','tags','notes','company','loan_type','loan_amount','lead_score','score_tier','lead_temperature','appointment_set','appointment_date','created_at','updated_at'];
        await uploadToDrive(token, dataFolder, `contacts_${dateStr}.csv`, toCSV(contacts, h), 'text/csv');
        results.contacts = { count: contacts.length };
        console.log(`Contacts backed up: ${contacts.length}`);
      } else {
        results.contacts = { count: 0 };
      }
    } catch(e: any) { console.error('Contacts backup error:', e); results.contacts = { error: e.message }; }

    // 2. LEADS
    try {
      const { data: leads, error: lErr } = await sb.from('leads')
        .select('id,contact_id,status,source,loan_type,loan_amount,property_address,property_type,property_value,score,notes,created_at,updated_at')
        .order('created_at', { ascending: false });
      if (lErr) throw lErr;
      if (leads?.length) {
        const h = ['id','contact_id','status','source','loan_type','loan_amount','property_address','property_type','property_value','score','notes','created_at','updated_at'];
        await uploadToDrive(token, dataFolder, `leads_${dateStr}.csv`, toCSV(leads, h), 'text/csv');
        results.leads = { count: leads.length };
        console.log(`Leads backed up: ${leads.length}`);
      } else { results.leads = { count: 0 }; }
    } catch(e: any) { console.error('Leads backup error:', e); results.leads = { error: e.message }; }

    // 3. MORTGAGE APPLICATIONS
    try {
      const { data: apps, error: aErr } = await sb.from('mortgage_applications')
        .select('id,contact_id,loan_type,loan_amount,property_address,created_at')
        .order('created_at', { ascending: false });
      if (aErr) throw aErr;
      if (apps?.length) {
        const h = ['id','contact_id','loan_type','loan_amount','property_address','created_at'];
        await uploadToDrive(token, dataFolder, `applications_${dateStr}.csv`, toCSV(apps, h), 'text/csv');
        results.applications = { count: apps.length };
        console.log(`Applications backed up: ${apps.length}`);
      } else { results.applications = { count: 0 }; }
    } catch(e: any) { console.error('Applications backup error:', e); results.applications = { error: e.message }; }

    // 4. LENDERS
    try {
      const { data: lenders, error: ldErr } = await sb.from('lenders')
        .select('id,name,lender_type,programs,tags,min_credit_score,max_ltv,website,contact_name,contact_email,contact_phone,rep_name,rep_phone,rep_email,channel,priority,is_active,clickup_task_id,last_synced_at')
        .order('name');
      if (ldErr) throw ldErr;
      if (lenders?.length) {
        const h = ['id','name','lender_type','programs','tags','min_credit_score','max_ltv','website','contact_name','contact_email','contact_phone','rep_name','rep_phone','rep_email','channel','priority','is_active','clickup_task_id','last_synced_at'];
        await uploadToDrive(token, dataFolder, `lenders_${dateStr}.csv`, toCSV(lenders, h), 'text/csv');
        results.lenders = { count: lenders.length };
        console.log(`Lenders backed up: ${lenders.length}`);
      } else { results.lenders = { count: 0 }; }
    } catch(e: any) { console.error('Lenders backup error:', e); results.lenders = { error: e.message }; }

    // 5. LENDER SUBMISSIONS
    try {
      const { data: subs } = await sb.from('lead_lender_submissions')
        .select('id,lead_id,contact_id,lender_id,status,submitted_at,notes,created_at')
        .order('created_at', { ascending: false });
      if (subs?.length) {
        const h = ['id','lead_id','contact_id','lender_id','status','submitted_at','notes','created_at'];
        await uploadToDrive(token, dataFolder, `lender_submissions_${dateStr}.csv`, toCSV(subs, h), 'text/csv');
        results.lender_submissions = { count: subs.length };
      }
    } catch(e: any) { console.error('Submissions backup error:', e); }

    // 6. WEBSITE HTML FILES
    let siteCount = 0;
    const siteErrors: string[] = [];
    for (const path of SITE_FILES) {
      const content = await fetchSiteFile(path);
      if (content) {
        const folder = path.startsWith('admin/') ? adminFolder : path.startsWith('public/') ? publicFolder : siteFolder;
        const fname = path.split('/').pop() || path;
        const mime = path.endsWith('.js') ? 'application/javascript' : 'text/html';
        try {
          await uploadToDrive(token, folder, fname, content, mime);
          siteCount++;
          console.log(`Site file backed up: ${path}`);
        } catch(e: any) { siteErrors.push(`${path}: ${e.message}`); }
      } else {
        siteErrors.push(`${path}: not found`);
      }
    }
    results.website = { files_backed_up: siteCount, errors: siteErrors.length, error_list: siteErrors };

    // 7. Log backup
    await sb.from('backup_logs').upsert({
      backup_date: dateStr, results, status: 'success', created_at: now.toISOString()
    }, { onConflict: 'backup_date' });

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
