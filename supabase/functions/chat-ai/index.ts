import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SYSTEM_PROMPT = `You are Rene, an AI mortgage and real estate assistant for Rates & Realty (ratesandrealty.com), run by Rene Duarte, MLO NMLS #1795044 in Orange County, California.

Your job is to be warm, helpful, and knowledgeable — like a trusted friend who happens to be a mortgage expert. You help people understand:
- Home buying process (first-time buyers, move-up buyers, investors)
- Mortgage loan types: FHA, Conventional, VA, USDA, DSCR, Jumbo, Bank Statement
- Down payment assistance programs (CalHFA Dream For All, MyHome, GSFA Platinum, OC MAP, Santa Ana DPA)
- Credit score requirements and how to improve them
- Current rates (explain you can get a personalized rate quote from Rene)
- Refinancing options
- Orange County and Southern California real estate market
- The home buying timeline and what to expect

Key facts about Rates & Realty:
- Owner: Rene Duarte, MLO NMLS #1795044
- Phone: (714) 472-8508
- Email: rene@ratesandrealty.com
- Booking: https://cal.com/rene-duarte-rates-realty
- Specialties: Orange County, DSCR investor loans, first-time buyers, DPA programs
- Credit optimization service: $97 program available

Tone guidelines:
- Warm, friendly, conversational — not robotic
- Use simple language — avoid jargon unless asked
- Be encouraging — homeownership is achievable
- When asked about specific rates or eligibility, always say rates change daily and offer to connect them with Rene for a personalized quote
- Never make guarantees about loan approval
- Keep responses concise — 2-4 sentences max unless explaining a complex topic
- Always end with a helpful follow-up question or offer to connect with Rene

If someone seems ready to move forward, suggest booking a free call: https://cal.com/rene-duarte-rates-realty or calling (714) 472-8508.

IMPORTANT: You are an AI assistant. For official loan advice, always refer to Rene Duarte directly.`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { messages, session_id, guest_name, guest_email, page_url, utm_source, utm_campaign } = body;

  if (!messages || !Array.isArray(messages)) {
    return new Response('messages array required', { status: 400 });
  }

  // Call Anthropic API
  let aiReply = '';
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: messages.slice(-10) // last 10 messages for context
      })
    });

    const data = await response.json();
    aiReply = data.content?.[0]?.text ?? 'I apologize, I had trouble responding. Please try again or call Rene at (714) 472-8508.';
  } catch (err) {
    console.error('Anthropic error:', err);
    aiReply = 'Sorry, I had a technical issue. You can reach Rene directly at (714) 472-8508.';
  }

  // Save/update conversation in Supabase
  if (session_id) {
    try {
      const allMessages = [...messages, { role: 'assistant', content: aiReply }];

      // Check if conversation exists
      const { data: existing } = await supabase
        .from('chat_conversations')
        .select('id, contact_id')
        .eq('session_id', session_id)
        .single();

      if (existing) {
        // Update existing conversation
        await supabase
          .from('chat_conversations')
          .update({
            messages: allMessages,
            last_message_at: new Date().toISOString(),
            guest_name: guest_name || null,
            guest_email: guest_email || null
          })
          .eq('session_id', session_id);

        // If email just provided and no contact yet, create contact
        if (guest_email && !existing.contact_id) {
          const nameParts = (guest_name || '').trim().split(' ');
          const { data: contact } = await supabase
            .from('contacts')
            .upsert({
              email: guest_email.toLowerCase(),
              first_name: nameParts[0] || '',
              last_name: nameParts.slice(1).join(' ') || '',
              source: 'chat-widget',
              funnel_source: page_url || 'website',
              contact_type: 'lead',
              updated_at: new Date().toISOString()
            }, { onConflict: 'email' })
            .select('id')
            .single();

          if (contact?.id) {
            await supabase
              .from('chat_conversations')
              .update({ contact_id: contact.id, lead_captured: true })
              .eq('session_id', session_id);

            // Log activity
            await supabase.from('activity_events').insert({
              contact_id: contact.id,
              type: 'chat',
              title: 'Chat widget conversation started',
              description: `${guest_name || guest_email} started a chat on ${page_url || 'the website'}`
            });
          }
        }
      } else {
        // Create new conversation
        await supabase.from('chat_conversations').insert({
          session_id,
          guest_name: guest_name || null,
          guest_email: guest_email || null,
          messages: allMessages,
          page_url: page_url || null,
          utm_source: utm_source || null,
          utm_campaign: utm_campaign || null,
          last_message_at: new Date().toISOString()
        });
      }
    } catch (err) {
      console.error('Supabase save error:', err);
    }
  }

  return new Response(
    JSON.stringify({ reply: aiReply }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    }
  );
});
