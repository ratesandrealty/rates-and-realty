import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/*
 * send-listing-alerts
 * -------------------
 * Scheduled function that:
 *   1. Reads all active listing_alerts whose frequency window has elapsed
 *   2. Queries Trestle (CRMLS) MLS API for matching listings
 *   3. Filters out already-sent listings via alert_sent_listings
 *   4. Sends email (MailerSend) + optional SMS with matching listings
 *   5. Updates last_sent_at, total_sent on the alert
 *   6. Inserts sent listing keys into alert_sent_listings
 *
 * Invoke manually:  supabase functions invoke send-listing-alerts --no-verify-jwt
 * Schedule via pg_cron or Supabase cron to run every 15-30 minutes.
 */

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const MS_KEY = Deno.env.get("MAILERSEND_API_KEY");

const TRESTLE_TOKEN_URL = "https://api.cotality.com/trestle/oidc/connect/token";
const TRESTLE_API_BASE = "https://api.cotality.com/trestle/odata";

const SMS_FN =
  Deno.env.get("SUPABASE_URL") + "/functions/v1/sms-service";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

// ── Trestle Auth ──────────────────────────────────────────────
async function getTrestleToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const id = Deno.env.get("TRESTLE_CLIENT_ID");
  const secret = Deno.env.get("TRESTLE_CLIENT_SECRET");
  if (!id || !secret) throw new Error("TRESTLE_CLIENT_ID / SECRET not set");
  const res = await fetch(TRESTLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: secret,
      scope: "api",
    }),
  });
  if (!res.ok) throw new Error(`Trestle auth ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken!;
}

// ── Build OData $filter from alert criteria ───────────────────
interface AlertRow {
  id: string;
  contact_id: string | null;
  portal_user_id: string | null;
  name: string;
  frequency: string;
  listing_type: string;
  listing_statuses: string[];
  counties: string[];
  cities: string[];
  min_price: number | null;
  max_price: number | null;
  min_beds: number | null;
  min_baths: number | null;
  property_types: string[];
  min_sqft: number | null;
  max_sqft: number | null;
  min_year_built: number | null;
  max_dom: number | null;
  has_pool: boolean;
  has_garage: boolean;
  max_hoa: number | null;
  last_sent_at: string | null;
  last_checked_at: string | null;
  total_sent: number;
}

function buildODataFilter(a: AlertRow): string {
  const parts: string[] = [];

  // Status
  const statuses = a.listing_statuses?.length
    ? a.listing_statuses
    : ["Active", "Coming Soon"];
  parts.push(
    "(" + statuses.map((s) => `StandardStatus eq '${s}'`).join(" or ") + ")"
  );

  // Cities
  if (a.cities?.length) {
    parts.push(
      "(" + a.cities.map((c) => `City eq '${c}'`).join(" or ") + ")"
    );
  }

  // Price
  if (a.min_price) parts.push(`ListPrice ge ${a.min_price}`);
  if (a.max_price) parts.push(`ListPrice le ${a.max_price}`);

  // Beds / Baths
  if (a.min_beds) parts.push(`BedroomsTotal ge ${a.min_beds}`);
  if (a.min_baths) parts.push(`BathroomsTotalInteger ge ${a.min_baths}`);

  // Sqft
  if (a.min_sqft) parts.push(`LivingArea ge ${a.min_sqft}`);
  if (a.max_sqft) parts.push(`LivingArea le ${a.max_sqft}`);

  // Year built
  if (a.min_year_built) parts.push(`YearBuilt ge ${a.min_year_built}`);

  // Property types
  if (a.property_types?.length) {
    parts.push(
      "(" +
        a.property_types.map((t) => `PropertyType eq '${t}'`).join(" or ") +
        ")"
    );
  }

  return parts.join(" and ");
}

// ── Fetch MLS listings for one alert ──────────────────────────
interface Listing {
  ListingKey: string;
  ListPrice: number;
  BedroomsTotal: number;
  BathroomsTotalInteger: number;
  LivingArea: number;
  UnparsedAddress: string;
  City?: string;
  PublicRemarks?: string;
  Media?: { MediaURL?: string }[];
}

async function fetchMlsListings(alert: AlertRow): Promise<Listing[]> {
  const token = await getTrestleToken();
  const filter = buildODataFilter(alert);
  const params = new URLSearchParams({
    $filter: filter,
    $top: "25",
    $orderby: "ModificationTimestamp desc",
    $select:
      "ListingKey,ListPrice,BedroomsTotal,BathroomsTotalInteger,LivingArea,UnparsedAddress,City,PublicRemarks,Media",
  });
  const url = `${TRESTLE_API_BASE}/Property?${params}`;
  console.log("[send-listing-alerts] MLS query:", url.substring(0, 200));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  console.log("[send-listing-alerts] MLS response status:", res.status);
  if (!res.ok) {
    console.log("[send-listing-alerts] MLS error:", await res.text());
    return [];
  }
  const data = await res.json();
  const listings = data.value || [];
  console.log(
    `[send-listing-alerts] MLS returned ${listings.length} listings for alert "${alert.name}"`
  );
  return listings;
}

// ── Mock listings (until CRMLS approval) ──────────────────────
const MOCK_LISTINGS: Listing[] = [
  {
    ListingKey: "MOCK-001",
    ListPrice: 749000,
    BedroomsTotal: 3,
    BathroomsTotalInteger: 2,
    LivingArea: 1450,
    UnparsedAddress: "123 Test St, Huntington Beach, CA 92648",
    City: "Huntington Beach",
    PublicRemarks:
      "Beautiful single family home in a quiet neighborhood. Updated kitchen with granite countertops.",
    Media: [{ MediaURL: "https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=400&h=300&fit=crop" }],
  },
  {
    ListingKey: "MOCK-002",
    ListPrice: 825000,
    BedroomsTotal: 4,
    BathroomsTotalInteger: 2,
    LivingArea: 1850,
    UnparsedAddress: "456 Demo Ave, Irvine, CA 92620",
    City: "Irvine",
    PublicRemarks:
      "Stunning remodeled home with open floor plan and chef kitchen.",
    Media: [{ MediaURL: "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=400&h=300&fit=crop" }],
  },
];

// ── Build search URL from alert criteria ──────────────────────
function buildSearchUrl(alert: AlertRow & { borrower_id?: string }, listingKey?: string): string {
  const params = new URLSearchParams();
  if (alert.cities?.length) params.set('cities', alert.cities.join(','));
  if (alert.counties?.length) params.set('counties', alert.counties.join(','));
  if (alert.min_price) params.set('min_price', String(alert.min_price));
  if (alert.max_price) params.set('max_price', String(alert.max_price));
  if (alert.min_beds) params.set('min_beds', String(alert.min_beds));
  if (alert.min_baths) params.set('min_baths', String(alert.min_baths));
  if (alert.property_types?.length) params.set('property_types', alert.property_types.join(','));
  if (alert.listing_statuses?.length) params.set('statuses', alert.listing_statuses.join(','));
  if (alert.min_sqft) params.set('min_sqft', String(alert.min_sqft));
  if (alert.max_sqft) params.set('max_sqft', String(alert.max_sqft));
  if (alert.has_pool) params.set('has_pool', 'true');
  if (alert.max_hoa) params.set('max_hoa', String(alert.max_hoa));
  if (alert.listing_type) params.set('listing_type', alert.listing_type);
  params.set('alert_id', alert.id);
  if (alert.borrower_id) params.set('borrower_id', alert.borrower_id);
  if (listingKey) params.set('highlight', listingKey);
  return `https://beta.ratesandrealty.com/public/search-homes.html?${params.toString()}`;
}

