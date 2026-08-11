-- tg_loan_conditions_stamp_cleared()
-- language: plpgsql   SECURITY DEFINER
-- Added 2026-08-11. Captured on creation — observe-db-functions diffs
-- production against this directory, so an uncaptured function reads as
-- movement on every run.
--
-- WHY: loan_conditions.cleared_by is TEXT and had THREE writers that disagreed
-- about what it holds --
--   extract-conditions/index.ts   cleared_by = cleared_by || 'Rene'  (client
--                                 string, named-human fallback; produced all 9
--                                 populated rows)
--   condition_set_status.sql      cleared_by = auth.uid()
--   condition_attach.sql          cleared_by = auth.uid()
-- so whether a row named a person or held a uuid depended on the path taken.
-- Nothing renders the column, which is why it went unnoticed.
--
-- This records who signed off on a lender condition, so the rule from
-- tg_processing_items_stamp_completion applies with more force: a row that
-- cannot name a person must not name one. Attribution is overwritten from
-- auth.uid() on the transition into 'cleared' and pinned to OLD otherwise, so a
-- client PATCH cannot rewrite who signed off. Both forgery paths probed on the
-- ZZ-TEST fixture.
--
-- 'system' exists because extract-conditions runs with the service role:
-- auth.uid() is null there and a service-role clear must name nobody.

CREATE OR REPLACE FUNCTION public.tg_loan_conditions_stamp_cleared()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare entering boolean; leaving boolean;
begin
  entering := NEW.status = 'cleared'
              and (TG_OP = 'INSERT' or OLD.status is distinct from NEW.status);
  leaving  := TG_OP = 'UPDATE' and OLD.status = 'cleared' and NEW.status is distinct from 'cleared';
  if entering then
    if NEW.cleared_at is null then NEW.cleared_at := now(); end if;
    if NEW.cleared_source = 'system' or auth.uid() is null then
      NEW.cleared_source := 'system'; NEW.cleared_by_user_id := null;
    else
      NEW.cleared_source := 'user';   NEW.cleared_by_user_id := auth.uid();
    end if;
  elsif leaving then
    NEW.cleared_at := null; NEW.cleared_by_user_id := null;
    NEW.cleared_source := null; NEW.cleared_by := null;
  elsif TG_OP = 'UPDATE' then
    NEW.cleared_by_user_id := OLD.cleared_by_user_id;
    NEW.cleared_source     := OLD.cleared_source;
  end if;
  return NEW;
end; $function$;
