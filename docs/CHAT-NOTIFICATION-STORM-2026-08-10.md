# Chat notification storm — findings and design, 2026-08-10

**Read-only investigation plus a design. Nothing here was built.**

## What fires, and how often

Per **message**, per **recipient**. Not per thread, not per conversation.

```
staff_message_send(p_thread, p_body, p_attachments)          -- RPC, SECURITY DEFINER
  └─ INSERT app_notifications … one row PER PARTICIPANT (excluding the sender)
       kind='chat_message'  source_kind='chat'  source_id=<thread>  is_read=false
          │
          └─ TRIGGER app_notifications_chat  AFTER INSERT FOR EACH ROW
             WHEN (new.kind = 'chat_message')
               ├─ net.http_post → email-service        "💬 New message from <sender>"
               └─ net.http_post → clickup-mention-ping  task assigned to the recipient
```

**Nothing debounces. There is no cooldown, no dedupe, no check for an existing
unread notification.** Confirmed against the data rather than inferred:

| | |
|---|---|
| `chat_message` notifications in the last 24h | **21** |
| distinct `source_id` across all 21 | **1** |
| unread | **21** |
| window | 17:13 → 18:17, about **64 minutes** |

Twenty-one notifications, twenty-one emails, twenty-one ClickUp tasks, for
**one conversation**.

### The fact that makes the fix small

**`source_id` is already the thread, not the message.** The correct dedupe key
is therefore already present on every row:

```
(recipient_user_id, source_kind='chat', source_id)  WHERE NOT is_read
```

Nothing new has to be derived. The row that should have been updated is
identifiable by columns that already exist.

### Precedent, in the trigger's own body

The **SMS** arm of this same trigger was removed on 2026-08-07. Its comment
says it "duplicated what the chat notification already delivers in-app and by
email", fired per `app_notifications` INSERT, and notes the table "went from 22
rows all-time to 16 in a single week". That reasoning applies unchanged to the
email arm — which is now the loudest of the survivors — and the volume it warned
about has since gone to 21 rows **in an hour**.

---

## Design

### 1. One notification per conversation, updated in place

```sql
alter table app_notifications add column msg_count int not null default 1;

create unique index app_notifications_chat_unread_uq
  on app_notifications (recipient_user_id, source_id)
  where source_kind = 'chat' and not is_read;
```

`staff_message_send`'s insert becomes an upsert:

```sql
insert into app_notifications (…, msg_count) select …, 1
  from staff_thread_participants p
  where p.thread_id = p_thread and p.user_id <> auth.uid()
on conflict (recipient_user_id, source_id) where source_kind='chat' and not is_read
do update set msg_count  = app_notifications.msg_count + 1,
              preview    = excluded.preview,
              created_at = now();
```

**The debounce is then free, and this is the point of the whole design.** The
trigger is already `AFTER INSERT`. An upsert that lands on the UPDATE branch
fires *nothing* — no email, no ClickUp call. No cooldown table, no scheduler, no
timer to get stuck. The bell count and the preview still update, because those
are read from the row.

The UI reads `msg_count`: **"5 new messages"**, latest preview underneath.

### 2. The window is READ STATE, not minutes — and that is deliberate

The brief asked what window and why. **The window should not be a duration.** It
should be *until the recipient has read the conversation*, which is what the
partial index's `where not is_read` expresses.

- A ten-minute window still storms a long conversation: sixty messages over
  three hours is eighteen notifications, each one telling someone something they
  already know.
- Read state is the actual signal. If they have not read it, a second interrupt
  adds no information. Once they have read it, the next message genuinely is new
  and **should** break through — which happens automatically, because reading
  clears `is_read` and the next insert finds no conflict row.
- It cannot wedge. There is no state that outlives the thing that clears it.

This is the same rule as `gdrive-health-monitor`'s digest: key on identity, and
let something genuinely new break the cooldown. There, a new red check changes
the key. Here, "you have caught up" is the equivalent.

**The trade-off, stated on purpose:** a recipient who never opens the bell gets
one notification and no further nudges, however long the conversation runs. That
is correct. The alternative is what happened today.

### 3. If an unread task exists, update it — but do not chase the count

ClickUp cannot currently be updated, because **the task id is thrown away.**
`clickup-mention-ping` returns `clickup_task_id`, but it is invoked by
`net.http_post` from a trigger, which is fire-and-forget; the response lands in
`net._http_response` and is gone in about six hours.

So the prerequisite is:

```sql
alter table app_notifications add column external_task_id text;
```

…written back by the ping function (it needs a callback, or the trigger must
call it synchronously and capture the id).

With the upsert in §1 the task is created **once per unread conversation**, so
Rene sees one task instead of ten. **Do not PATCH it on every subsequent
message** — that restores one HTTP call per message to fix a number nobody is
reading in ClickUp. The task says "New messages from X — open chat"; the count
lives in the app, where the conversation is. Close the task when the
notification is marked read.

### 4. Does chat need email at all? — No. Cut it.

**Cut the email arm of `tg_app_notifications_chat` entirely.** Reasons, in order:

- The bell already exists and is the right surface: `notif-bell.js`,
  `notifications_unread_count`, `notifications_list`.
- Chat is a fast medium. An email per message is a slow copy of a fast thing,
  arriving after the conversation has moved on.
- **The SMS arm was already cut for exactly this reasoning**, five days ago, and
  documented in this same function. Email is the same argument with a higher
  volume.
- It is the arm generating the most noise per unit of information.

Keep ClickUp, reduced to one task per unread conversation — it is the thing Rene
actually works from, and one task is a legitimate to-do.

If an away-from-desk nudge is wanted, use **`send-push`** and the existing VAPID
keys. The trigger's own comment already recommends that over SMS; the same
applies to email.

Net effect per conversation: **1 bell entry, 1 ClickUp task, 0 emails** — down
from 21, 21 and 21.

### 5. Clearing the existing backlog

**App side — safe, scoped by `kind`:**

```sql
update app_notifications
   set is_read = true, read_at = now()
 where kind = 'chat_message'
   and not is_read;
```

`kind` is the discriminator the triggers themselves switch on, so this cannot
touch the six `system`/`monitor` notifications, which are a different kind and
are the ones worth keeping unread.

**ClickUp side — this is the awkward half, and it is awkward *because* the id
was discarded.** There is no stored link from a notification to its task, so the
only handle is the task's own shape. Filter on **all** of:

- title begins `💬 New message from` — the literal string this trigger builds,
- assignee is the recipient,
- created within the storm window (2026-08-10 17:13 → 18:17Z),
- list is the mention-ping default list.

Then **list them and read the list before closing anything.** Title-matching is
inference, not a key; a human-created task that happens to start with that
string would be caught by it. Four predicates ANDed together make that unlikely,
not impossible.

This is the concrete cost of not storing `external_task_id`, and the reason §3
lists it as a prerequisite rather than a nicety: the *next* cleanup would be one
join.

---

## Order of work, if approved

1. Cut the email arm. One `create or replace function`, immediate relief,
   reverses cleanly.
2. `msg_count` + the partial unique index + the upsert in `staff_message_send`.
   This is the actual fix and it needs no new moving parts.
3. Clear the backlog (app side, then ClickUp with eyes on the list).
4. `external_task_id` and the write-back, so the task can be updated and closed
   and the next cleanup is a join rather than a string match.

**Not built. No schema changed, no function replaced, nothing closed.**
