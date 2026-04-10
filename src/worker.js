/**
 * Cloudflare Worker entry — serves /api/env.js dynamically so secrets
 * (MAPBOX_TOKEN) come from Cloudflare bindings instead of git.
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

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
        ADMIN_EMAILS: adminEmails,
        ADMIN_USER_IDS: [],
        MAPBOX_TOKEN: env.MAPBOX_TOKEN || ''
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

    // Clean-URL routing for county area pages (/areas/slug → /areas/slug.html)
    if (/^\/areas\/[a-z0-9-]+$/.test(path)) {
      const newUrl = new URL(request.url);
      newUrl.pathname = path + '.html';
      return env.ASSETS.fetch(new Request(newUrl, request));
    }

    return env.ASSETS.fetch(request);
  }
};
