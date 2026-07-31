/* Twilio webhook signature validation.
 *
 * Twilio signs HMAC-SHA1( AUTH_TOKEN, url + sortedPostParams ) where `url` is
 * the EXACT URL it requested, and sortedPostParams is every POST parameter
 * concatenated as key+value in lexicographic key order. Get one byte of the URL
 * wrong and every legitimate request fails closed.
 *
 * ── WHY req.url IS NOT THE URL ──────────────────────────────────────────────
 * Measured inside this runtime, a request Twilio would send to
 *     https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/sms-assistant
 * arrives as:
 *     req.url  = http://ljywhvbmsibwnssxpesh.supabase.co/sms-assistant
 *     host hdr = edge-runtime.supabase.com
 *     x-forwarded-proto = https
 * Three differences, each fatal on its own: the scheme is http, the
 * `/functions/v1` prefix has been stripped by the gateway, and the Host header
 * is the internal runtime host rather than the project host. Signing req.url
 * verbatim would reject 100% of real Twilio traffic while looking like a
 * correct implementation.
 *
 * So the URL is rebuilt as:
 *     https:// + <hostname from req.url> + /functions/v1 + <pathname> + <search>
 * The hostname in req.url is already the project host, which is what Twilio was
 * configured with (verified against the live console: all three numbers, both
 * messaging services and the TwiML app point at
 * https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/<name>). The query
 * string is passed through untouched — Twilio signs it exactly as sent, so it
 * must not be re-encoded or reordered.
 *
 * If the webhook host ever changes (a custom domain in front of the functions),
 * set TWILIO_WEBHOOK_BASE to that origin and this follows it.
 */

const enc = new TextEncoder();

/** Rebuild the URL Twilio signed. Exported for testing and for logging on failure. */
export function twilioRequestUrl(req: Request): string {
  const u = new URL(req.url);
  const override = Deno.env.get("TWILIO_WEBHOOK_BASE") || "";
  const base = override
    ? override.replace(/\/+$/, "")
    : `https://${u.hostname}/functions/v1`;
  // pathname here is "/<function-name>" because the gateway strips the prefix.
  return `${base}${u.pathname}${u.search}`;
}

/** The exact string Twilio HMACs: url followed by key+value for each POST param, keys sorted. */
export function twilioSignatureBase(url: string, params: URLSearchParams): string {
  const keys = [...new Set([...params.keys()])].sort();
  let s = url;
  for (const k of keys) {
    // A repeated key contributes each of its values, in order.
    for (const v of params.getAll(k)) s += k + v;
  }
  return s;
}

async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const ck = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", ck, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** Length-independent comparison. Signature comparison is attacker-visible timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type TwilioAuthResult =
  | { ok: true; mode: "signature" | "test"; url: string }
  | { ok: false; reason: string; url: string; expected?: string; got?: string | null };

/* The reserved test range, mirrored from sms-assistant. NPA 555 is unassignable
 * under the NANP, so a number in this range cannot belong to a handset. */
const TEST_PHONE_RE = /^\+1555555\d{4}$/;

/**
 * Validate an inbound Twilio webhook.
 *
 * `bodyText` must be the already-read raw body — a Request body can only be
 * consumed once, so the caller reads it and passes it in rather than this
 * helper stealing it.
 *
 * The test bypass requires BOTH the reserved From number AND the shared secret.
 * Either alone is not enough: the number is an identifier, not a credential,
 * and the secret without the number would let a fixture drive a real handset.
 */
export async function verifyTwilioRequest(
  req: Request,
  bodyText: string,
  opts: { authToken: string; testKey?: string } = { authToken: "" },
): Promise<TwilioAuthResult> {
  const url = twilioRequestUrl(req);
  const isForm = (req.headers.get("content-type") || "").includes("application/x-www-form-urlencoded");
  const params = isForm ? new URLSearchParams(bodyText) : new URLSearchParams();

  // ── test path ──
  const from = params.get("From") || "";
  const testKey = opts.testKey || "";
  const keyOk = !!testKey && req.headers.get("x-sms-test-key") === testKey;
  if (TEST_PHONE_RE.test(from.trim()) && keyOk) return { ok: true, mode: "test", url };

  const got = req.headers.get("x-twilio-signature");
  if (!opts.authToken) return { ok: false, reason: "auth_token_not_configured", url, got };
  if (!got) return { ok: false, reason: "missing_signature", url, got: null };

  const expected = await hmacSha1Base64(opts.authToken, twilioSignatureBase(url, params));
  if (!timingSafeEqual(expected, got)) return { ok: false, reason: "signature_mismatch", url, expected, got };
  return { ok: true, mode: "signature", url };
}

/** 403 with no detail — a probe learns nothing about why it failed. */
export function twilioForbidden(): Response {
  return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
}
