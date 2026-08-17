-- attachment_is_our_form(p_filename text)
-- language: sql
-- Captured from production 2026-08-17.

CREATE OR REPLACE FUNCTION public.attachment_is_our_form(p_filename text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
/* NORMALISED NAME, AND SIZE IS IGNORED ON PURPOSE. Measured 2026-08-17: our copy
   is 'Request for VOE BLANK.pdf' at 1,239,853 bytes and the copy that comes back
   is 'Request_for_VOE_BLANK.pdf' at 1,362,040. Forwarding rewrites the filename
   and the blank was a different revision, so an exact (name, size) match scored
   ZERO against real data. Normalising case and underscores/spaces found 8.

   Data-driven from what we have actually sent, plus the two known blanks by name
   because the sends that carried them predate attachment logging — those three
   threads carry no outbound attachments at all. */
select exists (
  select 1
  from public.email_log e, jsonb_array_elements(e.attachments) x
  where e.direction = 'outbound'
    and jsonb_typeof(e.attachments) = 'array'
    and lower(regexp_replace(coalesce(x->>'filename',''), '[_\s]+', ' ', 'g'))
      = lower(regexp_replace(coalesce(p_filename,''), '[_\s]+', ' ', 'g'))
    and coalesce(p_filename,'') <> ''
)
or lower(regexp_replace(coalesce(p_filename,''), '[_\s]+', ' ', 'g')) in (
  'request for voe blank.pdf',
  'borrower authorization signed.pdf'
)
$function$;
