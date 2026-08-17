// Tests for the shared identity helpers.
//   deno test supabase/functions/_shared/identity.test.ts
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isOurAddress, validEmail, OUR_ADDRESSES } from './identity.ts';

Deno.test('every one of our addresses is recognised', () => {
  for (const a of OUR_ADDRESSES) assert(isOurAddress(a), `${a} should be ours`);
});

Deno.test('both personal gmails are included — the gap that mis-filed 344 rows', () => {
  // The old SELF set held only the two ratesandrealty mailboxes. These two are
  // the addresses on the contact record that absorbed the whole mailbox.
  assert(isOurAddress('reneduarte.homeside@gmail.com'));
  assert(isOurAddress('reneduarte.realty1@gmail.com'));
});

Deno.test('recognition is case- and whitespace-insensitive', () => {
  // contacts.email is stored as 'Reneduarte.realty1@gmail.com' — capitalised.
  // A case-sensitive check would have missed it and changed nothing.
  assert(isOurAddress('Reneduarte.Realty1@GMAIL.com'));
  assert(isOurAddress('  rene@ratesandrealty.com  '));
});

Deno.test('a borrower address is NOT ours', () => {
  // The present-assertion paired with the ones above: if isOurAddress returned
  // true for everything, matchContact would resolve nothing and the panel would
  // silently go empty. That failure looks like "no email on this lead".
  assertEquals(isOurAddress('borrower@example.com'), false);
  assertEquals(isOurAddress('jesus@ezinsurance123.com'), false);
  assertEquals(isOurAddress(''), false);
  assertEquals(isOurAddress(null), false);
});

Deno.test('validEmail accepts and lowercases a normal address', () => {
  assertEquals(validEmail('Agent@Example.COM'), 'agent@example.com');
});

Deno.test('a comma is REFUSED — this is the or-filter injection', () => {
  /* The payload that matters. matchContact builds
       .or(`email.ilike.${e},secondary_email.ilike.${e}`)
     and PostgREST splits that on commas, so an address carrying one — from an
     inbound To/Cc header, which anyone can write — could append its own
     predicate. Refused, not escaped. */
  assertEquals(validEmail('a@b.com,secondary_email.ilike.*'), null);
  assertEquals(validEmail('x@y.com,or(id.gt.0)'), null);
});

Deno.test('quotes and parens are refused too', () => {
  assertEquals(validEmail('a"b@c.com'), null);
  assertEquals(validEmail("a'b@c.com"), null);
  assertEquals(validEmail('a(b)@c.com'), null);
});

Deno.test('malformed shapes are refused', () => {
  assertEquals(validEmail('no-at-sign'), null);
  assertEquals(validEmail('no@tld'), null);
  assertEquals(validEmail('has space@c.com'), null);
  assertEquals(validEmail(''), null);
  assertEquals(validEmail(undefined), null);
});
