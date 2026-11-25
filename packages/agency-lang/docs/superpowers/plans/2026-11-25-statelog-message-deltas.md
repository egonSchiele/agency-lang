# Log only the new messages in `promptCompletion`: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each `promptCompletion` event logs the messages added since the previous call on its thread, instead of the whole conversation, and every reader gets the whole conversation back when it parses the log.

**Architecture:** The statelog client remembers, per thread, what it last logged, and writes only the part that changed, with a count of the messages it kept. The parse layer rebuilds the full list as it reads, so the logs viewer, eval, `std::statelog`, and the statelog server's eval summary keep reading `data.messages` as they do today.

**Tech Stack:** TypeScript, vitest, agency-js tests. A follow-up PR in the statelog repo (`~/statelog`) updates its trace pages.

**Spec:** There is no separate spec. The investigation is in the conversation that produced this plan, and the Background part below restates every number from it.

---

## Background: what the log holds today

### One event per model call, with the whole conversation

Every model call writes one `promptCompletion` event. `emitPromptCompletion` in `lib/runtime/promptEvents.ts` builds it, and `StatelogClient.promptCompletion` in `lib/statelogClient.ts` posts it. The event's `messages` field holds every message the call sent to the model: the system prompt, every earlier user message, every earlier reply, and every earlier tool result.

So a conversation's history is logged again on every call. Suppose a thread makes three calls. The first call sends 1 message, the second sends 3, and the third sends 5. The log holds 1 + 3 + 5 = 9 messages, but only 5 different ones. With N calls the log holds about N²/2 messages, so a long session's log grows with the square of its length.

The statelog doc already names this. Its "Size cap" section in `docs/dev/hosting/statelog.md` says: "Logging only the messages a round added would shrink these events properly; that needs its own spec, since every reader of `promptCompletion` changes." This plan is that change.

### Measured on two real logs

| | Perry log (`~/.agency-agent/perry-log.jsonl`) | `packages/agency-lang/log.jsonl` |
|---|---|---|
| File size | 96.7 MB | 37.3 MB |
| Model calls | 413 | 412 |
| Share of the file that is `promptCompletion.messages` | 86% (83 MB) | 68% (25 MB) |
| Messages logged | 18,264 | 5,314 |
| Of those, logged for the first time | 1,077 | 678 |

The biggest single run in the Perry log made 110 calls on a 205-message thread and wrote 51 MB, 92% of it messages.

I replayed the Perry log through the scheme in this plan. The messages go from 83 MB to 3.5 MB, and the file from 96.7 MB to about 17 MB. The full-copy rule described below adds some of that back. The table in "A full copy every 50 calls" gives the numbers.

### Who writes a trace

A trace is every event that shares a `trace_id`. One trace can have several writers, and this decides how a reader can rebuild a list:

- **One run, one client.** An execution context makes one `StatelogClient` per run, with `traceId: runId` (`lib/runtime/state/context.ts:634`).
- **Fork branches share that client.** `forBranch` (`lib/statelogClient.ts:299`) makes a branch's logger with `Object.create(this)`. The logger has its own span stack and tag store, and reads every other field through the prototype from the one client. Two branches can log calls on the same thread.
- **A subprocess writes into the parent's trace and file.** `withParentStatelog` (`lib/runtime/ipc.ts:1553`) passes the parent's log file and sinks to the child, and the child inherits the parent's run id, so it logs under the same `trace_id`. Parent and child append to one file at the same time.
- **A resumed run reuses the trace.** Resuming an interrupt builds a new execution context with the same run id, so it gets a new client under the old `trace_id`. A thread restored from the checkpoint keeps its identity (`threadIdentity`, the serialized `MessageThread.id`).
- **A rewind starts a new trace.** `rewindFrom` runs in a fresh trace.

So "the previous `promptCompletion` for this thread in this trace" is not always the event the writer built on. A subprocess could log between two of the parent's calls, and a resumed run's client has never logged anything.

### How events reach the file and the server

`post()` (`lib/statelogClient.ts:1681`) serializes the event once and hands the text to every sink. The file sink appends the line synchronously (`appendFileSync`). Nothing in `post()` awaits before that append, so lines land in the file in the order `post()` was called.