// ── Build search criteria summary rows ────────────────────────
function buildCriteriaRows(a: AlertRow): string {
  const row = (label: string, value: string) =>
    `<div style="margin-bottom:4px;"><span style="color:#7A5820;">${label}:</span> <span style="color:#F0EDE4;">${value}</span></div>`;
  const rows: string[] = [];
  if (a.cities?.length) rows.push(row('Cities', a.cities.join(', ')));
  if (a.counties?.length) rows.push(row('Counties', a.counties.join(', ')));
  if (a.min_price || a.max_price) {
    const mn = a.min_price ? '$' + Number(a.min_price).toLocaleString() : 'Any';
    const mx = a.max_price ? '$' + Number(a.max_price).toLocaleString() : 'Any';
    rows.push(row('Price', `${mn} – ${mx}`));
  }
  if (a.min_beds) rows.push(row('Beds', `${a.min_beds}+`));
  if (a.min_baths) rows.push(row('Baths', `${a.min_baths}+`));
  if (a.property_types?.length) rows.push(row('Types', a.property_types.join(', ')));
  if (a.listing_statuses?.length) rows.push(row('Status', a.listing_statuses.join(', ')));
  if (a.min_sqft || a.max_sqft) {
    const mn = a.min_sqft ? Number(a.min_sqft).toLocaleString() : '0';
    const mx = a.max_sqft ? Number(a.max_sqft).toLocaleString() : 'Any';
    rows.push(row('Sqft', `${mn} – ${mx} sqft`));
  }
  if (a.has_pool) rows.push(row('Pool', 'Yes'));
  if (a.max_hoa) rows.push(row('Max HOA', `$${Number(a.max_hoa).toLocaleString()}/mo`));
  if (a.frequency) rows.push(row('Frequency', a.frequency));
  return rows.join('');
}

