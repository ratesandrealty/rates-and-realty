-- search_guideline_chunks_text(search_query text, filter_agencies text[], filter_loan_types text[], match_count integer)
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.search_guideline_chunks_text(search_query text, filter_agencies text[] DEFAULT NULL::text[], filter_loan_types text[] DEFAULT NULL::text[], match_count integer DEFAULT 10)
 RETURNS TABLE(id uuid, guideline_id uuid, guideline_title text, chunk_text text, page_number integer, agency text, loan_types text[], rank double precision)
 LANGUAGE plpgsql
 STABLE
AS $function$
begin
  return query
  select
    gc.id,
    gc.guideline_id,
    gg.title as guideline_title,
    gc.chunk_text,
    gc.page_number,
    gc.agency,
    gc.loan_types,
    ts_rank(
      to_tsvector('english', gc.chunk_text),
      plainto_tsquery('english', search_query)
    )::double precision as rank
  from global_guideline_chunks gc
  join global_guidelines gg on gg.id = gc.guideline_id
  where
    gg.is_active = true
    and to_tsvector('english', gc.chunk_text) @@ plainto_tsquery('english', search_query)
    and (filter_agencies is null or gc.agency = any(filter_agencies))
    and (filter_loan_types is null or gc.loan_types && filter_loan_types)
  order by rank desc
  limit match_count;
end;
$function$;
