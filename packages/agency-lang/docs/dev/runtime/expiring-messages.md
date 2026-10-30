# Expiring messages

Most messages stay in a thread for as long as the thread exists. A few
are only meant to be there while something is in progress: one `llm()`
call, one model request, or one handoff body. When that thing ends, the
runtime removes them. These are expiring messages, and they all work the
same way.

There are three today:

1. The persona and any other system message a handoff body pushes. It is
   removed when the body returns.
2. The "Relevant context from memory" system message that `llm(…, {
   memory: true })` adds. It is removed when the request it was recalled
   for returns.
3. The round warning (`warnAtRoundsLeft`, see
   `docs/dev/agents/tool-loop-guards.md`). It is removed when the `llm()`
   call that sent it returns.

Agency code can add a fourth kind of its own:

```
userMessage("Reply in French for this question only.", expires: "llmCall")
const answer = llm("What is the capital of Peru?")
// The French instruction is gone from the thread here.
```

## The metadata on a message

Every smoltalk message has an optional `metadata` record that smoltalk
keeps through `toJSON` and `fromJSON` and never sends to a provider
(`docs/dev/llm/smoltalk.md`). Agency writes two keys there:

```ts
type MessageMetadata = {
  label?: string;
  expires?: { at: "llmCall" | "request" | "handoff"; key: string | null };
};
```

`label` is the debug label from `llm(label:)` or `userMessage(msg,
label:)`. `expires` is present only on an expiring message. `at` says
what kind of thing owns the message, and `key` says which one.

`lib/runtime/state/messageMetadata.ts` is the only module that reads or
writes these keys. It exports `labelOf`, `expiryOf`, `withMetadata`, and
`mayExpire`. No other file spells the key names.

The `metadata` option of `llm()` (in `lib/typeChecker/builtins.ts`) is a
different thing. It belongs to the request.

## Owners, keys, and where each expires

| `at` | Owner | `key` | Removed in |
|---|---|---|---|
| `llmCall` | one `llm()` call | the call's key, `self.llmCallKey` | the `finally` of `runPrompt`, when `shouldPop` is true |
| `request` | one model request | the call's key plus the request's step key | the `finally` around that request in `runPrompt` |
| `handoff` | one handoff dispatch | the handoff scope key from `handoffScopeKey` | `closeHandoff` in `lib/runtime/handoff.ts` |

Each owner removes its messages with one call:

```ts
thread.expire("llmCall", self.llmCallKey);
```

`expire` removes every message whose expiry matches both `at` and `key`.
It is the only way expiring messages leave a thread.

The key keeps owners apart. Two `async llm()` calls on one thread each
remove only their own messages. A handoff nested in a handoff removes
only its own persona. A handoff body's `llm()` call runs on the caller's
thread and removes only what it added.

The call's key is a random id that `initLoopFrame` (`lib/runtime/loopFrame.ts`)
mints once and keeps on the `runPrompt` frame, so a resumed call reads
the same key. It is not the statelog span id, which is undefined when
logging is off.

An `llmCall` message expires in the `finally` of `runPrompt`, on every
exit except a pause: a normal return, an `endTurn`, a cancel, a thrown
failure. `shouldPop` is false only when the call leaves paused on an
interrupt. A paused call is resumed later and still needs its messages,
so they stay. The `finally` is not a step. It does not need to be one,
because the frame is popped there and nothing replays it.

A `request` message is pushed inside the request step and removed in a
`finally` right after the request returns. The `finally` covers a guard
trip that unwinds the request and re-issues it, so the message is never
left behind and pushed a second time.

A `handoff` message gets its expiry from `push`. While a handoff body
runs, the thread holds the dispatch's scope key
(`enterHandoffScope`), and `push` gives every system message that has no
expiry of its own `{ at: "handoff", key: <scope key> }`. User messages
do not get it, so a user message the body pushes stays on the caller's
thread. `docs/dev/language/handoff-functions.md` covers the rest of the
handoff.

## Claiming an unkeyed message

Agency code that calls `userMessage(…, expires: "llmCall")` runs before
the call that will own the message has started, so it has no key to
give. The message is pushed with `{ at: "llmCall", key: null }`.

When an `llm()` call starts, its `pushPrompt` step calls
`claimUnkeyed("llmCall", key)`. That writes the call's key into every
`llmCall` message whose key is null. The claim is inside the step, so a
resumed call does not claim twice.

Only Agency code that ran since the last call started can leave an
unkeyed message, so a handoff body's call claims only what the body
pushed. A message pushed in a handoff body that makes no `llm()` call of
its own is claimed by the caller's next call, which may be the next
turn.

## Which roles may expire

Only system and user messages may expire. A tool message has to stay
paired with the assistant message that called it, and an assistant
message with tool calls has to keep its results. Otherwise the provider
rejects the next request.

