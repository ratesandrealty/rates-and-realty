/**
 * Cloudflare Worker entry — serves /api/env.js and /config dynamically so
 * secrets come from Cloudflare bindings instead of git.
 * Also blocks access to sensitive paths that were accidentally uploaded.
 */
const BLOCKED_PREFIXES = [
  '/.git',
  '/.github',
  '/.wrangler',
  '/.claude',
  '/.vscode',
  '/.idea',
  '/node_modules',
  '/supabase',
  '/src/',
  '/.gitignore',
  '/.gitattributes',
  '/.assetsignore',
  '/wrangler.toml',
  '/package.json',
  '/package-lock.json',
  '/lender_import.js',
  '/README.md',
];

// The Worker serves ONE asset bundle for every host, split only by path — so the
// admin CRM (/admin/*, /dashboard/*) would otherwise be reachable on the public
// domains too. These sets drive the admin gate below: on any PUBLIC host, admin
// paths are bounced to the ADMIN host; the ADMIN host itself is never gated.
const PUBLIC_HOSTS = new Set([
  'ratesandrealty.com',
  'www.ratesandrealty.com',
  'homes.ratesandrealty.com',
  'beta.ratesandrealty.com',
]);
const ADMIN_HOST = 'admin.ratesandrealty.com';

/* Pages reachable at a SHORT URL: /portal serves public/portal.html, the way
 * /admin/people already serves admin/people.html.
 *
 * WHY AN EXPLICIT LIST. The obvious implementation — try public/<slug>.html and
 * fall through if it 404s — cannot work: the asset binding used to answer a
 * missing file with index.html and a 200, so "does this file exist" had no
 * answer. That is fixed below, but an explicit list is still the right shape:
 * it makes the set of public URLs reviewable, and tools/check-short-urls.mjs
 * fails the build if it drifts from public/*.html.
 *
 * DELIBERATE OMISSIONS, all four for different reasons:
 *   fee, cma        — already routed as /fee/<slug> and /cma/<slug>; the pages
 *                     read that slug from location.pathname, so a bare /fee
 *                     would render a snapshot page with nothing to render.
 *   admin-chat      — moving to admin/chat-conversations.html, behind the gate.
 *   privacy-policy,
 *   terms-of-service — NOT duplicates of the root privacy.html / terms.html.
 *                     They carry the credit-repair funnel's CROA disclaimer,
 *                     payment terms and 30-day refund policy, which the root
 *                     pair does not; the root pair carries SMS terms and CCPA
 *                     rights, which these do not. Pending a merge, neither
 *                     version gets promoted to a short URL. */
const PUBLIC_PAGES = new Set([
  'about', 'apply', 'bank-statement', 'commercial', 'contact', 'conventional',
  'credit-optimization', 'down-payment-assistance', 'dscr', 'dscr-investor',
  'fha', 'first-time-buyer', 'fix-flip', 'jumbo', 'lender-form', 'portal',
  'property-detail', 'realtor-referral', 'refinance', 'refund-policy',
  'search-homes', 'thank-you-credit', 'unified-portal', 'va',
]);
/* Old paths that must keep resolving, as a 301 rather than a page. public/
 * search.html is a 248-byte stub whose entire body is a meta-refresh to
 * search-homes.html — a redirect pretending to be a page. Served here it costs
 * one round trip instead of two, and tells a crawler what actually happened. */
const REDIRECTS = new Map([['search', '/search-homes']]);
/* Marketing pages that live at the repo root rather than under public/. The
 * legal pair here is the one linked from all 48 footers and updated most
 * recently; see the note above. */
