# Log only the new messages in `promptCompletion`: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A statelog holds each message once instead of once per model call, and each interrupt's payload once instead of once per handler. Every reader still gets the whole conversation when it parses the log.

**Architecture:** The statelog client remembers, per thread, what it last logged, and writes only the part that changed, with a count of the messages it kept. The parse layer rebuilds the full list as it reads, so the logs viewer, eval, `std::statelog`, and the statelog server's eval summary keep reading `data.messages` as they do today. Separately, `handlerDecision` stops repeating the interrupt's data, which `interruptResolved` already logs.

**Tech Stack:** TypeScript, vitest, agency-js tests. A PR in the statelog repo (`~/statelog`) updates its trace pages, and deploys first.

**Spec:** There is no separate spec. The investigation is in the conversation that produced this plan, and the Background part below restates every number from it.

**Reviews:** Two reviews sit next to this file: `2026-11-25-statelog-message-deltas-review.md` and `2026-11-25-statelog-message-deltas-architecture-review.md`. This version of the plan includes every finding from both. The one finding not taken is converting logs that already exist, which the owner declined.

---

## Background: what the log holds today

### One event per model call, with the whole conversation

Every model call writes one `promptCompletion` event. `emitPromptCompletion` in `lib/runtime/promptEvents.ts` builds it, and `StatelogClient.promptCompletion` in `lib/statelogClient.ts` posts it. The event's `messages` field holds every message the call sent to the model: the system prompt, every earlier user message, every earlier reply, and every earlier tool result.

So a conversation's history is logged again on every call. Suppose a thread makes three calls. The first call sends 1 message, the second sends 3, and the third sends 5. The log holds 1 + 3 + 5 = 9 messages, but only 5 different ones. With N calls the log holds about N²/2 messages, so a long session's log grows with the square of its length.

The statelog doc already names this. Its "Size cap" section in `docs/dev/hosting/statelog.md` says: "Logging only the messages a round added would shrink these events properly; that needs its own spec, since every reader of `promptCompletion` changes." This plan is that change.

### Measured on three sets of logs

The eval sample is a random 250 of the 7,940 `statelog*.jsonl` files under `~/agency-evals` and `~/bench-agency` (20.6 GB in all).

| | Perry log (`~/.agency-agent/perry-log.jsonl`) | `packages/agency-lang/log.jsonl` | Eval sample (250 files) |
|---|---|---|---|
| File size | 96.7 MB | 37.3 MB | 559 MB |
| Model calls | 413 | 412 | 6,958 |
| `promptCompletion.messages` today | 84.3 MB | 25.8 MB | 313.3 MB |
| The same messages under this plan | 3.6 MB | 3.5 MB | 14.0 MB |
| `handlerDecision.interrupt` today | 2.3 MB | 1.6 MB | 128.7 MB |

The "under this plan" row comes from replaying each log through the writer's rule, with one record per thread in each trace and with message keys compared in sorted-key order. The full-copy rule described below adds a little back. The table in "A full copy every 50 calls" gives those numbers.

The biggest single run in the Perry log made 110 calls on a 205-message thread and wrote 51 MB, 92% of it messages.

### What a resume costs if the record does not survive it

A resume makes a new `StatelogClient` (see "Who writes a trace"). If a new client always started with nothing, its first call on each thread would be a full copy. The Perry log has 41 traces and 175 `agentStart` events, because each approval a person answers is a resume. Replaying with a new writer at each `agentStart`:

| Log | Messages today | Record survives a resume | New record at every run and resume |
|---|---|---|---|
| Perry log | 84.3 MB | 3.6 MB | 25.8 MB |
| `log.jsonl` | 25.8 MB | 3.5 MB | 3.7 MB |
| Eval sample | 313.3 MB | 14.0 MB | 16.5 MB |

With a new record at every resume, 208 of the Perry log's 413 calls would be full copies. So this plan keeps the record across a resume in the same process (Task 5). Evals seldom resume, because a policy answers their interrupts.

### Who writes a trace

A trace is every event that shares a `trace_id`. One trace can have several writers, and this decides how a reader can rebuild a list:

- **One run, one client.** An execution context makes one `StatelogClient` per run, with `traceId: runId` (`lib/runtime/state/context.ts:632`).
- **Fork branches share that client.** `forBranch` (`lib/statelogClient.ts:299`) makes a branch's logger with `Object.create(this)`. The logger has its own span stack and tag store, and reads every other field through the prototype from the one client. A fork copies its threads through JSON, and `fromJSON` keeps a thread's id (`lib/runtime/state/messageThread.ts:358`), so the branches of a fork each hold a thread with the same identity, and the threads grow apart.
- **A subprocess writes into the parent's trace and file.** `withParentStatelog` (`lib/runtime/ipc.ts:1553`) passes the parent's log file and sinks to the child, and the child inherits the parent's run id, so it logs under the same `trace_id`. Parent and child append to one file at the same time.
- **A resumed run reuses the trace.** Resuming an interrupt calls `createExecutionContext` again with the same run id (`lib/runtime/interrupts.ts:872` and `:1023`), so it gets a new client under the old `trace_id`. A thread restored from the checkpoint keeps its identity (`threadIdentity`, the serialized `MessageThread.id`).
- **A rewind starts a new trace.** `rewindFrom` runs in a fresh trace.

So "the previous `promptCompletion` for this thread in this trace" is not always the event the writer built on. A subprocess could log between two of the parent's calls.

### How events reach the file and the server

`post()` (`lib/statelogClient.ts:1681`) serializes the event once and hands the text to every sink. The file sink appends the line synchronously (`appendFileSync`). Nothing in `post()` awaits before that append, so lines land in the file in the order `post()` was called.

The remote sink is fire-and-forget: `sendStatelogPost` starts a `fetch` with a 1.5 second timeout and nothing waits for it. So an upload can be lost to a timeout, a network error, or a killed process. Uploads can also arrive out of order. The statelog server stores live uploads ordered by arrival time (`created_at`). Only bulk eval uploads carry a `sequence` column that keeps the file's order (`~/statelog/src/backend/db/log.ts:92`).

The bulk eval upload reads a run's log with `readTraces` and posts the parsed events (`lib/cli/eval/upload.ts:173`, then `sequencedFrom` at line 292). So whatever the parser returns is what the server stores.

### Who reads `messages`

Inside agency-lang, two functions in `lib/statelog/wireAccessors.ts` read the field, and everything else goes through them:

- `messagesOf(event)` returns `data.messages`. The logs viewer uses it in `lib/logsViewer/messageDelta.ts`, `lib/logsViewer/transcript.ts`, and `lib/logsViewer/roundInputPayload.ts`.
- `userMessageOf(event)` returns the last user message. `lib/logsViewer/spanText.ts:107` applies it to the first completion of each `llmCall` span, `lib/logsViewer/traceSummaries.ts:68` to a trace's first round, and `lib/eval/extract.ts:340` to the first top-level completion.

`spanText.ts` matters here. Each `llm()` call opens its own `llmCall` span, so the first completion in a span is often the second or third call on its thread. It would get a partial list if nothing rebuilt it.

`messageDelta.ts` already works out what each round added and detects a rewritten history. This plan does not reuse it for the writer, and "How the writer finds what changed" says why.

Events reach those readers through `lib/statelog/parse.ts`:

| Entry point | Callers | How it reads |
|---|---|---|
| `parseStatelogLines(lines, firstLineNumber)` | `lib/statelog/tail.ts`, `lib/cli/logsView.ts` (stdin), `lib/logsViewer/run.ts` (follow mode), `lib/runDirectory/traces.ts` (run directories, `std::statelog`, eval upload) | chunks of lines in file order, from the start of the file |
| `parseStatelogJsonl(text)` | `lib/eval/statelogParser.ts`, test fixtures | a whole file at once |
| `parseStatelogRecords(records)` | `lib/cli/remote/logsBridge.ts` (`agency remote logs`) | a whole trace fetched from the server, in the server's order |

Every `makeLineReader` call starts at offset 0, so no local reader starts in the middle of a file. Two readers parse lines with their own `JSON.parse` (`lib/runsExplorer/mine.ts:61`, `lib/runsExplorer/sources.ts:137`). Neither reads messages, and this plan leaves them alone.

