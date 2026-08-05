-- sync_drive_folder_urls()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sync_drive_folder_urls()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.gdrive_folder_id is not null and new.gdrive_folder_id <> '' then
    new.gdrive_folder_url := 'https://drive.google.com/drive/folders/' || new.gdrive_folder_id;
    new.google_drive_folder_url := 'https://drive.google.com/drive/folders/' || new.gdrive_folder_id;
  end if;
  return new;
end;
$function$;
