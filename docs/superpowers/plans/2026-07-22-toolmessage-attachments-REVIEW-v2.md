# Review v2: `toolMessage` attachments plan, re-checked against current `main`

Re-reviewing `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-22-toolmessage-attachments.md`
after `a790075a4` (queueMessage + the turn-boundary unification, #651).

**Verdict: the plan is still sound. The design does not need to change.** The
code it depends on is intact; what moved is a *call site the plan cites*, not
any function it calls. Below: one thing the plan should now say out loud (why
not `queueMessage`), one stale file reference, one instruction whose target
text has drifted, and four small factual nits. All are edits to the plan, not
redesigns.

## What actually changed underneath, and why it does not break the plan

`a790075a4` did two things. It added a public `queueMessage` primitive on
`MessageThread`, and it moved message delivery at the turn boundary out of
`prompt.ts` into a new `lib/runtime/turnBoundary.ts`.

Everything Task 1 consumes survived that move unchanged:

- `buildReplyUserMessage`, `HarvestedReplyAttachment`, and `ReplyAttachmentPart`
  are all still exported from `lib/runtime/replyAttachments.ts`
  (`replyAttachments.ts:34`, `:38`, `:162`). That file's last commit is still
  `ea64ad10d`, the original attachments PR — `a790075a4` never touched it.
- The exact push pattern the plan copies still exists, just in a new home:
  `smoltalk.userMessage(buildReplyUserMessage(pending) as smoltalk.UserContentInput)`
  now lives in `attachmentsProducer` at `lib/runtime/turnBoundary.ts:78-82`.
- `_toolMessage` is on main as described (`lib/stdlib/thread.ts:82-131`), with
  the `args` guards the plan says to leave alone.
- `MessageThread.push(message, label)` (`messageThread.ts:184`) and
  `labelAt(index)` (`messageThread.ts:190`) are unchanged, so every test in the
  plan still compiles against the real API.
- `_imageAttachment(source, mimeType, base64)` and
  `_fileAttachment(source, filename, mimeType, base64)` match the argument
  lists used in the plan's tests (`thread.ts:216`, `thread.ts:230`).

## 1. Say why `_toolMessage` pushes directly instead of using `queueMessage`

There is now an obvious-looking alternative that did not exist when the plan was
written: `agency.thread.current().queueMessage(...)`. An executor reading
`turnBoundary.ts`'s module comment — "the public way to inject a message into a
running conversation is `MessageThread.queueMessage`" — could reasonably
conclude the plan's direct `thread.push` is the old way and "modernize" it. The
plan should settle the question explicitly rather than leave it open.

**First, a correction to an easy misreading of the timing.** Queued messages do
*not* land at some vague later point. There are exactly two delivery points, and
for the ordinary case they put the message precisely where a direct push would:

- Call entry, **before** the new prompt is pushed. `runInitialBoundary`
  (`turnBoundary.ts:174-183`) drains the queue, and only then does `prompt.ts`
  run its `pushPrompt` step (`prompt.ts:1186-1194`).
- After every tool round, once all tool results are in
  (`runRoundBoundary`, `turnBoundary.ts:156-172`; called at `prompt.ts:1831`).

So for `toolMessage("t", {}, ["text", img])` followed immediately by `llm(...)`,
queueing and pushing produce the *same* transcript: assistant / tool /
attachment-user-message / prompt. Any claim that queueing "detaches the image
from its tool result" is wrong for that case.

**Where they actually diverge** is when something else is pushed between the
seed and the next call — which is the normal way seeding gets used:

```
thread.toolMessage("screenshot", {}, ["saw this", img])
thread.userMessage("Now compare it against the spec.")
llm(...)
```

`toolMessage` pushes messages 1 and 2 immediately. If message 3 is queued, the
"Now compare it" push lands ahead of it, and the transcript becomes
assistant / tool / "Now compare it" / `[att_1 — image output of tool screenshot]`.
The label now points backwards past an unrelated message. And in the case where
no further `llm()` ever runs on that thread, the seeded pair is in history while
its attachment never arrives at all — the tool result reads `[see attached]`
with nothing attached.

The rule that falls out is simple and worth stating in the plan: **`toolMessage`
emits an atomic group, so all of its messages travel by the same mechanism.**
`#641` already chose immediate `push` for messages 1 and 2. Queueing only
message 3 would put two delivery mechanisms inside one function — more ways to
do the same thing, not fewer. (The alternative that *would* be uniform, queueing
all three, is discussed in §1b; I do not recommend it.)

Add a Global Constraints bullet saying this, in about those words.

### 1b. Could `queueMessage` be made to carry attachments properly? Yes — and it should, separately

The second half of my original objection was that `queueMessage` stores content
raw with no path→base64 inlining. That part is accurate, and it is a real gap in
`queueMessage` **independent of this plan**. Worth fixing on its own; not worth
folding into this plan.

What happens today when a JS helper queues an image with a `{kind: "path"}`
source (which the signature `content: string | smoltalk.UserContentInput`
openly invites):

- The raw part sits in `queuedMessages` and is serialized with the thread
  (`messageThread.ts:281-283`, and cloned through `adoptFrom` at `:164`), so a
  checkpoint carries a *filesystem path* across resume — possibly to another
  machine or another cwd.
- Nothing inlines it at delivery: `queuedMessagesProducer`
  (`turnBoundary.ts:104-118`) hands the content straight to
  `smoltalk.userMessage`.
- smoltalk resolves it at send instead (`resolveMessageAttachments`,
  `smoltalk/dist/clients/resolveAttachments.js:83-102`). If the file changed in
  the meantime the model silently sees different bytes; if it is gone, the
  resolver returns `failure(...)` and **the whole request fails**, not just the
  attachment.

Contrast `buildReplyUserMessage`, which inlines at build time and degrades an
unreadable file to a text note that never fails the turn
(`replyAttachments.ts:162-190`). That asymmetry is the actual duplication in the
codebase — two attachment paths with different durability guarantees — and it is
what "one way to do things" should be aimed at.

**What the fix would take (small, ~half a day):**

1. Extract the path→base64 loop out of `buildReplyUserMessage` into a pure
   helper, e.g. `inlineAttachmentPaths(parts: UserContentPart[]):
   UserContentPart[]` in `replyAttachments.ts` (or a new
   `lib/runtime/attachmentInlining.ts` if that file is getting crowded). It
   keeps the existing never-throw behavior: an unreadable path becomes a text
   part naming the failure. `buildReplyUserMessage` becomes label-building plus
   a call to it.
2. Call it from `MessageThread.queueMessage` when `content` is an array —
   inline at *queue* time, not at drain. Queue time is when the caller
   guarantees the file exists, and it makes the serialized queue self-contained,
   which is the property the checkpoint path needs.
3. Tests: queue a path image, delete the file, drain, assert base64 with the
   right bytes; queue a path image, `toJSON`/`fromJSON` the thread, assert the
   queue survives with no path left in it.

Note this fix does **not** change the answer in §1 — even with inlining in
place, `toolMessage` still wants atomic delivery of its three messages. What it
does buy is that the two attachment paths finally agree on durability, and any
future feature that queues an image gets the same guarantee for free.

I would file this as its own issue and leave the plan alone.

## 2. Stale reference: `prompt.ts:1848`

Self-Review, "Type consistency": "mirrors the loop's
`smoltalk.userMessage(buildReplyUserMessage(entries) as smoltalk.UserContentInput)`
at `prompt.ts:1848`". That line no longer exists — `prompt.ts` now calls into the
turn boundary. Update the citation to
`lib/runtime/turnBoundary.ts:78-82` (`attachmentsProducer.take`). The pattern
itself is byte-for-byte what the plan writes, so only the pointer changes.

## 3. Task 2 Step 2's target comment has drifted

Step 2 says to add a "SECOND CONSUMER" sentence after the "MODEL-FACING API"
note in `replyAttachments.ts`. That note is still there
(`replyAttachments.ts:26-28`), so the instruction works as written. But the
sentence right above it is now itself stale:

> the tool loop drains the branch queue at invocation completion, harvests it
> here into the prompt's `runnerState` ... and after the full tool round the
> loop injects ONE labeled user message built here.

The loop no longer injects it; `turnBoundary.attachmentsProducer` does. Since
the step is already editing that paragraph, have it fix the attribution too, and
phrase the new sentence as "`buildReplyUserMessage` has two callers" rather than
"the tool loop plus a second consumer":

```
 * TWO CALLERS: `turnBoundary.attachmentsProducer` (the live tool loop) and
 * std::thread.toolMessage (lib/stdlib/thread.ts), which uses it to attach
 * images to a seeded tool result. A change to this function's output shape or
 * its label wording affects seeded messages too, not just the live loop.
```

## 4. Task 1 Step 2's `toJSON` caveat is resolved — you can delete it

Step 2 asks the executor to "note the actual shape" of `msgs[2].content`,
because the tests read it through a `toJSON` hop the existing reply-attachment
tests never exercise. I checked it directly against the installed smoltalk
(0.8.4):

```
userMessage([{type:"text",…},{type:"image",…}]).toJSON().content
  → [{type:"text",…},{type:"image",…}]
userMessage([{type:"text", text:"only"}]).toJSON().content
  → [{type:"text", text:"only"}]      // NOT collapsed to a string
```

Content stays a `UserContentPart[]`, including in the single-text-part case the
"unreadable path" test relies on. The accessors in the plan's tests are correct
as written. Replace the caveat with a one-line statement of that fact so nobody
re-derives it.

## 5. Nits

- **Import line number.** Task 1 Step 3 says the `ReplyAttachmentPart` import is
  "line 3" of `lib/stdlib/thread.ts`. It is line 4.
- **Test counts.** Task 1 Step 5 expects "the original 8 plus the 12 new cases".
  The file currently has **7** `it(...)` blocks, and the plan adds **11**. Say 18
  total, or just drop the numbers.
- **`att_` prefix comment.** The comment in Step 4 says `att_` "deliberately
  parallels the loop's `img_N`". Still accurate — the `img_${...}` mint is at
  `replyAttachments.ts:120`, untouched.
- **Task 2 Step 4's fixture exists.** `tests/agency/thread/toolmessage-roundtrip.agency`
  is present, so the round-trip check is runnable as written.

## Not a problem, checked anyway

- **Message alternation.** The follow-up user message lands immediately after a
  `tool` message. That is the same adjacency the live loop produces, so no
  provider complains.
- **`smoltalk.UserContentPart` is exported** and is `TextPart | ImagePart |
  FilePart`, so `isToolResultAttachment` / `toolResultPartText` type-check as
  written, and the v1 review's blocking text-part bug stays fixed.
- **The `label || null` on all three pushes** is consistent with how
  `attachmentsProducer` labels its message (`null`) — no conflict, since seeded
  messages carry the caller's debug tag by design.
