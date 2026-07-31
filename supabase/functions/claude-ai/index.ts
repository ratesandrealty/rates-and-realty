import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      }
    });
  }

  try {
    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
    
    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ success: false, error: 'ANTHROPIC_API_KEY not set' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const body = await req.json();
    const { action, data } = body;

    let systemPrompt = 'You are an AI assistant built into the Rates & Realty mortgage CRM. Help the loan officer with questions about their leads, pipeline, and mortgage business. Be concise and helpful.';
    let userMessage = data?.message || JSON.stringify(data);

    if (action === 'summarize_lead') {
      systemPrompt = 'You are a mortgage CRM assistant. Summarize this lead profile in 2-3 sentences and suggest next steps.';
      userMessage = `Summarize this lead: ${JSON.stringify(data)}`;
    } else if (action === 'score_lead') {
      systemPrompt = 'You are a mortgage lead scoring expert. Score this lead 0-100. Reply with JSON only: {"score": number, "reason": "string", "priority": "high|medium|low"}';
      userMessage = `Score this lead: ${JSON.stringify(data)}`;
    } else if (action === 'draft_email') {
      systemPrompt = 'You are a mortgage loan officer assistant for Rates & Realty. Write a short professional follow-up email.';
      userMessage = `Write a follow-up email for: ${JSON.stringify(data)}`;
    } else if (action === 'draft_sms') {
      systemPrompt = 'Write a friendly SMS under 160 characters for this mortgage lead.';
      userMessage = `Write SMS for: ${JSON.stringify(data)}`;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    const result = await response.json();
    
    if (result.error) {
      return new Response(JSON.stringify({ success: false, error: result.error.message }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const text = result.content?.[0]?.text || 'No response';

    return new Response(JSON.stringify({ success: true, result: text }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: String(error) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
});