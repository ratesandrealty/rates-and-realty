import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function verifyStripeSignature(body: string, signature: string, secret: string): Promise<boolean> {
  const parts = signature.split(',');
  const ts = parts.find(p => p.startsWith('t='))?.split('=')[1];
  const v1 = parts.find(p => p.startsWith('v1='))?.split('=')[1];
  if (!ts || !v1) return false;

  const payload = `${ts}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
  return computed === v1;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, stripe-signature',
  };

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature') ?? '';

  if (STRIPE_WEBHOOK_SECRET) {
    const valid = await verifyStripeSignature(rawBody, signature, STRIPE_WEBHOOK_SECRET);
    if (!valid) {
      console.error('Invalid Stripe signature');
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let event: any;
  try { event = JSON.parse(rawBody); }
  catch { return new Response('Invalid JSON', { status: 400 }); }

  console.log(`Stripe event: ${event.type}`);

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(event.data.object);
    } else if (event.type === 'payment_intent.succeeded') {
      await handlePaymentSucceeded(event.data.object);
    } else if (event.type === 'payment_intent.payment_failed') {
      await handlePaymentFailed(event.data.object);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

async function handleCheckoutCompleted(session: any) {
  const customerEmail = session.customer_details?.email ?? session.customer_email ?? '';
  const customerName = session.customer_details?.name ?? '';
  const amountTotal = (session.amount_total ?? 0) / 100;

  console.log(`Checkout completed: ${customerEmail} — $${amountTotal}`);

  // 1. Upsert contact
  let contactId: string | null = null;
  if (customerEmail) {
    const nameParts = customerName.trim().split(' ');
    const { data: contact } = await supabase
      .from('contacts')
      .upsert({
        email: customerEmail.toLowerCase(),
        first_name: nameParts[0] || '',
        last_name: nameParts.slice(1).join(' ') || '',
        source: 'stripe-payment',
        funnel_source: 'credit-optimization',
        contact_type: 'borrower',
        updated_at: new Date().toISOString()
      }, { onConflict: 'email' })
      .select('id')
      .single();
    contactId = contact?.id ?? null;
  }

  // 2. Record payment
  const { error: payErr } = await supabase.from('stripe_payments').insert({
    contact_id: contactId,
    stripe_session_id: session.id,
    stripe_payment_intent_id: session.payment_intent,
    amount: amountTotal,
    currency: session.currency ?? 'usd',
    status: 'paid',
    product: 'credit_optimization',
    customer_email: customerEmail,
    customer_name: customerName,
    paid_at: new Date().toISOString()
  });
  if (payErr) console.error('Payment insert error:', payErr);

  // 3. Log activity
  if (contactId) {
    await supabase.from('activity_events').insert({
      contact_id: contactId,
      type: 'payment',
      title: 'Credit Optimization payment received',
      description: `$${amountTotal} payment completed via Stripe. Session: ${session.id}`
    });

    // 4. Create a task for Rene to follow up
    await supabase.from('tasks').insert({
      title: `Follow up with ${customerName || customerEmail} — credit optimization paid`,
      status: 'pending',
      due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 1 day from now
    });
  }

  console.log(`Payment recorded. Contact: ${contactId}, Amount: $${amountTotal}`);
}

async function handlePaymentSucceeded(paymentIntent: any) {
  await supabase.from('stripe_payments')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('stripe_payment_intent_id', paymentIntent.id);
  console.log(`Payment intent succeeded: ${paymentIntent.id}`);
}

async function handlePaymentFailed(paymentIntent: any) {
  await supabase.from('stripe_payments')
    .update({ status: 'failed' })
    .eq('stripe_payment_intent_id', paymentIntent.id);
  console.log(`Payment intent failed: ${paymentIntent.id}`);
}
