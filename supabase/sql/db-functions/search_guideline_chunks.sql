-- search_guideline_chunks(query_embedding vector, match_count integer, lender_filter uuid, agency_filter text, category_filter text, loan_type_filter text)
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.search_guideline_chunks(query_embedding vector, match_count integer DEFAULT 8, lender_filter uuid DEFAULT NULL::uuid, agency_filter text DEFAULT NULL::text, category_filter text DEFAULT NULL::text, loan_type_filter text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, guideline_id uuid, lender_id uuid, chunk_text text, chunk_index integer, page_number integer, category text, loan_types text[], similarity double precision, source_type text, source_title text, source_lender text, source_agency text)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  -- Lender-specific chunks
  SELECT
    gc.id,
    gc.guideline_id,
    gc.lender_id,
    gc.chunk_text,
    gc.chunk_index,
    gc.page_number,
    gc.category,
    gc.loan_types,
    1 - (gc.embedding <=> query_embedding) AS similarity,
    'lender'::text AS source_type,
    lg.title AS source_title,
    l.name AS source_lender,
    NULL::text AS source_agency
  FROM guideline_chunks gc
  JOIN lender_guidelines lg ON lg.id = gc.guideline_id
  LEFT JOIN lenders l ON l.id = gc.lender_id
  WHERE gc.embedding IS NOT NULL
    AND (lender_filter IS NULL OR gc.lender_id = lender_filter)
    AND (category_filter IS NULL OR gc.category = category_filter)
    AND (loan_type_filter IS NULL OR gc.loan_types @> ARRAY[loan_type_filter])

  UNION ALL

  -- Global agency chunks
  SELECT
    ggc.id,
    ggc.guideline_id,
    NULL::uuid AS lender_id,
    ggc.chunk_text,
    ggc.chunk_index,
    ggc.page_number,
    ggc.category,
    ggc.loan_types,
    1 - (ggc.embedding <=> query_embedding) AS similarity,
    'global'::text AS source_type,
    gg.title AS source_title,
    NULL::text AS source_lender,
    ggc.agency AS source_agency
  FROM global_guideline_chunks ggc
  JOIN global_guidelines gg ON gg.id = ggc.guideline_id
  WHERE ggc.embedding IS NOT NULL
    AND (agency_filter IS NULL OR ggc.agency = agency_filter)
    AND (category_filter IS NULL OR ggc.category = category_filter)
    AND (loan_type_filter IS NULL OR ggc.loan_types @> ARRAY[loan_type_filter])

  ORDER BY similarity DESC
  LIMIT match_count;
END;
$function$;
