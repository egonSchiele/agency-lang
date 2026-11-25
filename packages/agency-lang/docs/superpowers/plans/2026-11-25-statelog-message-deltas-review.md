# Review of "Log only the new messages in `promptCompletion`"

Plan: `docs/superpowers/plans/2026-11-25-statelog-message-deltas.md`

## Summary

The core design is sound. Logging the changed part of a thread, with a writer id and a call number, and rebuilding the full list in the parse layer, is the right shape. I checked every reader of `messages` and the plan's list is complete.

Three things need to change before this plan meets its two goals:

1. `agency eval upload` would send the rebuilt, full-size events to the server, so the server stores as much as today.
2. A resumed run starts with a full copy of every thread. On the Perry log that leaves 25.8 MB of messages, not the 3.5 MB the plan predicts.
3. The plan does nothing for logs that already exist, and the 10 GB import is made of those.

A fourth point is about scope. On eval logs, the interrupt payload repeated in `handlerDecision` and `interruptResolved` is a third of the file, and the plan leaves it out.

All numbers below come from scripts I ran on the same two logs the plan uses, and on a random sample of 250 of the 7,940 `statelog*.jsonl` files under `~/agency-evals` and `~/bench-agency` (20.6 GB in total, 559 MB in the sample).

---

## Question 1: does anything rely on the full list in every event?

Nothing breaks that the plan does not already handle. I searched agency-lang (`lib`, `stdlib`, the other packages), the statelog server, Perry, and `~/agency-evals`.

Readers of `promptCompletion.messages`, all found:

| Reader | Where | Covered by |
|---|---|---|
| `messagesOf`, `userMessageOf` | `lib/statelog/wireAccessors.ts:234`, `:280` | the rebuild in `parse.ts` (Task 3) |
| The viewer's round input | `lib/logsViewer/roundInputPayload.ts:77` | the rebuild in `parse.ts` |
| Eval extraction | `lib/eval/extract.ts`, through `userMessageOf` | the rebuild in `normalize` |
| Server trace pages | `traceModel.ts:209`, `traceOverview.ts:66`, `traceTranscript.ts:308`, `EventContent.tsx:63` | the server PR (Task 7) |
| The size cap | `lib/runtime/trimStatelogEvent.ts:20` | Task 4 |

Readers of `promptCompletion` that do not touch `messages`, so need nothing: `costTail.ts`, `modelUsage.ts`, `runsExplorer/mine.ts`, `runDirectory/traceText.ts` (it reads `completion`), and the Harbor importer (it copies statelog files and does not build events). The statelog server's backend never reads `messages`. Perry has only a test stub that names the event type.

Two things do stop working for a while, and the plan names both:

- An older `agency logs` shows "Input messages were not recorded." on change events.
- The server's trace pages skip change events until the server PR deploys. The server PR is independent, so merge and deploy it first. Then there is no window where a trace page hides rounds.

The server pages work with `data.messages ?? data.newMessages` as the plan says. I checked the three uses. Two look for the first user message, which is always in a thread's first full copy or in the change that added it. The transcript shows a message only the first time it sees its fingerprint (`addPromptMessages`), so it does not depend on position in the list.

---

## Problems to fix in the plan

### 1. Eval upload sends the rebuilt events (blocks goal B)

`agency eval upload` posts `trace.events` (`lib/cli/eval/upload.ts:173`, then `sequencedFrom` at line 292). Those events come from `readTraces`, which calls `parseStatelogLines` (`lib/runDirectory/traces.ts:105`). After Task 3, `parseStatelogLines` returns rebuilt events. So the upload would send every `promptCompletion` with its whole list, and the server would store the same bytes as today.

The file on disk gets smaller and the server does not. Goal B is the server.

Fix: the upload must send the events as the file holds them. `Trace.lines` already keeps each raw line (`traces.ts:158`), so the upload can parse those lines without rebuilding. Add a test that uploads a run whose log has a change event and checks that the posted event has `newMessages` and no `messages`.

The same question applies to any other code that re-sends parsed events. I found only the upload. `agency remote logs` reads from the server and does not write back.

### 2. A resumed run logs every thread whole again (weakens goal A)

