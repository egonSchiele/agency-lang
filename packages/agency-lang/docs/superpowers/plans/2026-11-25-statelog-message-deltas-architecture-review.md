# Architecture review of "Log only the new messages in `promptCompletion`"

Plan: `docs/superpowers/plans/2026-11-25-statelog-message-deltas.md`

The first review, `2026-11-25-statelog-message-deltas-review.md`, covers correctness. This one covers whether the plan is the right size and shape. The owner has since decided that existing logs stay as they are, so that point from the first review is closed.

## Verdict

The plan is worth building and its core is the right size. Two changes would improve it:

1. Add one small task that stops repeating the interrupt payload in `handlerDecision`. It is a few lines and removes 23% of an eval log.
2. Cut Task 5, the viewer's "messages are missing" line. It can only show for a live-streamed trace read back from the server.

## A correction first: the logged interrupt holds no checkpoint

The interrupt that `handlerDecision` and `interruptResolved` log is a summary with three fields: `effect`, `message`, and `data` (`InterruptSummary`, `lib/statelogClient.ts:114`). It has no checkpoint, and `post()` scrubs checkpoints out of every event anyway. I searched the 27,465 `handlerDecision` events in the eval sample and none mentions a checkpoint.

What makes these events large is file content. Of the 128.7 MB of `handlerDecision.interrupt` in the sample:

| Effect and field | Size |
|---|---|
| `std::edit` `before` | 79.1 MB |
| `std::edit` `after` | 37.1 MB |
| every other effect and field | 12.5 MB |

An edit's interrupt carries the whole file before and after the edit, so the approval prompt can show a diff. Each interrupt logs that 2.9 times on average: 1.9 `handlerDecision` events, and one `interruptResolved`.

So the fix is smaller than "stop logging the interrupt". See "The 80/20 rule" below.

## Major features and API

The plan changes the statelog wire format, which three things outside the runtime depend on:

- **The raw log file.** Today one `promptCompletion` line holds everything the model was sent. After this change it does not. A person using `jq` or `grep` on a log, or a script that reads lines itself, sees only the new messages. This is the one deliberate cost of the plan, and it is the right trade. The dev doc should say it in one sentence: read a log through `parse.ts`, not line by line.
- **The `agency-lang/eval` export.** The statelog server calls `summarizeEvalRun` from it. The plan handles this by rebuilding inside `normalize`, so the server needs no code for eval summaries. Good.
- **The server's ingest schema.** Handled in Task 7.

It does not touch interrupts, handlers, or checkpoints. The per-thread record lives on the client and is never serialized, which the plan states.

`parseStatelogLines` gets a new required parameter. It is not a package export (the exports are `runtime`, `zod`, `compiler`, `config`, `eval`, `optimize`, `serve`, `local`), so only the five callers in the repo change.

## Effort and impact

| Task | Effort | Impact | Keep? |
|---|---|---|---|
| 1. The writer's rule | small | the whole saving depends on it | must |
| 2. Rebuild when reading | medium | every reader depends on it | must |
| 3. Every reader rebuilds | medium, five call sites | must | must |
| 4. The client writes the fields | small | must | must |
| 5. Viewer line for a gap | small | very low | cut |
| 6. End-to-end test | medium | catches a real thread, a real file | must |
| 7. Docs and the server PR | medium | must | must |

**Task 5 is optional.** A gap needs a lost or late upload, and only the live remote path can lose one. A local file never has a gap. So the line shows only when someone runs `agency remote logs` on a live-streamed trace that lost an event. `rebuildMessages` still marks the gap with `missingMessages`, which is the part that prevents a wrong history. Showing it in the viewer can wait until someone meets one.

**The machinery for lost uploads is about a third of the plan:** `threadCall`, the gap rule, the any-order batch rebuild, and the full copy every 50 calls. I would keep all of it except Task 5. Without the call number, a lost event produces a history that looks complete and is wrong, and a log that lies is worse than a big log. The parts are small and they are confined to `read.ts` and `write.ts`.

**Documentation is proportionate.** A wire format change earns the subsection in `statelog.md`. Nothing goes in the user guide, which is right.

**Test cost is fine.** Two unit test files and one new agency-js test with three mocked calls.

## The 80/20 rule