The remote sink is fire-and-forget: `sendStatelogPost` starts a `fetch` with a 1.5 second timeout and nothing waits for it. So an upload can be lost to a timeout, a network error, or a killed process. Uploads can also arrive out of order. The statelog server stores live uploads ordered by arrival time (`created_at`). Only bulk eval uploads carry a `sequence` column that keeps the file's order (`~/statelog/src/backend/db/log.ts:92`).

### Who reads `messages`

Inside agency-lang, two functions in `lib/statelog/wireAccessors.ts` read the field, and everything else goes through them:

- `messagesOf(event)` returns `data.messages`. The logs viewer uses it in `lib/logsViewer/messageDelta.ts` (which already works out what each round added, and detects a rewritten history), `lib/logsViewer/transcript.ts`, and `lib/logsViewer/roundInputPayload.ts`.
- `userMessageOf(event)` returns the last user message. `lib/logsViewer/spanText.ts:107` applies it to the first completion of each `llmCall` span, `lib/logsViewer/traceSummaries.ts:68` to a trace's first round, and `lib/eval/extract.ts:340` to the first top-level completion.

`spanText.ts` matters here. Each `llm()` call opens its own `llmCall` span, so the first completion in a span is often the second or third call on its thread. It would get a partial list if nothing rebuilt it.

Events reach those readers through `lib/statelog/parse.ts`:

| Entry point | Callers | How it reads |
|---|---|---|
| `parseStatelogLines(lines, firstLineNumber)` | `lib/statelog/tail.ts`, `lib/cli/logsView.ts` (stdin), `lib/logsViewer/run.ts` (follow mode), `lib/runDirectory/traces.ts` (run directories, `std::statelog`) | chunks of lines in file order, from the start of the file |
| `parseStatelogJsonl(text)` | `lib/eval/statelogParser.ts`, test fixtures | a whole file at once |
| `parseStatelogRecords(records)` | `lib/cli/remote/logsBridge.ts` (`agency remote logs`) | a whole trace fetched from the server, in the server's order |

Every `makeLineReader` call starts at offset 0, so no local reader starts in the middle of a file. Two readers parse lines with their own `JSON.parse` (`lib/runsExplorer/mine.ts:61`, `lib/runsExplorer/sources.ts:137`). Neither reads messages, and this plan leaves them alone.

The eval extractor has one more entry. `extractEvalRecord` calls `normalize(events)` (`lib/eval/normalize.ts:41`) on the events it is handed. The statelog server builds such events straight from its database rows and calls `summarizeEvalRun` from `agency-lang/eval` (`~/statelog/src/backend/lib/evals/traceSummary.ts`), which reaches `normalize` without passing through `parse.ts`.

### The statelog server

The server stores any event. On upload it only warns when an event does not match its schema (`~/statelog/src/backend/lib/logIngest.ts`). Its trace pages skip an event that fails the schema, and the schema requires `messages` on a `promptCompletion` (`~/statelog/src/common/apiTypes/logEvents.ts:144`). Its transcript already shows each message only the first time it sees it (`traceTranscript.ts`, `addPromptMessages`), which is the shape this plan writes.

The server refuses an upload whose `format_version` is above the version it supports (`~/statelog/src/backend/routes/api/logs.ts:94`).

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

- `logWriter`: a random 12-character id the client picks when it is made. Two clients writing into one trace have different ids.
- `threadCall`: 1 for the first call this client logged on this thread, then 2, 3, and so on.

A reader rebuilds a change as "the first `keptMessages` messages of call `threadCall - 1` from the same writer on the same thread, then `newMessages`".

Every other field of the event is unchanged.

### How the writer finds what changed

The client keeps a record per thread identity: the last `threadCall` it logged, and one string per message it logged, made with `JSON.stringify` on the message as it is about to be logged. That message is the output of `withMessageLabels`, which is already redacted and labeled.

On each call the client stringifies the new list and counts how many strings at the start match the stored ones. That count is `keptMessages`. Usually the thread has only grown, so the count is the whole stored list. When history was rewritten (by compaction, or by an expiring message being removed, see `docs/dev/runtime/expiring-messages.md`), the count stops at the first changed message, and everything after it goes into `newMessages`. A rewrite needs no separate format.

When the count is 0, the event is a full copy, with `messages`.

