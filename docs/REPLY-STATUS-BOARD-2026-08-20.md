# Reply-status board for HOI and VOE — report before building

**Headline: it would be a six-lead board, and 71% of its rows would say "we can
never know".** That is worth deciding on before any of it is built.

---

## 1. The states in the data today — measured

| | HOI | VOE | total |
|---|---|---|---|
| live rows | 11 | 10 | **21** |
| **no send record — can never correlate** | **6** | **9** | **15** |
| awaiting reply (sent, nothing back) | 4 | 1 | **5** |
| replied | 1 | 0 | **1** |
| archived | 1 | — | 1 |

**Distinct leads on the board: 6.** (4 with HOI, 6 with VOE, overlapping.)

**Correlated replies, all time: 3.** Against **694** inbound messages the poller
has seen and matched to nothing.

### The fourth state is the board

`no send record` means the row has neither a `gmail_thread_id` nor an
`rfc_message_id`, so `quote_reply_match` has nothing to key on. **A reply to one of
these cannot attach even if it arrives.** That is not "waiting" — it is *"we never
asked through a channel that can hear an answer"*, and it is **15 of 21 rows**.

Rendering that as amber "awaiting" alongside genuine waits would be the board
lying in the most expensive direction: it would show 20 rows apparently in flight
when only 5 can ever resolve.

### "Replied with a document" vs "replied without"

`order_document_status` distinguishes these, and with **1 replied row** the split
is at most 1 versus 0. It is worth carrying in the model — the logic exists and is
proven — but it cannot carry a colour of its own yet without an empty legend.

---

## 2. Is it mostly empty? — Yes, and that is the finding

Six leads and twenty-one rows is not a board, it is a list. Built as a full tab it
would look broken; built as a dashboard card it would be honest and useful.

**This is not an argument against building it.** The single most valuable thing it
could say today is *"15 of your 21 third-party requests went out through a path
that cannot hear a reply"* — which nobody currently sees anywhere. That is a
finding the board would surface on day one, and it is worth more than the
reply-tracking it was asked for.

---

## 3. Where it should live — a dashboard card, not a tab

| option | verdict |
|---|---|
| **A tab** | Disproportionate. A tab implies a workspace; six leads is a glance. It would also compete with the per-lead panels that already do this job properly for one file. |
| **A dashboard card** ✅ | Matches the volume, sits where cross-lead questions are already asked, and can grow into a tab if the numbers grow. |
| A strip | Too little room for the state that matters — "cannot correlate" needs a sentence, not a swatch. |

**Recommended: a card on `/dashboard/admin`,** one row per outstanding request,
grouped by state with the counts in the header.

### The colour scheme, chosen so the dominant state reads correctly

- 🟢 **replied** — green, and if `order_document_status` says a document came,
  say so on the row
- 🟡 **awaiting** — amber, with days-since-send, because that is the only state
  where chasing helps
- ⚪ **cannot correlate** — deliberately **grey, not red**. It is not a failure of
  the counterparty and colouring it red would train the eye to ignore it. Grey with
  an explicit label: *"sent outside the tracked channel — a reply cannot attach"*
- The header should carry the honest total: **"5 of 21 can resolve"**

---

## 4. What I would want settled before building

1. **Does the "cannot correlate" state have a fix, or only a label?** For most of
   the 15 the answer is re-sending through the Gmail path, which is a *workflow*
   the board could link to. If it links nowhere, it is a list of regrets.
2. **Archived rows** — the 1 archived HOI request should be excluded, but the
   board should say it excluded something.
3. **694 unmatched inbound** is the other half of this picture and is not on the
   board as scoped. A counterparty may well have replied into a thread nothing
   correlated. Worth knowing whether the board should surface that too, or whether
   it is a separate question.

Point 3 is the one I would push on. As scoped, the board answers "who has replied
in a way we recorded". The 694 says that may not be the same as "who has replied".
