# Log viewer: errors, threads, and resumed runs — implementation plan

Read first:

- `docs/dev/cli/logs-viewer.md`, for how the four screens are built and what
  the story outline, transcript and message deltas promise.
- `docs/dev/hosting/statelog.md`, for the event format and how spans work.
- `docs/dev/runtime/interrupts.md` and `docs/dev/runtime/checkpointing.md`,
  for how a run pauses, saves a checkpoint and resumes.
- `docs/dev/llm/decision-models.md`, for how a typed call to a decision model
  becomes state and questions.
- `docs/dev/contributing/coding-standards.md` and
  `docs/dev/contributing/anti-patterns.md`.

Paths are relative to `packages/agency-lang` unless they start with
`smoltalk/`, which means `~/smoltalk/packages/smoltalk`. Each part below is
its own PR, with one commit per task.

## Background: the run that started this

A BMO chat turn (trace `105b7143`, in `~/bmo/log.jsonl`) asked for a weekly
schedule. What happened:

1. **Run 1.**
   - The expression check ran on the user's message (LLM call 1).
   - The main agent called `schedulesAgent` (call 2).
   - The sub-agent's `scheduleTask` calls failed twice on `repeatRule` (calls 5 and 6).
   - Call 7's `scheduleTask` raised `schedules::create`, and the run paused.
2. **Run 2.** The user approved. The run resumed, raised `schedules::setApprovals`, and paused again.
3. **Run 3.**
   - The user approved. The resumed `scheduleTask` crashed with "Resume desync", which was fixed in #1197.
   - The sub-agent retried twice (calls 8 and 9) and gave up (call 10).
   - The expression check ran on the reply (call 11).

The log viewer made this hard to follow:

- **Errors:** only the Trace screen showed them.
  - Overview said "● running" for a finished run.
  - Transcript dropped the Resume desync entirely.
  - Timeline showed nothing.
- **Threads:** Transcript and Overview didn't show them, and the sub-agent's thread was called "unnamed".
- **The resume itself confused the Trace screen:**
  - It looked like a second `schedulesAgent` call.
  - Both approvals showed as "pending".
  - The user's message seemed to be sent twice.

Each part below explains one cause and its fix.

## Parts and order

| Part | Repo | What | Must merge after |
|---|---|---|---|
| 1 | smoltalk | Tool messages survive a save and rebuild unchanged | — |
| 2 | agency | Resume events are logged inside the run's span | — |
| 3 | agency | Span ids survive a resume | 2 (same two functions) |
| 3b | agency | The CLI resume keeps the paused run's trace id | — |
| 4 | agency | The statelog records decision-model calls explicitly | — |
| 5 | agency | Viewer: errors on every screen | — |
| 6 | agency | Viewer: threads on every screen | 5 (same files) |
| 7 | agency | Viewer: resumed runs read as one story | 6 (same files) |
| 8 | agency | Viewer: decision-model calls | 4 |
| — | bmo | Handoff prompt no longer repeats the user's message | done: bmo #184 |

**Some of these PRs are a stack in practice.** Every PR is branched from
`main`, but the viewer parts 5, 6 and 7 all edit `transcript.ts`,
`transcriptPayload.ts`, `transcriptScreen.ts` and `overviewData.ts`, and
Parts 2 and 3 both edit `runResumeInvocation` and `resumeCliFromCheckpoint`.
So they are opened one at a time: Part 5 merges before Part 6 is branched,
Part 6 before Part 7, and Part 2 before Part 3. Each of those PRs says in its
first line which merged PR it builds on.

Parts 1, 2, 3b and 4 are independent of everything else and can go in any
order. Part 1 gates nothing, because Part 7 makes the viewer correct for
existing logs without it. Parts 5 and 6 start from the prototype, which is
uncommitted in the main checkout today (see "Starting from the prototype").

Part 7 reads correctly for new logs only once Parts 2 and 3 are in a release
that BMO uses, because BMO pins `agency-lang` from npm.

---

## Part 1 (smoltalk): tool messages survive a save and rebuild

### The issue

`ToolMessage.fromJSON` (`smoltalk/lib/classes/message/ToolMessage.ts:79-109`)
does not rebuild the message that `toJSON` saved:

- **Before:** a tool's result is kept as the raw value, e.g. an array of records.
- **After `fromJSON`:**
  - content that is neither a string nor an array of text parts is replaced with `JSON.stringify(content)`;
  - the schema already accepts any content (`content: z.any()`), so nothing requires the conversion.

**What the model sees is unaffected.** Every provider conversion reads the
`content` getter, which calls `contentToString` (`BaseMessage.ts:9`). That
turns the raw value into the same compact JSON text, before and after.

**The consequences are in everything that reads a thread's saved JSON:**

- **Which threads are affected:** every resumed run (`restoreThreadForResume`) and
  every subthread (`MessageThread.cloneMessages`, which copies through JSON)
  holds strings where an untouched thread holds arrays or objects.
- **Checkpoints and the statelog** record the content differently depending on
  whether the thread was ever rebuilt.
- **The log viewer compares the logged messages**, saw an array turn into a string, and
  decided the history had been rewritten. This is why the user's message
  appeared to be sent again before call 8 (Part 7 fixes the viewer side).
- **The structured value is lost.** Code that reads a tool result back out of a rebuilt
  thread gets text where it would otherwise get the value.

### The fix

