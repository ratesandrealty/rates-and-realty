// campaign-ai-generate v2: pulls real booking URL from email_settings instead of
// letting the AI invent a Calendly link. If no URL is set, omits booking link entirely
// (no fake links).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_CHANNELS = ["email", "sms", "voicemail", "canva_image"];

function estimateSegments(body: string): number {
  const isUnicode = /[^\x00-\x7F]/.test(body);
  const limit = isUnicode ? 70 : 160;
  if (body.length <= limit) return 1;
  const multipartLimit = isUnicode ? 67 : 153;
  return Math.ceil(body.length / multipartLimit);
}

async function getBookingContext(): Promise<string> {
  const { data } = await sb.from("email_settings")
    .select("booking_url, booking_url_intro, booking_url_strategy, booking_url_application, booking_provider")
    .eq("lo_id", "rene").maybeSingle();

  if (!data?.booking_url && !data?.booking_url_intro) {
    return `BOOKING LINK: NO URL CONFIGURED YET. Do NOT include any booking link, Calendly link, or scheduling URL in any channel. Use phrases like "text me back" or "give me a call" instead. Never invent a URL.`;
  }

  const lines = ["BOOKING LINKS (use these EXACT URLs only — never invent any other URL):"];
  if (data.booking_url) lines.push(`- General: ${data.booking_url}`);
  if (data.booking_url_intro) lines.push(`- 15-min intro call: ${data.booking_url_intro}`);
  if (data.booking_url_strategy) lines.push(`- 30-min strategy call: ${data.booking_url_strategy}`);
  if (data.booking_url_application) lines.push(`- 60-min application review: ${data.booking_url_application}`);
  lines.push("");
  lines.push("Pick the most appropriate one for the campaign topic. If unsure, use the general booking URL.");
  return lines.join("\n");
}

async function generateWithClaude(systemPrompt: string, userPrompt: string): Promise<{ json: any; usage: any }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errTxt.substring(0, 400)}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || "{}";
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "").trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`AI response not valid JSON: ${cleaned.substring(0, 300)}`);
  }
  return { json: parsed, usage: data.usage };
}

