-- order_document_status(p_order_id uuid)
-- language: sql
-- Captured from production 2026-08-17.

CREATE OR REPLACE FUNCTION public.order_document_status(p_order_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
/* Returns exactly one of:

     no_reply     nothing has been correlated to this order
     document     a reply carried something that is a document and is NOT our own
                  form returning
     no_document  a reply arrived, we DID capture its attachment metadata, and
                  nothing in it qualifies
     unknown      a reply arrived but we have no attachment metadata for it

   THE FOURTH VALUE IS THE POINT. Replies correlated before attachments were
   captured have NULL there, and "we did not record it" is not the same claim as
   "the vendor attached nothing". Collapsing the two would produce a reminder
   accusing a vendor of failing to send something they may well have sent —
   the same could-not-run-versus-failed distinction the suppression notice keeps.

   OUR OWN FORM RETURNED IS NOT A DOCUMENT. It is the case that would otherwise
   close a VOE nobody filled in: HR hits reply-all, our blank comes back attached,
   and a naive "is there a PDF" says the document arrived. */
with r as (
  select q.attachments
  from public.quote_reply_log q
  where q.row_id = p_order_id
),
att as (
  select x->>'filename' as fn, (x->>'size')::bigint as size
  from r, jsonb_array_elements(r.attachments) x
  where jsonb_typeof(r.attachments) = 'array'
)
select case
  when not exists (select 1 from r) then 'no_reply'
  when exists (
    select 1 from att
    where public.attachment_stage1(att.fn, att.size) <> 'noise'
      and not public.attachment_is_our_form(att.fn)
  ) then 'document'
  when exists (select 1 from r where r.attachments is null) then 'unknown'
  else 'no_document'
end
$function$;
