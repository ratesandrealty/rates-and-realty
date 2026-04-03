import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MAILERSEND_KEY = Deno.env.get('MAILERSEND_API_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    // 1. Fetch scheduled emails that are now due
    const now = new Date().toISOString();
    const dueRes = await fetch(
      `${SUPABASE_URL}/rest/v1/email_log?status=eq.scheduled&scheduled_at=lte.${now}&select=*`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    );
    const dueEmails = await dueRes.json();

    if (!Array.isArray(dueEmails) || dueEmails.length === 0) {
      console.log('[send-scheduled-emails] No due emails.');
      return new Response(JSON.stringify({ message: 'No scheduled emails due', sent: 0 }), { headers: cors });
    }

    console.log(`[send-scheduled-emails] Found ${dueEmails.length} due email(s)`);
    const results: any[] = [];

    for (const email of dueEmails) {
      try {
        // 2. Build recipient list
        const toAddresses = email.to_emails?.length
          ? email.to_emails.map((e: string) => ({ email: e }))
          : [{ email: email.to_email }];

        // 3. Send via MailerSend
        const sendRes = await fetch('https://api.mailersend.com/v1/email', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${MAILERSEND_KEY}`,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({
            from: { email: email.from_email || 'rene@ratesandrealty.com', name: 'Rene Duarte' },
            to: toAddresses,
            subject: email.subject,
            html: email.body_html || `<p>${email.body_text || ''}</p>`,
            text: email.body_text || '',
          })
        });

        const success = sendRes.ok || sendRes.status === 202;
        const sendTxt = await sendRes.text();
        console.log(`[send-scheduled-emails] MailerSend ${sendRes.status} for "${email.subject}": ${sendTxt.substring(0, 100)}`);

        // 4. Update status in DB
        await fetch(
          `${SUPABASE_URL}/rest/v1/email_log?id=eq.${email.id}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': SERVICE_KEY,
              'Authorization': `Bearer ${SERVICE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify({
              status: success ? 'sent' : 'failed',
              sent_at: success ? new Date().toISOString() : null,
            })
          }
        );

        // 5. Log activity if contact_id exists
        if (success && email.contact_id) {
          await fetch(`${SUPABASE_URL}/rest/v1/activity_events`, {
            method: 'POST',
            headers: {
              'apikey': SERVICE_KEY,
              'Authorization': `Bearer ${SERVICE_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              contact_id: email.contact_id,
              type: 'email',
              channel: 'email',
              direction: 'outbound',
              title: `Scheduled email sent: ${email.subject}`,
              description: (email.body_text || '').substring(0, 200),
              email_subject: email.subject,
              email_to: email.to_email,
              email_from: email.from_email || 'rene@ratesandrealty.com',
              status: 'sent',
              created_at: new Date().toISOString(),
            })
          });
        }

        results.push({ id: email.id, subject: email.subject, to: email.to_email, success });
        console.log(`[send-scheduled-emails] ${success ? 'SENT' : 'FAILED'}: "${email.subject}" to ${email.to_email}`);

      } catch (err: any) {
        console.error(`[send-scheduled-emails] Error sending ${email.id}:`, err.message);

        // Mark as failed so it doesn't retry forever
        await fetch(`${SUPABASE_URL}/rest/v1/email_log?id=eq.${email.id}`, {
          method: 'PATCH',
          headers: {
            'apikey': SERVICE_KEY,
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ status: 'failed' })
        });

        results.push({ id: email.id, subject: email.subject, success: false, error: err.message });
      }
    }

    const sentCount = results.filter(r => r.success).length;
    console.log(`[send-scheduled-emails] Done: ${sentCount}/${results.length} sent`);

    return new Response(
      JSON.stringify({ sent: sentCount, total: results.length, results }),
      { headers: cors }
    );

  } catch (err: any) {
    console.error('[send-scheduled-emails] Fatal error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});
