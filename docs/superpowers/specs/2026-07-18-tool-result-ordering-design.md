# Spec: tool results in call order — agency-side ordering + smoltalk Gemini repair

**Status:** brainstormed with the owner 2026-07-18 (issue #579);
decisions settled. Two independent fixes in two repos. This spec
fully designs the agency half (Part A) and records the smoltalk
half's contract (Part B); the smoltalk change is designed and
reviewed in that repo.

---

## Part 1: Background

### How tool results pair with tool calls

One round of tool calls looks like this in the conversation. The
model sends one message that says "call these tools." Agency runs
the tools. Then agency sends one result message back per call, and
the model continues.

The model's provider needs to know which result answers which call.
Most providers solve this with an id: every call carries one, and
every result repeats it. With ids, order does not matter. OpenAI and
Anthropic work this way.

Gemini is the exception, and the ground truth shifted since our code
comments were written (verified against the current docs during
brainstorming):

- **Gemini 3.5 and later** send a `functionCall.id` and pair
  `functionResponse.id` back to it. Order-free, like everyone else —
  IF the ids are round-tripped.
- **The Gemini 3 family** has no usable ids. It REQUIRES
  functionResponse parts in the exact order the calls were received.
  It also attaches a `thoughtSignature` only to the FIRST call of a
  parallel batch, which makes order load-bearing beyond pairing.

### What agency actually sends

Completion order, not call order. Each dispatched tool's branch
pushes its result message the moment the tool finishes, so a slow
first tool posts last. Since #578, a saveDraft handled by the loop's
ordered pass posts before every dispatched result in its round —
one more reordering source, and a systematic one.

For id-pairing providers this is harmless. For Gemini 3 it is a
silent data swap: two same-named calls in one round get their
results matched by position, so the model can read tool A's answer
as tool B's. Nothing errors. The model quietly reasons from swapped
data.

### What smoltalk actually sends

Two gaps, both verified in the source:

1. The non-streaming Gemini response parser DISCARDS the id Gemini
   now sends: `new ToolCall("", functionCall.name, ...)` hardcodes
   the empty string (`clients/google.ts`). The streaming path keeps
   it.
2. `ToolMessage.toGoogleMessage()` emits
   `functionResponse: { name, response }` with no id, and the
   request builder maps messages 1:1 into `contents` with no
   reordering. So even a caller that sends perfect call order gets
   no id pairing on 3.5+, and a caller that sends completion order
   gets silent swaps on Gemini 3.

### Decision (owner, 2026-07-18): fix BOTH layers

smoltalk is just one library a user can point agency at; another
library may have the same gaps. So agency stops depending on any
library's pairing behavior by emitting results in call order (Part
A), and smoltalk repairs the Gemini wire for every consumer it has
(Part B). Belt and suspenders. Two PRs, one per repo, independent —
neither depends on the other landing first.

---

## Part 2: Part A — agency emits each round's results in call order

### The change in one sentence

Per-call result messages stop going onto the live thread as each
tool finishes; instead every per-call message the round produces is
FILED in frame-persisted round state keyed by call index, and one
idempotent step after the round pushes them all in call-index order.

### The precedent this copies

Reply attachments already work exactly this way, for the same
reason: tools file attachments into `self.runnerState` during the
round, and a `pr.step` after the round injects ONE user message
after all tool results (`round.${round}.attachReplies`), snapshotting
`messagesJSON` inside the step. Frame state (`self.runnerState`)
serializes with checkpoints, and `pr.step` completion marks make the
injection resume-idempotent. Part A is the same shape applied to the
results themselves.

### What routes through the buffer

Every message the round produces FOR A SPECIFIC CALL — the rule is
"one filed entry per tool call, always", because providers reject a
round whose calls are not all answered:

- success results (today `pushSuccessToolMessage`),
- error results a failing tool sends back to the model,
- the unhandled-tool notice ("No handler found for tool call ..."),
- the removed-tool notice,
- the max-rounds notice,
- the saveDraft intrinsic's ack (today pushed inside
  `runIntrinsicCall`; it files with its call index instead).

NOT routed through the buffer, because they are round-level rather
than per-call: the assistant message that opens the round, the
reply-attachment user message (already ordered after results by its
own step), guard feedback drains, and validation-retry user
messages.

### The flush step

After the round's ordered intrinsic pass and the concurrent pool
both complete, a new `pr.step` (`round.${round}.flushToolResults`)
runs BEFORE the existing `attachReplies` step. It reads the round's
filed entries, pushes each message in call-index order with the same
`tool_call_id`/`name` fields it carries today, clears the round's
buffer, and snapshots `messagesJSON` — the same idempotency pattern
`attachReplies` uses, for the same reason (a completed flush is
skipped on resume; the snapshot carries the pushed messages into any
later checkpoint).