Other readers of `promptCompletion` do not touch `messages` and need nothing: `lib/eval/run/costTail.ts`, `lib/runDirectory/modelUsage.ts`, and `lib/runDirectory/traceText.ts` (it reads `completion`). The Harbor importer copies statelog files and builds no events. Perry has only a test stub that names the event type.

The eval extractor has one more entry. `extractEvalRecord` calls `normalize(events)` (`lib/eval/normalize.ts:41`) on the events it is handed. The statelog server builds such events straight from its database rows and calls `summarizeEvalRun` from `agency-lang/eval` (`~/statelog/src/backend/lib/evals/traceSummary.ts`), which reaches `normalize` without passing through `parse.ts`.

### The statelog server

The server stores any event. On upload it only warns when an event does not match its schema (`~/statelog/src/backend/lib/logIngest.ts`). Its trace pages skip an event that fails the schema, and the schema requires `messages` on a `promptCompletion` (`~/statelog/src/common/apiTypes/logEvents.ts:144`). Its backend never reads `messages`.

Three trace-page files read the field. Two look for the first user message (`traceModel.ts:209`, `traceOverview.ts:66`). The transcript shows each message only the first time it sees its fingerprint (`traceTranscript.ts`, `addPromptMessages`), so it does not depend on a message's position in the list. All three work on the shape this plan writes.

The server refuses an upload whose `format_version` is above the version it supports (`~/statelog/src/backend/routes/api/logs.ts:94`).

### The interrupt payload is logged about three times

`handlerDecision` and `interruptResolved` each carry a summary of the interrupt: `effect`, `message`, and `data` (`InterruptSummary`, `lib/statelogClient.ts:114`). The summary holds no checkpoint. What makes it large is file content: an edit's interrupt carries the whole file before and after the edit, so the approval prompt can show a diff. Of the 128.7 MB of `handlerDecision.interrupt` in the eval sample, 116.2 MB is the `before` and `after` of `std::edit`.

Every handler in the chain logs one `handlerDecision`. The sample has 27,465 of them for 14,095 interrupts, so 1.9 per interrupt, and then one `interruptResolved`. Every interrupt in the sample has an `interruptResolved` event that carries the summary (14,096 of 14,096). So the copy on `handlerDecision` is never the only copy.

---

## The design

### The new fields, by example

Take a thread that makes three calls, "one", "two", "three", with replies "r1" and "r2". Today the three events hold:

```json
{"type":"promptCompletion","messages":[{"role":"user","content":"one"}], ...}
{"type":"promptCompletion","messages":[{"role":"user","content":"one"},{"role":"assistant","content":"r1"},{"role":"user","content":"two"}], ...}
{"type":"promptCompletion","messages":[{"role":"user","content":"one"},{"role":"assistant","content":"r1"},{"role":"user","content":"two"},{"role":"assistant","content":"r2"},{"role":"user","content":"three"}], ...}
```

After this change they hold:

```json
{"type":"promptCompletion","messages":[{"role":"user","content":"one"}],"logWriter":"Xk3_a9QpL2mZ","threadCall":1, ...}
{"type":"promptCompletion","keptMessages":1,"newMessages":[{"role":"assistant","content":"r1"},{"role":"user","content":"two"}],"logWriter":"Xk3_a9QpL2mZ","threadCall":2, ...}
{"type":"promptCompletion","keptMessages":3,"newMessages":[{"role":"assistant","content":"r2"},{"role":"user","content":"three"}],"logWriter":"Xk3_a9QpL2mZ","threadCall":3, ...}
```

A `promptCompletion` now carries one of two shapes:

- **A full copy:** `messages`, the whole list, exactly as today.
- **A change:** `keptMessages`, the number of messages at the start of the list that are the same as in this thread's previous event, and `newMessages`, the messages that follow them.

Both shapes carry two more fields:

- `logWriter`: a random 12-character id for one writer. A writer is one `StatelogClient`, or a chain of clients that a resume in the same process joined (see "A resume in a process that is still running reuses its writer"). Two processes writing into one trace have different ids.
- `threadCall`: 1 for the first call this writer logged on this thread, then 2, 3, and so on.

A reader rebuilds a change as "the first `keptMessages` messages of call `threadCall - 1` from the same writer on the same thread, then `newMessages`".

Every other field of the event is unchanged.

One cost is deliberate: a raw `promptCompletion` line no longer holds everything the model was sent. A person using `jq` or `grep` on a log file, or a script that reads lines itself, sees only the new messages. Code reads a log through `parse.ts`.

### How the writer finds what changed

The writer keeps a record per thread identity: the last `threadCall` it logged, and one string per message it logged. The string is `canonicalize(message)` from `lib/utils/canonicalize.ts`, which is JSON with object keys sorted at every depth. The message is the one about to be logged, after `withMessageLabels` added its labels. Redaction and the size cap run later, inside `post()`, so the stored strings are unredacted. They stay in memory and are only compared.

On each call the writer makes the strings for the new list and counts how many at the start match the stored ones. That count is `keptMessages`. Usually the thread has only grown, so the count is the whole stored list. When history was rewritten (by compaction, or by an expiring message being removed, see `docs/dev/runtime/expiring-messages.md`), the count stops at the first changed message, and everything after it goes into `newMessages`. A rewrite needs no separate format.

When the count is 0, the event is a full copy, with `messages`.

The comparison ignores key order because a message restored from a checkpoint can come back with its keys in a different order. In the Perry log, 50 of the 282 calls after a thread's first looked like rewrites for that reason: the same message's `usage` keys were reordered. With plain `JSON.stringify`, every resume would log most of the thread again. A reader that copies a kept message from the earlier event gets the same message with its keys in the earlier order, which changes nothing a reader looks at.

The writer never assumes the thread grew. It compares the new list with what it last logged, so it gives a correct event whatever happened to the thread in between.

**Why not `messageDelta.ts`.** The viewer's `messageKey` compares role, content, name, and tool calls, and treats a tool result saved as a value and the same result as JSON text as one message. That is right for showing what the model saw. The writer must be exact, because a reader copies kept messages from the earlier event, and a looser rule would hand back an earlier version of a message. The viewer also compares by tool path, which the writer has no notion of. The two rules stay separate.

Making the strings on every call costs about what `post()` spends today, since today it serializes the whole list into the event. The stored strings take about as much memory as the thread itself. A message with a picture is stored with its base64 data, because the scrub that removes pictures runs later in `post()`. If that shows up in a memory profile, store a hash of each string instead.

### Why the writer id and the call number

**Without `logWriter`**, a reader would rebuild from "the previous event for this thread in this trace". A subprocess shares its parent's trace and file. If both log calls on a thread with the same identity, their events interleave, and each one's change is relative to its own previous event. The same holds for a resume in another process, whose client starts with no record.

**Without `threadCall`**, a lost or reordered upload would silently produce a wrong history. Suppose call 5 is lost on the way to the server. Call 6 says "keep 9 messages from the previous event". The reader's previous event is call 4, which also has at least 9 messages, so the reader keeps call 4's first 9, which may differ from call 5's. The result looks complete and is wrong. With `threadCall`, the reader sees that the event it holds is call 4, not call 5, and marks the gap.

### A full copy every 50 calls

A gap on a thread lasts until that thread's next full copy. Today every event is a full copy. With this change, only the first call on a thread is, unless something else forces one. So the writer also writes a full copy on calls 51, 101, 151, and so on: whenever `threadCall - 1` is divisible by `FULL_COPY_EVERY_CALLS`.

Measured on the two session logs (message bytes only):

| Full copy written | Perry log | `log.jsonl` |
|---|---|---|
| Today (every call) | 82.9 MB | 25.4 MB |
| Only on a thread's first call | 3.5 MB | 3.5 MB |
| Every 10 calls | 11.1 MB | 5.2 MB |
| Every 20 calls | 7.0 MB | 4.0 MB |
| Every 50 calls | 4.6 MB | 3.8 MB |

The interval is 50. It adds about 30% to the message bytes on the long-session log, and gaps only happen on the remote path.

### A resume in a process that is still running reuses its writer

There are two kinds of resume, and this section is about the first only:

