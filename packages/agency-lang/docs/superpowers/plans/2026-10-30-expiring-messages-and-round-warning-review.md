# Review: expiring messages and round warning plan

Plan: `docs/superpowers/plans/2026-10-30-expiring-messages-and-round-warning.md`
Spec: `docs/superpowers/specs/2026-10-30-expiring-messages-and-round-warning.md`

I checked the plan's claims against the code in this worktree and in
`~/smoltalk`. Each finding gives the file and line it rests on and a
proposed fix. They are grouped by how much they would hurt if the plan
ran as written.

## Would ship a bug

### 1. The call key is `undefined` whenever statelog is off

Task 6 Step 4 stores the call's key as `self.llmCallKey ??= llmSpanId`.
`llmSpanId` comes from `run.log.reopenSpan(...)` (`lib/runtime/prompt.ts:790`),
and `reopenSpan` returns `undefined` when the client is disabled
(`lib/statelogClient.ts:350-353`). Most runs and most tests have statelog
off. Then every `llm()` call on a thread has the same key, `undefined`,
and the keys no longer keep concurrent or nested owners apart. In the
handoff case, the body's `expireLlmCall` would remove the caller's round
warning along with its own.

The unit test in `prompt.toolRounds.test.ts` will not catch this. Its
`makeCtx` configures a statelog host and API key (lines 18-29), so the
span id is a real string there.

The spec's claim that `reopenSpan` keeps the id stable across a resume
is also only half true. `savedSpanIdFor` returns the saved id only when
the trace matches (`lib/statelog/spanSlot.ts:17-19, 46-48`), so a CLI
resume or a rewind gets a new id. Storing the key on the frame, as the
plan does, covers that half.

**Fix:** mint the key independently of statelog:
`self.llmCallKey ??= nanoid()`. Fix the spec's table row for `llmCall`
to say "a random id stored on the `runPrompt` frame".

### 2. The `request` key is the same for every `llm()` call

Task 5 keys the memory-facts message with `llmCallKey({ first: true })`.
That function returns the constant `"initialLlmCall"`
(`lib/runtime/promptRunner.ts:58-59`). Every call on every thread gets
the same key. The spec says keys exist to keep concurrent owners apart,
and this one does not. A stale facts message carried in by a seeded
`messages:` array would also match it.

**Fix:** key it as `` `${self.llmCallKey}:${llmCallKey(which)}` ``. Task 5
then depends on Task 6 Step 4, so either move the `self.llmCallKey` line
into Task 5 or swap the two tasks.

### 3. `expireLlmCall` misses the `endTurn` return and every thrown exit

Task 6 Step 4 lists three exits: the structured `accept`, the structured
`surfaceFailure`, and the no-schema `break`. There is a fourth return,
`return turnEnded.returnValue` at `prompt.ts:1840`, taken when a tool
calls `endTurn` or a handoff ends the turn. That is the agent's normal
path when the explorer or oracle answers the user, so the coordinator's
round warning would stay on `main` and reach the next turn. That is the
bug this work exists to fix.

Thrown exits are missed as well. An Esc cancel rethrows an abort
(`prompt.ts:1999-2008`), and a guard failure throws. The warning stays on
the thread, the agent saves the session, and the next turn reads "This
is the last tool round".

The spec rules out the `finally` because "the `finally` also runs on an
interrupt bailout." The `finally` already knows which case it is in:
`shouldPop` is false only for a `PromptBailout` (`prompt.ts:1995-1998`).

**Fix:** expire in the `finally`, guarded the same way as the pop:

```ts
} finally {
  run.log.endSpan(llmSpanId);
  ctx.beforeCheckpoint = ctx.beforeCheckpoint.filter((refresh) => refresh !== refreshMessages);
  if (shouldPop) {
    messages.expire("llmCall", self.llmCallKey);
    stateStack.pop();
  }
}
```

That gives one site in place of four and covers return, `endTurn`, and
throw. No step is needed, because a popped frame is never replayed.
Before relying on it, read `docs/dev/runtime/pause.md` and confirm that
a `pauseSignal` either goes through `PromptBailout` or takes its
checkpoint before the `finally` runs. Add one unit test for the `endTurn`
path and one for a thrown cancel.

