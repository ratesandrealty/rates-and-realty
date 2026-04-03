import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey' };
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');

function base64ToUint8Array(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.split(',')[1] : b64;
  const bin = atob(clean);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function uploadToStorage(fileBytes: Uint8Array, mimeType: string, fileName: string, contactId: string): Promise<{url: string, path: string} | null> {
  try {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${contactId}/${Date.now()}_${safeName}`;
    const { error } = await sb.storage.from('approval-letters').upload(path, fileBytes, {
      contentType: mimeType,
      upsert: true
    });
    if (error) { console.error('Storage upload error:', error); return null; }
    const { data: { publicUrl } } = sb.storage.from('approval-letters').getPublicUrl(path);
    return { url: publicUrl, path };
  } catch(e) {
    console.error('Storage upload exception:', e);
    return null;
  }
}

async function extractFromDoc(base64Data: string, mimeType: string): Promise<any> {
  const isPdf = mimeType === 'application/pdf';
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } };

  const prompt = `You are a mortgage loan processor reading a Conditional Loan Approval letter. These come from lenders like Newrez, AmWest, UWM, loanDepot, Pennymac, etc.

Extract ALL of the following information from the document header and body.

Common field locations by lender:
- Newrez: "Loan #", "Case #", "Date", "Est.Closing Date", "Partner", "Originator", "Rep Name", "CRM", "Underwriter" in header; then "Borrowers and Subject Property" section; then "General Loan Information" with Loan Program, LTV/CLTV, Loan Type, Base Loan Amount, Total Loan Amount, Qualifying Rate, DTI, Occupancy, Loan Purpose; then "Rate Lock Information"; then "Important Dates" with Initial Approval, Credit Report Exp, Approval Exp, Income Doc Exp, Assets Doc Exp
- AmWest: "Loan Number", "Loan Officer", "Processor" in Originator section; "Property Information"; "Borrower Information"; "Loan Information" with Loan Program, Mortgage Type, Loan Purpose, Note Rate, Qualifying Rate, Date Approved, Appraised Value, Base/Total Loan Amount, LTV, CLTV, Credit Score; "Document Expiration Dates"; "Lender Information" with Underwriter, Account Manager
- E Mortgage Capital / FHA: "Loan Number", "Borrower(s)", "Decision Date", "Approval Expires", "Estimated Close Date", "Originator", "Processor", "Median Score", "Underwriter"; "Loan Information" with Loan Program, Base Loan Amount, Interest Rate, Total Loan Amount, Loan Type, Purchase Price, Appraised Value, Occupancy, DTI; "Subject Property"

For each condition, determine which mortgage stage it belongs to:
- PTA (Prior to Approval): conditions that must be cleared before the loan can be approved — income verification, credit items, basic property requirements, borrower documentation
- PTCD (Prior to Closing Docs): conditions needed before closing documents can be drawn — title, HOA certs, insurance policies, appraisal sign-offs
- PTD (Prior to Docs): conditions needed before loan documents are prepared — final verifications, outstanding items, questionnaires
- PTF (Prior to Funding): conditions needed before wire/funding — final insurance proof, flood certs, executed docs, closing items, proof of payment

Return ONLY valid JSON, no other text:
{
  "loan_info": {
    "lender": "lending institution name",
    "loan_number": "loan or file number",
    "case_number": "case number if present",
    "borrower_name": "primary borrower full name",
    "co_borrower_name": "co-borrower name or null",
    "property_address": "full property address",
    "property_type": "e.g. Condominium, Single Family Residence",
    "loan_program": "e.g. Conforming Fixed 30, 30 FHA PLUS",
    "loan_type": "e.g. Conventional, FHA, VA",
    "loan_purpose": "Purchase or Refinance",
    "loan_amount": "base loan amount e.g. $322,500.00",
    "total_loan_amount": "total loan amount",
    "purchase_price": "purchase price or null",
    "appraised_value": "appraised value",
    "interest_rate": "note rate e.g. 6.990%",
    "qualifying_rate": "qualifying rate",
    "ltv": "LTV percentage",
    "cltv": "CLTV percentage",
    "dti": "DTI ratio",
    "credit_score": "qualifying/median credit score",
    "occupancy": "Primary Residence, Investment, or Second Home",
    "approval_date": "date approved",
    "expiration_date": "approval expiration date",
    "est_closing_date": "estimated closing date",
    "lock_status": "Locked or Unlocked",
    "lock_expiration": "lock expiration date",
    "credit_expiration": "credit report expiration date",
    "income_expiration": "income doc expiration date",
    "asset_expiration": "asset doc expiration date",
    "underwriter": "underwriter name",
    "underwriter_phone": "underwriter phone",
    "underwriter_email": "underwriter email",
    "processor": "processor name",
    "rep_name": "rep or account manager name",
    "rep_phone": "rep phone",
    "rep_email": "rep email",
    "originator": "loan officer name",
    "total_income": "total income if shown",
    "verified_assets": "verified assets if shown",
    "calculated_reserves": "calculated reserves if shown"
  },
  "conditions": [
    {
      "condition_text": "exact full condition text",
      "category": "Income|Assets|Property|Credit|Insurance|Title|Appraisal|Legal|Closing|Other",
      "stage": "PTA|PTCD|PTD|PTF",
      "condition_number": "number if shown",
      "priority": "high or normal"
    }
  ]
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5', max_tokens: 4000,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
    })
  });

  if (!res.ok) throw new Error('Claude API error: ' + await res.text());
  const data = await res.json();
  const text = data.content?.[0]?.text || '{"conditions":[]}';
  console.log('Claude response (first 400):', text.substring(0, 400));
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch(e) {
    console.error('JSON parse error:', e);
    return { conditions: [], loan_info: {} };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const { action } = body;

    if (action === 'extract') {
      const { file_base64, mime_type, file_name, contact_id } = body;
      if (!file_base64) return err('file_base64 required');
      if (!mime_type) return err('mime_type required');
      if (!contact_id) return err('contact_id required');

      const fileBytes = base64ToUint8Array(file_base64);
      const storageResult = await uploadToStorage(fileBytes, mime_type, file_name || 'approval.pdf', contact_id);

      const result = await extractFromDoc(file_base64, mime_type);
      const conditions = result.conditions || [];
      const loanInfo = result.loan_info || {};

      const { data: doc, error: docErr } = await sb.from('condition_documents').insert({
        contact_id,
        file_name: file_name || 'approval_letter',
        file_url: storageResult?.url || null,
        storage_path: storageResult?.path || null,
        extracted_at: new Date().toISOString(),
        condition_count: conditions.length,
        loan_info: loanInfo,
        lender: loanInfo.lender || null,
        loan_number: loanInfo.loan_number || null,
        borrower_name: loanInfo.borrower_name || null,
        expiration_date: loanInfo.expiration_date || null,
        property_address: loanInfo.property_address || null,
        loan_amount: loanInfo.loan_amount || null,
        loan_type: loanInfo.loan_type || null,
        interest_rate: loanInfo.interest_rate || null,
        approval_date: loanInfo.approval_date || null
      }).select('id, file_url').single();

      if (docErr || !doc?.id) return err('Failed to save document: ' + (docErr?.message || 'no id'), 500);

      let saved = 0;
      if (conditions.length > 0) {
        const rows = conditions.map((c: any, i: number) => ({
          contact_id, document_id: doc.id,
          condition_text: c.condition_text,
          category: c.category || 'Other',
          stage: c.stage || 'PTA',
          status: 'pending', sort_order: i,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }));
        for (let i = 0; i < rows.length; i += 10) {
          const { error: batchErr } = await sb.from('loan_conditions').insert(rows.slice(i, i + 10));
          if (batchErr) return err('Failed to save conditions: ' + batchErr.message, 500);
          saved += Math.min(10, rows.length - i);
        }
      }

      return ok({ success: true, document_id: doc.id, file_url: doc.file_url, conditions_found: conditions.length, conditions_saved: saved, loan_info: loanInfo, conditions });
    }

    if (action === 'get_conditions') {
      const { contact_id } = body;
      if (!contact_id) return err('contact_id required');
      const { data, error } = await sb.from('loan_conditions')
        .select('*, condition_documents(id,file_name,file_url,storage_path,extracted_at,loan_info,lender,loan_number,borrower_name,property_address,loan_amount,loan_type,interest_rate,approval_date,expiration_date)')
        .eq('contact_id', contact_id).order('sort_order');
      if (error) return err(error.message, 500);
      return ok({ conditions: data || [] });
    }

    if (action === 'get_notes') {
      const { condition_id } = body;
      if (!condition_id) return err('condition_id required');
      const { data, error } = await sb.from('condition_notes').select('*').eq('condition_id', condition_id).order('created_at', { ascending: false });
      if (error) return err(error.message, 500);
      return ok({ notes: data || [] });
    }

    if (action === 'add_note') {
      const { condition_id, contact_id, note_text, created_by } = body;
      if (!condition_id || !note_text) return err('condition_id and note_text required');
      const { data, error } = await sb.from('condition_notes').insert({ condition_id, contact_id: contact_id || null, note_text, created_by: created_by || 'Rene', created_at: new Date().toISOString() }).select().single();
      if (error) return err(error.message, 500);
      return ok({ success: true, note: data });
    }

    if (action === 'update_condition') {
      const { condition_id, status, notes, cleared_by } = body;
      if (!condition_id) return err('condition_id required');
      const update: any = { updated_at: new Date().toISOString() };
      if (status !== undefined) update.status = status;
      if (notes !== undefined) update.notes = notes;
      if (status === 'cleared') { update.cleared_at = new Date().toISOString(); update.cleared_by = cleared_by || 'Rene'; }
      else if (status && status !== 'cleared') { update.cleared_at = null; update.cleared_by = null; }
      const { error } = await sb.from('loan_conditions').update(update).eq('id', condition_id);
      if (error) return err(error.message, 500);
      return ok({ success: true });
    }

    if (action === 'clear_conditions') {
      const { contact_id, document_id } = body;
      if (document_id) {
        await sb.from('loan_conditions').delete().eq('document_id', document_id);
        await sb.from('condition_documents').delete().eq('id', document_id);
      } else if (contact_id) {
        await sb.from('loan_conditions').delete().eq('contact_id', contact_id);
        await sb.from('condition_documents').delete().eq('contact_id', contact_id);
      } else return err('contact_id or document_id required');
      return ok({ success: true });
    }

    if (action === 'get_documents') {
      const { contact_id } = body;
      if (!contact_id) return err('contact_id required');
      const { data } = await sb.from('condition_documents').select('*').eq('contact_id', contact_id).order('created_at', { ascending: false });
      return ok({ documents: data || [] });
    }

    return err('Unknown action');
  } catch(e: any) {
    console.error('extract-conditions error:', e);
    return err(e.message || 'Server error', 500);
  }
});