- **The process that ran the program is still alive.** The program returned an interrupt to its TypeScript caller, and the caller answers it with `respondToInterrupts` in the same process. Perry and `agency agent` work this way. The compiled program's base context is still in memory.
- **The process is gone.** `agency resume`, or a served agent whose `/resume` reaches a fresh process. Nothing is in memory. The resumed run gets a new writer with a new id, and its first call on each thread is a full copy.

The kept writer is a cache and nothing else. If it is missing, dropped, or out of date, the only cost is one full copy per thread. No resume depends on it, and it is in no checkpoint.

The base `RuntimeContext` outlives each run: `createExecutionContext` is called on it for every run and every resume. It keeps the writer of each recent run, by run id. A writer is the `logWriter` id and the per-thread records:

```ts
type LogWriterState = { logWriter: string; threads: Record<string, LoggedThread> };
```

`createExecutionContext` asks for the writer of its run id and hands it to the new `StatelogClient`. A first run gets a new writer. A resume in the same process gets the one its earlier client used, so its first call on a thread is a change event that builds on the last call before the interrupt, under the same `logWriter` and the next `threadCall`.

This is safe for the reason fork branches are safe. The record always describes the last event this writer posted for the thread, because the record is updated and the line appended with no `await` between them. What the restored thread holds does not matter: the writer compares, and keeps only the common start.

The base context keeps the writers of the 20 most recently used run ids (`MAX_KEPT_LOG_WRITERS`), and drops the least recently used one when a 21st arrives. A dropped writer costs one full copy per thread if that run resumes later, and nothing else. The limit bounds memory in a long-lived process, such as a served agent with interrupts nobody answers.

A resume in another process (`agency resume`, or a served agent whose `/resume` reaches a different process) has no kept writer. It gets a new one, and its first call on each thread is a full copy. A subprocess has its own base context, so it is always its own writer.

### How readers get the full list back

A new module rebuilds the full `messages` list on each change event while the log is read. A rebuilt event looks like a full copy: it has `messages` with the whole list, it keeps `keptMessages`, `logWriter`, and `threadCall`, and it drops `newMessages`. Because readers see the same `data.messages` as today, `messagesOf`, `userMessageOf`, the viewer, eval, and `std::statelog` need no changes.

There are two ways to run it:

- **In file order**, one event at a time (`rebuildMessages`). The caller keeps a `RebuildState` object across chunks. Every local reader reads from the start of the file, and a file holds each writer's events in the order that writer posted them, so this order is right for every file.
- **On a whole batch in any order** (`rebuildAllMessages`). It processes change events in `threadCall` order and puts each rebuilt event back at its original position in the list. `parseStatelogRecords` uses it, because the server's order is arrival order. `normalize` uses it, because the server hands eval its rows directly.

Running a rebuild twice is harmless. A rebuilt event has `messages`, so a second pass treats it as a full copy, and an event marked with a gap stays marked. This matters because a file parsed by `parse.ts` is later normalized by eval and rebuilt a second time.

Old events have no `logWriter` and pass through untouched.

### The parser hands back both the stored event and the rebuilt one

Display readers want full lists. The eval upload wants each event as the file holds it, or the server would store full lists and gain nothing. So a parsed line carries both:

```ts
export type ParsedEventLine = {
  /** The event with `messages` rebuilt. What a reader shows. */
  event: EventEnvelope;
  /** The event as the file holds it. What an upload sends. */
  stored: EventEnvelope;
  raw: string;
  line: number;
};
```

`stored` is the object `JSON.parse` produced. `rebuildMessages` never changes its input, so the two never alias a changed object. For every event that is not a change event, `event` and `stored` are the same object.

`Trace` in `lib/runDirectory/traces.ts` gains `storedEvents` next to `events`, and `agency eval upload` posts `storedEvents`. A caller has to pick one by name, so the next piece of code that sends events somewhere cannot send rebuilt ones by accident.

### What a reader does at a gap

A change event cannot be rebuilt when its previous call is missing, or when the previous call has fewer than `keptMessages` messages. Then the reader sets `messages` to `newMessages` and adds `missingMessages: <keptMessages>`, the number of messages at the start that are not in the log. It also forgets that thread's record, so every later change event on the thread is marked the same way until the next full copy. A gap never produces a list that looks complete.

The viewer does not show `missingMessages` yet. A local file never has a gap, so the mark only appears when `agency remote logs` reads back a live-streamed trace that lost an upload. Showing it can wait until someone meets one (see "Out of scope").

### `handlerDecision` leaves out the interrupt's data

`handlerDecision` logs `interrupt: { effect, message }`. `interruptResolved` keeps the whole summary, with `data`. So an interrupt's payload is in the log once.

The readers:

- The viewer's story rows read `effect` and `message` from `handlerDecision` (`lib/logsViewer/story.ts:327`), which stay.
- The viewer's interrupt payload reads `data` from its row's event (`lib/logsViewer/payload.ts:476`). Interrupt rows are built from `interruptResolved` and `interruptThrown` events (`lib/logsViewer/story.ts:114` and `:213`), never from `handlerDecision`, so it is unaffected.
- Eval extraction takes the summary from the first event of the interrupt that has one (`lib/eval/extract.ts:219`), which is usually a `handlerDecision`. It changes to prefer an `interruptResolved` and fall back to a `handlerDecision`, so old logs and an interrupt with no resolution still give a summary.
- The statelog server reads neither field.

This is not a config option. The payload is still logged once, so nobody loses anything, and an option would be one more thing to learn and to test in both positions.

On the eval sample this removes 128.7 MB. Together with the message change, the sample goes from 559 MB to about 131 MB, which is 23% of today. The message change alone reaches 46%.

### Interrupts, resume, checkpoints, branches, and subprocesses

- **The record is not part of any checkpoint.** It lives on the base context and the client, and neither is serialized. Putting it in a checkpoint would be wrong: a checkpoint can be resumed in another process, long after other writers logged to the trace.
- **Interrupts and handlers are untouched.** The message change is inside `promptCompletion` and the readers. The `handlerDecision` change removes a logged field. No control flow changes, and no handler is registered, skipped, or consulted differently.
- **A resume in a process that is still running reuses its run's writer,** as described above. A resume in another process starts a new one with a full copy.
- **Fork branches share one record.** The record is a field on the root client, and each branch's logger reads it through the prototype. Code changes the record object in place and never assigns a new object to the field. An assignment would create a field on that branch's logger, the branches would keep separate records under one `logWriter`, and readers could no longer rebuild their events. A test pins this.
- **Fork branches on one thread log their branch history each time they alternate.** The branches of a fork hold threads with the same identity that grow apart. Suppose branch A has added 20 messages and branch B has added 20 different ones. When B logs after A, the common start ends where they forked, so B's event holds all 20 of B's messages. Every event still rebuilds to the right list. It is only larger than a single thread's would be, by the part after the fork. The replay on all three sets of logs landed within 2 MB of the smallest possible result, so this is rare in practice, and the plan accepts it.
- **Order inside one process.** `promptCompletion` works out the fields and updates the record, then calls `post()`, which appends the line before its first `await`. No other event can be posted between the update and the append. A comment at the update says so, because adding an `await` between them would break it.
- **Subprocesses are separate writers.** Each child process has its own base context and makes its own writer.
- **Rewinds start a new trace,** so they get a new run id and a new writer.

### Redaction and the size cap

`post()` still scrubs every event and caps every string. A kept message is not scrubbed again on a later call, because it is not in the later event. A reader reuses its text from the earlier event, where it was already scrubbed. If a value is tagged `redact` after a message holding it was logged, the earlier event already contains it unredacted, as it does today. Later events do not repeat it.

`newMessages` joins `messages` in `UNBUDGETED_FIELDS` (`lib/runtime/trimStatelogEvent.ts:20`), for the reason the doc gives for `messages`: a budget keeps the start of a list, and the end of a conversation is the part worth reading.

### Compatibility

- **Old logs** have no `logWriter` and read exactly as before. Their `handlerDecision` events still carry `data`, and readers accept both.
- **A reader from an older agency-lang version** reading a new log sees full copies as before. Change events have no `messages` for it, so a round shows "Input messages were not recorded." and its history comparison is off. It does not crash.
- **The statelog server before its update** stores every event, as it stores anything. Its trace pages skip change events, because they fail its schema. The server PR does not depend on this change, so it deploys first and no trace page ever hides a round.
- **The statelog server's eval summary** gets rebuilt lists once the server moves to the agency-lang release that carries this change, because `summarizeEvalRun` reaches `normalize`.
- **Logs that already exist stay as they are.** This change shrinks what new runs write.

