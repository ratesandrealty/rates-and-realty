export async function createLeadCapture({
  firstName, lastName, email, phone, loanType, timeline, notes,
  source = "website", funnelTag = "", turnstileToken
}) {
  const res = await fetch("https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/submit-lead", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "lead", firstName, lastName, email, phone, loanType, timeline, notes, source, funnelTag, turnstileToken })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) {
    throw new Error((out.error === "captcha_failed" || out.error === "captcha_missing")
      ? "Please complete the verification box." : "Could not submit. Please try again.");
  }
  return out;
}