Comparing strings is exact. If the same message comes back with its keys in a different order, the strings differ and the message is logged again. That costs a few bytes and never produces a wrong history. When I compared the logged JSON of the Perry log, 50 of the 282 calls after a thread's first looked like rewrites for this reason: the same message's `usage` keys came back in a different order after a checkpoint. Inside one client this should be rare, because the messages are not reread from a checkpoint between calls, and a resume makes a new client.

Stringifying the list on every call costs about what `post()` spends today, since today it serializes the whole list into the event. The stored strings take about as much memory as the thread itself.

### Why the writer id and the call number

**Without `logWriter`**, a reader would rebuild from "the previous event for this thread in this trace". Two cases break that:

- A subprocess shares its parent's trace and file. If both log calls on a thread with the same identity, their events interleave, and each one's change is relative to its own previous event.
- A resumed run's new client starts with no record. Its first event is a full copy anyway, so this case alone would be safe. With a writer id, it does not depend on that.

**Without `threadCall`**, a lost or reordered upload would silently produce a wrong history. Suppose call 5 is lost on the way to the server. Call 6 says "keep 9 messages from the previous event". The reader's previous event is call 4, which also has at least 9 messages, so the reader keeps call 4's first 9, which may differ from call 5's. The result looks complete and is wrong. With `threadCall`, the reader sees that the event it holds is call 4, not call 5, and marks the gap.

### A full copy every 50 calls

A gap on a thread lasts until that thread's next full copy. Today every event is a full copy. With this change, only the first call on a thread is, unless something else forces one. So the client also writes a full copy on calls 51, 101, 151, and so on: whenever `threadCall - 1` is divisible by `FULL_COPY_EVERY_CALLS`.

Measured on the two logs (message bytes only):

| Full copy written | Perry log | `log.jsonl` |
|---|---|---|
| Today (every call) | 82.9 MB | 25.4 MB |
| Only on a thread's first call | 3.5 MB | 3.5 MB |
| Every 10 calls | 11.1 MB | 5.2 MB |
| Every 20 calls | 7.0 MB | 4.0 MB |
| Every 50 calls | 4.6 MB | 3.8 MB |

I recommend 50. It adds about 30% to the message bytes on the long-session log, and gaps only happen on the remote path. A resumed run also starts with a full copy, because its client is new.

### How readers get the full list back

A new module rebuilds the full `messages` list on each change event while the log is read. A rebuilt event looks like a full copy: it has `messages` with the whole list, it keeps `keptMessages`, `logWriter`, and `threadCall`, and it drops `newMessages`. Because readers see the same `data.messages` as today, `messagesOf`, `userMessageOf`, the viewer, eval, and `std::statelog` need no changes.

There are two ways to run it:

- **In file order**, one event at a time (`rebuildMessages`). The caller keeps a `RebuildState` object across chunks. Every local reader reads from the start of the file, and a file holds each writer's events in the order that writer posted them, so this order is right for every file.
- **On a whole batch in any order** (`rebuildAllMessages`). It processes change events in `threadCall` order and puts each rebuilt event back at its original position in the list. `parseStatelogRecords` uses it, because the server's order is arrival order. `normalize` uses it, because the server hands eval its rows directly.

Running a rebuild twice is harmless. A rebuilt event has `messages`, so a second pass treats it as a full copy, and an event marked with a gap stays marked. This matters because a file parsed by `parse.ts` is later normalized by eval and rebuilt a second time.

Old events have no `logWriter` and pass through untouched.

### What a reader does at a gap

A change event cannot be rebuilt when its previous call is missing, or when the previous call has fewer than `keptMessages` messages. Then the reader sets `messages` to `newMessages` and adds `missingMessages: <keptMessages>`, the number of messages at the start that are not in the log. It also forgets that thread's record, so every later change event on the thread is marked the same way until the next full copy. A gap never produces a list that looks complete.

The viewer's round input (`roundInputPayload`) shows one line above the messages: `3 earlier messages are not in the log.`

### Interrupts, resume, checkpoints, branches, and subprocesses