// ── Email HTML builder ────────────────────────────────────────
function buildListingAlertEmail(
  firstName: string,
  alert: AlertRow,
  listings: Listing[]
): string {
  const ctaUrl = buildSearchUrl(alert);
  const shown = listings.slice(0, 5);
  const overflow = listings.length - shown.length;

  const cards = shown.map((l) => {
    const listingUrl = buildSearchUrl(alert, l.ListingKey);
    const photoUrl = l.Media?.[0]?.MediaURL || (l as any).media?.[0]?.MediaURL || (l as any).photos?.[0] || null;
    const photoCell = photoUrl
      ? `<a href="${listingUrl}" style="display:block;"><img src="${photoUrl}" width="130" height="100" style="display:block;width:130px;height:100px;object-fit:cover;border-radius:8px 0 0 8px;" alt="Property photo"></a>`
      : `<div style="width:130px;height:100px;background:#2A1800;border-radius:8px 0 0 8px;text-align:center;line-height:100px;"><span style="font-size:20px;">&#127968;</span></div>`;
    const price = '$' + l.ListPrice.toLocaleString();
    const details = [
      l.BedroomsTotal ? `${l.BedroomsTotal} bed` : '',
      l.BathroomsTotalInteger ? `${l.BathroomsTotalInteger} bath` : '',
      l.LivingArea ? `${l.LivingArea.toLocaleString()} sqft` : '',
    ].filter(Boolean).join(' &middot; ');
    const remarks = (l.PublicRemarks || '').substring(0, 80);
    return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#1E1200;border:1px solid #3A2400;border-radius:8px;margin-bottom:10px;"><tr>
<td width="130" style="padding:0;vertical-align:top;">${photoCell}</td>
<td style="padding:10px 14px;vertical-align:top;">
<div style="font-size:16px;font-weight:700;color:#C9A84C;">${price}</div>
<div style="font-size:12px;color:#A09070;margin:2px 0 4px;">${details}</div>
<div style="font-size:12px;color:#E0DDD4;margin-bottom:4px;">${l.UnparsedAddress}</div>
${remarks ? `<div style="font-size:11px;color:#6A6050;line-height:1.4;">${remarks}&hellip;</div>` : ''}
<a href="${listingUrl}" style="display:inline-block;margin-top:6px;padding:5px 14px;background:#C9A84C;color:#1A0E00;border-radius:5px;font-size:11px;font-weight:700;text-decoration:none;">View Listing &rarr;</a>
</td></tr></table>`;
  }).join('');

  const criteriaHtml = buildCriteriaRows(alert);
  const n = listings.length;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#1A1200;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#1A1200;">
<tr><td align="center" style="padding:24px 12px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
<!-- Header -->
<tr><td style="background:#1A1200;padding:16px 24px;border-bottom:2px solid #C9A84C;">
<table width="100%" cellpadding="0" cellspacing="0"><tr>
<td><div style="font-size:18px;font-weight:800;color:#C9A84C;">Rates &amp; Realty</div><div style="font-size:10px;color:#5A4820;text-transform:uppercase;letter-spacing:.12em;margin-top:1px;">Listing Alert</div></td>
<td align="right"><div style="background:rgba(201,168,76,.15);border:1px solid rgba(201,168,76,.4);color:#C9A84C;font-size:11px;font-weight:800;padding:4px 12px;border-radius:20px;">${n} New</div></td>
</tr></table>
</td></tr>
<!-- Subheader -->
<tr><td style="background:#1A1200;padding:20px 24px 12px;">
<div style="font-size:18px;font-weight:700;color:#F0EDE4;margin-bottom:4px;">${firstName}, ${n} home${n === 1 ? '' : 's'} match your &ldquo;${alert.name}&rdquo; alert!</div>
</td></tr>
<!-- Search Criteria -->
<tr><td style="padding:0 24px 16px;">
<div style="background:#261800;border:1px solid #4A3000;border-radius:8px;padding:12px 16px;font-size:13px;color:#C8A84A;">
<div style="font-size:11px;font-weight:700;color:#7A5820;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">Your Search</div>
<div style="font-weight:600;color:#F0EDE4;margin-bottom:6px;">${alert.name}</div>
${criteriaHtml}
</div>
</td></tr>
<!-- Listing Cards -->
<tr><td style="padding:0 24px;">
${cards}
${overflow > 0 ? `<div style="text-align:center;font-size:12px;color:#7A5820;padding:6px 0 10px;">…and ${overflow} more listing${overflow === 1 ? '' : 's'}</div>` : ''}
</td></tr>
<!-- CTA -->
<tr><td style="padding:12px 24px 20px;" align="center">
<a href="${ctaUrl}" style="display:inline-block;background:linear-gradient(135deg,#C9A84C,#e8c96a);color:#1A0E00;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:800;font-size:14px;">View All ${n} Matches &rarr;</a>
</td></tr>
<!-- Footer -->
<tr><td style="padding:16px 24px;border-top:1px solid #2A1800;">
<div style="font-size:11px;color:#4A4035;line-height:1.6;">Rene Duarte &middot; Rates &amp; Realty &middot; <a href="mailto:rene@ratesandrealty.com" style="color:#C9A84C;text-decoration:none;">rene@ratesandrealty.com</a> &middot; <a href="tel:7144728508" style="color:#C9A84C;text-decoration:none;">714-472-8508</a><br>NMLS #1795044 &middot; Equal Housing Lender</div>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ── Send email via MailerSend ─────────────────────────────────
async function sendEmail(
  to: string,
  toName: string,
  subject: string,
  html: string
): Promise<{ sent: boolean; error?: string }> {
  if (!MS_KEY) return { sent: false, error: "MAILERSEND_API_KEY not set" };
  try {
    const res = await fetch("https://api.mailersend.com/v1/email", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MS_KEY}`,
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({
        from: {
          email: "rene@ratesandrealty.com",
          name: "Rene Duarte | Rates & Realty",
        },
        to: [{ email: to, name: toName }],
        subject,
        html,
      }),
    });
    const txt = await res.text();
    console.log("[send-listing-alerts] MailerSend:", res.status, txt.substring(0, 200));
    return { sent: res.ok, error: res.ok ? undefined : `${res.status}: ${txt.substring(0, 200)}` };
  } catch (e: any) {
    return { sent: false, error: e.message };
  }
}