Keep the content exactly as saved. Text-part arrays and strings already round-trip; everything else should too.

**Why the conversion is there.** smoltalk commit `c48f205` ("ToolMessage
content sometimes isn't a string, and thats okay") loosened the schema from
`string | TextPart[]` to `z.any()` and added the conversion in the same change.
It was a defensive normalization written at the moment strings stopped being
required, not something a provider asked for. Every provider conversion already
goes through the `content` getter (`ToolMessage.ts:45`), and `toJSON` saves the
raw `_content`, so removing the conversion changes nothing a provider sees.

### Tasks

1. **Change `ToolMessage.fromJSON`** to pass non-string, non-text-part content
   through unchanged. Remove the debug log line. The field `_content` is typed
   `string | Array<TextPart>` (`ToolMessage.ts:29`); widen it, and the
   constructor parameter, to `unknown`.
2. **Test the round trip in `message.test.ts`.** `fromJSON(toJSON(m))` should equal
   `m` for content that is:
   - a string;
   - a text-part array, where one part carries an extra field such as a cache
     marker (see below);
   - an array of records;
   - an object;
   - a number;
   - a boolean;
   - `null`.

   Also assert that the `content` getter returns the same text for the original and the rebuilt message.

   **The text-part case has a trap.** `fromJSON` runs text-part arrays through
   `z.array(TextPartSchema).safeParse`, and a Zod object strips unknown keys by
   default. A part with an extra field comes back without it, which a test
   using a bare `{ type: "text", text }` would never notice. Decide whether
   stripping is intended. If it is not, parse with `.passthrough()` or skip
   the re-parse; if it is, say so in a comment and test the stripped shape.
3. **Check the other message classes.** `UserMessage`, `AssistantMessage`,
   `SystemMessage` and `DeveloperMessage` need the same round-trip test. Fix any that fail the same way.
4. **Release a smoltalk patch version** and bump `smoltalk` in `package.json`.
   Run the Agency tests that cover threads and resume:
   - `lib/runtime/state/messageThread.test.ts`;
   - `lib/runtime/threadRepair.test.ts`;
   - `tests/agency-js/prompt-start-resume`.

**Not doing:** storing tool results as strings in Agency. It would hide the
symptom for tool messages but leave the rebuild bug in place.

---

## Part 2 (agency): resume events are logged inside the run's span

### The issue

A resume logs two events before it opens the run's `agentRun` span:

- `checkpointRestored`, from `restoreForResume` (`lib/runtime/resumeSetup.ts:155-159`);
- the user's approval, `interruptResolved` with `resolvedBy: "user"` (`lib/runtime/interrupts.ts:884-896`).

Where the span is opened afterwards:

- `runResumeInvocation` calls `restoreForResume` at `interrupts.ts:928` and opens `agentRun` at `:937`.
- `resumeCliFromCheckpoint` does the same at `:799` and `:803`.

The execution context is new, so its span stack is empty and both events are written with `span_id: null`. The viewer attaches span-less events to the trace root, so the approval sits apart from the interrupt it answers.

### The fix

Open `agentRun` and emit `agentStart` (with `entryNode` from `args.checkpoint.nodeId`) before calling `restoreForResume` in both functions. The `finally` already closes the span when `agentRunSpanId` is set, so a restore that fails still closes it.

This is safe because `rootLog` is the statelog client itself (`lib/runtime/state/context.ts:177`), which logs on the root span stack, and `restoreState` (`context.ts:842`) replaces the state stack and globals but never touches span stacks.

**The order of the two events matters to the viewer.** `tree.ts` labels a span from the first event it sees in it and upgrades a weak label when a strong event such as `agentStart` arrives later. With `agentStart` first, the `agentRun` label is right from the start. The test below pins that order so a later reorder cannot quietly depend on the upgrade path.

Part 3 edits the same two functions, so it merges after this part.

### Tasks

1. **Reorder both functions.** Keep the existing failure handling.
2. **Check what reads `agentStart`.** Look for anything that assumes it comes after `checkpointRestored`, e.g. `lib/eval/extract.ts` and `lib/logsViewer`.
3. **Add a test in `tests/agency-js/prompt-start-resume/test.js`**, or a sibling test, that asserts:
   - `agentStart` is the first event in the resumed run's `agentRun` span;
   - `checkpointRestored` and the user `interruptResolved` both carry that span id;
   - no event in the log has `span_id: null`.

---

## Part 3 (agency): span ids survive a resume

### The issue

Span ids are random (`nanoid(12)` in `startSpan`, `lib/statelogClient.ts:298-310`) and are not saved in checkpoints. A resume builds a new execution context, so every span is opened again with a new id. A span only appears in the log if an event is written while it is open. On resume, many spans are reopened but their logging steps are skipped, because those steps already ran:

- **The outer LLM call's `llmCall` span** (`lib/runtime/prompt.ts:830`) gets a new id. In the BMO run that id was `JO9BDNSwEUsQ`. Its only events, `promptStart` and `promptCompletion`, come from completed steps, so the span never appears in the log.
- **The `schedulesAgent` tool span** (`prompt.ts:1616`) gets a new id (`VrZGmv_LAj-F`) under that missing parent:
  - its `toolCallStart` step already ran, so only `toolCall` is logged under the new id;
  - the start and the finish of one tool call end up in different spans.
- **The viewer** attaches any span whose parent is not in the log to the trace root (`lib/logsViewer/tree.ts:239-240`). The resumed work looked like a second `schedulesAgent` call, listed after everything else in the run.
- **The eval extractor** pairs `toolCallStart` and `toolCall` by span id (`lib/eval/extract.ts:265-277`), so it reports every tool that paused and resumed as incomplete.

Of the 22 `startSpan` sites, 8 can still be open when a checkpoint is taken. Four of them get a saved id; four keep a fresh id on purpose:

| Site | Span | What happens on resume | The slot the saved id lives in |
|---|---|---|---|
| `lib/runtime/prompt.ts:830` | `llmCall` | reuses its id | the `runPrompt` frame's locals, key `__span_llmCall`; dies when the frame is popped, like `messagesJSON` |
| `lib/runtime/prompt.ts:1616` | `toolExecution` | reuses its id | the same frame's locals, key `__span_tool_<callSlug>`; the slug includes the round, so no cross-round reuse, like `toolTimings` |
| `lib/runtime/runner.ts:1244` | `forkAll` / `race` | reuses its id | the loop frame's locals, key `__span_fork_<step path>`; cleared by the existing loop cleanup once its prefix is added at `runner.ts:1080-1085` |
| `lib/runtime/ipc.ts:1337` | `subprocessRun` | reuses its id | a `__span_subprocess` field in the subprocess resume payload (`ipc.ts:281-300`); dies with the payload |
| `lib/runtime/node.ts:453` | `agentRun` (fresh run) | fresh id | — |
| `lib/runtime/interrupts.ts:803` | `agentRun` (CLI resume) | fresh id | — |
| `lib/runtime/interrupts.ts:937` | `agentRun` (resume) | fresh id | — |
| `lib/simplemachine/graph.ts:126` | `nodeExecution` | fresh id | — |

The other 14 sites always close before a checkpoint can be taken: handler chains, thread-end hooks, the abort unwind, intrinsic tools, decision batches and memory operations. They keep random ids.

### Why `agentRun` and `nodeExecution` keep fresh ids

Each resume is a separate invocation: a new process, or a new HTTP request.
The BMO run really was three invocations, and the log records three
`agentRun` spans, each with its own `agentStart`. Folding them into one span
would:

- make the span's duration cover the pauses, so every per-run timing (the
  timeline bar, the overview's request duration, the runs explorer) becomes
  wrong;
- remove the structure Part 7 uses to draw its `paused 14.2s · resumed` rows;
- force the `agentRun` span to be opened after `restoreForResume` (to read the
  saved id from the restored stack) when Part 2 needs it opened before;
- change what the hosted serving side counts as one run.

It is also not needed for the bug. The viewer keeps the first parent it sees
for each span id (`tree.ts:86-111`). Once `llmCall` and `toolExecution` reuse
their ids, the resumed `toolCall` event lands under the original tool span,
which sits under the original `llmCall`, which sits under run 1's
`nodeExecution`. Run 2's own `agentRun` span then holds only what run 2 did at
the top level: `agentStart`, `checkpointRestored`, the approval, `agentEnd`.
That is the true picture: one logical call tree, three invocations.

### Why not derive ids from the program position

Computing each id from "where we are in the program" would avoid saving
anything, but the runtime has no stable position to compute it from:

- Frames have no id, and two calls to the same function, or one call per loop iteration, look the same.
- Loop iteration counters are cleared between iterations of enclosing loops.

Building a reliable position would mean saving a new chain of state, which is this design in a more fragile form.

### What `restore()` and rewind do with a saved id

A saved id is state, so `restore()` and `rewindFrom` bring it back along with
everything else. The `llmCall` id is written to `self` before the first step
of `runPrompt`, so every checkpoint inside the prompt loop carries it. Without
a rule, a `restore()` back to a checkpoint inside a tool would reopen the same
`llmCall` and `toolExecution` spans, re-run the tool, and log a second
`toolCallStart` under the same span id.

**The rule: a retry is a new attempt, so it gets new spans.** Before
replaying, `applyRestoreSignal` and `rewindFrom` call `forgetSavedSpans`,
which clears every frame local whose key starts with `__span_`. Restore does
not know which sites save ids or where; it knows one prefix, the same way the
loop cleanup clears `__substep_` and `__iteration_` locals by prefix today.
The viewer already shows retries as separate rows, the eval extractor keeps
pairing one start with one end per span, and the invariants below stay simple.
A resume after an interrupt is the same attempt continuing, so it keeps the
ids; a retry is not.

### The fix: one helper reopens a span from a slot, and the slot's lifetime does the rest

The first draft of this plan had a `withSpan` helper that opened, saved,
closed and cleared the id for every site, and detected a pause so it would
know when to keep the id. That last part is where it broke: each site
detects a pause differently (`shouldPop` in `runPrompt`, `b.interrupts` and
`invokeOutcome` at the tool site, the batch result in a fork, the payload in
a subprocess), so the helper would have needed a predicate per site.

The helper never needed to know about pauses. Every slot in the table already
has the lifetime the id needs:

- a frame local dies when the frame is popped, which `runPrompt` does on
  completion and on a throw (`prompt.ts:2001`) and skips on a pause, so the
  id is kept across a pause for free, exactly as `messagesJSON` and
  `toolTimings` are kept today;
- a fork's local is cleared by the loop cleanup that already clears its
  siblings;
- the subprocess payload is cleared by `clearSubprocessPayload`.

So "keep the id across a pause, drop it on completion" is a property of where
the id is stored, not code at each site. What is left is one declarative
interface:

```ts
// Reopen the span saved in `slot`, or open a new one and save it there.
// `self` is the runPrompt frame's locals (`prompt.ts:567`).
const llmSpanId = reopenSpan(run.log, "llmCall", { locals: self, key: "__span_llmCall" });
...
run.log.endSpan(llmSpanId);
```

`reopenSpan` lives next to `startSpan` in `lib/statelogClient.ts`. It reads
the slot, checks the id, calls `startSpan(type, { id })`, and writes the id
back. A site says *what* it wants (this span, from this slot) and never
writes the save, the check, or the clear. Closing stays the `endSpan` call
each site already has. The subprocess site passes the payload as its slot
object, since the payload is a plain record too.

Three details:

- **`startSpan` gains an optional `id`.** Only `reopenSpan` passes it.
- **A reused id is checked before use.** The checkpoint is the program, and
  the id goes straight into every event's `span_id`. `reopenSpan` accepts a
  saved id only if it is 12 characters of the nanoid alphabet, and opens a
  fresh span otherwise. That stops a tampered checkpoint from logging under
  another trace's span or writing arbitrary text into the log. The HMAC
  check covers this only when it is turned on.
- **Reused ids attach to the original tree.** The viewer keeps the parent it sees first for each span id (`tree.ts:86-111`), so resumed events land under the original span with no viewer change.

### Tasks

1. **Add `startSpan(type, { id })` and `reopenSpan(log, type, slot)`** in `lib/statelogClient.ts`, and `forgetSavedSpans()` on `StateStack` beside `clearLocalsWithPrefix` (`lib/runtime/state/stateStack.ts:120`), all sharing one `SPAN_SLOT_PREFIX = "__span_"` constant. Unit-test that a valid saved id is reused, an invalid one is replaced, a missing one is generated and written back, and `forgetSavedSpans` clears only `__span_` keys.
2. **Convert the `llmCall` and `toolExecution` sites in `prompt.ts`** to `reopenSpan`. These two cause the BMO bug. Test that the saved id survives a pause and is gone after completion and after a thrown error, with no clearing code added at either site.
3. **Call `forgetSavedSpans` from `applyRestoreSignal` and `rewindFrom`.** Test that a retried tool logs under a new span.
4. **Write the invariant check:** a function `assertSpanInvariants(events)` in the test utilities. For a whole log it asserts:
   - every `parent_span_id` appears as some event's `span_id`;
   - each tool call's `toolCallStart` and `toolCall` share a span id;
   - no two `toolCallStart` events share a span id.
5. **Run the check over pause-and-resume programs.** Use the harness in `tests/agency-js/prompt-start-resume/test.js` and cover:
   - an interrupt inside a tool;
   - an interrupt inside a handoff sub-agent, which is the BMO shape;
   - two interrupts in one run, resumed one after the other;
   - an interrupt inside a loop body, resumed on a later iteration;
   - a `restore()` retry, which must produce two tool spans.
6. **Add a regression test** to `lib/eval/extract.test.ts`: a tool that pauses and resumes is reported as complete.
7. **Update `docs/dev/hosting/statelog.md`** with a section on span ids across a resume: which spans reuse ids, why `agentRun` and `nodeExecution` do not, and the retry rule.

If this PR is still large, stop here and open the fork and subprocess sites as
a second PR with the same shape:

8. **Convert the fork/race site in `runner.ts`** to `reopenSpan`, and add `SPAN_SLOT_PREFIX` to the loop cleanup's prefix list at `runner.ts:1080-1085`. Add an interrupt inside `fork` to the invariant run.
9. **Convert `subprocessRun`** to `reopenSpan` with the resume payload as its slot, so the child adopts the same id on every resume. Add an interrupt inside a subprocess to the invariant run.

---

## Part 3b (agency): the CLI resume keeps the paused run's trace id

### The issue

`resumeCliFromCheckpoint` resolves its invocation as `"fresh"` (`interrupts.ts:789-793`), so a CLI resume gets a new trace id unless `AGENCY_TRACE_ID` is set. `respondToInterrupts` keeps the paused run's id. This decides which trace a resume lands in, not which span, so it is its own small change.

### Tasks

1. Decide whether a CLI resume should keep the paused run's trace id, as `respondToInterrupts` does.
2. If yes, fix it and add a test to the resume command's tests. If not, document why in `docs/dev/runtime/resume-command.md`.

---

## Part 4 (agency): the statelog records decision-model calls

### The issue

A decision model such as Laya is not a chat model:

- **What Agency logs:** `promptCompletion` records the thread's chat messages. For the expression check that is the user's message and "Which facial expression should BMO show?".
- **What Laya actually receives:** `dispatchDecision` (`lib/runtime/decision/dispatch.ts`) sends a state and a set of questions:
  - **state:** the thread's messages before the prompt, without tool messages (`messagesToState`);
  - **questions:** built from the response type, with the prompt as the instruction (`planDecision`).

Nothing in the log says the call went to a decision model. The viewer
could only guess from `completion.rawData.answers`. The runtime already knows:
`_runPrompt` has `usageKind` in hand when it logs `promptCompletion`
(`prompt.ts:443-455`), and it is `"decision"` for these calls
(`ProviderUsageKind`, `lib/runtime/invocationUsage.ts:24`). It is just not
written to the event.

### The fix

Record it explicitly, using the vocabulary the runtime already has rather
than a new one:

- **On `promptStart` and `promptCompletion`:** `usageKind`, from
  `ProviderUsageKind`. `promptStart` is logged before dispatch, but whether
  the call goes to a decision model is already known there from
  `ctx.llmClient.decide` (`dispatch.ts:99`). The viewer treats `"decision"`
  specially and shows every other kind as a text call. One field, one set of
  names, and it stays right if another kind is added.
- **On `promptCompletion`:** a `decision` field:

  ```json
  "decision": {
    "state": [{ "role": "user", "content": "..." }],
    "questions": { "response": { "type": "choice", "choices": ["idle", "..."], "instructions": "Which facial expression should BMO show?" } },
    "answers": { "response": { "choice": "curious", "confidence": 0.73, "probabilities": { "curious": 0.86, "...": 0 } } }
  }
  ```

The `questions` shape should be whatever `planDecision` produces, not a new one. In `wireTypes.ts`, `decision` is a named type (`DecisionLog`) built from three named types for the state, the questions and the answers, reusing the ones `lib/runtime/decision/questions.ts` exports rather than nesting object literals inside the event type.

### Tasks

1. **Return the request with the result.** Have `dispatchDecision` return the state and questions it sent along with the result. The batched path (`collector.submit`) must return the same.
2. **Log the fields** in `_runPrompt` (`prompt.ts`, where `promptStart` and `promptCompletion` are logged). Add the types in `lib/statelog/wireTypes.ts` and an accessor `decisionOf(event)` in `lib/statelog/wireAccessors.ts`.
3. **Redact the state.** This is a change, not a check. `messagesToState` builds the state from the thread's messages directly, not from the output of `redactMessagesForLog`, so the logged `decision.state` would carry text that `promptCompletion.messages` has redacted. Run the state through the same redaction before logging it, and test that a message redacted in `messages` is redacted in `decision.state` too.
4. **Add tests:**
   - a decision call logs `usageKind: "decision"` on both events and the three `decision` fields;
   - a text call logs `usageKind: "completion"` and no `decision`.

   `lib/runtime/decision/dispatch.test.ts` has the fixtures.
5. **Document the fields** in `docs/dev/hosting/statelog.md` and `docs/dev/llm/decision-models.md`.

---

## Starting from the prototype

The prototype for Parts 5 and 6 is uncommitted in the main checkout:

- 10 modified files under `lib/logsViewer/` (406 lines added, 47 removed);
- a new `lib/logsViewer/problems.ts`, which already holds `traceErrors`,
  `runStatus` and `runMarkers`. Part 5's first task reviews and tests that
  file; it does not write it from scratch.

Before Part 5:

1. Create branch `viewer-errors` from `main` and move the prototype changes onto it.
   - Do not take the unrelated `CHANGELOG.md` and `package.json` changes in the main checkout.
2. Split the work: Part 5 takes the error changes, and Part 6 (branch `viewer-threads`) takes the thread changes. The table below says which file belongs where.

| Prototype change | Part |
|---|---|
| `problems.ts`: `traceErrors`, `runStatus`, `runMarkers` | 5 (`runMarkers` is used by 7) |
| `overviewData.ts`: status, errors, failed calls, `toolsByRound` | 5 |
| `overviewData.ts`: thread colors and legend | 6 |
| `overviewScreen.ts`: header, tool results in the preview | 5 |
| `overviewScreen.ts`: thread line in the preview metadata | 6 |
| `overviewCharts.ts`: ✖ marks and "✖ failed" legend | 5 |
| `overviewCharts.ts`: tick colors and "threads" legend | 6 |
| `payload.ts`: `toolResultPayload`, `accent` tone | 5 (`accent` is used by 6) |
| `transcript.ts`, `transcriptPayload.ts`, `transcriptScreen.ts`: error blocks, failed-tool marks, inline error messages | 5 |
| the same files: thread blocks, dividers, indentation | 6 |
| the same files: pause and resume markers | 7 |
| `timelineScreen.ts`: ✖ and ⏸ marks | 5 |
| `timeline/rounds.ts`: thread named after the tool that started it | 6 |

The viewer has thorough tests (`*.test.ts` next to each file, snapshot tests
in `screens/__snapshots__`). Every behavior below gets a test. Build the
fixtures with `timeline/fixture.ts` and `storyFixture.ts`, not from the BMO
log, which holds private chat content.

---

## Part 5 (agency viewer): errors on every screen

### The issue

Errors are recorded as `error` events. The Trace screen builds its outline
from the full event tree, so it shows them. The other screens are built from
narrower lists:

- **Overview** is built from LLM calls.
  - Its header took "running" from `hasRunningWork`, which treats a tool that paused for approval as still running. So a finished run read "● running".
  - Its output preview showed what the model asked for, not what came back.
  - Its charts had no notion of failure.
- **Transcript** is built from LLM calls and their tool calls.
  - An error outside a tool call, like the Resume desync, had nowhere to go.
  - A failed tool looked like any other in the sidebar, and its message was only visible after expanding it.
- **Timeline** draws spans, and an error is an event inside a span, not a span.

### The fix

**Overview:**

- **Header:** shows how the run ended, with an error count.
  - The outcome is one of: `done`, `✖ crashed`, `⏸ paused for a response`, `● running`.
  - A paused run logs no `agentEnd` (`node.ts:504-513`, "no footer"), so a run whose latest `agentStart` has no `agentEnd` is paused or running. A crashed run logs `error` and then an `agentEnd` with no `result` (`node.ts:567-578`), so that is `crashed`. An `agentEnd` with a result is `done`.
  - The count reads like `✖ 5 errors`.
- **Error count:** one error logged several times as it travels up the call stack counts once. Two errors with the same message from different tool calls, such as two tools in a parallel block failing the same validation, count twice.
- **Charts:** every LLM call with a problem gets a red ✖ under its bars:
  - a failed tool call is marked on the call that requested it;
  - an error outside any tool call is marked on the last earlier call in the same thread. After Part 3 the Resume desync from the BMO run sits inside the resumed tool span, so this rule is for errors between calls: a hook, a validator, a guard. When the thread has no earlier call, the error is marked on the first call of the trace, so it is never dropped;
  - a request that failed before the provider answered is marked too (see below).
- **Failed provider requests:** they log `promptStart` and then an `error` with `errorType: "llmError"`, and no `promptCompletion`, so they have no chart column today. Add a column for each, with no bars, the ✖ mark, and the error in the preview.
- **Output preview:** each tool call is followed by its result:
  - `✖ RESULT · tool failed`, with the message;
  - `⚠ RESULT · waiting for a response`;
  - `→ RESULT`, with the output shortened to a named limit (`RESULT_PREVIEW_CHARS`, about 600).

**One notion of "running" per question.** `hasRunningWork` (`timeline/spans.ts:122`) answers "does this span have work that has not ended", which is right for a span row and stays as it is. `runStatus` answers "how did the whole run end". The two must not be mixed: the Overview header and any Trace row that describes the run as a whole read `runStatus`; rows that describe one span read `hasRunningWork`. Task 1 says which Trace rows switch.

**Transcript:**

- **Sidebar:** failed tools show `✖` in red, and tools waiting for approval show `⚠`.
- **Tool blocks:** a failed tool's error message is always shown.
- **Errors outside a tool call** get their own `✖ ERROR` block, placed by time in the thread where they happened. A burst of the same error shows once, with "logged N times as it was rethrown".

**Timeline:**

- A span holding an error gets `✖` and a red bar.
- A tool waiting for approval gets `⏸`.

### Tasks

1. **Review and test `problems.ts`** from the prototype.
   - `traceErrors(trace)`: groups the same message logged within 1 second into one error with a count. The prototype matches on message and time only; add the tool call to the match, so a burst merges only within one tool call (or within "no tool call"). Each error records the tool call it belongs to.
   - `runStatus(trace)`: look at the events after the latest `agentStart`. `done` when there is an `agentEnd` with a result; `crashed` when there is an `agentEnd` without one; `paused` when there is an `interruptResolved` with outcome `propagated` and no end; `running` otherwise.

   Test the grouping (including two tools failing with the same message at the same time), the four statuses, and a run that paused and then finished.

   Then find every place that reads `hasRunningWork` to describe the run rather than a span (`traceScreen.ts:765` is the one to check) and switch it to `runStatus`, so the viewer has one answer per question.
2. **Add Overview data** to `overviewData.ts`:
   - status;
   - errors;
   - the failed calls, attached as described above;
   - tool rows per call.

   Test that every error is attached to some call, that an error outside any tool call goes to the earlier call in its own thread, and that an error on a thread with no earlier call still lands somewhere.
3. **Build `failedRequestsOf(trace)`** for requests that failed before a completion, and add their columns to `overviewCharts.ts`. They count in the header and are selectable like any call.
4. **Fix the two-digit tick problem.** Today a ✖ is cut off when a call number has two digits and the columns are narrow. Draw the ✖ on its own row under the call numbers, so it never competes for width.
5. **Paint the header** from pieces so the error count is red and the status has its own color. Update the snapshot tests.
6. **Show tool results in the output preview.** `roundResponsePayload(round, tools)` matches each requested call to its tool row by name, in order. Test that a failed, a waiting and a completed tool each show their result.
7. **Transcript:**
   - **New block kind `error`.** Place blocks by the time of the event they come from, not by the call's end time. Each block needs a time:
     - a tool block uses its tool's first event;
     - a user, system or history block uses its call's start;
     - an assistant block uses its call's end.
   - **Failed-tool sidebar marks**, and the error message always visible in tool blocks.
   - **Search** finds error blocks (`transcriptText`).
8. **Timeline:** mark spans that directly contain an error, and tool spans waiting for approval. Use the story outline's tool status, not a second classification.
9. **Avoid repeated work.** `storyOutline` and `traceErrors` are each computed by several screens. Compute them once in the screen host when the trace is selected and pass them to the screens along with the tree index, which is how `buildTreeIndex` results already travel. No cache: a cache keyed by the trace node would be a `Map` or `WeakMap`, which the repo avoids, and it would need invalidating in follow mode.
10. **Update `docs/dev/cli/logs-viewer.md`** for the Overview header, charts and preview, the Transcript error blocks, and the Timeline marks.

---

## Part 6 (agency viewer): threads on every screen

### The issue

- **Transcript:** every block knows its thread, but nothing showed it, so the sub-agent's calls sat in one flat list with the main conversation's.
- **Overview:** showed a thread only when it had a label, and nothing in the charts.
- **Trace:** turns a nested `llmCall` span into a `Thread · <name>` row (`storyCandidates` in `story.ts`), but only inside a tool call. A top-level `llmCall` becomes a machinery row and is hidden.
  - `docs/dev/cli/logs-viewer.md` describes this ("Nested `llmCall` spans become `llmGroup` rows") without a reason.
  - In BMO, the expression checks run on their own top-level threads, so they looked like part of the main conversation.
- **Every screen:** a thread with no label is called "unnamed", even when the tool that started it is right above it.

### The fix

- **Thread names:** a thread with no label of its own is named after the tool that started it (`timeline/rounds.ts`). A top-level thread has no starting tool, so it falls back to the call's `label` (already logged on `promptStart`), then to the node name, and only then to `unnamed`. Every screen reads `round.threadLabel`, so they all change together.
- **Transcript:**
  - a `══ THREAD · <name> ══` divider wherever the conversation moves to another thread;
  - blocks indented in the sidebar by how many tool calls deep their thread was started.
- **Overview:**
  - call numbers are colored by thread, with a `threads` legend;
  - threads that share a label, such as every unnamed one, share a color;
  - the preview always shows the thread.
- **Trace:** every `llmCall` span gets a `Thread · <name>` row, top-level ones included.

Trace after this part and Part 7, for the BMO run:

```
Thread · expressionCheck
  user Are you able to set up a recurring job…
  LLM call 1 {"response":"curious"}
Thread · mainConversation
  user Are you able to set up a recurring job…
  LLM call 2 tool: updateStatus, schedulesAgent
    updateStatus Setting up your schedule
    schedulesAgent Set up a schedule to check…
      Thread · schedulesAgent
        …
Thread · expressionCheck
  user I hit a snag trying to set up…
  LLM call 11 {"response":"focused"}
```

The two expression-check threads are named from the call's label here. If
BMO's expression check has no label, they read as the node name instead.

### Tasks

1. **Name threads after their starting tool:** the fallback chain in `timeline/rounds.ts` (`startingToolName`, then the call label, then the node name). Test a labeled thread, an unlabeled thread under a tool, an unlabeled top-level thread with a call label, and one with neither.
2. **Transcript thread blocks and indentation:**
   - Add `threadLabel` and `depth` to every block.
   - Add a `thread` block kind and the dividers (`withThreadDividers`).
   - Test that dividers appear only where the thread changes.
3. **Overview thread colors, legend and preview line.** Test that two unnamed threads share one legend entry.
4. **Trace top-level thread rows.**
   - In `storyCandidates`, make every `llmCall` span an `llmGroup` row. `toolName` becomes optional for a top-level group, and Details says the thread was not started by a tool.
   - Keep the folding rules: a completed group starts folded. Check that this doesn't hide a top-level conversation the reader expects to see open. If it does, leave top-level groups unfolded.
   - Update the story tests and snapshots.
5. **Optional, and after Part 7: show copied history once.** A subthread starts with a copy of its parent's history, so its first call shows the user's message and earlier tool calls again as new. If the first messages of a thread equal the messages of the thread that was current when it was created, show one collapsed `copied N messages from <parent>` block. This overlaps Part 7 task 4, which also changes what a call shows as new, so build it only after `firstChangedAt` lands, as one rule for "what is new in this call", and only if it reads clearly in the BMO run.
6. **Update `docs/dev/cli/logs-viewer.md`:**
   - thread names;
   - Transcript dividers;
   - Overview colors;
   - Trace thread rows, replacing the "Nested `llmCall` spans" sentence.

---

## Part 7 (agency viewer): resumed runs read as one story

### The issue

Four things made the resumed BMO run hard to read:

1. **Resumed work looked like a new call.** Fixed for new logs by Parts 2 and 3. Older logs still have orphaned spans.
2. **Approvals showed as "pending".**
   - The story outline merges an interrupt's thrown and resolved events by `interruptId`, but only within one owner (`storyCandidates`, key `[owner, interruptKey]`). The owner is the nearest tool span or parent span.
   - The approval logged at resume had no span, so its owner was the trace root. It never merged, and it became a separate row. The grouping at `story.ts:340-356` only folds the later rows of a group into `hidden`, and a span-less approval is a group of one, so that path does not hide it; it is more likely dropped by the default filter on successful approvals. Either way the "2 hidden" in the outline header are probably these two rows. The test in task 1 asserts the row count, not only the label, so the answer is pinned down.
   - Part 2 gives the approval a span, but that span is `agentRun`, still not the tool. So the viewer must match across owners.
3. **Pauses were invisible.** Nothing showed that the run stopped and waited 14 seconds, then 7.
4. **History looked rewritten.**
   - `messageDelta.ts` compares each call's messages with the previous call on the same thread by `messageKey`. `messageKey` is a JSON string of the raw content.
   - If the earlier messages are an exact prefix, only the extra messages are new. Any other difference marks every message as new and labels the call "HISTORY REWRITTEN".
   - The content of two old tool results changed from an array to a string across the resume (Part 1). The model saw the same text, but the keys differed, so the whole history, including the user's message, was shown again.
   - Real rewrites exist but are rare. The cases in the runtime are:
     - context compaction, which replaces older messages with a summary and is labeled "CONTEXT COMPACTED";
     - a handoff that answers everything, which removes its tool call from the parent's last assistant message (`lib/runtime/handoff.ts:100-118`);
     - remembered facts, which are added as a system message for one call and removed after it (`prompt.ts:945-960`).

### The fix

1. **Approvals:** merge interrupt events by `interruptId` across the whole trace when the id is present. Place the merged row where the interrupt was thrown, with the latest outcome and who resolved it ("approved by user").
2. **Pauses:** show a `── paused 14.2s · resumed ──` row under the interrupt that paused the run, in the Trace outline and as `⏸ PAUSED` / `▶ RESUMED` blocks in the Transcript.
3. **Messages:** compare as the text the model sees. In `messageKey`, a non-string content becomes `JSON.stringify(content)`, the same rule as smoltalk's `contentToString`. An array and its JSON string then have the same key. This restates smoltalk's rule rather than importing it, because `contentToString` is a protected method on `BaseMessage`; the comment on `messageKey` names that method so the two are kept in step.
4. **Real rewrites:** show only what changed. Find the first message that differs. Show the messages before it as unchanged history (hidden, as today), then a `HISTORY CHANGED at message 8 of 14` block, then the replacement messages.
5. **Older logs:** no guessing. A span whose parent is missing from the log stays at the top level, with the label `parent span not in this log`, and top-level rows are ordered by their first event's time. The label states the fact and not the cause, because a missing parent has several causes: a resume logged before Part 3, a log truncated mid-write, follow mode reading a file that is still being written, or a subprocess child whose parent span is in another file. The Details pane can list those. Matching orphans to their original tool call by name would be wrong whenever a tool is called twice, and these logs carry no tool-call id.

### Tasks

1. **Interrupt merging.**
   - The owner has been part of the key since the trace screen was built (#1107). The reason is the rule in `docs/dev/cli/logs-viewer.md`: "events from a nested tool do not change its parent tool's status". Keep that: when nested tools log the same `interruptId` at more than one level, the innermost tool stays the row's owner and the rest merge into it.
   - Change the grouping and show `resolvedBy`.
   - Test: an interrupt thrown in a tool and approved by a span-less event shows one row, "approved by user", and the outline's hidden count drops by the rows that merged. Also test that an interrupt that propagates through two nested tools still shows one row owned by the inner tool.
   - Also cover the handler-chain resolutions logged at `interrupts.ts:525-603`, which carry a `resolvedBy` other than `user`. They are logged under the tool's span today, so they should merge the same way; the test asserts it.
2. **Pause rows.** `runMarkers` from Part 5's `problems.ts`.
   - In the Trace outline, put the row under the interrupt whose `interruptResolved` has outcome `propagated`, with the time until the matching resume.
   - In the Transcript, add the marker blocks.
   - Test both.
3. **`messageKey` compares text.** Test that an array and its JSON string count as equal, and that two different strings still don't.
4. **Show only the changed part of a rewrite.**
   - Have `deltaFrom` return `firstChangedAt` along with the rewrite.
   - Have `transcript.ts` show only the messages from that point.
   - Keep the "CONTEXT COMPACTED" label for compaction.
   - Test a compaction, a removed handoff call, and a change in the middle of the history.
5. **Orphaned spans in older logs.**
   - Mark them in `tree.ts`.
   - Order top-level rows by time in `storyOutline`.
   - Test that a span with a missing parent is labeled and placed by time.
6. **End-to-end check.** After Parts 2 and 3 are in a released `agency-lang` that BMO has upgraded to, record a fresh BMO run that pauses inside a sub-agent and resumes. Check in the viewer that:
   - the resumed work nests under the original tool call;
   - both approvals show as approved;
   - no history is repeated.
7. **Update `docs/dev/cli/logs-viewer.md`:**
   - interrupt merging;
   - pause rows;
   - the message comparison rule;
   - "HISTORY CHANGED";
   - orphaned spans.

---

## Part 8 (agency viewer): decision-model calls

### The issue

The viewer drew the expression check as a chat call with two user messages,
which is not what Laya received, and gave no sign it was a decision model.

### The fix

Use the `usageKind` and `decision` fields from Part 4. A call is a decision
call when its `promptCompletion` has `usageKind: "decision"`. Logs without
the fields are shown as ordinary calls; the viewer does not guess.

- **Outline rows** in Trace, Transcript and Timeline read `LLM call 1 · decision · curious 86%`. The percentage is the chosen answer's probability.
- **Overview input preview:** shows `STATE` (the state messages) and `QUESTIONS` (each question's type, choices and instructions).
- **Overview output preview:** shows each answer with its confidence, and the highest probabilities as bars, up to a named count (`PROBABILITY_BARS`, five).
- **Transcript:** shows a decision call as one block with the state, the question and the answer, instead of user messages and a JSON reply.

### Tasks

1. **Add a `decisionOf` accessor to the round**, e.g. `round.decision`, read from the completion event.
2. **Build the row labels and previews** described above. Test them with a fixture that has a choice question and one with two questions.
3. **Update `docs/dev/cli/logs-viewer.md`.**

---

## Done separately

- **bmo #184:** the handoff prompt no longer repeats the user's message. Every handoff runs on a subthread, which already holds the message, so the prompt is now "BMO asked you to handle this part of the user's latest message: <task>".

## Out of scope

- **Rewording BMO's expression prompt.** Laya was fine-tuned on this exact instruction with a one-message state, so changing the wording needs retraining. The fine-tune notes already list BMO's replies as an untrained kind of input; add reply examples to the training data first.
- **`scheduleTask` input in BMO:** accepting `"friday"` and other day spellings, and describing `RepeatRule` better.
- **Validators that raise interrupts**, left out of #1197.
