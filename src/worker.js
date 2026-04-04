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

    return env.ASSETS.fetch(request);
  }
};
