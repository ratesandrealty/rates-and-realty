// Authorization tests for the outbound attachment path guard.
//   deno test supabase/functions/_shared/attach.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { attachmentPathError } from './attach.ts'

const RENE = 'rene@ratesandrealty.com'
const PROC = 'processing@ratesandrealty.com'
const ok = (p: string, mb: string) => assertEquals(attachmentPathError(p, mb), null)
const denied = (p: string, mb: string) =>
  assertEquals(attachmentPathError(p, mb), 'attachment path outside this mailbox')

Deno.test('own-prefix path is accepted', () => {
  ok(`${RENE}/1785/CD.pdf`, RENE)
  ok(`${PROC}/1785/CD.pdf`, PROC)
  ok(`${RENE}/a/b/c/deep.pdf`, RENE)
})

Deno.test('admin resolved to rene@ cannot reach processing@ prefix', () => {
  denied(`${PROC}/1785/CD.pdf`, RENE)
})

Deno.test('va (only ever resolves to processing@) cannot reach rene@ prefix', () => {
  // A va's requested mailbox is rejected outright by allowedMailboxes() before this
  // predicate is reached, so the only mailbox it can arrive here with is processing@.
  denied(`${RENE}/1785/CD.pdf`, PROC)
  denied(`${RENE}/anything.pdf`, PROC)
})

Deno.test('arbitrary objects elsewhere in the bucket are rejected', () => {
  denied('someone-else/secret.pdf', RENE)
  denied('CD.pdf', RENE)                        // bucket root
  // An empty path is a distinct case: it reports "missing", not "outside".
  assertEquals(attachmentPathError('', RENE), 'attachment missing path')
})

Deno.test('traversal and absolute paths are rejected', () => {
  denied(`${RENE}/../${PROC}/CD.pdf`, RENE)
  denied(`${RENE}/../../etc/passwd`, RENE)
  denied(`/${RENE}/CD.pdf`, RENE)
  denied(`${RENE}//CD.pdf`, RENE)
  denied(`${RENE}\\CD.pdf`, RENE)
  denied(`${RENE}/CD\0.pdf`, RENE)
})

Deno.test('prefix-confusion attempts are rejected', () => {
  // A sibling prefix that merely STARTS with the mailbox string.
  denied(`${RENE}.evil.com/CD.pdf`, RENE)
  denied(`${RENE}-backup/CD.pdf`, RENE)
  // The prefix itself, naming no object.
  denied(`${RENE}/`, RENE)
  denied(RENE, RENE)
  // Case must match — a differently-cased prefix is a different storage object.
  denied(`${RENE.toUpperCase()}/CD.pdf`, RENE)
})

Deno.test('missing or empty mailbox never authorizes anything', () => {
  denied(`${RENE}/CD.pdf`, '')
  denied(`${RENE}/CD.pdf`, null as unknown as string)
  denied(`${RENE}/CD.pdf`, undefined as unknown as string)
})

Deno.test('non-string paths are rejected', () => {
  assertEquals(attachmentPathError(null, RENE), 'attachment missing path')
  assertEquals(attachmentPathError(undefined, RENE), 'attachment missing path')
  assertEquals(attachmentPathError({ path: `${RENE}/x` }, RENE), 'attachment missing path')
  assertEquals(attachmentPathError(42, RENE), 'attachment missing path')
})