- **The record is not part of any checkpoint.** It lives on the `StatelogClient`, which is never serialized. A resumed run gets a new client, so its first call on each thread is a full copy. Putting the record in a checkpoint would be wrong: the resumed client is a new writer with a new id, and a reader would have no record for it to build on.
- **Interrupts and handlers are untouched.** The change is inside `promptCompletion` and the readers. No control flow changes.
- **Fork branches share one record.** The record is a field on the root client, and each branch's logger reads it through the prototype. Code changes the record object in place and never assigns a new object to the field. An assignment would create a field on that branch's logger, the branches would keep separate records under one `logWriter`, and readers could no longer rebuild their events. A test pins this.
- **Order inside one process.** `promptCompletion` works out the fields and updates the record, then calls `post()`, which appends the line before its first `await`. No other event can be posted between the update and the append. A comment at the update says so, because adding an `await` between them would break it.
- **Subprocesses are separate writers.** Each child process makes its own client with its own `logWriter`.
- **Rewinds start a new trace,** so a reader starts new records for them too.

### Redaction and the size cap

`post()` still scrubs every event and caps every string. A kept message is not scrubbed again on a later call, because it is not in the later event. A reader reuses its text from the earlier event, where it was already scrubbed. If a value is tagged `redact` after a message holding it was logged, the earlier event already contains it unredacted, as it does today. Later events do not repeat it.

`newMessages` joins `messages` in `UNBUDGETED_FIELDS` (`lib/runtime/trimStatelogEvent.ts:20`), for the reason the doc gives for `messages`: a budget keeps the start of a list, and the end of a conversation is the part worth reading.

### Compatibility

- **Old logs** have no `logWriter` and read exactly as before.
- **A reader from an older agency-lang version** reading a new log sees full copies as before. Change events have no `messages` for it, so a round shows "Input messages were not recorded." and its history comparison is off. It does not crash.
- **The statelog server before its update** stores every event, as it stores anything. Its trace pages skip change events, because they fail its schema, so their messages do not show until the server PR in Task 7 deploys. No data is lost.
- **The statelog server's eval summary** gets rebuilt lists once the server moves to the agency-lang release that carries this change, because `summarizeEvalRun` reaches `normalize`.

### `format_version` stays 1

The doc's rule says to bump `STATELOG_FORMAT_VERSION` "when the wire format changes in a way a viewer must notice". An old viewer would notice something here: rounds with no input. A bump would cost more:

- The statelog server refuses uploads with a version it does not support. Until the server deploys, every event from a program on the new runtime would be rejected, including the events this change does not touch.
- An older `agency logs` would refuse every line of a new log, instead of showing everything except the change events' inputs.

The new fields are additive. A full copy is unchanged, and a change event adds fields an old reader ignores. I recommend keeping version 1, and writing in the doc why this change did not bump it.

---

## Decisions for the owner

1. **Full copy every 50 calls** (see the table above). The alternative is "only on a thread's first call", which is smaller, but a remote gap then stays open until the run ends or resumes.
2. **`format_version` stays 1** (see the section above). The alternative is a bump, which requires deploying the server first.
3. **Field names:** `keptMessages`, `newMessages`, `logWriter`, `threadCall`, and `missingMessages` (reader side only). A person reading a raw log line sees these names, so I picked plain ones.

## Out of scope

- The node state on `enterNode` and `exitNode` still logs `messages` (3 MB of the Perry log). That is a separate, smaller change.
- `handlerDecision` and `interruptResolved` still repeat an interrupt's payload.
- Compressing the log file.
- The previous call's reply appears both in that call's `completion` and in the next call's `newMessages`. That is one message per call, not the whole history.

## Global Constraints

- Use objects instead of maps, arrays instead of sets, and types instead of interfaces (repo `CLAUDE.md`).
- No dynamic imports.
- No magic numbers: the full-copy interval is the named constant `FULL_COPY_EVERY_CALLS = 50`.
- Keep the field names exactly: `messages`, `keptMessages`, `newMessages`, `logWriter`, `threadCall`, `missingMessages`.
- `STATELOG_FORMAT_VERSION` stays `1`.
- Save every test, typecheck, and build output to a file in your scratch folder, written `<scratch>` below, and read the file. Do not rerun a command to see its output.
- Run `pnpm run typecheck` after every task that edits TypeScript.
- Format changed TypeScript files by name (`pnpm exec prettier --write <files>`). Never run `pnpm run fmt:ts` from the main checkout.
- Do not run the full agency test suite locally. Run only the tests each task names.
- Write commit messages in a file and commit with `git commit -F <file>`.