### `format_version` stays 1

The doc's rule says to bump `STATELOG_FORMAT_VERSION` "when the wire format changes in a way a viewer must notice". An old viewer would notice something here: rounds with no input. A bump would cost more:

- The statelog server refuses uploads with a version it does not support. Until the server deploys, every event from a program on the new runtime would be rejected, including the events this change does not touch.
- An older `agency logs` would refuse every line of a new log, instead of showing everything except the change events' inputs.

The new fields are additive. A full copy is unchanged, and a change event adds fields an old reader ignores. The version stays 1, and the doc says why this change did not bump it.

---

## Decisions, settled by the owner on 2026-11-25

1. **Full copy every 50 calls** (see the table above). The alternative was "only on a thread's first call", which is smaller, but a remote gap then stays open until the run ends.
2. **`format_version` stays 1** (see the section above). The alternative was a bump, which requires deploying the server first.
3. **Field names:** `keptMessages`, `newMessages`, `logWriter`, `threadCall`, and `missingMessages` (reader side only).
4. **A resume in a process that is still running reuses its run's writer,** and the base context keeps the writers of 20 run ids. The alternative was a full copy at every resume, which is simpler and leaves 25.8 MB of messages in the Perry log instead of 3.6 MB.
5. **`handlerDecision` drops the interrupt's `data` for everyone,** with no config option.

## Out of scope

- **Converting logs that already exist.** The owner decided the saving applies going forward.
- **Showing a gap in the logs viewer.** The reader marks it with `missingMessages`. A line in the round input can follow when someone meets a gap.
- **The `before` and `after` of `std::edit` on `interruptResolved`** (about 51 MB of the eval sample). Shrinking it means changing what an edit's interrupt carries, which changes what a handler and the approval prompt see.
- The node state on `enterNode` and `exitNode` still logs `messages` (3 MB of the Perry log, 14 MB of the eval sample). That is a separate, smaller change.
- Compressing the log file, or what the server stores.
- The previous call's reply appears both in that call's `completion` and in the next call's `newMessages`, and a tool's output appears in `toolCall.output` and in the next `newMessages`. That is one message per call, not the whole history.
- Logging each message once per trace by content hash. On these logs it saves nothing over this plan (3.6 MB against 3.6 MB on Perry) and needs a larger format.

## Global Constraints

- Use objects instead of maps, arrays instead of sets, and types instead of interfaces (repo `CLAUDE.md`).
- No dynamic imports.
- No magic numbers: the full-copy interval is `FULL_COPY_EVERY_CALLS = 50`, and the kept-writer limit is `MAX_KEPT_LOG_WRITERS = 20`.
- Keep the field names exactly: `messages`, `keptMessages`, `newMessages`, `logWriter`, `threadCall`, `missingMessages`.
- `STATELOG_FORMAT_VERSION` stays `1`.
- No state at TypeScript module level. The kept writers live on the base `RuntimeContext`.
- Save every test, typecheck, and build output to a file in your scratch folder, written `<scratch>` below, and read the file. Do not rerun a command to see its output.
- Run `pnpm run typecheck` after every task that edits TypeScript.
- Format changed TypeScript files by name (`pnpm exec prettier --write <files>`). Never run `pnpm run fmt:ts` from the main checkout.
- Do not run the full agency test suite locally. Run only the tests each task names.
- Write commit messages in a file and commit with `git commit -F <file>`.

## Review Focus

1. **Two fork branches logging calls on one thread.** The second branch's event must say `threadCall: 2` and build on the first branch's event. A branch logger that got its own record would write `threadCall: 1` twice under one `logWriter`. Pinned in Task 4. Expect the second branch's event to hold every message that branch added since the fork, as "Fork branches on one thread" explains.
2. **A history rewrite (compaction) in the middle of a session.** The rebuilt list after the rewrite must equal the list the model was sent, not the old history with the new messages appended. Pinned in Tasks 1 and 2.
3. **A lost or reordered remote upload.** A lost call must give `missingMessages` on every following change event until the next full copy, never a list that looks complete. A reordered batch must rebuild correctly. Pinned in Task 2.
4. **A subprocess logging into its parent's file and trace.** Its events must rebuild against its own writer. Pinned in Task 2 with two interleaved writers. The existing `subprocess-statelog-runid` agency-js test covers the real process boundary in Task 7.
5. **A log read twice:** parsed by `parse.ts`, then normalized by eval. The second rebuild must not change anything, including an event marked with a gap. Pinned in Task 2.
6. **A resume in the same process.** The first call after it must be a change event with the same `logWriter` and the next `threadCall`, and it must rebuild to the list the model was sent. Pinned in Tasks 5 and 7.
7. **The eval upload.** It must post change events as the file holds them, with `newMessages` and no `messages`. Pinned in Task 3.
8. **Every interrupt keeps its payload once.** An interrupt answered by a handler at once, with no `interruptThrown`, must still have `data` on its `interruptResolved`. Pinned in Task 6.

---

## File structure

New directory `lib/statelog/threadMessages/`, one concept per file:

- `write.ts`: `messageFieldsFor`, which works out one event's fields from the writer's record for the thread, and `FULL_COPY_EVERY_CALLS`.
- `read.ts`: `rebuildMessages` and `rebuildAllMessages`.
- `writers.ts`: `LogWriterState`, and the kept writers a base context holds by run id.
- `write.test.ts`, `read.test.ts`, `writers.test.ts`.

Changed:

- `lib/statelog/wireTypes.ts`: the two field types, `FullCopyFields` and `ChangeFields`, next to the other wire types. Writer and reader both import them.
- `lib/statelog/parse.ts`: `ParsedEventLine` gains `stored`, `parseStatelogLines` takes a `RebuildState`, and the batch parsers rebuild.
- `lib/statelog/tail.ts`, `lib/cli/logsView.ts`, `lib/logsViewer/run.ts`, `lib/runDirectory/traces.ts`: keep one `RebuildState` per reader.
- `lib/runDirectory/traces.ts`: `Trace` gains `storedEvents`.
- `lib/cli/eval/upload.ts`: posts `storedEvents`.
- `lib/eval/normalize.ts`: rebuild before normalizing.
- `lib/eval/extract.ts`: an interrupt's summary prefers `interruptResolved`.
- `lib/statelogClient.ts`: the writer, `promptCompletion` using `messageFieldsFor`, and `handlerDecision` without `data`.
- `lib/runtime/state/context.ts`: the kept writers, and `createExecutionContext` passing one to the client.
- `lib/runtime/trimStatelogEvent.ts`: `newMessages` exempt from the field budget.
- `tests/agency-js/guard-feedback/test.js`: read the log through the parser.
- New agency-js test `tests/agency-js/statelog-message-history/`.
- `docs/dev/hosting/statelog.md`.

In `~/statelog`, in a separate PR that deploys first: `src/common/apiTypes/logEvents.ts` and the trace page readers.

The readers change (Task 3) before the writer (Task 4). Readers that rebuild do nothing to old logs, so the repo works after every task.

---

### Task 1: The fields and the writer's rule

**Files:**
- Modify: `lib/statelog/wireTypes.ts`
- Create: `lib/statelog/threadMessages/write.ts`
- Test: `lib/statelog/threadMessages/write.test.ts`

**Interfaces:**
- Produces, in `wireTypes.ts`:

```ts
/** A whole message list on a `promptCompletion`, logged as it was before
 *  change events existed. */
export type FullCopyFields = { messages: unknown[]; logWriter: string; threadCall: number };

/** The messages that changed since this writer's previous call on the thread. */
export type ChangeFields = {
  keptMessages: number;
  newMessages: unknown[];
  logWriter: string;
  threadCall: number;
};
```

- Produces, in `write.ts`:

