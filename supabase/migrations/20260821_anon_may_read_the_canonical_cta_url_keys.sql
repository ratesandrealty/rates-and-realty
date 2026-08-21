/* The public watch page (/v/<slug>, served by the Worker with the ANON key) reads
 * its CTA links from app_config. The allowlist permitted `video_cta_%` only, so
 * when the canonical `cta_%_url` keys were introduced the page could not see them
 * and silently kept rendering from the legacy fallback -- cta_schedule_url was set
 * and the Schedule button still did not appear.
 *
 * Caught by fetching the live page and diffing the buttons against the config,
 * not by reading the migration back. A key nobody can read is indistinguishable
 * from a key nobody set.
 *
 * Scope is unchanged in kind: these are public marketing URLs that already render
 * on a page served to anyone with the link. The allowlist stays an ALLOWLIST --
 * `cta_%_url` is a narrow, purpose-named prefix, not `cta_%` and not the table.
 * Verified after applying: anon reads the five cta rows and still gets [] for
 * ci_service_sid_en.
 */
drop policy if exists app_config_select_anon_safe on public.app_config;
create policy app_config_select_anon_safe on public.app_config
  for select to anon
  using (
    key = any (array[
      'google_drive_account_email',
      'tour_public_base_url',
      'short_link_base_url',
      'property_search_base_url'
    ])
    or key like 'video_cta_%'     -- legacy, still read as a fallback by the Worker
    or key like 'cta_%\_url'      -- canonical: shared by the watch page and the email signature
  );