// ── Determine if alert is due for check ───────────────────────
function isDue(alert: AlertRow): boolean {
  if (!alert.last_sent_at) return true; // Never sent → due
  const last = new Date(alert.last_sent_at).getTime();
  const now = Date.now();
  const freq = (alert.frequency || "daily").toLowerCase();
  if (freq === "instant") return true; // Always check
  if (freq === "daily") return now - last > 23 * 60 * 60 * 1000;
  if (freq === "weekly") return now - last > 6.5 * 24 * 60 * 60 * 1000;
  return now - last > 23 * 60 * 60 * 1000; // Default daily
}

// ── Main handler ──���───────────────────────────────────────────
Deno.serve(async (_req: Request) => {
  const startTime = Date.now();
  console.log("[send-listing-alerts] ═══ Function invoked ═══");
  console.log("[send-listing-alerts] MS_KEY present:", !!MS_KEY);

  try {
    // 1. Fetch all active alerts
    const { data: alerts, error: alertErr } = await sb
      .from("listing_alerts")
      .select("*")
      .eq("is_active", true);

    if (alertErr) {
      console.error("[send-listing-alerts] DB error fetching alerts:", alertErr);
      return new Response(JSON.stringify({ error: alertErr.message }), {
        status: 500,
      });
    }

    if (!alerts?.length) {
      console.log("[send-listing-alerts] No active alerts found. Done.");
      return new Response(JSON.stringify({ processed: 0 }));
    }

    console.log(
      `[send-listing-alerts] Found ${alerts.length} active alerts:`,
      alerts.map((a: AlertRow) => `${a.id.substring(0, 8)}… "${a.name}"`).join(", ")
    );

    let totalSent = 0;
    let totalSkipped = 0;
    const debugLog: any[] = [];

    // 2. Process each alert
    for (const alert of alerts as AlertRow[]) {
      const tag = `[alert "${alert.name}" ${alert.id.substring(0, 8)}]`;
      const alog: any = { alert_name: alert.name, alert_id: alert.id.substring(0, 8) };

      // Check if due
      if (!isDue(alert)) {
        console.log(`${tag} Not due yet (freq=${alert.frequency}, last_sent=${alert.last_sent_at}). Skipping.`);
        alog.status = 'skipped_not_due';
        debugLog.push(alog);
        totalSkipped++;
        continue;
      }

      // Update last_checked_at
      await sb
        .from("listing_alerts")
        .update({ last_checked_at: new Date().toISOString() })
        .eq("id", alert.id);

      // 3. Fetch listings from MLS
      let listings: Listing[] = [];
      let mlsError = '';
      try {
        listings = await fetchMlsListings(alert);
        alog.mls_count = listings.length;
      } catch (err: any) {
        mlsError = err.message;
        console.log(`${tag} MLS fetch error: ${err.message}`);
        alog.mls_error = mlsError;
      }

      // TEMP: inject mock listings if MLS returns empty (remove after CRMLS approval)
      if (!listings || listings.length === 0) {
        console.log(`${tag} No MLS data — using mock listings for pipeline test`);
        listings = MOCK_LISTINGS;
        alog.using_mocks = true;
      }

      // 4. Filter out already-sent listings
      const { data: sentRows } = await sb
        .from("alert_sent_listings")
        .select("listing_key")
        .eq("alert_id", alert.id);
      const sentKeys = new Set((sentRows || []).map((r: any) => r.listing_key));
      const newListings = listings.filter((l) => !sentKeys.has(l.ListingKey));

      console.log(
        `${tag} ${listings.length} total, ${sentKeys.size} already sent, ${newListings.length} new`
      );

      alog.new_count = newListings.length;
      if (newListings.length === 0) {
        console.log(`${tag} No new listings to send.`);
        alog.status = 'skipped_no_new';
        debugLog.push(alog);
        continue;
      }

      // 5. Look up contact email
      let contactEmail = "";
      let contactName = "there";
      let contactPhone = "";
      if (alert.contact_id) {
        const { data: contact } = await sb
          .from("contacts")
          .select("email,first_name,last_name,phone")
          .eq("id", alert.contact_id)
          .single();
        if (contact) {
          contactEmail = contact.email || "";
          contactName = contact.first_name || "there";
          contactPhone = contact.phone || "";
        }
      }
      if (!contactEmail && alert.portal_user_id) {
        const { data: pu } = await sb
          .from("portal_users")
          .select("email,first_name,phone")
          .eq("id", alert.portal_user_id)
          .single();
        if (pu) {
          contactEmail = pu.email || "";
          contactName = pu.first_name || "there";
          contactPhone = contactPhone || pu.phone || "";
        }
      }

      alog.contact_email = contactEmail || null;
      alog.contact_name = contactName;
      if (!contactEmail) {
        console.log(`${tag} No contact email found. Skipping send.`);
        alog.status = 'skipped_no_email';
        debugLog.push(alog);
        continue;
      }

      console.log(`${tag} Sending ${newListings.length} listings to ${contactEmail}`);

      // 6. Send email
      const subject = `🏡 ${newListings.length} New Listing${newListings.length === 1 ? "" : "s"} — ${alert.name}`;
      const html = buildListingAlertEmail(contactName, alert, newListings);
      const emailResult = await sendEmail(contactEmail, contactName, subject, html);
      alog.email_sent = emailResult.sent;
      alog.email_error = emailResult.error || null;
      console.log(`${tag} Email result: ${emailResult.sent ? "SUCCESS" : "FAILED"} ${emailResult.error || ""}`);

      if (!emailResult.sent) {
        alog.status = 'email_failed';
        debugLog.push(alog);
        continue;
      }

      // 7. Insert into alert_sent_listings
      const sentInserts = newListings.map((l) => ({
        alert_id: alert.id,
        listing_key: l.ListingKey,
        sent_at: new Date().toISOString(),
      }));
      const { error: insertErr } = await sb
        .from("alert_sent_listings")
        .insert(sentInserts);
      if (insertErr) {
        console.log(`${tag} alert_sent_listings insert error:`, insertErr.message);
      } else {
        console.log(`${tag} Recorded ${sentInserts.length} sent listings in alert_sent_listings`);
      }

      // 8. Update alert: last_sent_at, total_sent
      const newTotal = (alert.total_sent || 0) + newListings.length;
      const { error: updateErr } = await sb
        .from("listing_alerts")
        .update({
          last_sent_at: new Date().toISOString(),
          total_sent: newTotal,
          updated_at: new Date().toISOString(),
        })
        .eq("id", alert.id);
      if (updateErr) {
        console.log(`${tag} Update last_sent_at error:`, updateErr.message);
      } else {
        console.log(`${tag} Updated last_sent_at, total_sent=${newTotal}`);
      }

      // 9. Log activity
      if (alert.contact_id) {
        await sb.from("activity_events").insert({
          contact_id: alert.contact_id,
          portal_user_id: alert.portal_user_id || null,
          type: "email",
          channel: "email",
          title: `Listing Alert: ${newListings.length} new matches for "${alert.name}"`,
          description: newListings.map((l) => l.UnparsedAddress).join("; "),
          status: "sent",
          email_subject: subject,
          email_to: contactEmail,
          email_from: "rene@ratesandrealty.com",
          metadata: JSON.stringify({
            alert_id: alert.id,
            listing_count: newListings.length,
            listing_keys: newListings.map((l) => l.ListingKey),
          }),
          created_at: new Date().toISOString(),
        });
      }

      // 10. Optional SMS notification
      if (contactPhone) {
        try {
          await fetch(SMS_FN, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization:
                "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
            },
            body: JSON.stringify({
              action: "send",
              to: contactPhone,
              body: `New listings match your "${alert.name}" search! Check your email for details. - Rene @ Rates & Realty`,
            }),
          });
          console.log(`${tag} SMS sent to ${contactPhone}`);
        } catch (smsErr: any) {
          console.log(`${tag} SMS error: ${smsErr.message}`);
        }
      }

      alog.status = 'sent';
      debugLog.push(alog);
      totalSent++;
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[send-listing-alerts] ═══ Done. ${totalSent} alerts sent, ${totalSkipped} skipped. ${elapsed}ms ═══`
    );

    return new Response(
      JSON.stringify({
        processed: alerts.length,
        sent: totalSent,
        skipped: totalSkipped,
        elapsed_ms: elapsed,
        ms_key_present: !!MS_KEY,
        ms_key_prefix: MS_KEY?.substring(0, 6) || 'none',
        debug: debugLog,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("[send-listing-alerts] Fatal error:", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});
