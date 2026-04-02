import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
};

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = 'mailto:rene@ratesandrealty.com';

// Base64url helpers
function base64urlToUint8Array(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
  const binary = atob(padded);
  return new Uint8Array([...binary].map(c => c.charCodeAt(0)));
}

function uint8ArrayToBase64url(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function makeVapidJwt(audience: string): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + 43200, sub: VAPID_SUBJECT };
  const headerB64 = uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const keyData = base64urlToUint8Array(VAPID_PRIVATE);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${uint8ArrayToBase64url(new Uint8Array(signature))}`;
}

async function sendWebPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<{ ok: boolean; status: number; body: string }> {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await makeVapidJwt(audience);

  // Encrypt payload using Web Push encryption (AES-GCM)
  const authBytes = base64urlToUint8Array(sub.auth);
  const p256dhBytes = base64urlToUint8Array(sub.p256dh);

  // Generate server ephemeral key pair
  const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const serverPublicKeyRaw = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);

  // Import client public key
  const clientPublicKey = await crypto.subtle.importKey('raw', p256dhBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  // Derive shared secret
  const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPublicKey }, serverKeyPair.privateKey, 256);

  // Generate salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF to derive content encryption key and nonce
  const prk = await crypto.subtle.importKey('raw', sharedSecret, { name: 'HKDF' }, false, ['deriveKey', 'deriveBits']);

  const serverPublicKeyBytes = new Uint8Array(serverPublicKeyRaw);
  const keyInfo = new Uint8Array([...new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 0]);
  const nonceInfo = new Uint8Array([...new TextEncoder().encode('Content-Encoding: nonce\0'), 0]);

  // PRK with salt
  const prkHmacKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prkSigned = new Uint8Array(await crypto.subtle.sign('HMAC', prkHmacKey, new Uint8Array(sharedSecret)));
  const contentPrk = await crypto.subtle.importKey('raw', prkSigned, { name: 'HKDF' }, false, ['deriveBits']);

  const keyBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: keyInfo }, contentPrk, 128);
  const nonceBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: nonceInfo }, contentPrk, 96);

  const contentKey = await crypto.subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, false, ['encrypt']);
  const payloadBytes = new TextEncoder().encode(payload);
  const paddedPayload = new Uint8Array(payloadBytes.length + 1);
  paddedPayload.set(payloadBytes);
  paddedPayload[payloadBytes.length] = 2; // padding delimiter

  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceBits }, contentKey, paddedPayload);

  // Build RFC 8188 header
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  const header = new Uint8Array([
    ...salt,
    ...recordSize,
    serverPublicKeyBytes.length,
    ...serverPublicKeyBytes
  ]);

  const body = new Uint8Array(header.length + encrypted.byteLength);
  body.set(header);
  body.set(new Uint8Array(encrypted), header.length);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400'
    },
    body
  });

  const resBody = await res.text();
  return { ok: res.ok, status: res.status, body: resBody };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const { action } = body;

    // Save subscription from portal
    if (action === 'subscribe') {
      const { portal_user_id, contact_id, borrower_id, subscription } = body;
      if (!subscription?.endpoint) return err('subscription.endpoint required');
      const { error } = await sb.from('push_subscriptions').upsert({
        portal_user_id: portal_user_id || null,
        contact_id: contact_id || null,
        borrower_id: borrower_id || null,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        updated_at: new Date().toISOString()
      }, { onConflict: 'endpoint' });
      if (error) return err(error.message, 500);
      return ok({ success: true });
    }

    // Remove subscription
    if (action === 'unsubscribe') {
      const { endpoint } = body;
      await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
      return ok({ success: true });
    }

    // Send push to a specific user or all subscribers
    if (action === 'send') {
      const { portal_user_id, contact_id, title, message, url, icon } = body;
      if (!title || !message) return err('title and message required');

      let q = sb.from('push_subscriptions').select('endpoint, p256dh, auth');
      if (portal_user_id) q = q.eq('portal_user_id', portal_user_id);
      else if (contact_id) q = q.eq('contact_id', contact_id);
      // if neither, send to all (admin broadcast)

      const { data: subs, error } = await q;
      if (error) return err(error.message, 500);
      if (!subs?.length) return ok({ success: true, sent: 0, message: 'No subscribers found' });

      const payload = JSON.stringify({
        title,
        body: message,
        icon: icon || '/icon-192.png',
        url: url || 'https://beta.ratesandrealty.com/public/unified-portal.html',
        badge: '/badge-72.png'
      });

      let sent = 0, failed = 0;
      const stale: string[] = [];

      for (const sub of subs) {
        try {
          const result = await sendWebPush(sub, payload);
          if (result.ok) {
            sent++;
          } else if (result.status === 410 || result.status === 404) {
            stale.push(sub.endpoint); // subscription expired
            failed++;
          } else {
            console.error('Push failed:', result.status, result.body);
            failed++;
          }
        } catch(e) {
          console.error('Push error:', e);
          failed++;
        }
      }

      // Clean up stale subscriptions
      if (stale.length) {
        await sb.from('push_subscriptions').delete().in('endpoint', stale);
      }

      return ok({ success: true, sent, failed, stale: stale.length });
    }

    // Get VAPID public key (needed by portal to subscribe)
    if (action === 'get_vapid_key') {
      return ok({ vapid_public_key: VAPID_PUBLIC });
    }

    return err('Unknown action: ' + action);
  } catch(e: any) {
    console.error('send-push error:', e);
    return err(e.message || 'Server error', 500);
  }
});