The goal is a smaller log. The plan is the 80: on the eval sample, messages are 56% of the bytes, and nothing cheaper removes them.

There is one more piece with a much better ratio. Every interrupt in the sample has an `interruptResolved` event, and every one of those carries the interrupt summary (14,096 of 14,096). So the copy on `handlerDecision` is never the only copy.

**Add a task: `handlerDecision` logs the interrupt's `effect` and `message`, and leaves out `data`.** `interruptResolved` keeps the whole summary.

- It removes 128.7 MB of the 559 MB sample. With the plan, the sample goes to about 131 MB, which is 23% of today. The plan alone reaches 46%.
- It is a few lines in the client and one doc sentence.
- The readers keep working. Eval extraction takes the summary from the first event that has one (`lib/eval/extract.ts:219`), so it must prefer `interruptResolved`. The viewer's interrupt payload reads `data` from its row's event (`lib/logsViewer/payload.ts:476`), so confirm that row is the `interruptResolved` event. The viewer's story rows read only `effect` and `message` (`lib/logsViewer/story.ts:327`), which stay.

I recommend this over a config option. An option is one more thing to learn and to test in both positions, and nobody loses anything here: the payload is still in the log once.

I also recommend this over the reader-side scheme in my first review (log the payload on the first event, rebuild it on the rest). This one needs no rebuild.

What remains after that is 51 MB of `interruptResolved.interrupt`, nearly all of it the `before` and `after` of `std::edit`. Shrinking that means changing what an edit's interrupt carries, which changes what a handler and the approval prompt see. That is a separate design question and I would leave it out.

## Reusing code

- **`lib/logsViewer/messageDelta.ts` already finds what a round added.** It has `messageKey` and a common-start comparison (`deltaFrom`), and it detects a rewritten history. The plan adds a second comparison in `write.ts` with a different rule for "the same message": the viewer compares role, content, name, and tool calls, and the writer compares the whole JSON text.

  Keep them separate. The writer must be exact, because a reader copies the kept messages from the earlier event, and a looser rule would hand back an earlier version of a message. The viewer compares what the model saw, and it also compares by tool path, which the writer has no notion of. The plan mentions `messageDelta.ts` in the Background. It should add one sentence to the dev doc saying why the two rules differ, or the next person will merge them.

- **The new field types belong with the other event types.** `lib/statelog/wireTypes.ts` holds the wire types. `FullCopyFields` and `ChangeFields` describe wire fields, so put them there and keep `fields.ts` for the constant, or drop `fields.ts`.

- **`LoggedThread` and the values in `RebuildState` look alike** (`{ call, messageKeys }` and `{ call, messages }`). They are different on purpose: the writer keeps strings to compare, the reader keeps messages to copy. No change.

## Reusing and unifying concepts

The plan adds five field names and one constant. Four are needed. `logWriter` is the only new idea, and I looked for an existing id it could reuse:

- The run id is shared by a parent and its subprocess, which is the case the writer id exists for.
- A span id changes on every call.

So a new id is justified. Name it once in the doc as "one `StatelogClient`", since that is all it is.

## Tying concepts together

- **Writer and reader share `fields.ts` (or `wireTypes.ts`).** They should: a change to the format must reach both.
- **The server reads the format with its own code:** `data.messages ?? data.newMessages` in three files. That ties the server to the format loosely, and it is enough, because those three readers only look for the first sighting of a message. The server would need the real rebuild only if a trace page had to show one call's full input. It does not today. If it ever does, export `rebuildAllMessages` from `agency-lang/eval` instead of writing the rule a second time in the server.
- **Parsing and rebuilding are tied together in `parse.ts`.** That is the right default, since every display reader wants full lists. It is also the cause of the upload problem in the first review: the upload wants events as the file holds them, and gets rebuilt ones. Whatever fixes that should be explicit in the API, for example `ParsedEventLine` carrying both the stored event and the rebuilt one, so a caller has to pick.

## Changes I recommend to the plan

1. Add the `handlerDecision` task above.
2. Cut Task 5.
3. Put the field types in `wireTypes.ts`.
4. Add two sentences to the dev doc: read logs through the parser, and why the writer's comparison differs from the viewer's.
5. Make "stored event or rebuilt event" an explicit choice for callers of the parser, which also fixes the upload.