function buildSystemPrompt(bookingContext: string): string {
  return `You are a senior mortgage marketing strategist for Rates & Realty (Rene Duarte, MLO NMLS #1795044, Huntington Beach CA, serving Orange County).

You are given a campaign brief from the loan officer. Your job: produce a complete multi-channel campaign as JSON.

VOICE & STYLE:
- Conversational, confident, never salesy or generic
- Mortgage industry terminology used naturally (rates, LTV, conventional/FHA/VA, cash-out, etc.)
- Local Orange County references when relevant (Anaheim, Costa Mesa, HB, etc.)
- Always sounds like Rene speaking directly to the recipient
- Compliant: no rate/APR claims unless the prompt provides specific numbers
- No NMLS quoting unless context requires it; keep messaging human

${bookingContext}

CRITICAL RULES ABOUT URLS:
- NEVER invent or guess any URL of any kind
- For booking/scheduling: use ONLY the URLs listed above. If none are listed, say "text me back" or "call me" \u2014 do NOT include any link
- For property links, do NOT invent. Use {{property_url}} merge tag if needed
- The only acceptable URLs are: the booking URLs above, ratesandrealty.com, beta.ratesandrealty.com, and the {{unsubscribe_url}} merge tag

OUTPUT JSON SCHEMA (return EXACTLY this shape, no commentary):
{
  "campaign_name": "<short title for internal use, 4-8 words>",
  "audience_suggestion": {
    "description": "<one-line description of who this is for>",
    "filters": { "loan_type": "<FHA|VA|Conventional|Jumbo|null>", "pipeline_status": "<new|qualifying|nurture|active|closed_won|...|null>", "city": "<single city or null>", "lead_temperature": "<hot|warm|cold|null>", "score_tier": "<A|B|C|D|null>" }
  },
  "email": {
    "subject": "<6-9 word subject line, NO clickbait, NO emojis at start>",
    "preheader": "<60-90 char hook visible in inbox preview>",
    "html": "<full email body in clean HTML, mobile-friendly. Use <h2>, <p>, <ul>, <a> with strong CTA. Include {{first_name}} merge tag in greeting. End with Rene's signature block: '<p style=\"margin-top:24px;font-size:14px;color:#666\">Rene Duarte<br>Rates &amp; Realty<br>NMLS #1795044<br>(714) 472-8508</p>'. Include a single 'View in browser' style unsubscribe link with {{unsubscribe_url}} merge tag at the very bottom.>",
    "plaintext": "<plaintext fallback version>"
  },
  "sms": {
    "body": "<160 chars max ideally. Start with Rene identifying himself unless the recipient already replies. Include {{first_name}} merge tag if it fits naturally. Always end with 'Reply STOP to opt out.'>"
  },
  "voicemail": {
    "script": "<20-30 second voicemail script for ringless drop. Conversational, opens with name, 1 specific value point, soft CTA like 'give me a quick text back' instead of demanding a callback. ~75-100 words.>"
  },
  "canva_image": {
    "prompt": "<concise visual concept for a 1080x1080 Canva graphic that pairs with this campaign. Describe colors, mood, type hierarchy, key text, and brand elements. Brand: gold #C9A84C accent on dark or warm cream background, Playfair Display headlines, DM Sans body. Include the headline text the graphic should display.>",
    "headline": "<6-12 word headline that goes on the graphic>",
    "subhead": "<optional supporting line, 8-15 words>"
  }
}

IMPORTANT:
- Always populate ALL fields above, even if some channels were not requested. The caller will pick which to use.
- Stay under 160 chars for SMS body.
- Email HTML should be inline-styled (no external CSS) for compatibility.
- Never invent specific rates, APRs, or program eligibility numbers. Speak to the topic without quoting fake stats.
- Use {{first_name}}, {{last_name}}, {{property_city}}, {{loan_type}}, and {{unsubscribe_url}} as merge tags. Don't invent others.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method !== "POST") return err("Method not allowed", 405);

  try {
    const body = await req.json();
    const {
      prompt,
      channels = ["email", "sms", "voicemail", "canva_image"],
      audience_hint = {},
      campaign_id,
      regenerate_channel,
    } = body;

    if (!prompt || typeof prompt !== "string" || prompt.length < 5) {
      return err("prompt required (5+ chars)");
    }
    const requestedChannels = channels.filter((c: string) => VALID_CHANNELS.includes(c));
    if (!requestedChannels.length) return err("At least one valid channel required");

    // Pull current booking context from settings
    const bookingContext = await getBookingContext();
    const systemPrompt = buildSystemPrompt(bookingContext);

    let userPrompt = `Campaign brief: ${prompt}`;
    if (audience_hint && Object.keys(audience_hint).length) {
      userPrompt += `\n\nAudience hint from user: ${JSON.stringify(audience_hint)}`;
    }
    userPrompt += `\n\nChannels needed: ${requestedChannels.join(", ")}`;
    userPrompt += `\n\nReturn ONLY the JSON object \u2014 no commentary, no code fences.`;

    const { json: ai, usage } = await generateWithClaude(systemPrompt, userPrompt);

    let campaign: any;
    if (campaign_id) {
      const { data, error } = await sb.from("campaigns")
        .update({
          name: ai.campaign_name || "Untitled Campaign",
          prompt,
          audience_filter: ai.audience_suggestion?.filters || {},
          channels: requestedChannels,
          ai_model: "claude-sonnet-4-6",
          generation_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
          updated_at: new Date().toISOString(),
          status: "draft",
        })
        .eq("id", campaign_id)
        .select()
        .single();
      if (error) throw new Error(`update campaign: ${error.message}`);
      campaign = data;
    } else {
      const { data, error } = await sb.from("campaigns")
        .insert({
          name: ai.campaign_name || "Untitled Campaign",
          prompt,
          audience_filter: ai.audience_suggestion?.filters || {},
          channels: requestedChannels,
          ai_model: "claude-sonnet-4-6",
          generation_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
          status: "draft",
          created_by: "rene@ratesandrealty.com",
        })
        .select()
        .single();
      if (error) throw new Error(`insert campaign: ${error.message}`);
      campaign = data;
    }

    const piecesToWrite: any[] = [];

    if (requestedChannels.includes("email") && ai.email) {
      piecesToWrite.push({
        campaign_id: campaign.id,
        channel: "email",
        email_subject: ai.email.subject,
        email_preheader: ai.email.preheader,
        email_html: ai.email.html,
        email_plaintext: ai.email.plaintext,
        email_from_name: "Rene Duarte",
        email_from_email: "rene@ratesandrealty.com",
        ai_generated: true,
        status: "draft",
      });
    }

    if (requestedChannels.includes("sms") && ai.sms) {
      piecesToWrite.push({
        campaign_id: campaign.id,
        channel: "sms",
        sms_body: ai.sms.body,
        sms_segments: estimateSegments(ai.sms.body || ""),
        ai_generated: true,
        status: "draft",
      });
    }

    if (requestedChannels.includes("voicemail") && ai.voicemail) {
      piecesToWrite.push({
        campaign_id: campaign.id,
        channel: "voicemail",
        voicemail_script: ai.voicemail.script,
        voicemail_duration_seconds: Math.ceil((ai.voicemail.script || "").split(/\s+/).length / 2.5),
        ai_generated: true,
        status: "draft",
      });
    }

    if (requestedChannels.includes("canva_image") && ai.canva_image) {
      piecesToWrite.push({
        campaign_id: campaign.id,
        channel: "canva_image",
        image_prompt: ai.canva_image.prompt,
        email_subject: ai.canva_image.headline,
        email_preheader: ai.canva_image.subhead,
        ai_generated: true,
        status: "draft",
      });
    }

    if (piecesToWrite.length) {
      if (campaign_id) {
        await sb.from("campaign_pieces")
          .delete()
          .eq("campaign_id", campaign.id)
          .in("channel", piecesToWrite.map(p => p.channel));
      }
      const { error: pErr } = await sb.from("campaign_pieces").insert(piecesToWrite);
      if (pErr) throw new Error(`insert pieces: ${pErr.message}`);
    }

    const [{ data: c }, { data: pieces }] = await Promise.all([
      sb.from("campaigns").select("*").eq("id", campaign.id).single(),
      sb.from("campaign_pieces").select("*").eq("campaign_id", campaign.id),
    ]);

    return ok({
      success: true,
      campaign: c,
      pieces: pieces || [],
      audience_suggestion: ai.audience_suggestion,
      tokens_used: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
      booking_context_used: bookingContext.startsWith("BOOKING LINKS") ? "configured" : "none",
    });
  } catch (e: any) {
    console.error("[campaign-ai-generate] FATAL:", e);
    return err(e.message || String(e), 500);
  }
});
