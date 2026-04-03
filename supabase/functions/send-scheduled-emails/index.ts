import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function stripMarkdownFences(text: string): string {
  return (text || '')
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

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
    console.log(`[scheduler] Checking for due emails at ${now}`);

    const dueRes = await fetch(
      `${SUPABASE_URL}/rest/v1/email_log?status=eq.scheduled&scheduled_at=lte.${now}&select=*`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    );
    const dueEmails = await dueRes.json();

    if (!Array.isArray(dueEmails) || dueEmails.length === 0) {
      console.log('[scheduler] No due emails.');
      return new Response(JSON.stringify({ message: 'No scheduled emails due', sent: 0 }), { headers: cors });
    }

    console.log(`[scheduler] Found ${dueEmails.length} due email(s)`);
    const results: any[] = [];

    for (const email of dueEmails) {
      const tag = `[scheduler "${email.subject}" ${email.id.substring(0, 8)}]`;
      try {
        // 2. Determine recipients
        const toEmail = Array.isArray(email.to_emails) && email.to_emails.length
          ? email.to_emails[0]
          : email.to_email;

        if (!toEmail) {
          console.log(`${tag} No recipient — marking failed`);
          await patchStatus(email.id, 'failed');
          results.push({ id: email.id, subject: email.subject, success: false, error: 'No recipient' });
          continue;
        }

        // 3. Send via email-service (proven working path)
        console.log(`${tag} Sending to ${toEmail} via email-service...`);

        const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/email-service`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify({
            action: 'send',
            to_email: toEmail,
            subject: email.subject || '(no subject)',
            html: stripMarkdownFences(email.body_html) || `<p>${stripMarkdownFences(email.body_text)}</p>`,
            contact_id: email.contact_id || null,
          })
        });

        const sendData = await sendRes.json();
        const success = sendRes.ok && sendData.success === true;

        console.log(`${tag} email-service response: ${sendRes.status} success=${sendData.success} error=${sendData.error || 'none'}`);

        // 4. Update email_log status (email-service already creates its own log row,
        //    so we just update the scheduled row's status)
        await patchStatus(email.id, success ? 'sent' : 'failed', success ? new Date().toISOString() : null);

        if (!success) {
          console.error(`${tag} FAILED: ${sendData.error || sendRes.status}`);
        }

        results.push({
          id: email.id,
          subject: email.subject,
          to: toEmail,
          success,
          error: success ? undefined : (sendData.error || `HTTP ${sendRes.status}`),
        });

      } catch (err: any) {
        console.error(`${tag} Exception:`, err.message);
        await patchStatus(email.id, 'failed');
        results.push({ id: email.id, subject: email.subject, success: false, error: err.message });
      }
    }

    const sentCount = results.filter(r => r.success).length;
    console.log(`[scheduler] Done: ${sentCount}/${results.length} sent`);

    return new Response(
      JSON.stringify({ sent: sentCount, total: results.length, results }),
      { headers: cors }
    );

  } catch (err: any) {
    console.error('[scheduler] Fatal error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});

async function patchStatus(id: string, status: string, sentAt?: string | null) {
  const body: any = { status };
  if (sentAt) body.sent_at = sentAt;
  await fetch(`${SUPABASE_URL}/rest/v1/email_log?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
  });
}