## Review Focus

1. **Two fork branches logging calls on one thread.** The second branch's event must say `threadCall: 2` and build on the first branch's event. A branch logger that got its own record would write `threadCall: 1` twice under one `logWriter`. Pinned in Task 4.
2. **A history rewrite (compaction) in the middle of a session.** The rebuilt list after the rewrite must equal the list the model was sent, not the old history with the new messages appended. Pinned in Tasks 1 and 2.
3. **A lost or reordered remote upload.** A lost call must give `missingMessages` on every following change event until the next full copy, never a list that looks complete. A reordered batch must rebuild correctly. Pinned in Task 2.
4. **A subprocess logging into its parent's file and trace.** Its events must rebuild against its own writer. Pinned in Task 2 with two interleaved writers. The existing `subprocess-statelog-runid` agency-js test covers the real process boundary in Task 6.
5. **A log read twice:** parsed by `parse.ts`, then normalized by eval. The second rebuild must not change anything, including an event marked with a gap. Pinned in Task 2.

---

## File structure

New directory `lib/statelog/threadMessages/`, one concept per file:

- `fields.ts`: the event field types and `FULL_COPY_EVERY_CALLS`. Writer and reader both import it.
- `write.ts`: `messageFieldsFor`, which works out one event's fields from the writer's record for the thread.
- `read.ts`: `rebuildMessages` and `rebuildAllMessages`.
- `write.test.ts`, `read.test.ts`.

Changed:

- `lib/statelog/parse.ts`: `parseStatelogLines` takes a `RebuildState`, and the batch parsers rebuild.
- `lib/statelog/tail.ts`, `lib/cli/logsView.ts`, `lib/logsViewer/run.ts`, `lib/runDirectory/traces.ts`: keep one `RebuildState` per reader.
- `lib/eval/normalize.ts`: rebuild before normalizing.
- `lib/statelogClient.ts`: the writer id, the per-thread record, and `promptCompletion` using `messageFieldsFor`.
- `lib/runtime/trimStatelogEvent.ts`: `newMessages` exempt from the field budget.
- `lib/logsViewer/roundInputPayload.ts`: the gap line.
- `tests/agency-js/guard-feedback/test.js`: read the log through the parser.
- New agency-js test `tests/agency-js/statelog-message-history/`.
- `docs/dev/hosting/statelog.md`.

In `~/statelog`, in a separate PR: `src/common/apiTypes/logEvents.ts` and the trace page readers.

The readers change (Task 3) before the writer (Task 4). Readers that rebuild do nothing to old logs, so the repo works after every task.

---

### Task 1: The fields and the writer's rule

**Files:**
- Create: `lib/statelog/threadMessages/fields.ts`
- Create: `lib/statelog/threadMessages/write.ts`
- Test: `lib/statelog/threadMessages/write.test.ts`

**Interfaces:**
- Produces, in `fields.ts`:

```ts
/** A thread's full message list is logged again on its first call and
 *  then every this many calls, so a lost remote upload leaves a gap that
 *  ends at the next full copy. */
export const FULL_COPY_EVERY_CALLS = 50;

/** A whole message list, logged as it is today. */
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
/** What one writer last logged for one thread. */
export type LoggedThread = { call: number; messageKeys: string[] };

export function messageFieldsFor(args: {
  previous: LoggedThread | undefined;
  logWriter: string;
  messages: unknown[];
}): { fields: FullCopyFields | ChangeFields; logged: LoggedThread };
```