Every `createExecutionContext` makes a new `StatelogClient` (`lib/runtime/state/context.ts:632`), and both resume paths call it (`lib/runtime/interrupts.ts:872` and `:1023`). The plan says so: "A resumed run also starts with a full copy, because its client is new." It does not measure what that costs.

The plan's replay grouped events by trace and thread. Old logs have no writer id, so the replay could not see where a new client started. I replayed again and started a new writer at each `agentStart` in a trace, which is where a run or a resume begins:

| Log | Messages today | Plan's estimate | With a new writer per run or resume |
|---|---|---|---|
| Perry log | 84.3 MB | 3.6 MB | 25.8 MB |
| `log.jsonl` | 25.8 MB | 3.5 MB | 3.7 MB |
| Eval sample (250 files) | 313.3 MB | 14.0 MB | 16.5 MB |

The Perry log has 41 traces and 175 `agentStart` events, because each approval a person answers is a resume. Of its 413 calls, 208 would be full copies. So the Perry file would go from 96.7 MB to about 38 MB, not 17 MB. Sessions like that one are the ones the logs viewer struggles with.

Evals are barely affected, because a policy answers their interrupts and they seldom resume.

Fix: when a resume happens in the same process, the new client takes over the old client's writer id and per-thread record. The base context that `createExecutionContext` is called on outlives each run, so it can hold the record by run id. A resume in another process (`agency resume`, a served agent's `/resume`) still starts with a full copy, which is correct there because the old record is gone.

This is safe for the same reason fork branches are safe. The writer never assumes the thread grew. It compares the new list with what it last logged and keeps only the common start. So it does not matter that a restored thread may differ from the last logged one.

Two details follow from this fix:

- **Compare messages without regard to key order.** The plan notes that a message restored from a checkpoint can come back with its `usage` keys in a different order, and that 50 of 282 calls in the Perry log looked like rewrites for that reason. Today the plan can ignore that, because a resume makes a new client. Once the record survives a resume, the comparison must sort keys, or every resume re-logs most of the thread.
- **Decide when a record is dropped.** A run that ends should drop its record. A run that stops at an interrupt nobody answers would keep its record for as long as the process lives. The plan should say what bounds that in a long-lived server.

If you would rather not carry the record across a resume, the plan should at least replace its size estimate with the measured one, so the trade is visible.

### 3. Existing logs stay as they are

The plan changes what new runs write. The eval runs you already imported, and the 20.6 GB on disk, are in the old format, and nothing in the plan shrinks them.

`messageFieldsFor` is a pure function, so the upload can apply it to old-format events before it posts them. It walks each trace in file order, keeps one record per thread identity, and writes change events with one fixed writer id for the whole conversion. The reader already rebuilds them. On the 250-file sample this takes the uploaded messages from 313 MB to about 14 MB.

This belongs with fix 1, because both are "what the upload sends". A resumed upload sends events from a sequence number onward (`upload.ts:233`), so the conversion must give the same result every time it runs on the same file. It does, as long as it always starts from the first line of the file and the writer id is fixed.

I recommend adding this to the plan. Without it, goal B waits until every stored run has been re-run on the new release.

### 4. Fork branches on one thread log more than the plan suggests

A fork clones threads through JSON, and `fromJSON` keeps the thread's id (`lib/runtime/state/messageThread.ts:358`). So the branches of a fork each hold a thread with the same identity, and the threads grow apart.

The plan shares one record per identity across branches. That is correct: every event rebuilds to the right list. It is not small, though. Suppose branch A has added 20 messages and branch B has added 20 different ones. Each time B logs after A, the common start ends where they forked, so B logs all 20 of its own messages again. Two branches taking turns log their whole branch history on every call, which is the growth the plan set out to remove, limited to the part after the fork.

The plan's Review Focus 1 pins that the second branch says `threadCall: 2`. It should also say what the event holds in this case, so the reviewer of the PR is not surprised.

I do not think this needs a fix now. My replay keyed records by thread, as the plan does, and landed within 2 MB of the smallest possible result on all three data sets, so forks on a shared thread are rare in these logs. Name the limit in the dev doc.

---

## Question 2: other ways to log less

### The interrupt payload is the next third of the file

After this change, here is what the eval sample holds (559 MB today, about 260 MB after):