```ts
/** A thread's full message list is logged again on its first call and
 *  then every this many calls, so a lost remote upload leaves a gap that
 *  ends at the next full copy. */
export const FULL_COPY_EVERY_CALLS = 50;

/** What one writer last logged for one thread. */
export type LoggedThread = { call: number; messageKeys: string[] };

export function messageFieldsFor(args: {
  previous: LoggedThread | undefined;
  logWriter: string;
  messages: unknown[];
}): { fields: FullCopyFields | ChangeFields; logged: LoggedThread };
```

It is a pure function, and the caller stores `logged`. `messageKeys[i]` is `canonicalize(messages[i])`, from `lib/utils/canonicalize.ts`. `call` is `(previous?.call ?? 0) + 1`. The event is a full copy when there is no `previous`, when `(call - 1) % FULL_COPY_EVERY_CALLS === 0`, or when the kept count is 0. Otherwise it is a change, and `keptMessages` is the length of the common start of `previous.messageKeys` and the new keys. A thread with no identity is handled by the client in Task 4, not here.

- [ ] **Step 1: Write the failing tests** in `write.test.ts`:

```ts
const user = (content: string) => ({ role: "user", content });
const reply = (content: string) => ({ role: "assistant", content });

it("logs a thread's first call whole", () => {
  const { fields, logged } = messageFieldsFor({ previous: undefined, logWriter: "w", messages: [user("one")] });
  expect(fields).toEqual({ messages: [user("one")], logWriter: "w", threadCall: 1 });
  expect(logged.call).toBe(1);
});

it("logs only what a grown thread added", () => {
  const first = messageFieldsFor({ previous: undefined, logWriter: "w", messages: [user("one")] });
  const { fields } = messageFieldsFor({
    previous: first.logged,
    logWriter: "w",
    messages: [user("one"), reply("r1"), user("two")],
  });
  expect(fields).toEqual({ keptMessages: 1, newMessages: [reply("r1"), user("two")], logWriter: "w", threadCall: 2 });
});

it("keeps only the unchanged start of a rewritten history", () => {
  const before = messageFieldsFor({ previous: undefined, logWriter: "w", messages: [user("a"), reply("b"), user("c"), reply("d")] });
  const { fields } = messageFieldsFor({ previous: before.logged, logWriter: "w", messages: [user("a"), user("summary"), reply("d")] });
  expect(fields).toEqual({ keptMessages: 1, newMessages: [user("summary"), reply("d")], logWriter: "w", threadCall: 2 });
});

it("logs a full copy when nothing at the start is unchanged", () => {
  const before = messageFieldsFor({ previous: undefined, logWriter: "w", messages: [user("a")] });
  const { fields } = messageFieldsFor({ previous: before.logged, logWriter: "w", messages: [user("z")] });
  expect(fields).toEqual({ messages: [user("z")], logWriter: "w", threadCall: 2 });
});

it("logs a full copy again on call FULL_COPY_EVERY_CALLS + 1", () => {
  let previous: LoggedThread | undefined;
  const messages: unknown[] = [];
  const shapes: string[] = [];
  for (let call = 1; call <= FULL_COPY_EVERY_CALLS + 1; call++) {
    messages.push(user(`m${call}`));
    const result = messageFieldsFor({ previous, logWriter: "w", messages: [...messages] });
    shapes.push("messages" in result.fields ? "full" : "change");
    previous = result.logged;
  }
  expect(shapes[0]).toBe("full");
  expect(shapes[1]).toBe("change");
  expect(shapes[FULL_COPY_EVERY_CALLS]).toBe("full");
});

it("logs an empty change when the thread did not change", () => {
  const first = messageFieldsFor({ previous: undefined, logWriter: "w", messages: [user("one")] });
  const { fields } = messageFieldsFor({ previous: first.logged, logWriter: "w", messages: [user("one")] });
  expect(fields).toEqual({ keptMessages: 1, newMessages: [], logWriter: "w", threadCall: 2 });
});

it("keeps a message whose keys came back in a different order", () => {
  const first = messageFieldsFor({
    previous: undefined,
    logWriter: "w",
    messages: [{ role: "assistant", content: "r1", usage: { inputTokens: 1, outputTokens: 2 } }],
  });
  const { fields } = messageFieldsFor({
    previous: first.logged,
    logWriter: "w",
    messages: [{ usage: { outputTokens: 2, inputTokens: 1 }, content: "r1", role: "assistant" }, user("two")],
  });
  expect(fields).toEqual({ keptMessages: 1, newMessages: [user("two")], logWriter: "w", threadCall: 2 });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm vitest run lib/statelog/threadMessages/write.test.ts > <scratch>/write-test.txt 2>&1`, then read the file.
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Add the types to `wireTypes.ts` and write `write.ts`** with the signature above.

- [ ] **Step 4: Run the tests and see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Typecheck, format, and commit**

```bash
pnpm run typecheck > <scratch>/typecheck.txt 2>&1
pnpm exec prettier --write lib/statelog/threadMessages/*.ts lib/statelog/wireTypes.ts
git add lib/statelog/threadMessages lib/statelog/wireTypes.ts
git commit -F <message file>   # "Add the rule that decides which messages a promptCompletion logs"
```

---

### Task 2: Rebuilding full lists when reading

**Files:**
- Create: `lib/statelog/threadMessages/read.ts`
- Test: `lib/statelog/threadMessages/read.test.ts`

**Interfaces:**
- Consumes: `FullCopyFields` and `ChangeFields` from Task 1, and `messageFieldsFor` in the tests.
- Produces, in `read.ts`:

```ts
/** What a reader has rebuilt so far, by trace, writer, and thread. */
export type RebuildState = Record<string, { call: number; messages: unknown[] }>;

/** The event with `data.messages` holding the whole list. Changes `state`.
 *  Returns any event that is not a tracked promptCompletion unchanged. */
export function rebuildMessages(state: RebuildState, event: EventEnvelope): EventEnvelope;

/** Rebuilds every event of a batch whose events may be in any order, such
 *  as a trace fetched from the server. Returns a new array with each event
 *  at its original position. */
export function rebuildAllMessages(events: readonly EventEnvelope[]): EventEnvelope[];
```

`rebuildMessages` rules:

1. Return the event unchanged unless `data.type === "promptCompletion"`, `data.logWriter` is a string, `data.threadCall` is a number, and `data.threadIdentity` is a string.
2. The key is `JSON.stringify([event.trace_id, data.logWriter, data.threadIdentity])`.
3. If `data.missingMessages` is a number, the event was rebuilt before and has a gap. Delete `state[key]` and return the event unchanged.
4. If `data.messages` is an array, the event is a full copy, or an event rebuilt before. Store `{ call: threadCall, messages }` under the key and return the event unchanged.
5. Otherwise it is a change. Let `base = state[key]`. The event can be rebuilt when `base` exists, `base.call === threadCall - 1`, and `base.messages.length >= keptMessages`.
   - If it can, `messages = base.messages.slice(0, keptMessages).concat(newMessages)`. Store `{ call: threadCall, messages }`.
   - If it cannot, `messages = newMessages`, add `missingMessages: keptMessages`, and delete `state[key]`, so the next change on this thread is marked too.
6. Return a copy of the event whose `data` has `messages` (and `missingMessages` at a gap) and has no `newMessages`. Do not change the input event.

`rebuildAllMessages` collects the indexes of the events rule 1 accepts and sorts them by `threadCall` with a stable sort. It runs `rebuildMessages` over them in that order with a fresh state, and puts each result back at its index. Events on different threads or writers are independent, so one sort by `threadCall` puts every thread's events in order.

- [ ] **Step 1: Write the failing tests** in `read.test.ts`. A helper turns a list of message lists into written events by running `messageFieldsFor` in sequence, so the tests check the round trip through the real writer:

```ts
function written(lists: unknown[][], opts: { trace?: string; writer?: string; thread?: string } = {}): EventEnvelope[]
// Each event: { format_version: 1, trace_id: opts.trace ?? "t", project_id: "", span_id: null,
//   parent_span_id: null, data: { type: "promptCompletion", timestamp: "", threadIdentity: opts.thread ?? "th", ...fields } }

const listsOf = (events: EventEnvelope[]) => events.map((event) => event.data.messages);
```

Tests, each with its assertion:

