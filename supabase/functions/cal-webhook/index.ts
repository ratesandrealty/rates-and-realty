import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const eventType: string = body.triggerEvent;
  const booking = body.payload;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  if (eventType === "BOOKING_CREATED") {
    const attendee = booking.attendees?.[0] ?? {};
    const name: string = attendee.name ?? "";
    const email: string = attendee.email ?? "";
    const phone: string = booking.responses?.phone?.value ?? "";

    // Extract property address pre-filled in the notes field
    const rawNotes: string =
      booking.responses?.notes?.value ?? booking.description ?? "";
    const propertyMatch = rawNotes.match(/Property:\s*(.+)/i);
    const propertyAddress: string = propertyMatch
      ? propertyMatch[1].trim()
      : rawNotes.trim();

    const startTime = new Date(booking.startTime);
    const preferredDate = startTime.toISOString().split("T")[0];
    const preferredTime = startTime.toTimeString().slice(0, 5);

    const { error } = await supabase.from("showings").insert({
      name,
      email,
      phone: phone || null,
      property_address: propertyAddress || null,
      preferred_date: preferredDate,
      preferred_time: preferredTime,
      status: "confirmed",
    });

    if (error) {
      console.error("Insert error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  } else if (eventType === "BOOKING_CANCELLED") {
    // Cal.com sends the booking UID on cancellation
    const uid: string = booking.uid;

    // Match by cal_booking_uid if stored, otherwise fall back to email + date
    const email: string = booking.attendees?.[0]?.email ?? "";
    const startTime = new Date(booking.startTime);
    const preferredDate = startTime.toISOString().split("T")[0];

    const { error } = await supabase
      .from("showings")
      .update({ status: "cancelled" })
      .eq("email", email)
      .eq("preferred_date", preferredDate);

    if (error) {
      console.error("Update error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
