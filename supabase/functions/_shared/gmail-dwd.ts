// gmail-dwd.ts — Shared Gmail Domain-Wide Delegation helper.
//
// Auth model: a Google Workspace service account (stored as the single-line JSON
// secret GOOGLE_SA_KEY) has DWD enabled and is authorized in the Admin console for
// exactly the scope https://www.googleapis.com/auth/gmail.modify. To act as a
// mailbox we mint an RS256-signed JWT whose `sub` is the mailbox to impersonate,
// exchange it for an access token, and call the Gmail API as `users/me`.
//
// Access tokens are cached PER MAILBOX until ~1 min before expiry. The SA private
// key never leaves this module; nothing here logs the key or the tokens.
//
// Usage:
//   import { gmailApi, getMailboxToken } from '../_shared/gmail-dwd.ts'
//   const res = await gmailApi('rene@ratesandrealty.com', 'messages?maxResults=10')

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/'

interface SAKey {
  client_email: string
  private_key: string
  token_uri: string
}

let _sa: SAKey | null = null
let _cryptoKey: CryptoKey | null = null
const _tokenCache = new Map<string, { token: string; exp: number }>()

function loadSA(): SAKey {
  if (_sa) return _sa
  const raw = Deno.env.get('GOOGLE_SA_KEY')
  if (!raw) throw new Error('GOOGLE_SA_KEY secret is not set')
  let j: any
  try { j = JSON.parse(raw) } catch (e) { throw new Error('GOOGLE_SA_KEY is not valid JSON: ' + (e as Error).message) }
  if (!j.client_email || !j.private_key) throw new Error('GOOGLE_SA_KEY missing client_email/private_key')
  _sa = { client_email: j.client_email, private_key: j.private_key, token_uri: j.token_uri || 'https://oauth2.googleapis.com/token' }
  return _sa
}

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === 'string' ? btoa(bytes) : btoa(String.fromCharCode(...bytes))
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlJSON(obj: unknown): string { return b64url(new TextEncoder().encode(JSON.stringify(obj))) }

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '')
  const bin = atob(body)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf.buffer
}

async function signingKey(): Promise<CryptoKey> {
  if (_cryptoKey) return _cryptoKey
  const sa = loadSA()
  _cryptoKey = await crypto.subtle.importKey(
    'pkcs8', pemToPkcs8(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  )
  return _cryptoKey
}

async function mintToken(mailbox: string): Promise<{ token: string; exp: number }> {
  const sa = loadSA()
  const now = Math.floor(Date.now() / 1000)
  const exp = now + 3600
  const header = b64urlJSON({ alg: 'RS256', typ: 'JWT' })
  const claim = b64urlJSON({ iss: sa.client_email, sub: mailbox, scope: SCOPE, aud: sa.token_uri, iat: now, exp })
  const signingInput = `${header}.${claim}`
  const key = await signingKey()
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput))
  const jwt = `${signingInput}.${b64url(new Uint8Array(sigBuf))}`

  const r = await fetch(sa.token_uri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) {
    // Surface Google's verbatim error (diagnostic: unauthorized_client, access_denied, …)
    throw new Error(`token exchange failed for ${mailbox} (HTTP ${r.status}): ${j.error || 'unknown'}${j.error_description ? ' — ' + j.error_description : ''}`)
  }
  return { token: j.access_token, exp: now + (j.expires_in || 3600) }
}

/** Get a cached access token for the impersonated mailbox (refreshes ~60s before expiry). */
export async function getMailboxToken(mailbox: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const hit = _tokenCache.get(mailbox)
  if (hit && hit.exp > now + 60) return hit.token
  const fresh = await mintToken(mailbox)
  _tokenCache.set(mailbox, fresh)
  return fresh.token
}

/** Call the Gmail API as `mailbox`. `path` is relative to users/me/ (e.g. 'messages?maxResults=5', 'profile'). */
export async function gmailApi(mailbox: string, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getMailboxToken(mailbox)
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  return fetch(GMAIL_BASE + path, { ...init, headers })
}