| Field | Size |
|---|---|
| `handlerDecision.interrupt` | 128.7 MB |
| `interruptResolved.interrupt` | 51.1 MB |
| `promptCompletion.completion` | 15.4 MB |
| `exitNode.data` | 14.3 MB |
| `promptCompletion` messages, after this plan | about 16 MB |
| `toolCall.output` | 6.8 MB |

Every handler in the chain logs one `handlerDecision`, and each one carries the interrupt's effect, message, and data (`lib/statelogClient.ts:1234`). A file write nested under several handlers logs the file's content once per handler, then once more in `interruptResolved`. The Perry log has 4,327 `handlerDecision` events for 175 interrupts that reached a person.

So this plan alone shrinks the eval sample to about 46% of its size. With the interrupt payload logged once per interrupt, it would shrink to about 15%. For the 10 GB import that is the difference between about 4.6 GB and about 1.5 GB.

The plan lists this under "Out of scope". I would move it to "next", as its own plan and PR, and build it on the reader module this plan adds. The same idea applies: the first event for an `interruptId` from a writer carries `interrupt`, later ones leave it out, and the rebuild copies it from the first. The readers are `lib/logsViewer/story.ts:327`, `lib/logsViewer/payload.ts:476`, and `lib/eval/extract.ts:224`, and they would not change.

The comment on `handlerDecision` explains why the payload is on every event: `interruptThrown` does not fire for an interrupt a handler answers at once. "First event for this id" covers that case without relying on `interruptThrown`.

### Smaller items, in order of size

- **`exitNode.data` (14.3 MB in the sample, 3.2 MB in Perry).** The plan already names it. It is the node state, with its messages. Worth doing after the interrupt payload.
- **The reply is logged twice.** It is in a call's `completion` and again in the next call's `newMessages`. Tool output is likewise in `toolCall.output` and in the next `newMessages`. Together that is about 22 MB of the sample. The plan lists the first as out of scope and I agree. Removing either copy means a reader has to stitch events together to show one call, and the saving is small next to the two items above.
- **Compression.** The server could compress stored events, and the upload could compress its requests. That helps everything at once, including old logs, and it changes no format. It is a server-side change and does not replace this plan, because the viewer still has to parse whatever the file holds.

### Alternatives I considered and would not pick

- **Give each message a content hash, log each message body once per trace, and list hashes in each event.** This handles forks and subthreads better, and it needs no call number, because a lookup does not depend on order. I measured what it would save over the plan's scheme: 3.6 MB against 3.6 MB on Perry, 3.4 against 3.5 on `log.jsonl`. It costs a hash per message per call and about 40 bytes per message per event. It is not worth the extra format.
- **Dropping the periodic full copy.** The table in the plan shows it costs 30% on a long session. Local files never have gaps, so this only protects live uploads. I would keep it at 50, as the plan recommends.

---

## Smaller points

- **The redaction sentence is inaccurate.** The plan says the message the writer stringifies "is already redacted and labeled". Redaction happens later, inside `post()` (`lib/statelogClient.ts:1703`). The writer's stored strings are unredacted. That is harmless, because they stay in memory and are only compared, but the doc paragraph in Task 7 should not repeat the claim.
- **Images in the stored strings.** For the same reason, a message with a picture is stringified and stored with its base64 data, before `post()` scrubs it. A thread with screenshots would hold a second copy of each one in the record. If that matters, store a hash of each string. I would wait until it shows up in a profile.
- **Task 3, step 4 runs `lib/cli/logsView`** as a path, and the tests there may be named differently. Check the path matches test files before relying on the run.
- **Rollout.** Change "The order of the two PRs does not matter for data" to "deploy the server PR first", for the reason under Question 1.

---

## What I would change in the plan

1. Upload sends the events as the file holds them, with a test (problem 1).
2. Upload converts old-format logs to change events (problem 3).
3. A resume in the same process continues the old writer, with key-order-independent comparison and a rule for dropping records (problem 2). Or, if not, correct the size estimate.
4. Name the fork-branch cost in Review Focus and the dev doc (problem 4).
5. Move the interrupt payload from "out of scope" to "the next plan", with the measured sizes.
6. Fix the redaction sentence and the rollout order.

The design decisions the plan asks about are fine as recommended: full copy every 50 calls, `format_version` stays 1, and the field names read clearly in a raw line.
