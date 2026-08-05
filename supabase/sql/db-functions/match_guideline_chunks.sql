-- match_guideline_chunks(query_embedding vector, match_count integer, lender_filter uuid[], loan_type_filter text[])
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.match_guideline_chunks(query_embedding vector, match_count integer DEFAULT 8, lender_filter uuid[] DEFAULT NULL::uuid[], loan_type_filter text[] DEFAULT NULL::text[])
 RETURNS TABLE(id uuid, guideline_id uuid, lender_id uuid, chunk_text text, page_number integer, chunk_index integer, category text, similarity double precision)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    gc.id,
    gc.guideline_id,
    gc.lender_id,
    gc.chunk_text,
    gc.page_number,
    gc.chunk_index,
    gc.category,
    1 - (gc.embedding <=> query_embedding) AS similarity
  FROM guideline_chunks gc
  WHERE gc.embedding IS NOT NULL
    AND (lender_filter IS NULL OR gc.lender_id = ANY(lender_filter))
    AND (loan_type_filter IS NULL OR gc.loan_types && loan_type_filter)
  ORDER BY gc.embedding <=> query_embedding
  LIMIT match_count;
END;
$function$;
