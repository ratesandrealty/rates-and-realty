import { supabase } from "/api/supabase-client.js";

export async function createLeadCapture({
  firstName,
  lastName,
  email,
  phone,
  loanType,
  timeline,
  notes,
  source = "website",
  funnelTag = ""
}) {
  // These inserts assume conventional CRM column names; adjust keys here if your schema uses different labels.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      source,
      contact_type: "borrower"
    })
    .select()
    .single();

  if (contactError) throw contactError;

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .insert({
      contact_id: contact.id,
      status: "new",
      lead_type: "mortgage",
      loan_type: loanType,
      timeline,
      notes: funnelTag ? `[${funnelTag}] ${notes || ""}`.trim() : notes,
      source
    })
    .select()
    .single();

  if (leadError) throw leadError;
  return { contact, lead };
}
