// Structural tests for the outbound MIME builder.
//   deno test supabase/functions/_shared/mime.test.ts
import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { buildMime, safeFilename, safeMime, b64Binary } from './mime.ts'

// Deterministic boundaries so assertions can name them.
let n = 0
const fixed = () => (++n, 'B' + n)
function fresh() { n = 0; return fixed }

const base = {
  from: 'rene@ratesandrealty.com',
  to: 'borrower@example.com',
  subject: 'Your loan estimate',
  html: '<div>Hello <b>there</b></div>',
  text: 'Hello there',
}

Deno.test('no attachments → top level is multipart/alternative', () => {
  const m = buildMime({ ...base, boundaryFn: fresh() })
  assertStringIncludes(m, 'Content-Type: multipart/alternative; boundary="alt_B1"')
  assert(!m.includes('multipart/mixed'), 'must not wrap in mixed when there are no attachments')
  // both alternative parts present, terminator closed exactly once
  assertStringIncludes(m, 'Content-Type: text/plain; charset="UTF-8"')
  assertStringIncludes(m, 'Content-Type: text/html; charset="UTF-8"')
  assertEquals(m.split('--alt_B1--').length - 1, 1)
  // headers separated from body by a blank line, CRLF throughout
  assertStringIncludes(m, 'MIME-Version: 1.0\r\nContent-Type: multipart/alternative')
  assert(!/[^\r]\n/.test(m), 'every LF must be preceded by CR')
})

Deno.test('with attachments → alternative nests inside multipart/mixed', () => {
  const m = buildMime({
    ...base,
    boundaryFn: fresh(),
    attachments: [{ name: 'CD.pdf', mime: 'application/pdf', bytes: new Uint8Array([1, 2, 3, 4]) }],
  })
  // alt_B1 is created first, mix_B2 second
  assertStringIncludes(m, 'Content-Type: multipart/mixed; boundary="mix_B2"')
  assertStringIncludes(m, '--mix_B2\r\nContent-Type: multipart/alternative; boundary="alt_B1"')
  // the alternative entity is closed BEFORE the attachment part opens
  const altEnd = m.indexOf('--alt_B1--')
  const attStart = m.indexOf('Content-Disposition: attachment')
  assert(altEnd > 0 && attStart > altEnd, 'attachment part must follow the closed alternative entity')
  assertStringIncludes(m, 'Content-Disposition: attachment; filename="CD.pdf"')
  assertStringIncludes(m, 'Content-Transfer-Encoding: base64')
  // mixed terminator present exactly once, and last
  assertEquals(m.split('--mix_B2--').length - 1, 1)
  assert(m.trimEnd().endsWith('--mix_B2--'), 'mixed terminator must close the message')
  assert(!/[^\r]\n/.test(m), 'every LF must be preceded by CR')
})

Deno.test('multiple attachments each get their own part', () => {
  const m = buildMime({
    ...base,
    boundaryFn: fresh(),
    attachments: [
      { name: 'a.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) },
      { name: 'b.png', mime: 'image/png', bytes: new Uint8Array([2]) },
    ],
  })
  assertEquals(m.split('Content-Disposition: attachment').length - 1, 2)
  assertStringIncludes(m, 'filename="a.pdf"')
  assertStringIncludes(m, 'filename="b.png"')
  assertStringIncludes(m, 'Content-Type: image/png; name="b.png"')
})

Deno.test('filename cannot inject headers', () => {
  const evil = 'x.pdf"\r\nBcc: attacker@evil.com\r\nX: '
  assertEquals(safeFilename(evil).includes('\r'), false)
  assertEquals(safeFilename(evil).includes('\n'), false)
  assertEquals(safeFilename(evil).includes('"'), false)
  const m = buildMime({
    ...base,
    boundaryFn: fresh(),
    attachments: [{ name: evil, mime: 'application/pdf', bytes: new Uint8Array([1]) }],
  })
  // The property that matters is that nothing became a HEADER — i.e. no line starts
  // with Bcc:. The text may legitimately survive inside the quoted filename value on
  // a single line, which is inert.
  const injected = m.split('\r\n').some((l) => /^bcc\s*:/i.test(l))
  assert(!injected, 'CRLF in a filename must not start a new header line')
  // And the filename must still be a single line inside its own header.
  const fnLine = m.split('\r\n').filter((l) => l.startsWith('Content-Disposition:'))[0]
  assert(fnLine && fnLine.endsWith('"'), 'filename header must be one well-formed line')
})

Deno.test('non-ASCII filename is RFC 2047 encoded', () => {
  const f = safeFilename('Résumé señor.pdf')
  assertStringIncludes(f, '=?UTF-8?B?')
  assert(!/[^\x20-\x7E]/.test(f), 'encoded filename must be pure ASCII')
})

Deno.test('mime type is validated, not echoed', () => {
  assertEquals(safeMime('application/pdf'), 'application/pdf')
  assertEquals(safeMime('image/png'), 'image/png')
  assertEquals(safeMime('bogus'), 'application/octet-stream')
  assertEquals(safeMime('text/html\r\nX-Evil: 1'), 'application/octet-stream')
  assertEquals(safeMime(''), 'application/octet-stream')
})

Deno.test('base64 body is wrapped at 76 chars', () => {
  const big = new Uint8Array(1000).fill(65)
  const lines = b64Binary(big).split('\r\n')
  for (const l of lines) assert(l.length <= 76, 'line too long: ' + l.length)
  assert(lines.length > 1, 'should have wrapped')
})

Deno.test('large attachment does not blow the argument limit', () => {
  // 2MB — String.fromCharCode(...bytes) would throw RangeError here.
  const big = new Uint8Array(2 * 1024 * 1024).fill(7)
  const out = b64Binary(big)
  assert(out.length > 2 * 1024 * 1024, 'expected base64 expansion')
})