`push` throws when it is asked to give an expiry to any other role. That
check is not enough on its own, because a message can arrive with
`metadata.expires` already in its JSON. A seeded `messages:` array can
carry one, and so can an edited checkpoint. So `expiryOf` returns null
for any role that may not expire, whatever its JSON says, and `expire`
never removes such a message.

## Copy-on-write

The runtime never changes a message in place. `withMetadata` returns a
copy of the message with the new metadata, rebuilt through its JSON, and
the thread stores the copy. `adoptFrom` and `getMessages` share message
objects between holders, so changing one in place would change it in
every thread that shares it.

`push` with a null label or a null expiry leaves whatever the message
already carries. `replaceAt` copies the old message's label onto the
message that replaces it.

## Serialization and logs

The metadata is part of each message's JSON, so it travels wherever a
thread is serialized: checkpoints, saved agent sessions, and the thread
JSON that Agency code reads. A message without metadata serializes
exactly as it would without the field.

The statelog dump (`withMessageLabels` in `lib/runtime/promptEvents.ts`)
leaves `metadata` out and adds the label as a top-level `label`.

Checkpoints written before the metadata existed carry two arrays beside
the messages, `messageLabels` and `messageScopes`, which line up with the
messages by position. `MessageThread.fromJSON` reads both and writes
them into the messages' metadata. A scope string becomes
`{ at: "handoff", key: <the string> }`. `toJSON` never writes them.

## Compaction

Memory compaction replaces the older part of a thread with a summary.
It leaves expiring messages out of the text it summarizes and keeps them
in the thread, right after the summary (`keptIndices` on the plan from
`compactIfNeeded`). Their owners remove them later, and their text never
lives on in the summary.

## Clones keep expiring messages

`newSubthreadChild` copies its parent's messages through their JSON, so
a subthread starts with the parent's expiring messages. Nothing removes
them from the child. This is correct because a child never outlives the
owner of a message it copied:

- Memory facts are pushed right before a request and removed right after
  it. No Agency code runs in between, so nothing forks the thread while
  they are there.
- A handoff persona is copied into a `subthread {}` opened inside the
  body, and the body's calls in that subthread need it. The subthread
  ends with its block, before the body returns.
- A round warning is on the parent only during the parent's `llm()`
  call. The only Agency code that can fork the parent's thread during
  that call is a handoff body, because an ordinary tool runs on a fresh
  thread store. A subthread opened there ends before the body returns,
  which is before the parent's call ends.

A `thread { }` block's messages are read after every `llm()` call inside
it has returned, so they hold no call-owned messages. They can hold an
unkeyed `llmCall` message that Agency code pushed with no call after it.
When those messages are passed to a later `llm()`, that call claims the
message and removes it, which is what the user asked for.

A handoff body's own `llm()` calls run on the caller's thread with their
own round counts. While the body runs, the caller's round warning is
still on the thread, so the body's model reads it. It is still true for
the caller.

## The rule

To add a message that should not outlive its call, request, or handoff,
push it with an expiry and let its owner call `expire`. Do not find the
message again by its content or its position.

Four other edits change history, and they are the only edits of
assistant and tool messages:

1. `dropHandoffToolCall` removes a handoff's call from an assistant
   message's tool-call list.
2. `endThreadWithAnswer` replaces a trailing assistant message with the
   answer.
3. Memory compaction replaces the older part of the thread with a
   summary.
4. `repairReopenedThread` appends tool results for calls an abandoned
   turn left without one.

## Files

- `lib/runtime/state/messageMetadata.ts`: the metadata type, its
  readers, and `withMetadata`.
- `lib/runtime/state/messageThread.ts`: `push`, `expire`,
  `claimUnkeyed`, `labelAt`, `expiryAt`, and the legacy fold in
  `fromJSON`.
- `lib/runtime/loopFrame.ts`: the call's key.
- `lib/runtime/prompt.ts`: the claim in `pushPrompt`, the memory facts
  and their `finally`, and the `llmCall` expiry in the `finally` of
  `runPrompt`.
- `lib/runtime/handoff.ts`: `closeHandoff` and `stripHandoffSystemMessages`.
- `lib/runtime/turnBoundary.ts`: `roundWarningProducer`.
- `lib/runtime/memory/manager.ts`: `compactIfNeeded` and `keptIndices`.
- `lib/stdlib/thread.ts` and `stdlib/thread.agency`: the `expires`
  argument of `systemMessage` and `userMessage`.
- Tests: `lib/runtime/state/messageMetadata.test.ts`,
  `lib/runtime/state/messageThread.test.ts`,
  `lib/runtime/prompt.toolRounds.test.ts`,
  `tests/agency/threads/expires-llm-call.agency`,
  `tests/agency/memory/llm-injection.agency`,
  `tests/agency-js/round-warning`, and `warningInsideHandoff` in
  `tests/agency-js/handoff`.
