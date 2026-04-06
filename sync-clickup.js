const https = require('https');

const CU_TOKEN = 'PASTE_YOUR_CLICKUP_TOKEN_HERE'; // paste your pk_60118... token

const FIELD_IDS = {
  website: 'ba278e9c-0ac2-4c5b-ad53-ea70049913ed',
  lender_portal: '64ce698b-bb66-4352-b9e6-f7d06798c236',
  nmlsr_id: '335ea276-af4f-4b59-a61e-a33cebc65c1d',
  channel: 'acb01a2d-75f0-436d-a277-3748c91624f7',
  min_credit_score: 'd79c5e87-2539-4c18-afa0-b5f19e40f8bd',
  loan_types: '9292d05c-65ab-4978-bf19-00df9fd77bc0',
  loan_programs: 'a691eb77-3b27-48c6-b76a-5716d5405ec4',
  specialty_notes: '62b8cc65-6222-4764-b725-6ace689a7dd3',
  contact_name: '281273a4-f4ff-42fd-8561-453f37865235',
  contact_email: '07d6bfda-c204-4fca-b56c-3ddc07b0e862',
  contact_phone: 'c394c988-19c4-4652-b7f2-c1e4f73af049',
  revenue_notes: 'a5a02fe7-df98-4fd0-ab3d-8064181bedbd',
  compensation_bps: '0776a7cb-aa18-4054-a2a4-ed491d793e1d',
  fee_notes: '91ab1f90-fc9c-4638-b045-3b24ca69449c',
  rating: '998e24e2-b46e-4b4f-ab15-294b73b6da89',
  is_preferred: '9b2bb6de-5790-488e-97d3-5b8dcbcc89b8',
  avg_app_to_fund: '96b06097-3dea-48aa-a1f5-8eb8958974a5',
  submission_count: '348eb18c-fc47-41a0-8d69-eb22f9a3a0f3',
  last_crm_sync: 'd0a5efff-9eae-4b56-929b-9c4cfdf3723c',
};

const SUPABASE_URL = 'https://ljywhvbmsibwnssxpesh.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqeXdodmJtc2lid25zc3hwZXNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxNjM3NjIsImV4cCI6MjA4OTczOTc2Mn0.ry5pFEnhCKVdqhTTHIPnGt0_IU9T8S6v8IfbdWuXCRo';

function cuRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.clickup.com',
      path: `/api/v2${path}`,
      method,
      headers: {
        'Authorization': CU_TOKEN,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sbRequest(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'ljywhvbmsibwnssxpesh.supabase.co',
      path,
      method: 'GET',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve([]); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function setField(taskId, fieldId, value) {
  await cuRequest('POST', `/task/${taskId}/field/${fieldId}`, { value });
}

function buildDesc(l) {
  const lt = Array.isArray(l.loan_types) ? l.loan_types.join(', ') : l.loan_types || '';
  const lp = Array.isArray(l.loan_programs) ? l.loan_programs.join(', ') : l.loan_programs || '';
  const lines = [`🏦 ${l.name}`, ''];
  if (l.website) lines.push(`🌐 Website: ${l.website}`);
  if (l.lender_portal) lines.push(`🔗 Portal: ${l.lender_portal}`);
  if (l.nmlsr_id) lines.push(`🪪 NMLS: ${l.nmlsr_id}`);
  if (l.channel) lines.push(`📡 Channel: ${l.channel}`);
  if (l.min_credit_score) lines.push(`📊 Min Credit: ${l.min_credit_score}`);
  if (l.avg_app_to_fund) lines.push(`⏱️ Avg Fund: ${l.avg_app_to_fund}`);
  if (l.rating) lines.push(`⭐ Rating: ${l.rating}`);
  if (l.is_preferred) lines.push(`✅ Preferred Lender`);
  if (l.submission_count) lines.push(`📁 Submissions: ${l.submission_count}`);
  if (lt) lines.push(`\n💳 Loan Types: ${lt}`);
  if (lp) lines.push(`📋 Programs: ${lp}`);
  if (l.specialty_notes) lines.push(`🎯 Specialty: ${l.specialty_notes}`);
  lines.push(`\n👤 Account Executive`);
  if (l.contact_name) lines.push(`Name: ${l.contact_name}`);
  if (l.contact_email) lines.push(`Email: ${l.contact_email}`);
  if (l.contact_phone) lines.push(`Phone: ${l.contact_phone}`);
  lines.push(`\n💰 Compensation`);
  if (l.revenue_notes) lines.push(l.revenue_notes);
  if (l.fee_notes) { lines.push(`\n🧾 Fees`); lines.push(l.fee_notes); }
  if (l.key_overlays) { lines.push(`\n⚠️ Key Overlays`); lines.push(l.key_overlays); }
  lines.push(`\n🔄 CRM Sync: ${new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'})}`);
  return lines.join('\n');
}

async function syncLender(l) {
  if (!l.clickup_task_id) return false;
  try {
    // Update description
    await cuRequest('PUT', `/task/${l.clickup_task_id}`, { description: buildDesc(l) });
    await sleep(50);

    // Set all custom fields
    const sf = async (key, val) => {
      if (val !== null && val !== undefined && val !== '' && FIELD_IDS[key]) {
        await setField(l.clickup_task_id, FIELD_IDS[key], val);
        await sleep(50);
      }
    };

    const lt = Array.isArray(l.loan_types) ? l.loan_types.join(', ') : l.loan_types || '';
    const lp = Array.isArray(l.loan_programs) ? l.loan_programs.join(', ') : l.loan_programs || '';

    await sf('website', l.website);
    await sf('lender_portal', l.lender_portal);
    await sf('nmlsr_id', l.nmlsr_id);
    await sf('channel', l.channel);
    if (l.min_credit_score) await sf('min_credit_score', l.min_credit_score);
    await sf('loan_types', lt);
    await sf('loan_programs', lp);
    await sf('specialty_notes', l.specialty_notes);
    await sf('contact_name', l.contact_name);
    await sf('contact_email', l.contact_email);
    await sf('contact_phone', l.contact_phone);
    await sf('revenue_notes', l.revenue_notes);
    if (l.compensation_bps) await sf('compensation_bps', parseFloat(l.compensation_bps));
    await sf('fee_notes', l.fee_notes);
    if (l.rating) await sf('rating', parseFloat(l.rating));
    await setField(l.clickup_task_id, FIELD_IDS.is_preferred, !!l.is_preferred);
    await sf('avg_app_to_fund', l.avg_app_to_fund);
    if (l.submission_count) await sf('submission_count', parseInt(l.submission_count));
    await setField(l.clickup_task_id, FIELD_IDS.last_crm_sync, new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));

    return true;
  } catch(e) {
    return false;
  }
}

async function main() {
  console.log('Fetching lenders from Supabase...');
  const lenders = await sbRequest('/rest/v1/lenders?select=*&clickup_task_id=not.is.null&order=name');
  console.log(`Found ${lenders.length} lenders with ClickUp task IDs`);

  let synced = 0, failed = 0;
  for (let i = 0; i < lenders.length; i++) {
    const l = lenders[i];
    process.stdout.write(`[${i+1}/${lenders.length}] ${l.name.substring(0,40).padEnd(40)} `);
    const ok = await syncLender(l);
    if (ok) { synced++; console.log('✅'); }
    else { failed++; console.log('❌'); }
    await sleep(200); // rate limit between lenders
  }

  console.log(`\n✅ Done! Synced: ${synced} | Failed: ${failed} | Total: ${lenders.length}`);
}

main().catch(console.error);