const ROOT_PAGES = new Set(['privacy', 'terms', 'sms-consent']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // === ADMIN GATE ON PUBLIC HOSTS ================================
    // On any PUBLIC host, /admin/* and /dashboard/* must NOT serve the CRM — bounce
    // them to the admin host (same path + query) so the admin app is never exposed
    // on the public domains. The ADMIN host (admin.ratesandrealty.com) is not in
    // PUBLIC_HOSTS, so its behavior is unchanged. Everything else falls through.
    {
      const host = url.hostname;
      if (PUBLIC_HOSTS.has(host) &&
          (path === '/admin' || path.startsWith('/admin/') ||
           path === '/dashboard' || path.startsWith('/dashboard/'))) {
        const dest = new URL(request.url);
        dest.hostname = ADMIN_HOST;
        return Response.redirect(dest.toString(), 302);
      }
    }
    // === END ADMIN GATE ============================================

    // === ADMIN HOST ROOT → CRM LOGIN ===============================
    // The Worker serves the shared public homepage (index.html) at "/" on every
    // host, and bare "/admin" / "/dashboard" (no page) also SPA-fall-back to it.
    // On the ADMIN host that's wrong — Rene expects the CRM. Send those entry
    // paths to the admin login, which auto-forwards an already-signed-in user on
    // to their dashboard (people / va-dashboard) and shows the login otherwise.
    // Only these bare entry paths on the admin host are affected; every deeper
    // admin path (/admin/people, /dashboard/admin, …) and all public hosts are
    // untouched.
    if (url.hostname === ADMIN_HOST &&
        (path === '/' || path === '/admin' || path === '/admin/' ||
         path === '/dashboard' || path === '/dashboard/')) {
      return Response.redirect('https://' + ADMIN_HOST + '/auth/admin-login.html', 302);
    }
    // === END ADMIN HOST ROOT =======================================

    // === CANONICAL HOST REDIRECTS ==================================
    // The apex (ratesandrealty.com) is canonical for the public app. Forward the
    // www alias and the legacy beta host to it, preserving path + query, with a
    // 301 so browsers/crawlers update. apex + homes serve the app directly.
    {
      const host = url.hostname;
      if (host === 'www.ratesandrealty.com' || host === 'beta.ratesandrealty.com') {
        const dest = new URL(request.url);
        dest.hostname = 'ratesandrealty.com';
        return Response.redirect(dest.toString(), 301);
      }
    }
    // === END CANONICAL HOST REDIRECTS ==============================

    /* === THE HOMEPAGE, ROUTED EXPLICITLY ===========================
     * "/" used to arrive here through the asset binding's not_found_handling
     * = "single-page-application", which answered EVERY unmatched path with
     * index.html and a 200. That fallback is gone (see the 404 handler at the
     * bottom), and html_handling = "none" means "/" resolves to no asset on its
     * own — so the homepage has to be named. This must stay ABOVE every
     * clean-URL rule below; it is the one path the fallback was load-bearing
     * for. */
    if ((request.method === 'GET' || request.method === 'HEAD') && (path === '/' || path === '/index.html')) {
      const newUrl = new URL(request.url);
      newUrl.pathname = '/index.html';
      return withCsp(await env.ASSETS.fetch(new Request(newUrl, request)), path);
    }
    // === END HOMEPAGE ==============================================

    /* === VIDEO LANDING PAGE (/v/{slug}) ============================
     * Canonical route for a personal video. Three sub-paths, all same-origin so
     * a recipient never sees ljywhvbmsibwnssxpesh.supabase.co:
     *   /v/{slug}          the page
     *   /v/{slug}/media    the video bytes, proxied WITH Range support
     *   /v/{slug}/track    engagement events  -> video-track
     *   /v/{slug}/chat     AI assistant       -> video-chat
     * Range matters: without it Safari refuses to play and nobody can seek. */
    {
      const SB = env.SUPABASE_URL || 'https://ljywhvbmsibwnssxpesh.supabase.co';
      const seg = path.split('/').filter(Boolean);

      // Legacy links already in inboxes must keep resolving. 301 to canonical.
      if ((path === '/watch.html' || path === '/watch') && url.searchParams.get('v')) {
        return Response.redirect(
          `${url.origin}/v/${encodeURIComponent(url.searchParams.get('v'))}`, 301);
      }

      if (seg[0] === 'v' && seg[1]) {
        const slug = decodeURIComponent(seg[1]).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
        const sub = seg[2] || '';
        const viewerIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
        const viewerUa = request.headers.get('user-agent') || '';

        const resolve = async () => {
          const r = await fetch(`${SB}/rest/v1/rpc/video_get_public`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
            body: JSON.stringify({ p_slug: slug }),
          });
          if (!r.ok) return null;
          const j = await r.json();
          return j && j.found ? j : null;
        };

        // ── event + chat relays: keep Supabase off the client entirely ──
        if (sub === 'track' || sub === 'chat') {
          if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
          const fn = sub === 'track' ? 'video-track' : 'video-chat';
          const payload = await request.text();

          /* SELF-VIEW SIGNAL — the viewer's own session, preserved.
           * `Authorization` on the upstream call MUST be the anon key or the
           * function won't invoke, so setting it here overwrites whatever the
           * browser sent. That is why video-track's staff check never fired: it
           * read `authorization` and only ever saw the anon key. Carry the real
           * viewer identity in separate headers instead.
           *   x-viewer-staff — the cross-subdomain marker auth-guard.js sets on
           *                    .ratesandrealty.com. It covers admin.* AND the apex,
           *                    so it carries the whole browser-based case on its own.
           *   x-viewer-jwt   — an Authorization header, when a PROGRAMMATIC caller
           *                    sends one. The page no longer puts a token in the
           *                    beacon body: that shipped the access token of any
           *                    viewer holding a session on this origin — including a
           *                    borrower with a portal login — for a signal the cookie
           *                    already provides. No credential belongs in a body a
           *                    public page composes.
           * Both are suppression HINTS, never grants: the worst a forged value can
           * do is stop the forger's own view from scoring. */
          let viewerJwt = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
          if (viewerJwt === env.SUPABASE_ANON_KEY) viewerJwt = '';
          const staffCookie = /(?:^|;\s*)rr_staff=1(?:;|$)/.test(request.headers.get('cookie') || '');

          const up = await fetch(`${SB}/functions/v1/${fn}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: env.SUPABASE_ANON_KEY,
              Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
              // The viewer's real IP/UA under OUR header names — the functions
              // trust these because only this Worker can set them.
              'x-viewer-ip': viewerIp,
              'x-viewer-ua': viewerUa,
              'x-viewer-jwt': viewerJwt.slice(0, 4096),
              'x-viewer-staff': staffCookie ? '1' : '0',
            },
            body: payload,
          });
          return new Response(up.body, {
            status: up.status,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          });
        }

        // ── media proxy with Range passthrough ──
        if (sub === 'media') {
          const meta = await resolve();
          if (!meta || !meta.storage_path) return new Response('Not found', { status: 404 });
          const origin = `${SB}/storage/v1/object/public/video-messages/${meta.storage_path
            .split('/').map(encodeURIComponent).join('/')}`;
          const fwd = new Headers();
          const range = request.headers.get('range');
          if (range) fwd.set('range', range);
          const up = await fetch(origin, { method: request.method === 'HEAD' ? 'HEAD' : 'GET', headers: fwd });
          /* Supabase storage flattens its errors to HTTP 400 with the real status in
           * the JSON body. Passing that through would hand a <video> element a 400
           * and a JSON payload; surface a plain 404 instead so the player fails
           * cleanly and nothing about the origin leaks. */
          if (up.status !== 200 && up.status !== 206) {
            return new Response('Video unavailable', { status: 404, headers: { 'Cache-Control': 'no-store' } });
          }
          const h = new Headers();
          // Copy only what a media element needs; drop anything naming the origin.
          ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']
            .forEach((k) => { const v = up.headers.get(k); if (v) h.set(k, v); });
          if (!h.has('accept-ranges')) h.set('accept-ranges', 'bytes');
          if (!h.has('content-type')) h.set('content-type', meta.mime_type || 'video/mp4');
          h.set('Cache-Control', 'private, max-age=3600');
          h.set('X-Content-Type-Options', 'nosniff');
          return new Response(up.body, { status: up.status, headers: h });
        }

        // ── poster proxy (same reasoning as media) ──
        if (sub === 'poster') {
          const meta = await resolve();
          if (!meta) return new Response('Not found', { status: 404 });
          /* No stored poster → a BRANDED STATIC image, never a frame of the
           * recording.
           *
           * Poster capture used to take a real frame off the live preview while
           * recording. For a screen recording that frame is whatever was on
           * screen — routinely a borrower's lead-detail page, with their name,
           * phone and email in it. The /v/ page is public and gets forwarded, so
           * that would publish borrower PII as a thumbnail to anyone holding the
           * link. Capture is deliberately NOT restored; see the note in
           * loom-recorder.js. Every video currently has poster_path null, so
           * nothing has been exposed. */
          if (!meta.poster_url) {
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">'
              + '<rect width="1280" height="720" fill="#0F0F11"/>'
              + '<circle cx="640" cy="330" r="86" fill="none" stroke="#C9A84C" stroke-width="5" opacity=".9"/>'
              + '<path d="M614 284 L614 376 L692 330 Z" fill="#C9A84C"/>'
              + '<text x="640" y="486" text-anchor="middle" font-family="Segoe UI,Arial,Helvetica,sans-serif"'
              + ' font-size="34" font-weight="700" letter-spacing="6" fill="#C9A84C">RATES &amp; REALTY</text>'
              + '<text x="640" y="530" text-anchor="middle" font-family="Segoe UI,Arial,Helvetica,sans-serif"'
              + ' font-size="21" fill="#8b8b8b">A personal video message</text></svg>';
            return new Response(svg, {
              headers: {
                'content-type': 'image/svg+xml; charset=utf-8',
                'Cache-Control': 'public, max-age=86400',
                'X-Content-Type-Options': 'nosniff',
              },
            });
          }
          const up = await fetch(meta.poster_url);
          const h = new Headers();
          ['content-type', 'content-length', 'etag'].forEach((k) => { const v = up.headers.get(k); if (v) h.set(k, v); });
          h.set('Cache-Control', 'private, max-age=3600');
          return new Response(up.body, { status: up.status, headers: h });
        }

        // ── the page ──
        if (!sub) {
          const meta = await resolve();
          if (!meta) {
            return new Response(videoNotFoundHtml(), {
              status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
            });
          }
          // CTA buttons come from app_config; a key that is unset simply has no
          // button. Only Document Upload is confirmed working today.
          let ctas = {};
          try {
            const cr = await fetch(`${SB}/rest/v1/app_config?select=key,value&key=like.video_cta_*`, {
              headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
            });
            if (cr.ok) for (const row of await cr.json()) ctas[row.key] = row.value;
          } catch (_) { /* no config → no optional buttons, page still works */ }
          return new Response(videoPageHtml(slug, meta, ctas), {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          });
        }
      }
    }
    // === END VIDEO LANDING PAGE ====================================

    // === SHORT-LINK REDIRECTOR (/r/{id}) ============================
    // Pretty-URL handler for SMS links generated by track-event v4.
    // Proxies to the Supabase track-event function which logs the click,
    // bumps click_count, fires the lead scorer, then 302s to the
    // destination. Placed at the top so the dashboard / API paths below
    // can't accidentally claim it.
    {
      const segments = path.split('/').filter(Boolean);
      // Accept GET and HEAD — browsers send GET when a link is clicked,
      // but HEAD is used by link-preview crawlers and curl -I health checks.
      if ((request.method === 'GET' || request.method === 'HEAD') && segments[0] === 'r' && segments[1]) {
        const id = segments[1];
        // id is opaque — be strict so junk paths fall through to ASSETS
        if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
          const supabaseBase = env.SUPABASE_URL || 'https://ljywhvbmsibwnssxpesh.supabase.co';
          const upstreamUrl = `${supabaseBase}/functions/v1/track-event/t/${id}`;
          try {
            const upstream = await fetch(upstreamUrl, {
              method: 'GET',
              headers: {
                'user-agent': request.headers.get('user-agent') || '',
                'x-forwarded-for':
                  request.headers.get('cf-connecting-ip') ||
                  request.headers.get('x-forwarded-for') || '',
                'referer': request.headers.get('referer') || '',
              },
              redirect: 'manual',
            });
            if (upstream.status === 301 || upstream.status === 302) {
              const location = upstream.headers.get('location');
              if (location) return Response.redirect(location, 302);
            }
            if (upstream.status === 404) {
              return new Response('This link has expired or is invalid.', {
                status: 404,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              });
            }
            return new Response(await upstream.text(), {
              status: upstream.status,
              headers: { 'content-type': upstream.headers.get('content-type') || 'text/plain' },
            });
          } catch (e) {
            console.error('Short-link /r proxy error:', e);
            return new Response('Link service unavailable.', { status: 502 });
          }
        }
      }
    }
    // === END SHORT-LINK REDIRECTOR =================================

    // === SHOWING TOUR PUBLIC VIEWER (/tour/{token}) =================
    // Proxies the lead-facing itinerary HTML rendered by tour-public-view.
    // The upstream returns HTML in the body but tags it application/json in
    // the Content-Type header (Supabase function header bug); we override
    // to text/html so browsers actually render it. GET/HEAD only — POSTs
    // would mean someone is hitting the wrong path.
    {
      const tourSegs = path.split('/').filter(Boolean);
      if ((request.method === 'GET' || request.method === 'HEAD') &&
          tourSegs[0] === 'tour' && tourSegs[1]) {
        const tail = tourSegs.slice(1).join('/');
        try {
          const upstream = await fetch(
            `${env.SUPABASE_URL || 'https://ljywhvbmsibwnssxpesh.supabase.co'}/functions/v1/tour-public-view/${tail}`,
            {
              method: 'GET',
              headers: {
                'user-agent': request.headers.get('user-agent') || '',
                'x-forwarded-for':
                  request.headers.get('cf-connecting-ip') ||
                  request.headers.get('x-forwarded-for') || '',
                'referer': request.headers.get('referer') || '',
              },
              redirect: 'manual',
            }
          );
          // Surface upstream redirects (e.g. for expired tokens that 302 to a
          // friendly /expired page) instead of swallowing the body.
          if (upstream.status === 301 || upstream.status === 302) {
            const loc = upstream.headers.get('location');
            if (loc) return Response.redirect(loc, 302);
          }
          const body = await upstream.text();
          return new Response(body, {
            status: upstream.status,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'x-frame-options': 'SAMEORIGIN',
            },
          });
        } catch (e) {
          console.error('Tour proxy error:', e);
          return new Response('Tour viewer unavailable.', {
            status: 502,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
      }
    }
    // === END TOUR VIEWER ===========================================

    // Block sensitive paths
    for (const prefix of BLOCKED_PREFIXES) {
      if (path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix)) {
        return new Response('Not Found', { status: 404 });
      }
    }

    // Block api/env.js static file — always served dynamically
    if (path === '/api/env.js' || path === '/api/env.example.js') {
      if (path === '/api/env.example.js') {
        return new Response('Not Found', { status: 404 });
      }
      const adminEmails = (env.ADMIN_EMAILS || '')
        .split(',').map(s => s.trim()).filter(Boolean);

      const config = {
        SUPABASE_URL: env.SUPABASE_URL || '',
        SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY || '',
        GOOGLE_MAPS_API_KEY: env.GOOGLE_MAPS_API_KEY || '',
        ADMIN_EMAILS: adminEmails,
        ADMIN_USER_IDS: []
      };

      return new Response(
        'window.APP_CONFIG = ' + JSON.stringify(config) + ';',
        {
          headers: {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store'
          }
        }
      );
    }

    // Google Maps API key — served to the browser at runtime so it stays in
    // Cloudflare secrets instead of git. Cache in the browser for 5 minutes
    // so page reloads / multiple call sites within a page don't re-hit the
    // worker unnecessarily.
    if (path === '/config') {
      return new Response(
        JSON.stringify({ googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || '' }),
        {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'private, max-age=300'
          }
        }
      );
    }

    // Short-link redirect: /s/<slug> → looks up destination via Supabase edge function
    if (path.startsWith('/s/') && path.length > 3) {
      const slug = path.slice(3).replace(/\/$/, '');
      if (slug && /^[a-z0-9]+$/i.test(slug)) {
        try {
          const res = await fetch(`${env.SUPABASE_URL}/functions/v1/short-link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'resolve', slug })
          });
          if (res.ok) {
            const data = await res.json();
            if (data.destination_url) {
              return Response.redirect(data.destination_url, 302);
            }
          }
        } catch (e) {
          console.error('Short link resolve error:', e);
        }
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Link not found</title><style>body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}h1{color:#C9A84C;margin:0 0 10px;font-size:1.4rem}p{color:#888;font-size:.9rem;margin:0 0 20px}a{color:#C9A84C;text-decoration:none;font-size:.85rem}</style></head><body><div><h1>Rates &amp; Realty</h1><p>This link has expired or doesn\'t exist.</p><a href="/">&larr; Go to homepage</a></div></body></html>',
          { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
      }
    }

    // Public fee-sheet snapshot page: /fee/<slug> → serve the branded page (reads the slug
    // client-side, fetches the frozen snapshot via get_fee_sheet_snapshot with anon). Mirrors
    // the /areas clean-URL rewrite; the slug is validated, then the static shell is served.
    if (/^\/fee\/[A-Za-z0-9]+$/.test(path)) {
      const newUrl = new URL(request.url);
      newUrl.pathname = '/public/fee.html';
      const feeRes = withCsp(await env.ASSETS.fetch(new Request(newUrl, request)), path);
      // Never cache the shell so render fixes take effect immediately (the snapshot data is
      // always fetched live from the RPC anyway).
      const fh = new Headers(feeRes.headers);
      fh.set('Cache-Control', 'no-store, must-revalidate');
      return new Response(feeRes.body, { status: feeRes.status, statusText: feeRes.statusText, headers: fh });
    }

    // Public CMA snapshot page: /cma/<slug> → serve the branded page (reads the slug
    // client-side, fetches the frozen snapshot via get_cma_snapshot with anon). Mirrors /fee.
    if (/^\/cma\/[A-Za-z0-9]+$/.test(path)) {
      const newUrl = new URL(request.url);
      newUrl.pathname = '/public/cma.html';
      const cmaRes = withCsp(await env.ASSETS.fetch(new Request(newUrl, request)), path);
      const ch = new Headers(cmaRes.headers);
      ch.set('Cache-Control', 'no-store, must-revalidate');
      return new Response(cmaRes.body, { status: cmaRes.status, statusText: cmaRes.statusText, headers: ch });
    }

    // Clean-URL routing for county area pages (/areas/slug → /areas/slug.html)
    if (/^\/areas\/[a-z0-9-]+$/.test(path)) {
      const newUrl = new URL(request.url);
      newUrl.pathname = path + '.html';
      return withCsp(await env.ASSETS.fetch(new Request(newUrl, request)), path);
    }

    // Clean-URL routing for CRM app pages (/admin/foo, /dashboard/foo →
    // serve the underlying .html). The ASSETS binding runs with
    // html_handling="none", so extensionless paths don't resolve on their own;
    // this mirrors the /areas handler above. Paths that already include a dot
    // (e.g. /admin/foo.html, /admin/js/app.js) have an extension and skip this,
    // so direct .html links and static assets keep working unchanged.
    if ((request.method === 'GET' || request.method === 'HEAD') &&
        /^\/(admin|dashboard)\/[A-Za-z0-9_-]+$/.test(path)) {
      const newUrl = new URL(request.url);
      newUrl.pathname = path + '.html';
      return withCsp(await env.ASSETS.fetch(new Request(newUrl, request)), path);
    }

    /* Clean-URL routing for the PUBLIC site (/portal → public/portal.html,
     * /privacy → privacy.html). Mirrors the /admin and /areas rules above; the
     * allowlists at the top of this file decide, because a rewrite that guessed
     * would 404 on every typo instead of falling through. Single segment only,
     * no dot — so /public/portal.html and every static asset skip this. */
    if ((request.method === 'GET' || request.method === 'HEAD') && /^\/[A-Za-z0-9_-]+$/.test(path)) {
      const slug = path.slice(1);
      if (REDIRECTS.has(slug)) {
        const dest = new URL(request.url);
        dest.pathname = REDIRECTS.get(slug);
        return Response.redirect(dest.toString(), 301);
      }
      const target = PUBLIC_PAGES.has(slug) ? `/public/${slug}.html`
                   : ROOT_PAGES.has(slug) ? `/${slug}.html`
                   : null;
      if (target) {
        const newUrl = new URL(request.url);
        newUrl.pathname = target;
        return withCsp(await env.ASSETS.fetch(new Request(newUrl, request)), path);
      }
    }

    /* Anything still unmatched is genuinely not a route. It used to be answered
     * with index.html and a 200 — which is how /search-homes looked like a
     * working page while being the marketing homepage, how two borrowers were
     * texted a pre-filtered search that silently became the front page, and how
     * the R2 backup filled with copies of index.html while reporting errors: 0.
     * A 404 that says 404 is the whole point of this change. */
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) {
      const page = await env.ASSETS.fetch(new Request(new URL('/404.html', request.url), request));
      return new Response(page.ok ? page.body : 'Not found', {
        status: 404,
        headers: {
          'Content-Type': page.ok ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    return withAssetCache(withCsp(res, path), url);
  }
};

/* Cache policy for STATIC assets (never HTML — withCsp already pins app HTML to
 * no-store, which is what makes the ?v=<hash> scheme work at all).
 *
 * The asset binding serves everything as `public, max-age=0, must-revalidate`,
 * so every hashed asset still costs a conditional round-trip on each page load
 * even though its URL can never change content. Anything requested WITH a ?v=
 * pin is immutable by construction — the HTML mints a new URL when the bytes
 * change — so it is safe to cache hard. Unpinned URLs keep must-revalidate:
 * caching /admin/js/inbox.js hard with no pin in the URL would strand a stale
 * copy forever, which is the exact failure this scheme exists to prevent. */
function withAssetCache(res, url) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) return res;
  if (!url.searchParams.has('v')) return res;
  if (res.status !== 200) return res;
  const h = new Headers(res.headers);
  h.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// Inject a relaxed CSP into HTML responses so pdf.js can spawn its worker
// from a blob: URL. The asset bundler doesn't let us set per-page headers,
// so we layer it on at the worker. Non-HTML responses pass through unchanged.
function withCsp(res, path) {
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return res;
  const headers = new Headers(res.headers);
  headers.set(
    'Content-Security-Policy',
    "script-src * 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob: *; child-src blob: *;"
  );
  // Allow camera/mic/screen-share for same-origin documents. Without this, a restrictive
  // default Permissions-Policy (Cloudflare edge) blocks getUserMedia/getDisplayMedia with an
  // instant deny ("camera is not allowed in this document") — breaking the Loom recorder and
  // the watch page. Applied to all HTML responses on every host.
  headers.set(
    'Permissions-Policy',
    'camera=(self), microphone=(self), display-capture=(self)'
  );
  // Legacy Feature-Policy for older engines (Permissions-Policy is the authoritative one).
  headers.set('Feature-Policy', "camera 'self'; microphone 'self'");
  // CRM app HTML (both /admin/* AND /dashboard/*) must never be cached (browser or
  // Cloudflare edge) so deploys take effect immediately without a manual purge or
  // clear-site-data. The relocation logic lives in the HTML's inline render(), so a
  // stale /dashboard/admin doc runs the OLD render() even though the versioned JS is
  // fresh — which is exactly why the dashboard looked unchanged. Cover the exact
  // route (no trailing slash) too. Public marketing pages keep their default caching.
  const p = path || '';
  const isAppHtml = p === '/admin' || p.indexOf('/admin/') === 0 || p === '/dashboard' || p.indexOf('/dashboard/') === 0;
  if (isAppHtml) {
    headers.set('Cache-Control', 'no-store, must-revalidate');
    headers.set('Pragma', 'no-cache');
    headers.set('Expires', '0');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/* ── /v/{slug} page rendering ────────────────────────────────────────────────
 * Server-rendered so the video and poster resolve on first paint. Mobile-first:
 * most of these open on a phone.
 *
 * The chat renders replies with textContent, never innerHTML. That is stronger
 * than sanitising — no HTML is parsed at all — and it means this page adds no
 * second sanitize path to maintain alongside window.GmailInbox.sanitize. */
function vEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function videoShell(inner, title) {
  return '<!doctype html><html lang="en"><head>' +
'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
'<meta name="robots" content="noindex,nofollow">' +
'<title>' + vEsc(title || 'A message from Rene Duarte') + '</title><style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
"body{background:#0a0a0a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}" +
'.wrap{max-width:680px;margin:0 auto;padding:0 16px 48px}' +
'.hdr{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);position:sticky;top:0;background:rgba(10,10,10,.94);z-index:5}' +
'.brand{font-weight:800;font-size:15px;color:#c9a84c}' +
'.player{margin:16px 0 14px;border-radius:14px;overflow:hidden;background:#000;border:1px solid rgba(255,255,255,.1)}' +
'video{width:100%;display:block;max-height:70vh;background:#000}' +
'h1{font-size:19px;font-weight:800;margin:0 0 6px}' +
'.who{color:rgba(255,255,255,.62);font-size:13.5px;margin-bottom:18px}' +
'.who b{color:#c9a84c;font-weight:700}' +
'.ctas{display:grid;grid-template-columns:1fr;gap:9px;margin-bottom:24px}' +
'@media(min-width:520px){.ctas{grid-template-columns:1fr 1fr}}' +
'.cta{display:flex;align-items:center;justify-content:center;gap:8px;padding:15px 16px;border-radius:11px;text-decoration:none;font-weight:700;font-size:14.5px;border:1px solid rgba(201,168,76,.42);background:rgba(201,168,76,.1);color:#c9a84c;min-height:52px}' +
'.cta.primary{background:#c9a84c;color:#141414;border-color:#c9a84c}' +
'.card{border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:15px;background:#111}' +
'.card h2{font-size:14.5px;font-weight:800;margin-bottom:4px}' +
'.card p{font-size:12.5px;color:rgba(255,255,255,.55);margin-bottom:12px}' +
'#log{display:flex;flex-direction:column;gap:9px;max-height:320px;overflow-y:auto;margin-bottom:11px}' +
'.msg{padding:10px 12px;border-radius:11px;font-size:13.5px;white-space:pre-wrap;word-wrap:break-word}' +
'.msg.u{background:rgba(201,168,76,.14);color:#f0e4c0;align-self:flex-end;max-width:85%}' +
'.msg.a{background:rgba(255,255,255,.06);color:#e8e8e8;align-self:flex-start;max-width:92%}' +
'.row{display:flex;gap:8px}' +
'#q{flex:1;min-width:0;background:#0a0a0a;border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:13px;color:#fff;font-size:16px;font-family:inherit}' +
'#send{background:#c9a84c;color:#141414;border:none;border-radius:10px;padding:0 18px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit}' +
'#send:disabled{opacity:.5}' +
'.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}' +
'.chips:empty{display:none}' +
'.chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;color:#7ee2a0;background:rgba(80,200,120,.13);border:1px solid rgba(80,200,120,.32);border-radius:11px;padding:3px 9px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'.sugg{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}' +
'.sugg button{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);color:#ccc;border-radius:14px;padding:7px 12px;font-size:12px;cursor:pointer;font-family:inherit;text-align:left;min-height:34px}' +
'.sugg button:hover{background:rgba(201,168,76,.12);border-color:rgba(201,168,76,.4);color:#f0e4c0}' +
'footer{margin-top:30px;padding-top:18px;border-top:1px solid rgba(255,255,255,.08);font-size:11.5px;color:rgba(255,255,255,.42);text-align:center;line-height:1.7}' +
'</style></head><body>' +
'<div class="hdr"><span class="brand">Rates &amp; Realty</span></div>' +
'<div class="wrap">' + inner +
'<footer>Rene Duarte &middot; NMLS #1795044<br>' +
'Operates under E Mortgage Capital, Inc. &middot; Broker NMLS #1416824' +
'<span style="display:inline-block;margin-top:6px;font-size:11px">&#8962; Equal Housing Opportunity</span>' +
'</footer></div></body></html>';
}

function videoNotFoundHtml() {
  return videoShell(
    '<div style="padding:64px 0;text-align:center">' +
    '<div style="font-size:34px;margin-bottom:10px">&#128279;</div>' +
    '<h1>This link isn&rsquo;t available</h1>' +
    '<p style="color:rgba(255,255,255,.55);font-size:14px;margin-top:8px">It may have been removed. Call Rene at ' +
    '<a href="tel:+17144728508" style="color:#c9a84c">714-472-8508</a> and he&rsquo;ll resend it.</p></div>',
    'Link not available');
}

function videoPageHtml(slug, meta, ctas) {
  var s = encodeURIComponent(slug);
  /* Optional CTAs: a key that is unset renders NO button. Only Document Upload is
   * confirmed working; Apply Now / Schedule / Reviews stay absent until their URLs
   * are verified, rather than shipping a button that silently goes nowhere. */
  var optional = [
    ['video_cta_schedule_url', '&#128197; Schedule a call'],
    ['video_cta_apply_url', '&#128221; Apply now'],
    ['video_cta_upload_url', '&#128196; Upload documents'],
    ['video_cta_reviews_url', '&#11088; Reviews']
  ].filter(function (p) { return ctas[p[0]] && /^https?:\/\//i.test(ctas[p[0]]); })
   .map(function (p) {
     return '<a class="cta" data-cta="' + vEsc(p[0]) + '" href="' + vEsc(ctas[p[0]]) +
            '" target="_blank" rel="noopener noreferrer">' + p[1] + '</a>';
   }).join('');

  // Always pinned: /poster serves a branded placeholder when none is stored, so
  // the player never opens on a blank or broken frame.
  var poster = ' poster="/v/' + s + '/poster"';
  var inner =
    '<div class="player"><video id="v" controls playsinline preload="metadata"' + poster + '>' +
    '<source src="/v/' + s + '/media" type="' + vEsc(meta.mime_type || 'video/mp4') + '"></video></div>' +
    '<h1>' + vEsc(meta.title || 'A quick message for you') + '</h1>' +
    '<div class="who"><b>Rene Duarte</b> &middot; Mortgage loan officer &middot; NMLS #1795044</div>' +
    '<div class="ctas">' +
      '<a class="cta primary" data-cta="call" href="tel:+17144728508">&#128222; Call 714-472-8508</a>' +
      optional +
    '</div>' +
    '<div class="card"><h2>Questions? Ask here</h2>' +
    '<p>General questions about the process, programs or documents. For anything about numbers or approval, Rene will call you back.</p>' +
    // Chips echo back what the assistant recorded, so nothing is stored invisibly
    // and a mis-heard name is obvious immediately.
    '<div id="chips" class="chips"></div>' +
    '<div id="log"></div>' +
    // Most visitors do not know what they are allowed to ask. Three openers.
    '<div id="sugg" class="sugg">' +
      '<button data-s="What documents do I need?">What documents do I need?</button>' +
      '<button data-s="How long does the process take?">How long does the process take?</button>' +
      '<button data-s="What\'s the difference between FHA and conventional?">FHA vs conventional?</button>' +
    '</div>' +
    '<div class="row">' +
    '<input id="q" placeholder="Type your question&hellip;" autocomplete="off" enterkeyhint="send">' +
    '<button id="send">Send</button></div></div>' +
    '<script>' + videoPageScript(slug) + '<\/script>';
  return videoShell(inner, meta.title || 'A message from Rene Duarte');
}

function videoPageScript(slug) {
  return '(function(){var SLUG=' + JSON.stringify(slug) + ';' +
  'var sid=(function(){try{var k="rrv_"+SLUG,v=sessionStorage.getItem(k);' +
  'if(!v){v=(crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2));sessionStorage.setItem(k,v);}' +
  'return v;}catch(e){return String(Math.random()).slice(2);}})();' +
  'var sent={};' +
  /* Self-view suppression is carried entirely by the rr_staff cookie, which
   * auth-guard.js scopes to .ratesandrealty.com and which therefore reaches the
   * Worker on the apex and on admin.* alike. This page deliberately reads NO
   * access token: it is public, so any token it could find in localStorage might
   * belong to a borrower with a portal login, and putting a live credential in a
   * beacon body to learn one bit ("is this staff?") is a bad trade. */
  'var prev=/[?&]preview=1/.test(location.search);' +
  'function track(ev,pct){if(sent[ev])return;sent[ev]=1;' +
  'var u="/v/"+encodeURIComponent(SLUG)+"/track";' +
  'var b=JSON.stringify({slug:SLUG,event:ev,session_id:sid,percent:pct||0,' +
  'preview:prev||undefined});' +
  'try{if(navigator.sendBeacon){navigator.sendBeacon(u,new Blob([b],{type:"application/json"}));}' +
  'else{fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:b,keepalive:true});}}catch(e){}}' +
  'track("page_opened");' +
  'var v=document.getElementById("v");' +
  'v.addEventListener("play",function(){track("play_started");});' +
  'v.addEventListener("timeupdate",function(){if(!v.duration)return;' +
  'var p=Math.floor(v.currentTime/v.duration*100);' +
  'if(p>=50)track("watched_50",p);if(p>=75)track("watched_75",p);if(p>=90)track("completed",p);});' +
  'v.addEventListener("ended",function(){track("completed",100);});' +
  'Array.prototype.forEach.call(document.querySelectorAll("[data-cta]"),function(a){' +
  'a.addEventListener("click",function(){sent["cta_clicked"]=0;track("cta_clicked");});});' +
  'var log=document.getElementById("log"),q=document.getElementById("q"),send=document.getElementById("send"),' +
  'chips=document.getElementById("chips"),sugg=document.getElementById("sugg");' +
  // textContent, never innerHTML — nothing from the model is ever parsed as HTML.
  'function add(role,text){var d=document.createElement("div");' +
  'd.className="msg "+(role==="user"?"u":"a");d.textContent=text;' +
  'log.appendChild(d);log.scrollTop=log.scrollHeight;}' +
  /* Echo captured fields back. Same textContent rule: these values came from a
   * visitor via a model, so they are never parsed as markup. */
  'function chipsOf(f){chips.textContent="";if(!f)return;' +
  'var items=[];if(f.name)items.push("\\uD83D\\uDC64 "+f.name);' +
  'if(f.phone)items.push("\\uD83D\\uDCDE "+f.phone+(f.consent_given?" \\u2713":""));' +
  'if(f.email)items.push("\\u2709 "+f.email);' +
  'items.forEach(function(t){var c=document.createElement("span");c.className="chip";c.textContent=t;chips.appendChild(c);});' +
  'if(items.length){var h=document.createElement("span");h.className="chip";' +
  'h.style.cssText="background:transparent;border-color:rgba(255,255,255,.14);color:rgba(255,255,255,.5);font-weight:600";' +
  'h.textContent="Rene has this \\u2014 tell me if anything is wrong";chips.appendChild(h);}}' +
  'var greeted=false;' +
  'function hideSugg(){if(sugg)sugg.style.display="none";}' +
  'function ask(text){var t=(text||q.value||"").trim();if(!t)return;' +
  'if(!greeted){greeted=true;track("chat_started");}' +
  'hideSugg();add("user",t);q.value="";send.disabled=true;' +
  'fetch("/v/"+encodeURIComponent(SLUG)+"/chat",{method:"POST",headers:{"Content-Type":"application/json"},' +
  'body:JSON.stringify({slug:SLUG,session_id:sid,message:t})})' +
  '.then(function(r){return r.json();})' +
  '.then(function(j){add("assistant",(j&&j.reply)||"Sorry — please call Rene at 714-472-8508.");' +
  'if(j&&j.fields)chipsOf(j.fields);})' +
  '.catch(function(){add("assistant","Sorry — please call Rene at 714-472-8508.");})' +
  '.then(function(){send.disabled=false;q.focus();});}' +
  'send.addEventListener("click",function(){ask();});' +
  'q.addEventListener("keydown",function(e){if(e.key==="Enter")ask();});' +
  'if(sugg)Array.prototype.forEach.call(sugg.querySelectorAll("[data-s]"),function(b){' +
  'b.addEventListener("click",function(){ask(b.getAttribute("data-s"));});});' +
  /* Rehydrate on load so a reload does not restart the conversation. Read-only on
   * the server and outside the spend limiter, so refreshing costs nothing. */
  'fetch("/v/"+encodeURIComponent(SLUG)+"/chat",{method:"POST",headers:{"Content-Type":"application/json"},' +
  'body:JSON.stringify({slug:SLUG,session_id:sid,action:"history"})})' +
  '.then(function(r){return r.json();}).then(function(j){' +
  'var m=(j&&j.messages)||[];if(m.length){greeted=true;hideSugg();' +
  'm.forEach(function(x){add(x.role==="user"?"user":"assistant",x.content);});}' +
  'if(j&&j.fields)chipsOf(j.fields);}).catch(function(){});' +
  '})();';
}