### 4. `replaceAt` drops the label

Today `replaceAt` keeps the label because the label lives in a side
array indexed by position (`messageThread.ts:173-180`). With the label on
the message, the new message replaces the old one and carries no label.
Two callers pass a brand-new message:
`smoltalk.assistantMessage(text)` at `lib/runtime/handoff.ts:119`, and
`answer` in `endThreadWithAnswer` at `handoff.ts:442`. The one at
`handoff.ts:111` rebuilds from `toJSON()`, so it would keep the label.

Task 4's test expects "a label and an expiry ride through ... replaceAt",
but the Step 3 implementation and the spec ("become plain array
operations") do not make that true.

**Fix:** in Step 3, say that `replaceAt` copies the old message's
`label` onto the new message with `withMetadata`. Leave `expires` out of
the copy, because only system and user messages may expire and every
caller replaces an assistant message.

### 5. The role rule is only checked on the `push` argument

Task 4 makes `push` throw when its `expires` argument is set on a tool,
assistant, or developer message. A message can also arrive with
`metadata.expires` already in its JSON:

- `llm(..., { messages })` seeds are revived with `fromJSON` and pushed
  as is (`prompt.ts:716-720`). Agency code can build those from
  `getThread()` output, which will now include `metadata`.
- A checkpoint is the program, so a hand-edited checkpoint can put
  `expires` on any message.

`expire` would then remove a tool message and leave its tool call with
no result, and the provider rejects the next request.

**Fix:** have `expiryOf` return null for any role where `mayExpire` is
false, so `expire` and `claimUnkeyed` cannot touch those messages
whatever their JSON says. Keep the throw in `push` as well. Add a test
that revives a tool message with `metadata.expires` set, then calls
`expire`, and checks the message is still there.

### 6. `push` with a null label erases a label the message already has

Task 3 says that in `withMetadata`, "a null value in the patch removes
that key". Task 4 Step 3 has `push` call
`withMetadata(message, { label, expires })` unless both are null. A
message that already carries metadata and is pushed with only one of
the two set loses the other. For example, a system message pushed inside
a handoff scope, with a label already in its metadata and no label
argument, would have its label removed when the handoff default is
added.

**Fix:** `push` writes only the keys it was given values for. Keep the
null-removes rule inside `withMetadata` for `expire` and the legacy
fold, and say so in the `push` doc comment.

## Would fail or mislead during implementation

### 7. smoltalk: the plan commits on `main`, edits CHANGELOG, and runs watch mode

- The smoltalk checkout is on `main`, with uncommitted owner edits: the
  0.20.1 bump in `package.json` and its CHANGELOG entry. Task 1 Step 5
  says "Commit in the smoltalk repo" with no branch, which would commit
  on `main` and could pick up the owner's edits.
- Task 1 Step 5 adds a CHANGELOG entry. The owner edits smoltalk's
  CHANGELOG and bumps the version. The standing rule is also to never
  touch a changelog unasked.
- `pnpm run test` in smoltalk is `vitest` with no `run`
  (`packages/smoltalk/package.json:7`), which is watch mode.

**Fix:** Task 1 Step 0: create `~/smoltalk/worktree-message-metadata` on
a new branch, then `pnpm install` and `pnpm --filter smoltalk build`.
Delete the CHANGELOG step. Put the changelog sentence in the PR
description instead, and open a smoltalk PR. Run tests with
`pnpm exec vitest run <file>`, and the full suite with
`pnpm exec vitest run --exclude='**/*.live.test.ts'`. Save output to the
session scratchpad, not `/tmp/claude-501/...`.

### 8. `pnpm link` dirties tracked files for the rest of Part B

`pnpm link <dir>` writes a `link:` entry into tracked files
(`package.json` or the workspace overrides, plus `pnpm-lock.yaml`). The
plan forbids committing it, but no later commit step names the files it
stages. CI also cannot pass until the real pin lands.

**Fix:** give every commit step an explicit `git add <files>` list.
State that Task 2 Steps 2 and 3 must land before Task 12's push. Restore
`package.json` and `pnpm-lock.yaml` from `HEAD` once the real pin is in.
smoltalk is already in `minimumReleaseAgeExclude`
(`pnpm-workspace.yaml:22-23`), so a new release installs right away.

### 9. Per-call `maxToolCallRounds` is missing from the `llm()` option table

Task 10 writes `llm("...", { tools: [lookup], maxToolCallRounds: 2 })`
in two agents. `maxToolCallRounds` is not in `llmOptionProperties`
(`lib/typeChecker/builtins.ts`; only `maxRepeatedToolCalls` is, at line
178). The checker runs an excess-property check on object literals
passed to a call (`lib/typeChecker/checker.ts:832`,
`utils.ts:317-336`). The researcher avoids the check by building its
options through a helper function (`stdlib/agents/researcher.agency:105-115`).
I could not run the checker (a hook blocks local test runs), so confirm
the error first.

**Fix:** if it errors, add a `maxToolCallRounds` row next to the new
`warnAtRoundsLeft` row in Task 7 Step 4. Its absence is a gap of its own,
since the runtime has read the per-call value since ADI-46. Do not
switch the handoff case to `setLlmOptions`. That changes the branch
default for the caller too.

### 10. The resume test does not test what it says it tests

Task 10 Step 2 uses cap 3: `ping` in round 0, a pause in round 1, then
text. With the defaults, the first warning fires after round 0
(remaining 2) and the final warning after round 1 (remaining 1). The
pause falls between them. After the resume, the final warning fires
because `remaining === 1`, whether or not `runnerState.roundWarnings`
survived the checkpoint. A lost `fired.first` would never be noticed,
because the first warning cannot fire at remaining 1.

The plan also reads "the final thread" from the last `onLLMCallStart`.
That hook fires before the last request, while the warning is still on
the thread by design. It cannot show the thread after the call.

**Fix:** use cap 5 with the default threshold 3. `ping` runs in rounds
0 and 1, so the first warning fires after round 1 (remaining 3). Pause
in round 2. After the resume, the boundary after round 2 has remaining 2,
which would fire the first warning a second time if the state were lost.
Assert that exactly one request contains "tool rounds for this request"
and exactly one contains "last tool round". To see the thread after the
call, have the node make a second `llm()` call with no tools on the same
thread and record its `onLLMCallStart` messages. Neither warning should
be in them. Add one mock for that call.

### 11. The test snippets do not match the helpers

- Task 6 Step 1 calls `runInTestContext(s.ctx, async (run) => ...)`. The
  helper takes four arguments,
  `runInTestContext(s.ctx, s.ctx.stateStack, s.threads, fn)`
  (`prompt.toolRounds.test.ts:143`).
- Task 4 says `lib/runtime/promptLabels.test.ts` "should pass
  unchanged". Line 132 reads `thread.messageLabels`, which Task 4
  deletes. `threadRepair.test.ts:163` does the same. Both need edits.
  `checkpointStore.test.ts:913` feeds `messageLabels` as input, so it
  should keep passing through the legacy fold. Name all three in Task 4.
- Task 9 changes the `REFUSAL` regex but not the four
  `toMatch(/\(N\) exceeded/)` assertions in the same file (lines 151,
  183, 193, 204). Update all four.
- Task 5 Step 1 tells the implementer to find "the function that returns
  the active thread's messages". `std::thread` has no `getMessages`. Use
  `getThread(currentThreadId())` (`stdlib/thread.agency:634, 644`), or
  make a second `llm()` call and read its `onLLMCallStart` messages, as
  in the existing test.

## Design questions for the owner

### 12. The request after the last allowed round still offers tools

The spec says (Part 4, "When each fires"): "Nothing fires at
`remaining == 0`. The next request offers no tools, so the model can only
answer." The code does something else. `atRoundCap` reads
`self.toolCallRound`, which is incremented only after the request
returns (`prompt.ts:597, 1878`). So the request after round `L-1` still
offers tools. Any call the model makes there is refused, and only the
request after that offers none. The existing test pins this: a cap of 3
gives `offered` of `[ping] x4, []` (`prompt.toolRounds.test.ts:154`).

So after the final warning ("the results of the tool calls you make now
are the last you will see"), the model runs its last round, sees the
results, and is offered the same tools again. A model that calls one
spends a request on a refusal. That is the round the warning is meant to
save.

There are two ways to resolve this:

- (a) Offer no tools on the request after round `L-1`, so the warning
  text holds. This changes the cap's behavior and the test above.
- (b) Keep the behavior and correct the spec and the dev doc.

I recommend (a). It makes the final warning true, and the refusal
becomes a fallback for a model that ignores an empty tool list. Either
way, the spec sentence needs fixing.

### 13. The spec's worked examples are off by one, and the dev doc would copy them

The spec gives "cap 50: first after round 47, final after round 49",
"cap 10: after round 7 and round 9", and "cap 2: final after round 1".
By its own formula `remaining = limit - (round + 1)`, those are 46/48,
6/8, and round 0. The plan's Task 7 tests use the correct numbers. Fix
the spec before Task 11 writes `expiring-messages.md` from it.

### 14. Statelog would carry the label twice, plus the expiry

Message JSON now includes `metadata`, so `redactMessagesForLog` emits
`metadata: { label, expires }` on every labeled or expiring message, and
`withMessageLabels` adds a top-level `label` beside it. Task 4 calls this
"unchanged in behavior". It changes what each logged message contains.
`onLLMCallStart` hook data and `getThread()` results will also show
`metadata`, so a fixture that records whole labeled messages will change.

Decide whether logs keep the top-level `label` (the logs viewer and the
`message-labels` fixture read it), keep `metadata`, or both. Whatever
the decision, add the `message-labels`, `stdlib-thread-messages`, and
`threads-registry` cases to Task 12's local runs, since those are the
fixtures that record labels.

## Smaller points

15. **Compaction can fold an expiring message into the summary.**
    `runPostTurnMemory` runs inside `_runPrompt` after every request
    (`prompt.ts:422`), while a warning or persona is on the thread. Its
    text then lives on in the summary. The warning is usually in the
    kept tail, so the risk is low. The spec cites Haystack keeping
    reminders out of compaction. A one-line filter that leaves expiring
    messages out of the summarized range would match that.
16. **An unkeyed `llmCall` message pushed in a handoff body that makes no
    `llm()` call** is claimed by the caller's next call, which may be the
    next turn. Add one sentence about it to the dev doc's claim rule.
17. **Merge helper.** Task 7 Step 4 says "reuse `roundWarningSettings`'s
    merge or a small shared `mergeFields` helper; do not write a third
    merge". Name the change instead: generalize `mergedReplyLimits`
    (`lib/runtime/localDefaults.ts:40`) into a generic
    `mergeDefinedFields<T>`, then use it for `replyLimits` and
    `warnAtRoundsLeft` in both `_setLlmOptions` and `runPrompt`.
18. **`turnBoundary.ts` header.** It says "Three sources ('producers')
    exist". Task 8 should update it to four and add the warning producer
    to the list.
19. **The word `metadata`.** `llm()` already takes a `metadata` option
    (`builtins.ts`, the `{ key: "metadata", value: ANY_T }` row), which
    is a different thing. Give it one sentence in
    `expiring-messages.md` so a reader does not confuse the two.
20. **Task 4 Step 6** expects the handoff fixture unchanged. That holds
    only if `test.js` records counts and never whole messages. I checked
    the `persona` block, which records counts. Skim the rest before
    trusting the claim.

## What holds up

- The round arithmetic in Task 7 (`remaining = limit - (round + 1)`,
  final checked before first, the `remaining: 10` with cap 3 case)
  matches the loop.
- Keeping `warnAtRoundsLeft` out of `stackSmolDefaults` and destructuring
  it from `clientConfig` keeps it off the provider wire, as
  `maxToolCallRounds` is kept off.
- The checkpoint schema stores `messages` as `z.array(z.any())`
  (`lib/runtime/state/schemas.ts:9`), so `metadata` survives a
  checkpoint without a schema change.
- Copy-on-write in `withMetadata` is the right choice. `adoptFrom`
  shares message instances between two threads (`messageThread.ts:194`),
  so changing a message in place would change both threads.
- `resolveAttachments.ts:203` is the only place in smoltalk that rebuilds
  a caller's message. The other `userMessage(...)`/`assistantMessage(...)`
  calls build new messages for a request.
