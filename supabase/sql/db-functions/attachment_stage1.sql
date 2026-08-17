-- attachment_stage1(p_filename text, p_size bigint)
-- language: sql
-- Captured from production 2026-08-17.

CREATE OR REPLACE FUNCTION public.attachment_stage1(p_filename text, p_size bigint)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
/* Stage 1 of "did the expected document arrive" — pure SQL, no model.
   Returns 'noise' | 'named:<kind>' | 'unnamed'.

   EXTENSION, NOT MIME TYPE. Measured on the 105 inbound attachments held
   2026-08-17: 10 of 93 PDFs arrive as application/octet-stream. Filtering on
   mimeType='application/pdf' silently drops 1 in 9 real documents.

   THE SIZE FLOOR IS 2KB, NOT 50KB. The noise cluster is genuinely tiny and
   cleanly separated — image001.png at 88 bytes (x3), html parts at ~461 bytes,
   a jpg at 823 bytes. The smallest REAL document is a 7.7KB pdf, and two docx
   land at 47KB and 57KB. A 50KB floor — the obvious guess — would have thrown
   all three away. 2KB separates the observed noise from the observed documents
   with an order of magnitude of headroom either side.

   NOT filtering on contentId: a 3.2MB lease and a 1.2MB blank VOE form both
   carry one, so "inline" does not mean "logo" here.

   The named patterns are deliberately conservative. A false 'named' asserts we
   know what arrived; 'unnamed' only asserts we cannot tell from the filename,
   which is what stage 2 exists to answer. */
select case
  when coalesce(p_size, 0) < 2048 then 'noise'
  when lower(regexp_replace(coalesce(p_filename,''), '^.*\.', '')) not in
       ('pdf','doc','docx','xls','xlsx','csv','eml','jpg','jpeg','png','tif','tiff')
    then 'noise'
  when p_filename ~* '(verification of employment|_voe_|\yvoe\y)'      then 'named:voe'
  when p_filename ~* '(prelim|title commitment|\ycommitment\y|title report)' then 'named:title'
  when p_filename ~* '(appraisal)'                                      then 'named:appraisal'
  when p_filename ~* '(payoff|demand statement|\ydemand\y)'             then 'named:payoff'
  when p_filename ~* '(binder|dec page|declaration page|evidence of insurance|mortgagee clause|\ypolicy\y|home quote|\yquote\y)' then 'named:hoi'
  when p_filename ~* '(escrow instruction|closing disclosure|\yestimated closing\y)' then 'named:escrow'
  else 'unnamed'
end
$function$;