It is a pure function, and the caller stores `logged`. `messageKeys[i]` is `JSON.stringify(messages[i])`. `call` is `(previous?.call ?? 0) + 1`. The event is a full copy when there is no `previous`, when `(call - 1) % FULL_COPY_EVERY_CALLS === 0`, or when the kept count is 0. Otherwise it is a change, and `keptMessages` is the length of the common start of `previous.messageKeys` and the new keys. A thread with no identity is handled by the client in Task 4, not here.

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
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm vitest run lib/statelog/threadMessages/write.test.ts > <scratch>/write-test.txt 2>&1`, then read the file.
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Write `fields.ts` and `write.ts`** with the types and signature above.

- [ ] **Step 4: Run the tests and see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Typecheck, format, and commit**

```bash
pnpm run typecheck > <scratch>/typecheck.txt 2>&1
pnpm exec prettier --write lib/statelog/threadMessages/*.ts
git add lib/statelog/threadMessages
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

### Task 3: Every reader rebuilds

**Files:**
- Modify: `lib/statelog/parse.ts`
- Modify: `lib/statelog/tail.ts`, `lib/cli/logsView.ts:388`, `lib/logsViewer/run.ts:1000-1095`, `lib/runDirectory/traces.ts:96`
- Modify: `lib/eval/normalize.ts:41`
- Test: `lib/statelog/parse.test.ts` (create it if it does not exist), and the existing test file for `lib/eval/extract.ts`

**Interfaces:**
- Consumes: `RebuildState`, `rebuildMessages`, `rebuildAllMessages` (Task 2).
- Produces: `parseStatelogLines(lines: readonly string[], firstLineNumber: number, rebuild: RebuildState): ParseWithLinesResult`. The new parameter is required, so the type checker finds every caller. `ParsedEventLine.raw` stays the exact line from the file, and `ParsedEventLine.event` is the rebuilt event.

- [ ] **Step 1: Write the failing tests:**
  - In `parse.test.ts`, `"parseStatelogJsonl returns full lists for change events"`: build three lines with `messageFieldsFor` (as in Task 2's helper) and join them with `\n`. `parseStatelogJsonl(text).events[2].data.messages` is the whole third list. The same lines split into two chunks and passed to `parseStatelogLines` with one shared `RebuildState` give the same events.
  - In `parse.test.ts`, `"parseStatelogRecords rebuilds records that arrive out of order"`: the three records reversed. Every event has its whole list.
  - In the extract test file, `"extractEvalRecord rebuilds events it is handed directly"`: hand `extractEvalRecord` written events where the thread's first call is a full copy holding a system message only, and the second call is a change that adds the user message. The extracted user message is that message. This is the path the statelog server's `summarizeEvalRun` takes.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Change the parsers and callers:**
  - `parseStatelogLines` maps each parsed event through `rebuildMessages(rebuild, event)`.
  - `parseStatelogJsonlWithLines` passes a new `{}`.
  - `parseStatelogRecords` runs `rebuildAllMessages` over the checked events.
  - `parseStatelogLine` stays as it is. Its doc comment says it does not rebuild, and that a caller reading more than one line uses `parseStatelogLines`.
  - `makeStatelogTailer`, `parseStatelogStream`, and `makeTraceCollector` each make one `RebuildState` and pass it on every call.
  - In `lib/logsViewer/run.ts`, the follow reader keeps one `RebuildState` next to `reader`, and passes it from `readAppended` and `withParsedLines`. Where a truncated file resets `reader`, `log`, and `lineCount` (line 1038), it also replaces the state with `{}`.
  - `normalize(events)` starts with `const rebuilt = rebuildAllMessages(events)` and works on `rebuilt`.

- [ ] **Step 4: Run the new tests and the readers' existing tests:** `pnpm vitest run lib/statelog lib/logsViewer lib/eval lib/runDirectory lib/logsQuery lib/cli/logsView > <scratch>/reader-tests.txt 2>&1`. Expected: PASS. Their fixtures are old-format logs, which pass through untouched.

- [ ] **Step 5: Typecheck, format the changed files, and commit** ("Rebuild full message lists in every statelog reader").

---

### Task 4: The client writes the new fields

**Files:**
- Modify: `lib/statelogClient.ts` (fields near line 180, `promptCompletion` at line 638, `post` at line 1681)
- Modify: `lib/runtime/trimStatelogEvent.ts:20`
- Test: `lib/statelogClient.test.ts`, `lib/runtime/trimStatelogEvent.test.ts`

**Interfaces:**
- Consumes: `messageFieldsFor` and `LoggedThread` (Task 1).
- Produces: `promptCompletion` events in the new shape. Its parameters do not change, so `emitPromptCompletion` does not change.

- [ ] **Step 1: Write the failing tests** in `lib/statelogClient.test.ts`, with the file-sink setup the existing tests there use to read back what was written:

- `"logs the first call on a thread whole and later calls as changes"`: two `promptCompletion` calls on thread identity `"th"`, the second with one more message. The first line has `messages`, `threadCall: 1`, and a 12-character `logWriter`. The second has `keptMessages: 1`, one `newMessages` entry, `threadCall: 2`, no `messages`, and the same `logWriter`.
- `"two branch loggers share one record per thread"`: make two loggers with `client.forBranch(globals, [])` and log one call on thread `"th"` through each, the second with one more message. The second line has `threadCall: 2` and `keptMessages: 1`, and both lines have the same `logWriter`.
- `"a thread with no identity is always logged whole"`: two calls with `threadIdentity: null`. Both lines have `messages`, and neither has `logWriter` or `threadCall`.
- `"two clients get different writer ids"`: one call through each of two clients writing to the same file. The `logWriter` values differ.

In `lib/runtime/trimStatelogEvent.test.ts`:

- `"does not budget promptCompletion.newMessages"`: an event whose `newMessages` serializes to more than the cap, made of many short strings, comes back with every entry.

- [ ] **Step 2: Run both files and see the new tests fail.**

- [ ] **Step 3: Change the client:**
  - Add `private readonly logWriter: string = nanoid(12);` and `private readonly loggedThreads: Record<string, LoggedThread> = {};`. A comment on `loggedThreads` says that branch loggers made by `forBranch` read this object through the prototype, so code changes it in place and never assigns a new object to the field.
  - Move the two early-return checks at the top of `post()` (the client is disabled; there is no host and no file) into `private willPost(): boolean`, and use it in `post()`.
  - In `promptCompletion`, return at once when `!this.willPost()`. When `threadIdentity` is a string, call `messageFieldsFor({ previous: this.loggedThreads[threadIdentity], logWriter: this.logWriter, messages })`, store the result with `this.loggedThreads[threadIdentity] = logged`, and spread `fields` into the posted body in place of `messages`. When it is not a string, post `messages` as today. A comment at the store says the record is updated and the line appended with no `await` between them, so lines land in the order of their `threadCall`.
  - In `trimStatelogEvent.ts`, `UNBUDGETED_FIELDS.promptCompletion` becomes `["messages", "newMessages"]`.

- [ ] **Step 4: Run both test files and see them pass.** Then run the existing tests that post `promptCompletion` events and read them back: `pnpm vitest run lib/runtime/prompt lib/runtime/promptLabels.test.ts lib/runtime/redactForStatelog.test.ts lib/statelogClient.redaction.test.ts lib/runtime/memory/manager.test.ts > <scratch>/client-tests.txt 2>&1`. A test that reads `messages` from a raw line after a thread's first call now gets a change event. Fix such a test by reading the lines through `parseStatelogJsonl`, which rebuilds since Task 3. Do not change the client to satisfy a test.

- [ ] **Step 5: Typecheck, format the changed files, and commit** ("Log only the messages a call added in promptCompletion").

---

### Task 5: The viewer says when messages are missing

**Files:**
- Modify: `lib/logsViewer/roundInputPayload.ts` (`roundInputPayload`, line 69)
- Test: `lib/logsViewer/roundInputPayload.test.ts`

**Interfaces:**
- Consumes: `missingMessages`, set by `rebuildMessages` (Task 2).

- [ ] **Step 1: Write the failing test** `"says how many earlier messages are not in the log"`: a round whose event has `messages: [user("two")]` and `missingMessages: 3`. The payload's first line is `{ kind: "meta", text: "3 earlier messages are not in the log." }`, followed by the lines for the one message. With `missingMessages: 1`, the text is `1 earlier message is not in the log.`

- [ ] **Step 2: Run it and see it fail.**

- [ ] **Step 3: Add the line.** When `event.data.missingMessages` is a positive number, `roundInputPayload` puts the meta line first and adds one to `newAt`.

- [ ] **Step 4: Run `lib/logsViewer/roundInputPayload.test.ts` and see it pass.**

- [ ] **Step 5: Typecheck, format, and commit** ("Show missing messages in the logs viewer's round input").

---

### Task 6: An end-to-end test, and the agency-js tests that read logs

**Files:**
- Create: `tests/agency-js/statelog-message-history/` with `agent.agency`, `test.js`, `agency.json`, `llmMocks.json`, `useTestLLMProvider`, and `fixture.json`, copying the setup of `tests/agency-js/statelog-readers/`.
- Modify: `tests/agency-js/guard-feedback/test.js`

**Interfaces:**
- Consumes: the readers from Task 3 and the client from Task 4. `test.js` imports `parseStatelogJsonl` from `../../../dist/lib/statelog/parse.js`, the way other agency-js tests import `safeDeleteDirectoryWithin` from `dist`.

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

- [ ] **Step 3: Fix `guard-feedback`.** Its `test.js` (line 55) reads every `promptCompletion`'s `messages` from the raw file, so calls after the first now lack them. Read the file with `parseStatelogJsonl(readFileSync("statelog.log", "utf-8")).events` instead of splitting and parsing lines. `fixture.json` does not change, because the rebuilt lists are the lists it already expects.

- [ ] **Step 4: Run the other agency-js tests that read logs,** one run each, output saved: `guard-feedback`, `message-labels`, `message-labels-resume`, `message-labels-resume-parallel`, `statelog-readers`, `statelog-small-events`, `prompt-start-pairing`, `span-ids-survive-resume`, `subprocess-statelog-runid`, `decision-statelog`. A test that reads `messages` from a raw line after a thread's first call gets the Step 3 fix, and its fixture stays unchanged. If a fixture would have to change, stop and report it, because that means a reader sees something different from today.

- [ ] **Step 5: Commit** ("Test that promptCompletion logs changes and readers rebuild them").

---

### Task 7: Docs, and the statelog server

**Files:**
- Modify: `docs/dev/hosting/statelog.md`
- In `~/statelog`, on its own branch and PR: `src/common/apiTypes/logEvents.ts`, `src/frontend/pages/Traces/traceTranscript.ts`, `traceOverview.ts`, `traceModel.ts`, `EventContent.tsx`, and their tests.

- [ ] **Step 1: Update `docs/dev/hosting/statelog.md`:**
  - In "Size cap": `newMessages` is unbudgeted like `messages`. Remove the sentences saying that logging only the added messages needs its own spec. Rewrite the paragraph that starts "One event type often takes the slow path for nothing": a change event is small, and only a full copy can still be large.
  - In the LLM part of "Event catalog", add a subsection, "Messages: full copies and changes". It gives the two shapes with this plan's three-call example, `logWriter` and `threadCall`, `FULL_COPY_EVERY_CALLS`, how the writer finds what changed, and that `lib/statelog/threadMessages/read.ts` rebuilds lists in `parse.ts` and in `normalize`, with `missingMessages` at a gap.
  - Add a paragraph on interrupts, resume, fork branches, and subprocesses, from "Interrupts, resume, checkpoints, branches, and subprocesses" above. Include the rule that `loggedThreads` is changed in place and never reassigned.
  - In "Key behaviors", after the format-version rule: this change kept version 1, because the new fields are additive and the statelog server refuses higher versions.

- [ ] **Step 2: Run `pnpm run lint:structure > <scratch>/lint.txt 2>&1`.** Expected: PASS. No doc was added, so the `CLAUDE.md` index does not change.

- [ ] **Step 3: Commit** ("Document full copies and changes in promptCompletion").

- [ ] **Step 4: The statelog server PR**, in a worktree of `~/statelog`:
  - In `LogPromptCompletionSchema`, `messages` becomes optional, and the schema adds optional `newMessages: z.array(z.unknown())`, `keptMessages: z.number()`, `logWriter: z.string()`, and `threadCall: z.number()`.
  - `traceTranscript.ts` (the `addPromptMessages` call at line 308), `traceOverview.ts:66`, and `traceModel.ts:209` read `data.messages ?? data.newMessages ?? []`. The transcript already shows each message the first time it sees it, so a change event's messages show at the right place.
  - `EventContent.tsx` labels the field "New messages (after N kept)" when the event is a change.
  - Tests: a `promptCompletion` with only `newMessages` passes the schema, and a transcript built from one full event and one change event lists every message once.
  - This PR does not depend on the agency-lang release and can merge first. Once the server moves to the release that carries this change, its eval summaries rebuild lists through `normalize` with no server code.

---

## Rollout

- The agency-lang change ships in the next batched release, with no release of its own.
- The order of the two PRs does not matter for data. If agency-lang ships first, the server stores every change event, and its pages hide them until the server PR deploys.
- After the release, run the investigation's analysis script on a fresh long-session log to confirm that the share of `promptCompletion.messages` dropped as the Background table predicts.
