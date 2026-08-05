-- gen_search_slug()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.gen_search_slug()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare alphabet text := 'abcdefghijkmnpqrstuvwxyz23456789'; s text := ''; i int;
begin
  for i in 1..7 loop s := s || substr(alphabet, 1 + floor(random()*length(alphabet))::int, 1); end loop;
  return s;
end; $function$;
