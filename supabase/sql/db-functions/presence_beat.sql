-- presence_beat()
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-06 (presence heartbeat).

CREATE OR REPLACE FUNCTION public.presence_beat()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* One heartbeat. Called every 60s by an open staff page while the tab is
 * visible. beat_at is server time — never accepted from the client, so a skewed
 * or tampered clock cannot inflate active time.
 *
 * Cheap on purpose: no dedupe, no upsert, no read. A duplicate beat is
 * harmless because active time is derived by gap-sessionising, not by counting
 * rows. */
begin
  if auth.uid() is null then return; end if;
  insert into public.presence_beats(user_id) values (auth.uid());
end; $function$;