- `"rebuilds every call of a growing thread"`: lists `[[u1], [u1, r1, u2], [u1, r1, u2, r2, u3]]`. Rebuilding the written events in order gives back the same three lists.
- `"rebuilds across a rewritten history"`: lists `[[a, b, c, d], [a, s, d], [a, s, d, e]]` give back the same lists.
- `"rebuilds two branches that grow apart on one thread"`: one writer, one thread, lists `[[base], [base, a1], [base, b1], [base, a1, a2], [base, b1, b2]]`, the order two fork branches would log them. Each rebuilt list equals the list it was written from.
- `"rebuilds two writers whose events interleave in one trace"`: writer `p` lists `[[p1], [p1, p2]]` and writer `c` lists `[[c1], [c1, c2]]`, on the same trace and the same thread identity, interleaved as p, c, p, c. Each rebuilt list equals its writer's list.
- `"marks a lost call and every change after it until the next full copy"`: write four calls and drop the second. The third event has `missingMessages` equal to its `keptMessages`, and `messages` equal to its `newMessages`. The fourth has `missingMessages` too. Neither has `newMessages`.
- `"rebuilds a batch that arrived out of order"`: write three calls and pass them to `rebuildAllMessages` as `[third, first, second]`. The result is in that same order, and each list is the full one.
- `"changes nothing when run a second time, gaps included"`: write four calls and drop the second. `rebuildAllMessages(rebuildAllMessages(events))` deep-equals `rebuildAllMessages(events)`, and the fourth event still has `missingMessages`.
- `"leaves events without writer fields untouched"`: an old-style `promptCompletion` with only `messages`, and a `toolCall` event, come back as the same objects (`toBe`).
- `"does not change the events it is given"`: a `structuredClone` of the input taken before the call deep-equals the input after it.

- [ ] **Step 2: Run the tests and see them fail.** `pnpm vitest run lib/statelog/threadMessages/read.test.ts > <scratch>/read-test.txt 2>&1`. Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Write `read.ts`** with the rules above.

- [ ] **Step 4: Run the tests and see them pass.**

- [ ] **Step 5: Typecheck, format the two files, and commit** ("Rebuild full message lists when a statelog is read").

---

### Task 3: Every reader rebuilds, and the upload sends stored events

**Files:**
- Modify: `lib/statelog/parse.ts`
- Modify: `lib/statelog/tail.ts`, `lib/cli/logsView.ts:388`, `lib/logsViewer/run.ts:1000-1095`, `lib/runDirectory/traces.ts`
- Modify: `lib/eval/normalize.ts:41`
- Modify: `lib/cli/eval/upload.ts:155-175`
- Test: `lib/statelog/parse.test.ts` (create it if it does not exist), the existing test files for `lib/eval/extract.ts`, `lib/runDirectory/traces.ts`, and `lib/cli/eval/upload.ts`

**Interfaces:**
- Consumes: `RebuildState`, `rebuildMessages`, `rebuildAllMessages` (Task 2).
- Produces:
  - `parseStatelogLines(lines: readonly string[], firstLineNumber: number, rebuild: RebuildState): ParseWithLinesResult`. The new parameter is required, so the type checker finds every caller.
  - `ParsedEventLine` gains `stored: EventEnvelope`, the event as the file holds it. `event` is the rebuilt event, and `raw` stays the exact line.
  - `Trace` gains `storedEvents: EventEnvelope[]`, in the same order as `events`.

