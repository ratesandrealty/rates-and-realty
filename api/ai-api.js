import { supabase } from "/api/supabase-client.js";

const AI_ENDPOINT = "https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/claude-ai";

async function callClaudeAI(action, data) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;

  const res = await fetch(AI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ action, data })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI request failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  // Support both { result } and { content } response shapes
  return json.result || json.content || json.text || json.message || JSON.stringify(json);
}

export async function summarizeLead(lead) {
  return callClaudeAI("summarize_lead", lead);
}

export async function scoreLead(lead) {
  return callClaudeAI("score_lead", lead);
}

export async function draftEmail(lead) {
  return callClaudeAI("draft_email", lead);
}

export async function draftSMS(lead) {
  return callClaudeAI("draft_sms", lead);
}

export async function chatWithAI(message, context = {}) {
  return callClaudeAI("chat", { message, context });
}
