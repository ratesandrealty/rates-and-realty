import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const MS_KEY = Deno.env.get('MAILERSEND_API_KEY');
const SMS_URL = 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/sms-service';
const PUSH_URL = 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/send-push';

console.log('listing-alert-actions started, MS_KEY present:', !!MS_KEY);

async function sendEmail(to: string, toName: string, subject: string, html: string) {
  if (!MS_KEY) return { sent: false, error: 'MAILERSEND_API_KEY not set' };
  try {
    const res = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${MS_KEY}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ from: { email: 'rene@ratesandrealty.com', name: 'Rene Duarte | Rates & Realty' }, to: [{ email: to, name: toName }], subject, html })
    });
    const txt = await res.text();
    console.log('MailerSend response:', res.status, txt.substring(0,200));
    return { sent: res.ok, error: res.ok ? undefined : txt };
  } catch(e: any) { return { sent: false, error: e.message }; }
}

function buildAlertConfirmEmail(p: { firstName: string; alertName: string; filters: any; frequency: string; portalUrl: string }): string {
  const filterLines = [
    p.filters.listing_type === 'rent' ? 'Type: For Rent' : 'Type: For Sale',
    p.filters.counties?.length ? 'Counties: ' + p.filters.counties.join(', ') : '',
    p.filters.cities?.length ? 'Cities: ' + p.filters.cities.slice(0,5).join(', ') + (p.filters.cities.length > 5 ? ` + ${p.filters.cities.length-5} more` : '') : '',
    (p.filters.min_price || p.filters.max_price) ? `Price: ${p.filters.min_price ? '$'+Number(p.filters.min_price).toLocaleString() : 'Any'} - ${p.filters.max_price ? '$'+Number(p.filters.max_price).toLocaleString() : 'Any'}` : '',
    p.filters.min_beds ? `Min Beds: ${p.filters.min_beds}+` : '',
    p.filters.min_baths ? `Min Baths: ${p.filters.min_baths}+` : '',
    p.filters.property_types?.length ? 'Property Types: ' + p.filters.property_types.join(', ') : '',
    p.filters.has_pool ? 'Must have Pool' : '',
    p.filters.new_construction_only ? 'New Construction Only' : '',
    p.filters.open_houses_only ? 'Open Houses Only' : '',
    p.filters.max_hoa ? `Max HOA: $${p.filters.max_hoa}/mo` : '',
    `Frequency: ${p.frequency}`,
    'Status: Active & Coming Soon'
  ].filter(Boolean);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a">
<tr><td align="center" style="padding:32px 16px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
  <tr><td style="background:linear-gradient(135deg,#1a1408,#2a1f0a);border-radius:14px 14px 0 0;padding:24px 32px;border-bottom:2px solid #C9A84C">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><div style="font-size:1.2rem;font-weight:800;color:#C9A84C">Rates &amp; Realty</div><div style="font-size:.62rem;color:#666;text-transform:uppercase;letter-spacing:.14em;margin-top:2px">AI-Powered Mortgage</div></td>
      <td align="right"><div style="background:rgba(201,168,76,.15);border:1px solid rgba(201,168,76,.4);color:#C9A84C;font-size:.68rem;font-weight:800;padding:5px 14px;border-radius:20px">Alert Active</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#111;padding:36px 32px 24px">
    <div style="font-size:.78rem;color:#C9A84C;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px">Listing Alert Created!</div>
    <h1 style="margin:0 0 12px;font-size:1.8rem;font-weight:800;color:#fff;line-height:1.2">You're on the list,<br><span style="color:#C9A84C">${p.firstName}!</span></h1>
    <p style="margin:0 0 20px;font-size:.88rem;color:#999;line-height:1.75">Your <strong style="color:#eee">${p.alertName}</strong> alert is active. I'll email you the moment a matching home hits the market.</p>
    <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:18px 20px;margin-bottom:20px">
      <div style="font-size:.68rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px">Your Search Criteria</div>
      ${filterLines.map(line => `<div style="font-size:.82rem;color:#ccc;padding:5px 0;border-bottom:1px solid #1e1e1e">${line}</div>`).join('')}
    </div>
    <a href="${p.portalUrl}" style="display:inline-block;background:linear-gradient(135deg,#C9A84C,#e8c96a);color:#000;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:800;font-size:.88rem">Manage My Alerts</a>
  </td></tr>
  <tr><td style="background:#0d0d0d;padding:18px 32px;border-top:1px solid #1a1a1a">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:12px"><div style="width:40px;height:40px;background:linear-gradient(135deg,#C9A84C,#a87a30);border-radius:50%;text-align:center;line-height:40px;font-weight:800;color:#000">RD</div></td>
      <td><div style="font-size:.82rem;font-weight:700;color:#eee">Rene Duarte &bull; NMLS #1795044</div>
        <div style="font-size:.7rem;color:#666"><a href="tel:7144728508" style="color:#C9A84C;text-decoration:none">(714) 472-8508</a> &bull; <a href="mailto:rene@ratesandrealty.com" style="color:#C9A84C;text-decoration:none">rene@ratesandrealty.com</a></div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#080808;padding:12px 32px;border-radius:0 0 14px 14px;border-top:1px solid #111">
    <p style="margin:0;font-size:.62rem;color:#333;text-align:center">&copy; 2026 Rates &amp; Realty &bull; NMLS #1795044 &bull; Equal Housing Lender</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const { action } = body;

    if (action === 'create_alert') {
      const { portal_user_id, email, borrower_id, alert, user_phone, user_email } = body;
      if (!alert?.name) return err('Alert name required');

      let contact_id: string | null = null;
      let firstName = 'there';
      let userPhone = user_phone || null;
      let portalEmail: string | null = null;

      if (portal_user_id) {
        const { data: pu } = await sb.from('portal_users').select('contact_id,first_name,phone,email,borrower_id').eq('id', portal_user_id).single();
        contact_id = pu?.contact_id || null;
        firstName = pu?.first_name || 'there';
        userPhone = userPhone || pu?.phone || null;
        portalEmail = pu?.email || null;
      }
      if (!contact_id && (email || user_email)) {
        const lookupEmail = (email || user_email).toLowerCase();
        const { data: c } = await sb.from('contacts').select('id').eq('email', lookupEmail).single();
        contact_id = c?.id || null;
      }

      const { data: newAlert, error: insertErr } = await sb.from('listing_alerts').insert({
        portal_user_id: portal_user_id || null,
        contact_id,
        borrower_id: borrower_id || null,
        name: alert.name,
        frequency: alert.frequency || 'Daily',
        is_active: true,
        listing_type: alert.listing_type || 'buy',
        listing_statuses: alert.listing_statuses || ['Active', 'Coming Soon'],
        counties: alert.counties || [],
        cities: alert.cities || [],
        county: alert.counties?.[0] || null,
        min_price: alert.min_price ? Number(alert.min_price) : null,
        max_price: alert.max_price ? Number(alert.max_price) : null,
        min_beds: alert.min_beds ? Number(alert.min_beds) : null,
        min_baths: alert.min_baths ? Number(alert.min_baths) : null,
        property_types: alert.property_types || [],
        min_sqft: alert.min_sqft ? Number(alert.min_sqft) : null,
        max_sqft: alert.max_sqft ? Number(alert.max_sqft) : null,
        min_year_built: alert.min_year_built ? Number(alert.min_year_built) : null,
        max_dom: alert.max_dom ? Number(alert.max_dom) : null,
        has_pool: alert.has_pool || false,
        has_garage: alert.has_garage || false,
        max_hoa: alert.max_hoa ? Number(alert.max_hoa) : null,
        open_houses_only: alert.open_houses_only || false,
        new_construction_only: alert.new_construction_only || false,
        keywords: alert.keywords || null,
        status: 'Active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).select().single();

      if (insertErr) { console.error('Alert insert error:', insertErr); return err(insertErr.message, 500); }

      // Log activity — use try/catch instead of .catch() chain
      const toEmail = email || user_email || portalEmail;
      let emailResult = { sent: false, error: 'No email' };

      if (toEmail) {
        const subject = `Alert Created: ${alert.name} - I'll notify you when homes match!`;
        const html = buildAlertConfirmEmail({ firstName, alertName: alert.name, filters: alert, frequency: alert.frequency || 'Daily', portalUrl: 'https://beta.ratesandrealty.com/public/unified-portal.html' });
        emailResult = await sendEmail(toEmail, firstName, subject, html);

        if (contact_id) {
          try {
            await sb.from('activity_events').insert({
              contact_id, portal_user_id: portal_user_id || null, crm_id: borrower_id || null,
              type: 'email', channel: 'email',
              title: 'Listing Alert Created: ' + alert.name,
              description: `Alert for ${(alert.counties||[]).join(', ')||'all counties'} - ${(alert.cities||[]).length} cities, freq: ${alert.frequency}`,
              status: emailResult.sent ? 'sent' : 'failed',
              email_subject: subject, email_to: toEmail, email_from: 'rene@ratesandrealty.com',
              metadata: JSON.stringify({ alert_id: newAlert.id, ms_key_present: !!MS_KEY, email_error: emailResult.error }),
              created_at: new Date().toISOString()
            });
          } catch(logErr) { console.error('Activity log error:', logErr); }
        }
      }

      // SMS — use try/catch
      if (userPhone) {
        try {
          await fetch(SMS_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              trigger: 'listing_alert_created', to_phone: userPhone,
              params: { firstName, alertName: alert.name },
              contact_id, portal_user_id: portal_user_id || null,
              borrower_id: borrower_id || null, trigger_id: newAlert.id
            })
          });
        } catch(smsErr) { console.warn('SMS error:', smsErr); }
      }

      // Push notification
      if (portal_user_id) {
        try {
          await fetch(PUSH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'send',
              portal_user_id: portal_user_id,
              title: 'Alert Created!',
              message: `Your "${alert.name}" alert is active. We'll notify you when homes match.`,
              url: 'https://beta.ratesandrealty.com/public/unified-portal.html#alerts'
            })
          });
        } catch(pushErr) { console.warn('Push notification error:', pushErr); }
      }

      return ok({ success: true, alert: newAlert, emailed: emailResult.sent, sms_queued: !!userPhone, email_error: emailResult.error, ms_key_present: !!MS_KEY });
    }

    if (action === 'get_alerts') {
      const { portal_user_id, contact_id, borrower_id } = body;
      // OR across all provided identifiers — alerts may be linked via any of them
      const orParts: string[] = [];
      if (contact_id) orParts.push(`contact_id.eq.${contact_id}`);
      if (portal_user_id) orParts.push(`portal_user_id.eq.${portal_user_id}`);
      if (borrower_id) orParts.push(`borrower_id.eq.${borrower_id}`);
      if (!orParts.length) return err('portal_user_id, contact_id, or borrower_id required');
      const { data, error } = await sb.from('listing_alerts')
        .select('*')
        .or(orParts.join(','))
        .order('created_at', { ascending: false });
      if (error) return err(error.message, 500);
      // De-dupe in case the same alert matches multiple ID fields
      const seen = new Set();
      const unique = (data || []).filter((a: any) => {
        if (seen.has(a.id)) return false;
        seen.add(a.id); return true;
      });
      return ok({ alerts: unique });
    }

    if (action === 'toggle_alert') {
      const { alert_id, is_active } = body;
      await sb.from('listing_alerts').update({ is_active, updated_at: new Date().toISOString() }).eq('id', alert_id);
      return ok({ success: true, is_active });
    }

    if (action === 'delete_alert') {
      const { alert_id } = body;
      await sb.from('listing_alerts').delete().eq('id', alert_id);
      return ok({ success: true });
    }

    if (action === 'update_alert') {
      const { alert_id, updates } = body;
      await sb.from('listing_alerts').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', alert_id);
      return ok({ success: true });
    }

    if (action === 'debug_env') {
      return ok({ ms_key_present: !!MS_KEY, ml_key_length: ML_KEY?.length || 0, ml_key_prefix: ML_KEY?.substring(0,8)||'none' });
    }

    return err('Unknown action: ' + action);
  } catch(e: any) {
    console.error('listing-alert-actions error:', e);
    return err(e.message || 'Server error', 500);
  }
});
