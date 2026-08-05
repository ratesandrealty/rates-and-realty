-- lead_tag_create(p_name text, p_color text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.lead_tag_create(p_name text, p_color text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'must be signed in'; end if;
  if coalesce(trim(p_name),'')='' then raise exception 'tag name required'; end if;
  select id into v_id from tags where lower(name)=lower(trim(p_name)) limit 1;
  if v_id is null then
    insert into tags(name, color) values (trim(p_name), coalesce(nullif(p_color,''),'#c9a84c')) returning id into v_id;
  elsif p_color is not null and p_color <> '' then
    update tags set color=p_color where id=v_id;
  end if;
  return v_id;
end;
$function$;