- [ ] **Step 1: Write the failing tests:**
  - In `parse.test.ts`, `"parseStatelogJsonl returns full lists for change events"`: build three lines with `messageFieldsFor` (as in Task 2's helper) and join them with `\n`. `parseStatelogJsonl(text).events[2].data.messages` is the whole third list. The same lines split into two chunks and passed to `parseStatelogLines` with one shared `RebuildState` give the same events.
  - In `parse.test.ts`, `"a parsed line keeps the event as the file holds it"`: for the third line, `entry.stored.data.newMessages` is the two new messages and `entry.stored.data.messages` is undefined, while `entry.event.data.messages` is the whole list.
  - In `parse.test.ts`, `"parseStatelogRecords rebuilds records that arrive out of order"`: the three records reversed. Every event has its whole list.
  - In the extract test file, `"extractEvalRecord rebuilds events it is handed directly"`: hand `extractEvalRecord` written events where the thread's first call is a full copy holding a system message only, and the second call is a change that adds the user message. The extracted user message is that message. This is the path the statelog server's `summarizeEvalRun` takes.
  - In the traces test file, `"a trace keeps its stored events next to the rebuilt ones"`: read a file of the three lines. `trace.events[2].data.messages` has five messages, and `trace.storedEvents[2].data.newMessages` has two.
  - In the upload test file, `"uploads change events as the file holds them"`: a run directory whose statelog has the three lines. The third event the fake client receives has `newMessages` and `keptMessages: 3`, and no `messages`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Change the parsers and callers:**
  - `parseStatelogLine` sets `stored` and `event` to the same checked event. Its doc comment says it does not rebuild, and that a caller reading more than one line uses `parseStatelogLines`.
  - `parseStatelogLines` replaces each entry's `event` with `rebuildMessages(rebuild, entry.event)` and leaves `stored`.
  - `parseStatelogJsonlWithLines` passes a new `{}`.
  - `parseStatelogRecords` runs `rebuildAllMessages` over the checked events.
  - `makeStatelogTailer`, `parseStatelogStream`, and the trace readers in `traces.ts` each make one `RebuildState` and pass it on every call.
  - In `traces.ts`, the grouper pushes `entry.stored` onto `storedEvents` where it pushes `entry.event` onto `events`. The digest stays over `events`.
  - In `lib/logsViewer/run.ts`, the follow reader keeps one `RebuildState` next to `reader`, and passes it from `readAppended` and `withParsedLines`. Where a truncated file resets `reader`, `log`, and `lineCount` (line 1038), it also replaces the state with `{}`.
  - `normalize(events)` starts with `const rebuilt = rebuildAllMessages(events)` and works on `rebuilt`.
  - In `upload.ts`, `readLocalRun` takes `storedEvents` from the trace for the events it posts. `digestTrace`, which builds the results-only digest, keeps reading the rebuilt `events`, so `LocalRun` holds both.

- [ ] **Step 4: Run the new tests and the readers' existing tests.** First list the test files, so no path in the command matches nothing: `ls lib/statelog lib/logsViewer lib/eval lib/runDirectory lib/logsQuery lib/cli lib/cli/eval | grep test`. Then run `pnpm vitest run lib/statelog lib/logsViewer lib/eval lib/runDirectory lib/logsQuery lib/cli/logsView lib/cli/eval > <scratch>/reader-tests.txt 2>&1`. Expected: PASS. Their fixtures are old-format logs, which pass through untouched.

- [ ] **Step 5: Typecheck, format the changed files, and commit** ("Rebuild full message lists in every statelog reader").

---

### Task 4: The client writes the new fields

**Files:**
- Modify: `lib/statelogClient.ts` (constructor at line 217, `promptCompletion` at line 638, `post` at line 1681)
- Create: `lib/statelog/threadMessages/writers.ts` (the `LogWriterState` type and `newLogWriter` only; Task 5 adds the rest)
- Modify: `lib/runtime/trimStatelogEvent.ts:20`
- Test: `lib/statelogClient.test.ts`, `lib/runtime/trimStatelogEvent.test.ts`

**Interfaces:**
- Consumes: `messageFieldsFor` and `LoggedThread` (Task 1).
- Produces, in `writers.ts`:

```ts
/** One writer of change events: its id, and what it last logged per thread. */
export type LogWriterState = { logWriter: string; threads: Record<string, LoggedThread> };

export function newLogWriter(): LogWriterState; // { logWriter: nanoid(12), threads: {} }
```

- Produces: `StatelogConfig` gains an optional `writer?: LogWriterState`. The client uses it when given and calls `newLogWriter()` otherwise. `promptCompletion` events come out in the new shape. Its parameters do not change, so `emitPromptCompletion` does not change.

- [ ] **Step 1: Write the failing tests** in `lib/statelogClient.test.ts`, with the file-sink setup the existing tests there use to read back what was written:

- `"logs the first call on a thread whole and later calls as changes"`: two `promptCompletion` calls on thread identity `"th"`, the second with one more message. The first line has `messages`, `threadCall: 1`, and a 12-character `logWriter`. The second has `keptMessages: 1`, one `newMessages` entry, `threadCall: 2`, no `messages`, and the same `logWriter`.
- `"two branch loggers share one record per thread"`: make two loggers with `client.forBranch(globals, [])` and log one call on thread `"th"` through each, the second with one more message. The second line has `threadCall: 2` and `keptMessages: 1`, and both lines have the same `logWriter`.
- `"a thread with no identity is always logged whole"`: two calls with `threadIdentity: null`. Both lines have `messages`, and neither has `logWriter` or `threadCall`.
- `"two clients get different writer ids"`: one call through each of two clients writing to the same file. The `logWriter` values differ.
- `"a client given a writer continues it"`: log one call through a client made with `writer: w`, then one more call, with one more message, through a second client made with the same `w`. The second line has `threadCall: 2`, `keptMessages: 1`, and the first line's `logWriter`.

In `lib/runtime/trimStatelogEvent.test.ts`:

- `"does not budget promptCompletion.newMessages"`: an event whose `newMessages` serializes to more than the cap, made of many short strings, comes back with every entry.

- [ ] **Step 2: Run both files and see the new tests fail.**

- [ ] **Step 3: Change the client:**
  - Add `private readonly writer: LogWriterState`, set in the constructor from `config.writer ?? newLogWriter()`. A comment says that branch loggers made by `forBranch` read this object through the prototype, so code changes `writer.threads` in place and never assigns a new object to the field.
  - Move the two early-return checks at the top of `post()` (the client is disabled; there is no host and no file) into `private willPost(): boolean`, and use it in `post()`.
  - In `promptCompletion`, return at once when `!this.willPost()`. When `threadIdentity` is a string, call `messageFieldsFor({ previous: this.writer.threads[threadIdentity], logWriter: this.writer.logWriter, messages })`, store the result with `this.writer.threads[threadIdentity] = logged`, and spread `fields` into the posted body in place of `messages`. When it is not a string, post `messages` as today. A comment at the store says the record is updated and the line appended with no `await` between them, so lines land in the order of their `threadCall`.
  - In `trimStatelogEvent.ts`, `UNBUDGETED_FIELDS.promptCompletion` becomes `["messages", "newMessages"]`.

- [ ] **Step 4: Run both test files and see them pass.** Then run the existing tests that post `promptCompletion` events and read them back: `pnpm vitest run lib/runtime/prompt lib/runtime/promptLabels.test.ts lib/runtime/redactForStatelog.test.ts lib/statelogClient.redaction.test.ts lib/runtime/memory/manager.test.ts > <scratch>/client-tests.txt 2>&1`. A test that reads `messages` from a raw line after a thread's first call now gets a change event. Fix such a test by reading the lines through `parseStatelogJsonl`, which rebuilds since Task 3. Do not change the client to satisfy a test.

- [ ] **Step 5: Typecheck, format the changed files, and commit** ("Log only the messages a call added in promptCompletion").

---

### Task 5: A resume in a process that is still running reuses its writer

**Files:**
- Modify: `lib/statelog/threadMessages/writers.ts`
- Modify: `lib/runtime/state/context.ts` (the constructor near line 420, `createExecutionContext` at line 632)
- Test: `lib/statelog/threadMessages/writers.test.ts`, and the existing test file for `lib/runtime/state/context.ts`

**Interfaces:**
- Consumes: `LogWriterState` and `newLogWriter` (Task 4).
- Produces, in `writers.ts`:

```ts
/** How many runs' writers a base context keeps, so a resume in the same
 *  process continues its run's writer instead of logging every thread whole. */
export const MAX_KEPT_LOG_WRITERS = 20;

/** The writers a base context keeps, by run id. `order` lists the run ids
 *  from least to most recently used. */
export type KeptLogWriters = { order: string[]; byRunId: Record<string, LogWriterState> };

export function newKeptLogWriters(): KeptLogWriters;

/** The writer for a run id: the kept one, or a new one. Marks the run id as
 *  most recently used and drops the least recently used past the limit.
 *  Changes `kept`. */
export function writerForRun(kept: KeptLogWriters, runId: string): LogWriterState;
```

- [ ] **Step 1: Write the failing tests.**

In `writers.test.ts`:

- `"gives one run id the same writer every time"`: two calls with `"run-a"` return the same object (`toBe`).
- `"gives different run ids different writers"`: `"run-a"` and `"run-b"` return writers with different `logWriter` values.
- `"drops the least recently used writer past the limit"`: ask for `MAX_KEPT_LOG_WRITERS` run ids, ask for the first again, then ask for one more. The second run id asked for now gets a new writer (a different `logWriter` from before), and the first still gets its original one.

In the context test file:

- `"two execution contexts for one run id share a log writer"`: call `createExecutionContext` twice on one base context with the same run id, with a file sink configured. Log one call on thread `"th"` through the first context's client, and one more, with one more message, through the second's. The second line has `threadCall: 2`, `keptMessages: 1`, and the first line's `logWriter`.
- `"execution contexts for different run ids do not"`: the same with two run ids. Both lines have `threadCall: 1` and their `logWriter` values differ.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Write the code.**
  - `writers.ts`: the constant, type, and two functions above.
  - `context.ts`: the base context's constructor sets `this.logWriters = newKeptLogWriters()`. `createExecutionContext` passes `writer: writerForRun(this.logWriters, runId)` in the config of the `StatelogClient` it makes at line 632. The execution context itself gets no `logWriters` field, because nothing calls `createExecutionContext` on an execution context. A comment at the field says what it is for in one sentence and points to `docs/dev/hosting/statelog.md`.

- [ ] **Step 4: Run both test files and see them pass.**

- [ ] **Step 5: Typecheck, format the changed files, and commit** ("Continue a run's log writer across a resume in the same process").

---

### Task 6: `handlerDecision` leaves out the interrupt's data

**Files:**
- Modify: `lib/statelogClient.ts` (`handlerDecision` at line 1234)
- Modify: `lib/eval/extract.ts` (`buildInterruptEntry`, line 211)
- Test: `lib/statelogClient.test.ts`, and the existing test file for `lib/eval/extract.ts`

**Interfaces:**
- Produces: a `handlerDecision` event whose `interrupt` is `{ effect, message }`. `interruptResolved` is unchanged. The parameters of `StatelogClient.handlerDecision` do not change, so its four callers in `lib/runtime/interrupts.ts` do not change.

- [ ] **Step 1: Write the failing tests.**

In `lib/statelogClient.test.ts`:

- `"handlerDecision logs the interrupt's effect and message without its data"`: call `handlerDecision` with `interrupt: { effect: "std::edit", message: "Edit a.txt?", data: { before: "x", after: "y" } }`. The line's `interrupt` equals `{ effect: "std::edit", message: "Edit a.txt?" }`.
- `"interruptResolved logs the whole interrupt"`: the same summary passed to `interruptResolved` comes back with `data`.

In the extract test file:

- `"takes an interrupt's data from interruptResolved"`: one interrupt with a `handlerDecision` whose `interrupt` has no `data`, then an `interruptResolved` whose `interrupt` has `data: { filename: "a.txt" }`. The extracted entry's data is `{ filename: "a.txt" }`.
- `"falls back to handlerDecision for an old log"`: one interrupt with only a `handlerDecision` whose `interrupt` has `data`. The extracted entry has that data.

- [ ] **Step 2: Run both files and see the new tests fail.**

- [ ] **Step 3: Write the code.**
  - In `handlerDecision`, post `interrupt: interrupt === undefined ? undefined : { effect: interrupt.effect, message: interrupt.message }`. Update the doc comment on the parameter: the data is on `interruptResolved`, which every interrupt logs.
  - In `buildInterruptEntry`, look for the summary on an `interruptResolved` event first, then on a `handlerDecision`.

- [ ] **Step 4: Run both test files, then `pnpm vitest run lib/logsViewer lib/eval lib/runtime/interrupts > <scratch>/interrupt-tests.txt 2>&1`.** Expected: PASS. If a viewer test fails because it read `data` from a `handlerDecision`, stop and report it: the Background says no viewer code does.

- [ ] **Step 5: Typecheck, format the changed files, and commit** ("Log an interrupt's data once, on interruptResolved").

---

### Task 7: End-to-end tests, and the agency-js tests that read logs

**Files:**
- Create: `tests/agency-js/statelog-message-history/` with `agent.agency`, `test.js`, `agency.json`, `llmMocks.json`, `useTestLLMProvider`, and `fixture.json`, copying the setup of `tests/agency-js/statelog-readers/`.
- Modify: `tests/agency-js/message-labels-resume/test.js` and its `fixture.json`
- Modify: `tests/agency-js/guard-feedback/test.js`

**Interfaces:**
- Consumes: the readers from Task 3, the client from Task 4, and the kept writers from Task 5. `test.js` imports `parseStatelogJsonl` from `../../../dist/lib/statelog/parse.js`, the way other agency-js tests import `safeDeleteDirectoryWithin` from `dist`.

- [ ] **Step 1: Write the test program and test.**

`agent.agency`:

```
node main(): string {
  thread {
    const first: string = llm("one")
    const second: string = llm("two")
    const third: string = llm("three")
  }
  return "done"
}
```

`llmMocks.json`: `[{"return": "r1"}, {"return": "r2"}, {"return": "r3"}]`. `agency.json`: `{ "observability": true, "log": { "logFile": "statelog.log" } }`.

`test.js` deletes `statelog.log`, runs `main()`, reads the file, and writes `__result.json` with:

- `rawShapes`: for each `promptCompletion` line, `"full"` when it has `messages`, else `"change"`. Expected `["full", "change", "change"]`.
- `kept`: each line's `keptMessages ?? null`. Expected `[null, 1, 3]`.
- `sameWriter`: whether all three lines have the same `logWriter`. Expected `true`.
- `rebuiltThird`: the third event's messages after `parseStatelogJsonl`, as `"role: content"` strings. Expected `["user: one", "assistant: r1", "user: two", "assistant: r2", "user: three"]`.

Before writing `fixture.json`, run the program once and confirm the thread carries the replies forward, so the expected values describe how threads work rather than a guess.

- [ ] **Step 2: Build and run it.** `pnpm run build > <scratch>/build.txt 2>&1`, then `pnpm run agency test js tests/agency-js/statelog-message-history > <scratch>/history-test.txt 2>&1`. Expected: PASS once `fixture.json` holds the values above.

- [ ] **Step 3: Pin the resume.** `message-labels-resume` already makes a model call, stops at an interrupt, resumes in the same process, and makes another call on the same thread. Add two values to what its `test.js` writes, and to `fixture.json`:

- `resumeKeepsWriter`: whether the first `promptCompletion` line after the resume has the same `logWriter` as the last one before it. Expected `true`.
- `resumeIsChange`: whether that line has `newMessages` and no `messages`. Expected `true`.

Read the test first and confirm it does what this step says. If its two calls are on different threads, write the resume into `statelog-message-history` as a second node instead, with an `interrupt` between two `llm()` calls in one `thread` block.

- [ ] **Step 4: Fix `guard-feedback`.** Its `test.js` (line 55) reads every `promptCompletion`'s `messages` from the raw file, so calls after the first now lack them. Read the file with `parseStatelogJsonl(readFileSync("statelog.log", "utf-8")).events` instead of splitting and parsing lines. `fixture.json` does not change, because the rebuilt lists are the lists it already expects.

- [ ] **Step 5: Run the other agency-js tests that read logs,** one run each, output saved: `guard-feedback`, `message-labels`, `message-labels-resume`, `message-labels-resume-parallel`, `statelog-readers`, `statelog-small-events`, `prompt-start-pairing`, `span-ids-survive-resume`, `subprocess-statelog-runid`, `decision-statelog`. A test that reads `messages` from a raw line after a thread's first call gets the Step 4 fix, and its fixture stays unchanged. A test that reads `interrupt.data` from a `handlerDecision` line reads it from the `interruptResolved` line instead. If a fixture would otherwise have to change, stop and report it, because that means a reader sees something different from today.

- [ ] **Step 6: Commit** ("Test that promptCompletion logs changes and readers rebuild them").

---

### Task 8: Docs, and the statelog server

**Files:**
- Modify: `docs/dev/hosting/statelog.md`
- In `~/statelog`, on its own branch and PR: `src/common/apiTypes/logEvents.ts`, `src/frontend/pages/Traces/traceTranscript.ts`, `traceOverview.ts`, `traceModel.ts`, `EventContent.tsx`, and their tests.

- [ ] **Step 1: The statelog server PR**, in a worktree of `~/statelog`. Do this first, because it deploys before the agency-lang release.
  - In `LogPromptCompletionSchema`, `messages` becomes optional, and the schema adds optional `newMessages: z.array(z.unknown())`, `keptMessages: z.number()`, `logWriter: z.string()`, and `threadCall: z.number()`.
  - `traceTranscript.ts` (the `addPromptMessages` call at line 308), `traceOverview.ts:66`, and `traceModel.ts:209` read `data.messages ?? data.newMessages ?? []`. The transcript already shows each message the first time it sees its fingerprint, so a change event's messages show at the right place.
  - `EventContent.tsx` labels the field "New messages (after N kept)" when the event is a change.
  - Tests: a `promptCompletion` with only `newMessages` passes the schema, and a transcript built from one full event and one change event lists every message once.
  - Once the server moves to the release that carries this change, its eval summaries rebuild lists through `normalize` with no server code. If a trace page ever has to show one call's whole input, export `rebuildAllMessages` from `agency-lang/eval` and call it, instead of writing the rule a second time in the server.

- [ ] **Step 2: Update `docs/dev/hosting/statelog.md`.** Describe the mechanism and its rules, not how the plan got there.
  - In "Size cap": `newMessages` is unbudgeted like `messages`. Remove the sentences saying that logging only the added messages needs its own spec. Rewrite the paragraph that starts "One event type often takes the slow path for nothing": a change event is small, and only a full copy can still be large.
  - In the LLM part of "Event catalog", add a subsection, "Messages: full copies and changes". It gives the two shapes with this plan's three-call example, `logWriter` and `threadCall`, `FULL_COPY_EVERY_CALLS`, how the writer finds what changed, and that `lib/statelog/threadMessages/read.ts` rebuilds lists in `parse.ts` and in `normalize`, with `missingMessages` at a gap. It includes these three rules, one sentence each:
    - Read a log through `parse.ts`. A raw `promptCompletion` line may hold only the new messages.
    - A parsed line has `event`, rebuilt, for showing, and `stored`, as the file holds it, for sending somewhere.
    - The writer compares whole messages with sorted keys, and the viewer's `messageKey` compares what the model saw. They differ on purpose: a reader copies kept messages from an earlier event, so the writer's rule must be exact.
  - Add a paragraph on interrupts, resume, fork branches, and subprocesses, from "Interrupts, resume, checkpoints, branches, and subprocesses" above. Include the rule that `writer.threads` is changed in place and never reassigned, that a resume in a process that is still running reuses its run's writer through `MAX_KEPT_LOG_WRITERS` kept writers on the base context, that a resume in a new process starts a new writer with a full copy, that the kept writer is only a cache, and that fork branches on one thread log their own branch history when they alternate.
  - In the interrupt part of "Event catalog": `handlerDecision` carries the interrupt's `effect` and `message`, and `interruptResolved` carries its `data`.
  - In "Key behaviors", after the format-version rule: this change kept version 1, because the new fields are additive and the statelog server refuses higher versions.

- [ ] **Step 3: Run `pnpm run lint:structure > <scratch>/lint.txt 2>&1`.** Expected: PASS. No doc was added, so the `CLAUDE.md` index does not change.

- [ ] **Step 4: Commit** ("Document full copies and changes in promptCompletion").

---

## Rollout

- The statelog server PR merges and deploys first. It does not depend on the agency-lang change, and with it in place no trace page ever hides a change event.
- The agency-lang change ships in the next batched release, with no release of its own.
- After the release, run the investigation's analysis script on a fresh long-session log and a fresh eval run. Confirm that the share of `promptCompletion.messages` dropped as the Background table predicts, that a session with resumes has one full copy per thread and not one per resume, and that `handlerDecision.interrupt` is a few hundred bytes per event.
