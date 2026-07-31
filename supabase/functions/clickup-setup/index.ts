import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const CU_TOKEN = Deno.env.get('CLICKUP_API_TOKEN')!;
const CU_BASE = 'https://api.clickup.com/api/v2';
const H = { 'Authorization': CU_TOKEN, 'Content-Type': 'application/json' };

const FIELDS: Record<string,string> = {
  website:'ba278e9c-0ac2-4c5b-ad53-ea70049913ed',
  lender_portal:'64ce698b-bb66-4352-b9e6-f7d06798c236',
  nmlsr_id:'335ea276-af4f-4b59-a61e-a33cebc65c1d',
  channel:'acb01a2d-75f0-436d-a277-3748c91624f7',
  min_credit_score:'d79c5e87-2539-4c18-afa0-b5f19e40f8bd',
  loan_types:'9292d05c-65ab-4978-bf19-00df9fd77bc0',
  loan_programs:'a691eb77-3b27-48c6-b76a-5716d5405ec4',
  specialty_notes:'62b8cc65-6222-4764-b725-6ace689a7dd3',
  key_overlays:'58a7216d-4f94-47b8-9088-de141aee797f',
  contact_name:'281273a4-f4ff-42fd-8561-453f37865235',
  contact_email:'07d6bfda-c204-4fca-b56c-3ddc07b0e862',
  contact_phone:'c394c988-19c4-4652-b7f2-c1e4f73af049',
  product_specialist:'ef2cc037-caf2-4282-b4cc-297b7eb5efc0',
  ps_email:'d4c11664-c459-4e25-8c1f-623554d736e1',
  lock_desk_email:'df2a6137-31dc-46b8-a853-c3b346aeb95a',
  submission_email:'13c95f0a-cf81-44f8-9a5b-000546c007f4',
  conditions_email:'8fa38f87-6a46-4aeb-8def-d18440cb4e4f',
  underwriting_email:'04278856-b817-4d90-a244-483ad1a12ed1',
  closing_email:'0f1fd30a-efa6-42a8-92eb-2c8ca2eec099',
  funding_email:'1e9481ea-3e6d-4d3b-9779-bd0f1a096a91',
  revenue_notes:'a5a02fe7-df98-4fd0-ab3d-8064181bedbd',
  compensation_bps:'0776a7cb-aa18-4054-a2a4-ed491d793e1d',
  fee_notes:'91ab1f90-fc9c-4638-b045-3b24ca69449c',
  rating:'998e24e2-b46e-4b4f-ab15-294b73b6da89',
  is_preferred:'9b2bb6de-5790-488e-97d3-5b8dcbcc89b8',
  avg_app_to_fund:'96b06097-3dea-48aa-a1f5-8eb8958974a5',
  submission_count:'348eb18c-fc47-41a0-8d69-eb22f9a3a0f3',
  cpl_clause:'241b5d77-f682-430a-898a-f27d79c32314',
  mortgagee_clause:'b7d03f64-c023-4dd7-8057-b1e8f15c8d83',
  broker_id:'4c1bbaa7-710a-4f45-879a-275000e3f21c',
  scenario_notes:'9e21cac8-bc18-4060-8893-765562a78377',
  last_crm_sync:'d0a5efff-9eae-4b56-929b-9c4cfdf3723c',
};

async function setField(taskId:string, fieldId:string, value:any) {
  await fetch(`${CU_BASE}/task/${taskId}/field/${fieldId}`,{method:'POST',headers:H,body:JSON.stringify({value})});
}

