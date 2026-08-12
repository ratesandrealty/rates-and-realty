-- help_topic_delete(p_key text)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.help_topic_delete(p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.help_topics;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  delete from public.help_topics where topic_key = p_key returning * into v_row;
  if v_row.topic_key is null then
    return jsonb_build_object('ok', true, 'deleted', false, 'reason', 'no such topic');
  end if;
  return jsonb_build_object('ok', true, 'deleted', true, 'topic_key', p_key);
end; $function$;
