/* Covers BOTH recording eras without needing a phone call.
 *
 * The point of this file: dual-channel recording started 2026-08-08, so the
 * dual formatting path would otherwise have no coverage until real borrower
 * calls ran through it in production. These cases run on every `deno test`.
 *
 *   deno test supabase/functions/_shared/transcript-format.test.ts
 */
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { formatTranscript, rolesForDirection } from './transcript-format.ts';

Deno.test('mono: one channel produces plain text', () => {
  const sentences = [
    { transcript: 'Hello?', media_channel: 1 },
    { transcript: 'How is it going?', media_channel: 1 },
    { transcript: 'So this is a test.', media_channel: 1 },
  ];
  assertEquals(
    formatTranscript(sentences, rolesForDirection('outbound'), 1),
    'Hello? How is it going? So this is a test.',
  );
});

Deno.test('mono: sentences with no media_channel at all still work', () => {
  const sentences = [{ transcript: 'Hello?' }, { transcript: 'Anyone there?' }];
  assertEquals(formatTranscript(sentences, {}, 1), 'Hello? Anyone there?');
});

/* ── THE REGRESSION THIS FILE EXISTS FOR ─────────────────────────────────────
 *
 * Real data from calls_log 8d14969b, whose Twilio Recording reports channels:1.
 * Conversational Intelligence still returned sentences on two media_channels —
 * the same mixed audio transcribed twice — and an earlier version of this
 * formatter dutifully labelled them as two speakers, inventing a conversation
 * out of one person talking. */
Deno.test('mono source reported as two channels is NOT labelled as two speakers', () => {
  const sentences = [
    { transcript: 'Hello?', media_channel: 1 },
    { transcript: 'Hello?', media_channel: 2 },
    { transcript: "How's it going?", media_channel: 1 },
    { transcript: "How's it going?", media_channel: 2 },
  ];
  const out = formatTranscript(sentences, rolesForDirection('outbound'), 1);
  assertEquals(out.includes('Borrower:'), false);
  assertEquals(out.includes('Rates and Realty:'), false);
  assertEquals(out, "Hello? How's it going?");
});

Deno.test('phantom channels with ASR drift between the two passes collapse too', () => {
  const sentences = [
    { transcript: 'So they test 1, 2, 3.', media_channel: 1 },
    { transcript: 'Is it test 1, 2, 3?', media_channel: 2 },
  ];
  assertEquals(formatTranscript(sentences, rolesForDirection('outbound'), 1), 'So they test 1, 2, 3.');
});

/* The other side of that coin: a person genuinely saying the same thing twice
 * lands on ONE channel, and must survive. */
Deno.test('a real repetition on one channel is kept', () => {
  const sentences = [
    { transcript: 'Hello?', media_channel: 1 },
    { transcript: 'Hello?', media_channel: 1 },
  ];
  assertEquals(formatTranscript(sentences, rolesForDirection('outbound'), 1), 'Hello? Hello?');
});

Deno.test('unknown channel count is treated as mono, never guessed into labels', () => {
  const sentences = [
    { transcript: 'Hi there.', media_channel: 1 },
    { transcript: 'Hi there.', media_channel: 2 },
  ];
  assertEquals(formatTranscript(sentences, rolesForDirection('outbound'), null), 'Hi there.');
  assertEquals(formatTranscript(sentences, rolesForDirection('outbound')), 'Hi there.');
});

Deno.test('dual outbound: channel 1 is staff, channel 2 is the borrower', () => {
  const sentences = [
    { transcript: 'Hi, this is Rene calling about your rate lock.', media_channel: 1 },
    { transcript: 'Oh great, thanks for calling back.', media_channel: 2 },
    { transcript: 'Do you have a minute?', media_channel: 1 },
  ];
  assertEquals(
    formatTranscript(sentences, rolesForDirection('outbound'), 2),
    'Rates and Realty: Hi, this is Rene calling about your rate lock.\n' +
    'Borrower: Oh great, thanks for calling back.\n' +
    'Rates and Realty: Do you have a minute?',
  );
});

/* The case that makes the direction mapping worth having. On an inbound call
 * the PARENT leg is the borrower, so Conversational Intelligence's own default
 * (channel 1 = Agent) is backwards. Same sentences, same channels, opposite
 * labels — and only the direction differs. */
Deno.test('dual inbound: the mapping inverts, because the borrower is the parent leg', () => {
  const sentences = [
    { transcript: 'Hi, I am calling about my loan.', media_channel: 1 },
    { transcript: 'Sure, let me pull that up.', media_channel: 2 },
  ];
  assertEquals(
    formatTranscript(sentences, rolesForDirection('inbound'), 2),
    'Borrower: Hi, I am calling about my loan.\n' +
    'Rates and Realty: Sure, let me pull that up.',
  );
});

Deno.test('dual: consecutive sentences from one speaker become a single turn', () => {
  const sentences = [
    { transcript: 'Hello.', media_channel: 1 },
    { transcript: 'Can you hear me?', media_channel: 1 },
    { transcript: 'Yes I can.', media_channel: 2 },
  ];
  assertEquals(
    formatTranscript(sentences, rolesForDirection('outbound'), 2),
    'Rates and Realty: Hello. Can you hear me?\nBorrower: Yes I can.',
  );
});

/* Neither era: a dual recording where only one party ever spoke. One distinct
 * channel, so it takes the plain path — labelling a monologue over and over
 * would be noise, and this is why the decision is "how many channels are in the
 * data" rather than "was this recorded after the switch". */
Deno.test('dual recording where only one party spoke reads as plain text', () => {
  const sentences = [
    { transcript: 'Hello, is anyone there?', media_channel: 1 },
    { transcript: 'I will try again later.', media_channel: 1 },
  ];
  assertEquals(
    formatTranscript(sentences, rolesForDirection('outbound'), 2),
    'Hello, is anyone there? I will try again later.',
  );
});

Deno.test('empty and whitespace-only sentences are dropped, not labelled', () => {
  assertEquals(formatTranscript([]), '');
  assertEquals(formatTranscript([{ transcript: '   ' }, { transcript: null }]), '');
  assertEquals(
    formatTranscript(
      [{ transcript: '  ', media_channel: 1 }, { transcript: 'Only this.', media_channel: 2 }],
      rolesForDirection('outbound'), 2,
    ),
    'Only this.',
  );
});

Deno.test('an unexpected channel number is labelled honestly rather than guessed', () => {
  const sentences = [
    { transcript: 'One.', media_channel: 1 },
    { transcript: 'Three.', media_channel: 3 },
  ];
  assertEquals(
    formatTranscript(sentences, rolesForDirection('outbound'), 2),
    'Rates and Realty: One.\nChannel 3: Three.',
  );
});
