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

// Parse channel string into array
function parseChannel(ch: string|null|undefined): string[] {
  if (!ch) return [];
  return ch.split(';').map((s:string) => s.trim()).filter(Boolean);
}

// Parse loan types string into array
function parseLoanTypes(lt: string|null|undefined): string[] {
  if (!lt) return [];
  return lt.split(';').map((s:string) => s.trim()).filter(Boolean);
}

// Parse loan programs string into array
function parseLoanPrograms(lp: string|null|undefined): string[] {
  if (!lp) return [];
  return lp.split(';').map((s:string) => s.trim()).filter(Boolean);
}

// Normalize lender name for matching
function normName(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

// Map EMC Flow record to Supabase lender fields
function mapEmcToLender(emc: any): Record<string,any> {
  const ae = emc.Primary_Account_Executive__r || {};
  const loanTypes = parseLoanTypes(emc.Loan_Types_Offered__c);
  const loanPrograms = parseLoanPrograms(emc.Loan_Programs_Offered__c);
  const channels = parseChannel(emc.Channel__c);

  // Build specialty notes from programs
  const specialtyNotes = loanPrograms.length > 0
    ? loanPrograms.join(', ')
    : null;

  // Determine preferred status
  const isPreferred = !!emc.Preferred_Lender__c;

  // Rating
  const rating = emc.Rating__c ? parseFloat(emc.Rating__c) : null;

  // App to fund
  const avgAppToFund = emc.App_to_Funded__c ? String(emc.App_to_Funded__c) + ' days' : null;

  return {
    // Core identity
    name: emc.Name,
    nmlsr_id: emc.NMLS__c || null,
    is_preferred: isPreferred,
    rating: rating,

    // Channel & loan types
    channel: channels.length === 1 ? channels[0] : (channels.join(', ') || null),
    loan_types: loanTypes,
    loan_programs: loanPrograms,
    specialty_notes: specialtyNotes,

    // AE contact info
    contact_name: ae.Name || null,
    contact_email: ae.Email || null,
    contact_phone: ae.OfficePhone__c || null,

    // Portal & website
    lender_portal: emc.Lender_Portal__c || null,
    website: emc.Lender_Portal__c || null, // use portal as website if no separate website
    logo_url: emc.Icon_URL__c || null,

    // Credit & LTV
    min_credit_score: emc.Min_Score__c ? Math.round(parseFloat(emc.Min_Score__c)) : null,
    min_credit: emc.Min_Score__c ? Math.round(parseFloat(emc.Min_Score__c)) : null,

    // Revenue & fees
    revenue_notes: emc.Revenue_Notes__c || null,
    fee_notes: emc.Fee_Notes__c || null,
    compensation_type: (() => {
      const r = (emc.Revenue_Notes__c || '').toLowerCase();
      if (r.includes('bpc only')) return 'BPC Only';
      if (r.includes('lpc only')) return 'LPC Only';
      if (r.includes('lpc/bpc') || r.includes('lpc or bpc')) return 'LPC/BPC';
      if (r.includes('lpc') && r.includes('bpc')) return 'LPC/BPC';
      if (r.includes('lpc')) return 'LPC';
      if (r.includes('bpc')) return 'BPC Only';
      if (r.includes('referral')) return 'Referral';
      if (r.includes('commercial')) return 'Commercial';
      return null;
    })(),
    compensation_bps: (() => {
      const m = (emc.Revenue_Notes__c || '').match(/(\d+\.?\d*)%/);
      if (m) return Math.round(parseFloat(m[1]) * 100); // e.g. 2.25% → 225 bps
      return null;
    })(),

    // Performance metrics
    avg_app_to_fund: avgAppToFund,
    submission_count: emc.Count_App_to_Funded__c ? parseInt(emc.Count_App_to_Funded__c) : null,

    // Status
    status: 'active',
    is_favorite: isPreferred,
    lender_type: (() => {
      if (loanTypes.includes('Commercial') || loanTypes.includes('SBA')) return 'commercial';
      if (loanTypes.includes('Hard Money')) return 'hard_money';
      if (loanTypes.includes('Non-QM') && loanTypes.length <= 2) return 'non_qm';
      if (loanTypes.includes('Reverse')) return 'reverse';
      if (channels.includes('Correspondent') && channels.includes('Wholesale')) return 'both';
      if (channels.includes('Correspondent')) return 'correspondent';
      if (channels.includes('Wholesale')) return 'wholesale';
      return 'wholesale';
    })(),

    updated_at: new Date().toISOString(),
  };
}

// Push lender data to ClickUp task
async function pushToClickUp(taskId: string, lender: any, emcData: any) {
  if (!taskId || !CU_TOKEN) return { success: false, reason: 'no task id or token' };
  try {
    const ae = emcData.Primary_Account_Executive__r || {};
    const desc = [
      emcData.Revenue_Notes__c ? `Comp: ${emcData.Revenue_Notes__c}` : '',
      emcData.Fee_Notes__c ? `Fees: ${emcData.Fee_Notes__c}` : '',
      emcData.Loan_Programs_Offered__c ? `Programs: ${emcData.Loan_Programs_Offered__c}` : '',
      ae.Email ? `AE Email: ${ae.Email}` : '',
      ae.OfficePhone__c ? `AE Phone: ${ae.OfficePhone__c}` : '',
    ].filter(Boolean).join('\n');

    await fetch(`${CU_BASE}/task/${taskId}`, {
      method: 'PUT',
      headers: cuHeaders,
      body: JSON.stringify({ description: desc })
    });

    // Get task custom fields
    const taskRes = await fetch(`${CU_BASE}/task/${taskId}?include_subtasks=false`, { headers: cuHeaders });
    const task = await taskRes.json();
    const cfs: any[] = task.custom_fields || [];

    const FIELD_MAP: Record<string, string> = {
      'AE Name': ae.Name || '',
      'AE Email': ae.Email || '',
      'AE Phone': ae.OfficePhone__c || '',
      'Website': emcData.Lender_Portal__c || '',
      'Lender Portal': emcData.Lender_Portal__c || '',
      'Min Credit': emcData.Min_Score__c ? String(Math.round(parseFloat(emcData.Min_Score__c))) : '',
      'Channel': emcData.Channel__c || '',
      'Loan Types': emcData.Loan_Types_Offered__c || '',
      'Specialty Programs': emcData.Loan_Programs_Offered__c || '',
      'Revenue Notes': emcData.Revenue_Notes__c || '',
      'Fee Notes': emcData.Fee_Notes__c || '',
      'NMLS': emcData.NMLS__c || '',
      'Specialty Notes': emcData.Loan_Programs_Offered__c || '',
    };

    for (const cf of cfs) {
      const val = FIELD_MAP[cf.name];
      if (!val) continue;
      await fetch(`${CU_BASE}/task/${taskId}/field/${cf.id}`, {
        method: 'POST',
        headers: cuHeaders,
        body: JSON.stringify({ value: val })
      }).catch(() => null);
    }

    return { success: true };
  } catch (e: any) {
    return { success: false, reason: e.message };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok  = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const { action, emc_data, sync_clickup = false, batch_size = 20 } = body;

    if (action !== 'import_emc') return err('Use action: import_emc');
    if (!Array.isArray(emc_data) || emc_data.length === 0) return err('emc_data array required');

    // Load all existing lenders for name-matching
    const { data: existing } = await sb.from('lenders').select('id, name, clickup_task_id, nmlsr_id');
    const existingMap: Record<string, any> = {};
    const nmslMap: Record<string, any> = {};
    for (const l of (existing || [])) {
      existingMap[normName(l.name)] = l;
      if (l.nmlsr_id) nmslMap[String(l.nmlsr_id)] = l;
    }

    const results: any[] = [];
    let inserted = 0; let updated = 0; let clickupSynced = 0;

    // Process in batches to avoid timeouts
    const batch = emc_data.slice(0, batch_size);

    for (const emc of batch) {
      if (!emc.Name) continue;
      const mapped = mapEmcToLender(emc);
      const normN = normName(emc.Name);

      // Try to find existing record by name or NMLS
      let existing_record = existingMap[normN];
      if (!existing_record && emc.NMLS__c) {
        existing_record = nmslMap[String(emc.NMLS__c)];
      }

      let lenderId: string | null = null;
      let opType = 'none';

      if (existing_record) {
        // UPDATE: merge in new data, don't overwrite existing values that are already set
        const updatePayload: Record<string, any> = {};
        for (const [k, v] of Object.entries(mapped)) {
          // Always update these from EMC source
          const alwaysUpdate = ['loan_types', 'loan_programs', 'specialty_notes', 'revenue_notes',
            'fee_notes', 'contact_name', 'contact_email', 'contact_phone', 'lender_portal',
            'logo_url', 'min_credit_score', 'min_credit', 'channel', 'nmlsr_id',
            'compensation_type', 'compensation_bps', 'avg_app_to_fund', 'is_preferred',
            'rating', 'submission_count', 'updated_at'];
          if (alwaysUpdate.includes(k) && v !== null && v !== undefined) {
            updatePayload[k] = v;
          }
        }
        await sb.from('lenders').update(updatePayload).eq('id', existing_record.id);
        lenderId = existing_record.id;
        opType = 'updated';
        updated++;
      } else {
        // INSERT new lender
        const { data: newRec, error: insErr } = await sb.from('lenders')
          .insert({ ...mapped, created_at: new Date().toISOString(), priority: 'normal' })
          .select('id').single();
        if (insErr) {
          results.push({ name: emc.Name, op: 'error', error: insErr.message });
          continue;
        }
        lenderId = newRec.id;
        opType = 'inserted';
        inserted++;
      }

      // Sync to ClickUp if requested and task ID exists
      let cuResult = null;
      if (sync_clickup && lenderId) {
        const taskId = existing_record?.clickup_task_id;
        if (taskId) {
          cuResult = await pushToClickUp(taskId, mapped, emc);
          if (cuResult.success) clickupSynced++;
        }
      }

      results.push({
        name: emc.Name,
        op: opType,
        lender_id: lenderId,
        clickup: cuResult,
      });
    }

    return ok({
      success: true,
      total_in_batch: batch.length,
      total_in_payload: emc_data.length,
      inserted,
      updated,
      clickup_synced: clickupSynced,
      results
    });

  } catch (e: any) {
    console.error('emc-lender-import error:', e);
    return err(e.message || 'Server error', 500);
  }
});
