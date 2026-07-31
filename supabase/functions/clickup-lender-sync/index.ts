import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
};

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const CU_TOKEN = Deno.env.get('CLICKUP_API_TOKEN')!;
const CU_BASE = 'https://api.clickup.com/api/v2';
const cuHeaders = { 'Authorization': CU_TOKEN, 'Content-Type': 'application/json' };

const ok  = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Field ID map — same IDs across all 4 lender lists
const FIELD_IDS: Record<string, string> = {
  website:              'ba278e9c-0ac2-4c5b-ad53-ea70049913ed',
  lender_portal:        '64ce698b-bb66-4352-b9e6-f7d06798c236',
  nmlsr_id:             '335ea276-af4f-4b59-a61e-a33cebc65c1d',
  channel:              'acb01a2d-75f0-436d-a277-3748c91624f7',
  min_credit_score:     'd79c5e87-2539-4c18-afa0-b5f19e40f8bd',
  loan_types:           '9292d05c-65ab-4978-bf19-00df9fd77bc0',
  loan_programs:        'a691eb77-3b27-48c6-b76a-5716d5405ec4',
  specialty_notes:      '62b8cc65-6222-4764-b725-6ace689a7dd3',
  key_overlays:         '58a7216d-4f94-47b8-9088-de141aee797f',
  contact_name:         '281273a4-f4ff-42fd-8561-453f37865235',
  contact_email:        '07d6bfda-c204-4fca-b56c-3ddc07b0e862',
  contact_phone:        'c394c988-19c4-4652-b7f2-c1e4f73af049',
  product_specialist:   'ef2cc037-caf2-4282-b4cc-297b7eb5efc0',
  ps_email:             'd4c11664-c459-4e25-8c1f-623554d736e1',
  lock_desk_email:      'df2a6137-31dc-46b8-a853-c3b346aeb95a',
  submission_email:     '13c95f0a-cf81-44f8-9a5b-000546c007f4',
  conditions_email:     '8fa38f87-6a46-4aeb-8def-d18440cb4e4f',
  underwriting_email:   '04278856-b817-4d90-a244-483ad1a12ed1',
  closing_email:        '0f1fd30a-efa6-42a8-92eb-2c8ca2eec099',
  funding_email:        '1e9481ea-3e6d-4d3b-9779-bd0f1a096a91',
  revenue_notes:        'a5a02fe7-df98-4fd0-ab3d-8064181bedbd',
  compensation_bps:     '0776a7cb-aa18-4054-a2a4-ed491d793e1d',
  fee_notes:            '91ab1f90-fc9c-4638-b045-3b24ca69449c',
  rating:               '998e24e2-b46e-4b4f-ab15-294b73b6da89',
  is_preferred:         '9b2bb6de-5790-488e-97d3-5b8dcbcc89b8',
  avg_app_to_fund:      '96b06097-3dea-48aa-a1f5-8eb8958974a5',
  submission_count:     '348eb18c-fc47-41a0-8d69-eb22f9a3a0f3',
  cpl_clause:           '241b5d77-f682-430a-898a-f27d79c32314',
  mortgagee_clause:     'b7d03f64-c023-4dd7-8057-b1e8f15c8d83',
  broker_id:            '4c1bbaa7-710a-4f45-879a-275000e3f21c',
  scenario_notes:       '9e21cac8-bc18-4060-8893-765562a78377',
  last_crm_sync:        'd0a5efff-9eae-4b56-929b-9c4cfdf3723c',
};

async function setField(taskId: string, fieldId: string, value: any): Promise<void> {
  await fetch(`${CU_BASE}/task/${taskId}/field/${fieldId}`, {
    method: 'POST', headers: cuHeaders,
    body: JSON.stringify({ value })
  });
}

async function updateDescription(taskId: string, desc: string): Promise<void> {
  await fetch(`${CU_BASE}/task/${taskId}`, {
    method: 'PUT', headers: cuHeaders,
    body: JSON.stringify({ description: desc })
  });
}