async function setDesc(taskId:string, l:any) {
  const lt = Array.isArray(l.loan_types)?l.loan_types.join(', '):l.loan_types||'';
  const lp = Array.isArray(l.loan_programs)?l.loan_programs.join(', '):l.loan_programs||'';
  const lines = [`🏦 ${l.name}`,``];
  if(l.website) lines.push(`🌐 Website: ${l.website}`);
  if(l.lender_portal) lines.push(`🔗 Portal: ${l.lender_portal}`);
  if(l.nmlsr_id) lines.push(`🪪 NMLS: ${l.nmlsr_id}`);
  if(l.channel) lines.push(`📡 Channel: ${l.channel}`);
  if(l.min_credit_score) lines.push(`📊 Min Credit: ${l.min_credit_score}`);
  if(l.avg_app_to_fund) lines.push(`⏱️ Avg Fund: ${l.avg_app_to_fund}`);
  if(l.rating) lines.push(`⭐ Rating: ${l.rating}`);
  if(l.is_preferred) lines.push(`✅ Preferred Lender`);
  if(l.submission_count) lines.push(`📁 Submissions: ${l.submission_count}`);
  if(lt) lines.push(`\n💳 Loan Types: ${lt}`);
  if(lp) lines.push(`📋 Programs: ${lp}`);
  if(l.specialty_notes) lines.push(`🎯 Specialty: ${l.specialty_notes}`);
  if(l.key_overlays) lines.push(`\n⚠️ Key Overlays:\n${l.key_overlays}`);
  lines.push(`\n👤 Account Executive`);
  if(l.contact_name) lines.push(`Name: ${l.contact_name}`);
  if(l.contact_email) lines.push(`Email: ${l.contact_email}`);
  if(l.contact_phone) lines.push(`Phone: ${l.contact_phone}`);
  const depts=[l.lock_desk_email&&`Lock Desk: ${l.lock_desk_email}`,l.submission_email&&`Submissions: ${l.submission_email}`,l.conditions_email&&`Conditions: ${l.conditions_email}`,l.underwriting_email&&`Underwriting: ${l.underwriting_email}`,l.closing_email&&`Closing: ${l.closing_email}`,l.funding_email&&`Funding: ${l.funding_email}`].filter(Boolean);
  if(depts.length){lines.push(`\n📧 Department Contacts`);depts.forEach(d=>lines.push(d as string));}
  lines.push(`\n💰 Compensation`);
  if(l.revenue_notes) lines.push(l.revenue_notes);
  if(l.fee_notes){lines.push(`\n🧾 Fees`);lines.push(l.fee_notes);}
  if(l.cpl_clause||l.mortgagee_clause||l.broker_id){lines.push(`\n📄 Clauses`);if(l.cpl_clause)lines.push(`CPL: ${l.cpl_clause}`);if(l.mortgagee_clause)lines.push(`Mortgagee: ${l.mortgagee_clause}`);if(l.broker_id)lines.push(`Broker ID: ${l.broker_id}`);}
  if(l.scenario_notes){lines.push(`\n📝 Notes`);lines.push(l.scenario_notes);}
  lines.push(`\n🔄 CRM Sync: ${new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'})}`);
  await fetch(`${CU_BASE}/task/${taskId}`,{method:'PUT',headers:H,body:JSON.stringify({description:lines.join('\n')})});
}

async function syncLender(l:any):Promise<{ok:boolean,fields:number}> {
  if(!l.clickup_task_id) return {ok:false,fields:0};
  try {
    await setDesc(l.clickup_task_id, l);
    const sf = async(k:string,v:any)=>{ if(v!==null&&v!==undefined&&v!=='') await setField(l.clickup_task_id,FIELDS[k],v); };
    const lt=Array.isArray(l.loan_types)?l.loan_types.join(', '):l.loan_types||'';
    const lp=Array.isArray(l.loan_programs)?l.loan_programs.join(', '):l.loan_programs||'';
    await sf('website',l.website); await sf('lender_portal',l.lender_portal);
    await sf('nmlsr_id',l.nmlsr_id); await sf('channel',l.channel);
    if(l.min_credit_score) await sf('min_credit_score',l.min_credit_score);
    await sf('loan_types',lt); await sf('loan_programs',lp);
    await sf('specialty_notes',l.specialty_notes); await sf('key_overlays',l.key_overlays);
    await sf('contact_name',l.contact_name); await sf('contact_email',l.contact_email); await sf('contact_phone',l.contact_phone);
    await sf('product_specialist',l.product_specialist_name); await sf('ps_email',l.product_specialist_email);
    await sf('lock_desk_email',l.lock_desk_email); await sf('submission_email',l.submission_email);
    await sf('conditions_email',l.conditions_email); await sf('underwriting_email',l.underwriting_email);
    await sf('closing_email',l.closing_email); await sf('funding_email',l.funding_email);
    await sf('revenue_notes',l.revenue_notes); await sf('fee_notes',l.fee_notes);
    if(l.compensation_bps) await sf('compensation_bps',parseFloat(l.compensation_bps));
    if(l.rating) await sf('rating',parseFloat(l.rating));
    await setField(l.clickup_task_id,FIELDS.is_preferred,l.is_preferred||false);
    await sf('avg_app_to_fund',l.avg_app_to_fund);
    if(l.submission_count) await sf('submission_count',parseInt(l.submission_count));
    await sf('cpl_clause',l.cpl_clause); await sf('mortgagee_clause',l.mortgagee_clause); await sf('broker_id',l.broker_id); await sf('scenario_notes',l.scenario_notes);
    await setField(l.clickup_task_id,FIELDS.last_crm_sync,new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));
    await sb.from('lenders').update({last_synced_at:new Date().toISOString()}).eq('id',l.id);
    return {ok:true,fields:20};
  } catch(e:any){return {ok:false,fields:0};}
}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  
  // GET request = trigger full bulk sync
  const {data:lenders} = await sb.from('lenders').select('*').not('clickup_task_id','is',null);
  const results:any[]=[];
  let synced=0, failed=0;
  
  for(const l of (lenders||[])) {
    const r = await syncLender(l);
    if(r.ok) synced++; else failed++;
    results.push({name:l.name,ok:r.ok});
    await new Promise(res=>setTimeout(res,120)); // rate limit
  }
  
  return new Response(JSON.stringify({success:true,synced,failed,total:lenders?.length||0,results},null,2),
    {headers:{...cors,'Content-Type':'application/json'}});
});