### The interrupt and resume story

This is the part that made the naive "buffer in a local array"
version wrong, and why the buffer lives in `self.runnerState`:

- A sibling tool interrupts mid-round. The shared checkpoint stamps.
  Completed tools' results are NOT yet on the thread — but they are
  in `runnerState`, which serializes with the frame. Nothing is
  lost.
- On resume, completed branches skip (their `b.step` marks are
  done), still-pending tools run, and the flush step then pushes
  everything in order. The flush had not completed pre-interrupt, so
  it is not skipped.
- No request goes to the provider between the interrupt and the
  flush, so the thread temporarily lacking result messages is
  invisible to the model.
- A run KILLED mid-round and never resumed leaves filed-but-unpushed
  results in a dead frame — the same status quo as today's
  never-pushed results from unfinished branches.

One consequence worth naming: today, a completed branch's result is
visible in the live thread at the moment a SIBLING's interrupt
checkpoint snapshots messages. After Part A it is in `runnerState`
instead. Both are in the checkpoint; what changes is which field
carries it. Statelog `toolCall` events still fire per-tool at
completion time, so observability order is unchanged — only the
THREAD order changes.

### What deliberately does not change

- Branch structure, `b.step` idempotency keys, invoke/end/log steps,
  tool timing, span pairing: untouched. Only the `messages.push`
  sites move.
- The intrinsic pass still runs first and still writes the draft at
  its call-list position — the ordering guarantee for saveDraft
  WRITES was never about the thread; it stays where it is.
- `removedTools` strategy B semantics, guard gates, feedback drains:
  untouched.

---

## Part 3: Part B — the smoltalk contract (designed in the smoltalk repo)

Three fixes in `packages/smoltalk/lib/clients/google.ts` and
`classes/message/ToolMessage.ts`, recorded here as the companion
contract:

1. **Keep the id on parse.** The non-streaming response parser stops
   hardcoding `""` and carries `functionCall.id` when Gemini sends
   one (the streaming path already does).
2. **Echo the id on send.** `toGoogleMessage()` includes the id in
   the `functionResponse` when the tool message has one — real
   pairing on Gemini 3.5+.
3. **Reorder defensively at request build.** Before sending, walk
   `contents`; after each model message with functionCall parts,
   reorder the following functionResponse contents to match the call
   order (by name; by position within duplicate names). This
   protects Gemini 3 even when a consumer sends completion order.
   No merging of responses into a single content unless
   `@google/genai`'s types force it — the docs accept separate
   contents, and reorder is the minimal correct repair.

Part B lands as its own PR in `~/smoltalk`, following that repo's
conventions, then agency bumps its smoltalk dependency.

---

## Part 4: Testing (Part A)

- **The distinguishing layer is a runtime test, not a fixture.** A
  scripted client issues two tool calls whose handlers complete in
  REVERSE order (controlled with deferred promises); assert the
  thread's result messages come out in CALL order with the right
  `tool_call_id` pairing. A second case mixes a saveDraft call and a
  dispatched tool and asserts the dispatched-but-earlier call's
  result precedes the ack. Fixtures cannot force completion order
  without wall-clock races, which this repo's tests do not do.
- Resume: extend the runtime test with an interrupting sibling —
  completed result filed pre-interrupt, flush after resume, thread
  order still call order. (The existing `savedraft-tool-resume`
  fixture keeps passing as an e2e sanity check.)
- Per-call error shapes: unhandled tool and error result route
  through the buffer — one runtime case each asserting position and
  pairing.
- Byte-stability where it applies: rounds with a SINGLE tool call
  produce the same thread content as today (order is trivially
  identical); the full fixture suite must stay green since ordering
  only ever changes multi-call rounds, which the deterministic
  fixtures exercise with same-name-only calls (saveDraft twice) or
  outcome-only assertions.

## Part 5: Out of scope, recorded so they stay decisions

- Merging Gemini functionResponse parts into a single content
  (smoltalk, only if the SDK forces it).
- Transcript-order guarantees for round-LEVEL messages (attachments,
  feedback) — they keep their existing positions.
- Any provider-specific behavior in agency: Part A is deliberately
  provider-agnostic; everything Gemini-shaped lives in Part B.
- Backporting the ordering to statelog event streams (events remain
  completion-ordered; they carry timing and that is their point).