function buildDesc(l: any): string {
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
  const lt = Array.isArray(l.loan_types) ? l.loan_types.join(', ') : l.loan_types;
  if (lt) lines.push(`\n💳 Loan Types: ${lt}`);
  const lp = Array.isArray(l.loan_programs) ? l.loan_programs.join(', ') : l.loan_programs;
  if (lp) lines.push(`📋 Programs: ${lp}`);
  if (l.specialty_notes) lines.push(`🎯 Specialty: ${l.specialty_notes}`);
  if (l.key_overlays) lines.push(`\n⚠️ Key Overlays:\n${l.key_overlays}`);
  lines.push(`\n👤 Account Executive`);
  if (l.contact_name) lines.push(`Name: ${l.contact_name}`);
  if (l.contact_email) lines.push(`Email: ${l.contact_email}`);
  if (l.contact_phone) lines.push(`Phone: ${l.contact_phone}`);
  if (l.product_specialist_name || l.product_specialist_email) {
    lines.push(`\n👤 Product Specialist`);
    if (l.product_specialist_name) lines.push(`Name: ${l.product_specialist_name}`);
    if (l.product_specialist_email) lines.push(`Email: ${l.product_specialist_email}`);
  }
  const depts = [l.lock_desk_email&&`Lock Desk: ${l.lock_desk_email}`,l.submission_email&&`Submissions: ${l.submission_email}`,l.conditions_email&&`Conditions: ${l.conditions_email}`,l.underwriting_email&&`Underwriting: ${l.underwriting_email}`,l.closing_email&&`Closing: ${l.closing_email}`,l.funding_email&&`Funding: ${l.funding_email}`].filter(Boolean);
  if (depts.length) { lines.push(`\n📧 Department Contacts`); depts.forEach(d=>lines.push(d as string)); }
  lines.push(`\n💰 Compensation`);
  if (l.compensation_type) lines.push(`Type: ${l.compensation_type}`);
  if (l.compensation_bps) lines.push(`BPS: ${l.compensation_bps}`);
  if (l.revenue_notes) lines.push(l.revenue_notes);
  if (l.fee_notes) { lines.push(`\n🧾 Fees`); lines.push(l.fee_notes); }
  if (l.key_overlays) { lines.push(`\n⚠️ Key Overlays`); lines.push(l.key_overlays); }
  if (l.cpl_clause||l.mortgagee_clause||l.broker_id) {
    lines.push(`\n📄 Clauses & IDs`);
    if (l.cpl_clause) lines.push(`CPL: ${l.cpl_clause}`);
    if (l.mortgagee_clause) lines.push(`Mortgagee: ${l.mortgagee_clause}`);
    if (l.broker_id) lines.push(`Broker ID: ${l.broker_id}`);
  }
  if (l.scenario_notes||l.notes) { lines.push(`\n📝 Notes`); if(l.scenario_notes)lines.push(l.scenario_notes); if(l.notes)lines.push(l.notes); }
  lines.push(`\n🔄 CRM Sync: ${new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'})}`);
  return lines.join('\n');
}

async function syncOne(l: any): Promise<{success:boolean;fields:number;error?:string}> {
  if (!l.clickup_task_id) return {success:false,fields:0,error:'No task ID'};
  try {
    await updateDescription(l.clickup_task_id, buildDesc(l));
    let fields = 0;
    const syncField = async (key: string, value: any) => {
      const id = FIELD_IDS[key];
      if (!id||value===null||value===undefined||value==='') return;
      await setField(l.clickup_task_id, id, value);
      fields++;
    };
    await syncField('website', l.website);
    await syncField('lender_portal', l.lender_portal);
    await syncField('nmlsr_id', l.nmlsr_id);
    await syncField('channel', l.channel);
    await syncField('min_credit_score', l.min_credit_score||null);
    await syncField('loan_types', Array.isArray(l.loan_types)?l.loan_types.join(', '):l.loan_types);
    await syncField('loan_programs', Array.isArray(l.loan_programs)?l.loan_programs.join(', '):l.loan_programs);
    await syncField('specialty_notes', l.specialty_notes);
    await syncField('key_overlays', l.key_overlays);
    await syncField('contact_name', l.contact_name);
    await syncField('contact_email', l.contact_email);
    await syncField('contact_phone', l.contact_phone);
    await syncField('product_specialist', l.product_specialist_name);
    await syncField('ps_email', l.product_specialist_email);
    await syncField('lock_desk_email', l.lock_desk_email);
    await syncField('submission_email', l.submission_email);
    await syncField('conditions_email', l.conditions_email);
    await syncField('underwriting_email', l.underwriting_email);
    await syncField('closing_email', l.closing_email);
    await syncField('funding_email', l.funding_email);
    await syncField('revenue_notes', l.revenue_notes);
    if (l.compensation_bps) await syncField('compensation_bps', parseFloat(l.compensation_bps));
    await syncField('fee_notes', l.fee_notes);
    if (l.rating) await syncField('rating', parseFloat(l.rating));
    await setField(l.clickup_task_id, FIELD_IDS.is_preferred, l.is_preferred||false); fields++;
    await syncField('avg_app_to_fund', l.avg_app_to_fund);
    if (l.submission_count) await syncField('submission_count', parseInt(l.submission_count));
    await syncField('cpl_clause', l.cpl_clause);
    await syncField('mortgagee_clause', l.mortgagee_clause);
    await syncField('broker_id', l.broker_id);
    await syncField('scenario_notes', l.scenario_notes);
    await setField(l.clickup_task_id, FIELD_IDS.last_crm_sync, new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'})); fields++;
    await sb.from('lenders').update({last_synced_at:new Date().toISOString()}).eq('id',l.id);
    return {success:true,fields};
  } catch(e:any) { return {success:false,fields:0,error:e.message}; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, {status:204,headers:cors});
  try {
    const body = await req.json();
    const { action, lender_id } = body;

    if ((action==='push_one'||action==='sync_one') && lender_id) {
      const {data:l} = await sb.from('lenders').select('*').eq('id',lender_id).single();
      if (!l) return err('Lender not found');
      const r = await syncOne(l);
      return ok({success:r.success,...r,lender:l.name});
    }

    if (action==='push_all') {
      const {data:lenders} = await sb.from('lenders').select('*').not('clickup_task_id','is',null);
      const results:any[] = [];
      let synced = 0;
      for (const l of (lenders||[])) {
        const r = await syncOne(l);
        if (r.success) synced++;
        results.push({name:l.name,success:r.success,fields:r.fields,error:r.error});
        await new Promise(res=>setTimeout(res,150)); // rate limit
      }
      return ok({success:true,synced,total:lenders?.length||0,results});
    }

    return err('Use action: push_one or push_all');
  } catch(e:any) { return err(e.message,500); }
});
