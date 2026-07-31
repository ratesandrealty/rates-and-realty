# Rates & Realty — working notes

## Deploying

**Always deploy with `bash tools/deploy.sh`. Never a bare `npx wrangler deploy`.**

```
bash tools/deploy.sh [https://host-to-verify]     # default https://admin.ratesandrealty.com
```

Three steps, and only the script does all three:

1. `node tools/stamp-assets.mjs --check` — refuse to deploy while any `?v=` cache
   pin disagrees with its asset's content hash.
2. `npx wrangler deploy`
3. `node tools/verify-deploy.mjs` — fetch the LIVE html, read the pins it actually
   asks for, fetch the asset at each pinned URL, compare to what shipped. Curling
   the asset path directly does **not** catch this class of bug.

`wrangler.toml` has a `[build]` hook running step 1, so a bare `wrangler deploy`
aborts on stale pins — but the hook cannot do step 3. Use the script.

### Why stale pins are now serious

`src/worker.js` serves any `?v=`-pinned asset as
`public, max-age=31536000, immutable`. That is safe *because* the pin is a content
hash: change the file, the URL changes. But it means a stale pin no longer
self-heals. Before, `max-age=0, must-revalidate` meant the next page load picked
up new bytes anyway. Now a returning browser keeps the old file with no
revalidation until a corrected deploy changes the pin — so a forgotten restamp
silently freezes every returning user on old code.

**Changed a file under `admin/js/`, `assets/`, or anything referenced with `?v=`?**
Run `node tools/stamp-assets.mjs` and commit the rewritten pins with the change.
Pins are source, not a deploy-time mutation.

Unpinned URLs deliberately keep `must-revalidate` — caching `/admin/js/inbox.js`
hard with no pin in the URL would strand a stale copy with no way to bust it.

## Edge functions

Only some of the ~126 deployed Supabase edge functions have source in this repo.
Before editing one, pull the deployed copy and diff it — the repo is not
authoritative for functions not present here. Deploy with:

```
supabase functions deploy <name> --project-ref ljywhvbmsibwnssxpesh --no-verify-jwt
```

Drop `--no-verify-jwt` for functions that require an authenticated caller
(`gmail-inbox` pins `verify_jwt = true` in `supabase/config.toml`).

## Security boundaries worth not breaking

- `gmail-inbox` downloads outbound attachments with the **service role**, which
  bypasses storage RLS. `_shared/attach.ts::attachmentPathError()` is the only
  control confining a path to the caller's own mailbox prefix. The mailbox is
  derived server-side from the verified JWT + `auth_user_roles`, never from the
  request body. Verified live: admin→processing@ prefix, admin→arbitrary object,
  va→rene@ prefix, va→rene@ mailbox, and `../` traversal all return 403.
- `video-track` must never read the viewer's identity from `authorization` — the
  Worker overwrites that header with the anon key to invoke the function at all.
  Self-view signals arrive as `x-viewer-staff` (from the `rr_staff` cookie
  `auth-guard.js` scopes to `.ratesandrealty.com`) and `x-viewer-jwt`.
- The public `/v/<slug>` page must never read a Supabase session from
  localStorage. It is served to borrowers, so any token it finds may be theirs.
