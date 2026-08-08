/* Turn Conversational Intelligence sentences into the text stored on
 * calls_log.transcript.
 *
 * ── WHY THIS IS A SEPARATE FILE WITH A TEST NEXT TO IT ──────────────────────
 *
 * Recordings made before 2026-08-08 are MONO (one channel, both legs mixed).
 * Recordings made after are DUAL (parent on channel 1, child on channel 2).
 * Both will exist in calls_log forever — the old ones cannot be re-cut.
 *
 * The obvious implementation is `if (isDual) { … } else { … }`, and the obvious
 * implementation is the trap: the dual half would only ever execute on calls
 * placed after the switch, so it could not be exercised until real borrower
 * calls were already flowing through it. A branch whose first real run is in
 * production is not tested, it is hoped for.
 *
 * So there is no isDual flag and nothing is passed in about which era a
 * recording came from. The shape is derived from the DATA — how many distinct
 * media_channel values the sentences actually carry — and the mono path is the
 * degenerate case of the same code, exercised by every historical call. The
 * accompanying transcript-format.test.ts runs both shapes on every `deno test`,
 * so neither half waits on a phone call to be covered.
 */

export type Sentence = {
  transcript?: string | null;
  media_channel?: number | string | null;
};

/** channel number → what to call whoever is on it. */
export type ChannelRoles = Record<number, string>;

/* ── WHO IS ON CHANNEL 1 DEPENDS ON WHO PLACED THE CALL ─────────────────────
 *
 * Twilio: "The parent call will always be in the first channel and the child
 * call will always be in the second channel."
 * Conversational Intelligence: channel 1 is assumed to be the Agent.
 *
 * Those two together are only correct when the parent leg is staff, and in this
 * codebase that depends on direction:
 *
 *   outbound (browser dialer)  parent = the staff member's browser leg → ch1 = staff
 *   inbound  (PSTN → forward)  parent = the BORROWER who rang in       → ch1 = borrower
 *
 * So on inbound calls Conversational Intelligence's default would label the
 * borrower as the agent and Rene as the customer — confidently, and backwards.
 * That is worse than mono's no-labels-at-all, because a wrong label reads as
 * information. This is the mapping that stops it. */
export function rolesForDirection(direction?: string | null): ChannelRoles {
  return String(direction || '').toLowerCase() === 'inbound'
    ? { 1: 'Borrower', 2: 'Rates and Realty' }
    : { 1: 'Rates and Realty', 2: 'Borrower' };
}

/* A mono recording comes back as two phantom channels of the same audio, so the
 * same utterance appears twice in a row — sometimes byte-identical, sometimes
 * with small ASR variation between the two passes ("So they test 1, 2, 3." vs
 * "Is it test 1, 2, 3?").
 *
 * Only ADJACENT near-duplicates on DIFFERENT channels are collapsed. A borrower
 * genuinely repeating themselves ("Hello? ... Hello?") lands on one channel and
 * is left alone, because on a mono source both passes of one utterance are what
 * sit next to each other. */
function dedupeAcrossPhantomChannels(rows: Array<{ text: string; ch: number | null }>): string {
  const out: Array<{ text: string; ch: number | null }> = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (prev && prev.ch !== r.ch && nearlySame(prev.text, r.text)) continue;
    out.push(r);
  }
  return out.map((r) => r.text).join(' ');
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Same utterance transcribed twice, allowing for small ASR drift. */
function nearlySame(a: string, b: string): boolean {
  const x = normalise(a), y = normalise(b);
  if (!x || !y) return false;
  if (x === y) return true;
  /* Token overlap, so "so they test 1 2 3" and "is it test 1 2 3" collapse but
   * two genuinely different sentences do not. Deliberately strict: it must be
   * most of both sides, not most of the shorter one. */
  const ax = new Set(x.split(' ')), ay = new Set(y.split(' '));
  let shared = 0;
  for (const t of ax) if (ay.has(t)) shared++;
  return shared / Math.max(ax.size, ay.size) >= 0.6;
}

function channelOf(s: Sentence): number | null {
  const raw = s.media_channel;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Mono in, one block of text out — byte-for-byte what this produced before
 * dual-channel existed. Dual in, speaker-labelled turns out.
 *
 * The decision is `distinct channels >= 2`, not "was this recorded after the
 * switch". That matters for a case that is neither era: a DUAL recording where
 * only one party ever spoke carries one distinct channel, and labelling a
 * monologue "Rates and Realty:" over and over would be noise. It falls through
 * to the plain path, correctly.
 */
export function formatTranscript(
  sentences: Sentence[],
  roles: ChannelRoles = {},
  sourceChannels?: number | null,
): string {
  const rows = (sentences || [])
    .map((s) => ({ text: String(s?.transcript ?? '').trim(), ch: channelOf(s) }))
    .filter((r) => r.text.length > 0);

  if (!rows.length) return '';

  /* ── THE SENTENCES ARE NOT AUTHORITATIVE ABOUT SPEAKERS ──────────────────
   *
   * Conversational Intelligence returns sentences on TWO media_channel values
   * even when the recording has ONE channel. Both carry the same mixed audio,
   * transcribed twice, so trusting the sentence channels turns one person into
   * two:
   *
   *     Rates and Realty: Hello?
   *     Borrower: Hello?          <- the same voice, attributed to both parties
   *
   * That is why every mono transcript here reads as if each phrase were said
   * twice. It is one utterance, counted once per phantom channel.
   *
   * sourceChannels comes from the Twilio Recording resource, which knows. When
   * it says 1 — or when it is unknown, because guessing towards labels is the
   * failure mode with teeth — the text is emitted plain and DEDUPLICATED. On an
   * attribution question, the cost of being wrong is not symmetric: an
   * unlabelled transcript is merely less useful, a mislabelled one is evidence
   * of something that did not happen. */
  const trustChannels = Number(sourceChannels) >= 2;
  if (!trustChannels) return dedupeAcrossPhantomChannels(rows);

  const distinct = new Set(rows.map((r) => r.ch).filter((c) => c !== null));
  if (distinct.size < 2) return rows.map((r) => r.text).join(' ');

  /* Group CONSECUTIVE sentences from the same channel into one turn. Labelling
   * every sentence individually turns a normal back-and-forth into a wall of
   * repeated names and is harder to read than the unlabelled mono version. */
  const out: string[] = [];
  let curCh: number | null | undefined = undefined;
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    const label = curCh === null || curCh === undefined
      ? ''
      : (roles[curCh] || `Channel ${curCh}`) + ': ';
    out.push(label + buf.join(' '));
    buf = [];
  };
  for (const r of rows) {
    if (r.ch !== curCh) { flush(); curCh = r.ch; }
    buf.push(r.text);
  }
  flush();
  return out.join('\n');
}
