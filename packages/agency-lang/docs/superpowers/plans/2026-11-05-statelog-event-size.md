# Statelog: smaller events — Implementation Plan

**Goal:** A statelog event no longer carries checkpoints, a finished run's
return value is logged once, and no string or event field is larger than a
cap.

**Spec:** `docs/superpowers/specs/2026-11-05-statelog-event-size.md`.

**Shape:** one PR, three commits, one per change. Each commit stands on its
own, so any of them can be reverted alone.

**Tech stack:** scrub rules in `lib/runtime/redactForStatelog.ts`, the
client in `lib/statelogClient.ts`, the graph runner in
`lib/simplemachine/graph.ts`, config in `lib/config/config.ts` and
`lib/backends/typescriptBuilder.ts`, eval in `lib/eval/extract.ts`.

## Background

- Every event is serialized in one place: `StatelogClient.post`
  (`lib/statelogClient.ts:1663`) calls `stringifyStatelogEvent` with
  `statelogScrubRules(globals)`. The same text goes to the file sink and
  the remote host.
- A scrub rule is `(raw, parent) => string | undefined`.
  `makeScrubReplacer` runs the rules in order and returns the **first**
  replacement, so a later rule never sees a value an earlier rule replaced.
  Rules see `raw`, the value before `toJSON`.
- `safeStatelogValue` (`lib/runtime/runner.ts:78`) also runs
  `statelogScrubRules`, on fork branch values. The checkpoint rule joins
  that list and is correct there. The string cap does not join it:
  `safeStatelogValue` has its own cap, `FORK_VALUE_CHAR_CAP`.
- The graph runner logs `exitNode` for every node
  (`lib/simplemachine/graph.ts:139`). A run ends at a node with no edge, or
  at a node with a conditional edge and no condition function that returns
  normally (the `else` branch at line 205). Agency gives every node that
  can go to another node such an edge
  (`lib/backends/typescriptBuilder.ts:4917`).
- `agentEnd` is logged with `result` only when the run finishes
  (`lib/runtime/node.ts:532`, `lib/runtime/interrupts.ts:832`). A paused
  run writes no `agentEnd`, so `exitNode` is the only record of its
  interrupts.
- An interrupt is `{ type: "interrupt", checkpointId?, checkpoint?, … }`
  (`lib/runtime/interrupts.ts:91`). A failure result is
  `{ __type: "resultType", success: false, checkpoint, … }`
  (`lib/runtime/result.ts:113`).
- A program's `log` config does not go through `getStatelogClient`
  (`lib/statelogClient.ts:1749`), which has no callers. It is written into
  the compiled program by `TypeScriptBuilder.generateImports`
  (`lib/backends/typescriptBuilder.ts:4684`) and passed to
  `new StatelogClient` by `RuntimeContext`
  (`lib/runtime/state/context.ts:380` and `:572`).
- Eval reads `agentEnd.result` in `returnValueOutputs`
  (`lib/eval/extract.ts:371`) and the explicit values in `collectExplicit`
  (`:334`). `capValue` caps both and sets `truncated: true`.
- The only reader that names `exitNode` is
  `lib/logsViewer/timeline/turns.ts`, which uses it to find the run's end.

## Task 1: leave checkpoints out of the log

**Files:** `lib/runtime/redactForStatelog.ts`, `docs/dev/hosting/statelog.md`.

1. Add `omitCheckpointRule: ScrubRule`. It fires when `raw` is an object,
   `raw === parent.checkpoint`, and `parent` is either:
   - an interrupt (`type === "interrupt"`), or
   - a failure result (`__type === "resultType"` and `success === false`).
2. It returns `[checkpoint <id>]`. The id is the interrupt's
   `checkpointId`, or the checkpoint's own `id` for a failure. With neither
   it returns `[checkpoint]`.
3. Add it to `statelogScrubRules` after `omitBinaryRule`, in both branches
   of the function, and name it in the doc comment.
4. Add the rule to the "Redaction" section of
   `docs/dev/hosting/statelog.md`.

The interrupt and the failure are not touched, so the caller still
receives the checkpoint.

**Tests** (`lib/runtime/redactForStatelog.test.ts`):

- An interrupt's `checkpoint` is logged as `[checkpoint 3]`.
- A failure result's `checkpoint` is logged as `[checkpoint …]`.
- A failure result with `checkpoint: null` is logged as it is.
- A `checkpoint` key on any other object is logged whole.
- The original interrupt still holds its checkpoint after serializing.

**Commit:** `Leave checkpoints out of statelog events`.

## Task 2: log the final return value once

**Files:** a new `lib/runtime/isInterrupt.ts`, `lib/runtime/interrupts.ts`,
`lib/simplemachine/graph.ts`, `lib/statelogClient.ts`.

1. Move `isInterrupt` and `hasInterrupts` into `lib/runtime/isInterrupt.ts`,
   a module with no imports. Re-export both from `interrupts.ts` so
   existing imports keep working. The client must not import
   `interrupts.ts`: that file imports `state/context.ts`, which imports the
   client.
2. In `graph.ts`, decide after the node returns:

   ```ts
   const edge = this.edges[currentId];
   const endsRun =
     !(result instanceof GoToNode) &&
     (edge === undefined || (!isRegularEdge(edge) && !edge.condition));
   ```

   Pass `endsRun` to `client.exitNode`.
3. In `StatelogClient.exitNode`, take `endsRun?: boolean`. The node state
   is `{ messages, data, … }`. When `endsRun` is true and
   `hasInterrupts(state.data)` is false, drop the `data` key from the
   logged state.
4. Put the dropping in a small function beside `nodeStateForLog`, so
   `exitNode` reads as: strip the runtime keys, then strip the final value.
   Say in its comment that `agentEnd.result` holds the value.

A run that is aborted after its last node returns logs neither the
`exitNode` value nor an `agentEnd.result`. That value was never delivered
to the caller either.

**Tests:**

`lib/statelogClient.test.ts`:

- `exitNode` with `endsRun: true` logs no `data.data`, and keeps
  `messages`.
- `exitNode` with `endsRun: true` and a list of interrupts logs the
  interrupts.
- `exitNode` without `endsRun` logs `data.data`, as today.

`lib/simplemachine/` graph test:

- A node with no edge passes `endsRun: true`.
- A node with a conditional edge that returns normally passes
  `endsRun: true`.
- A node that returns a `GoToNode` passes `endsRun: false`.

**Commit:** `Log a finished run's return value once`.

## Task 3: cap what an event can hold

**Files:** `lib/runtime/redactForStatelog.ts`, a new
`lib/runtime/trimStatelogEvent.ts`, `lib/statelogClient.ts`,
`lib/config/config.ts`, `lib/backends/typescriptBuilder.ts`,
`lib/runtime/invocationOptions.ts`, `lib/runtime/ipc.ts`,
`lib/eval/extract.ts`, and the docs.

### 3a. Config

One key, `log.maxValueChars`. Copy how `requestTimeoutMs` travels:

1. `lib/config/config.ts`: add `maxValueChars: number` to the `log` type
   with a doc comment, and `z.number().int().nonnegative()` in the schema.
2. `TypeScriptBuilder.generateImports`
   (`lib/backends/typescriptBuilder.ts:4684`): write the key into the
   generated `statelogConfig` only when it is set, so no fixture changes.
3. `StatelogConfig` in `lib/statelogClient.ts`: add the field. The
   constructor stores `config.maxValueChars ?? DEFAULT_MAX_VALUE_CHARS`.
   `RuntimeContext` and `SimpleMachine` pass the config object through, so
   they need no change beyond the type.
4. `lib/runtime/invocationOptions.ts:171`: add the key to the allowlist of
   per-invocation overrides.
5. `lib/runtime/ipc.ts:1486`: add the key to `inheritedLog`, so a
   subprocess uses its parent's cap.
6. Export `DEFAULT_MAX_VALUE_CHARS = 100_000` from `trimStatelogEvent.ts`.
   `0` turns the cap off.

### 3b. The string cap

In `redactForStatelog.ts`:

1. Add `capString(text, maxChars, onCut): string`. A string longer than
   `maxChars` is cut so that it ends with `…[truncated N chars]`, where N
   is the number removed, and is at most `maxChars` long with the marker.
   `onCut` is called. With `maxChars` of `0` it returns the text. (Changed
   while building: with the marker outside the cap, a cut string was over
   the field budget and was cut a second time.) It lives in
   `trimStatelogEvent.ts` beside the field budget.
2. `stringifyStatelogEvent` takes the cap as a third argument and applies
   `capString` to the **output** of the scrub replacer:

   ```ts
   const scrubbed = scrub.call(this, key, value);
   return typeof scrubbed === "string" ? capString(scrubbed, maxChars, onCut) : scrubbed;
   ```

   It is not a scrub rule. A rule would be skipped for any string the
   redact rule replaced, and would not see a string that came from
   `toJSON`.

### 3c. The field budget

In `trimStatelogEvent.ts`, pure functions over parsed JSON:

1. `trimField(value, maxChars): { value, cut: boolean }`. Walk the value in
   order with a running count of the characters it will serialize to:
   - a scalar costs its JSON length plus one, for the comma;
   - a key costs its JSON length plus one, for the colon;
   - an array or an object costs two, for its brackets.

   Once the count passes `maxChars`:
   - the rest of an array becomes one item, `[truncated: N more items]`;
   - the rest of an object becomes one key, `"__truncated": "N more keys"`;
   - a string is cut to what is left of the budget, with the same suffix
     `capString` writes.

   Everything before the cut is kept whole.
2. `trimEventData(data, maxChars): { data, cut: boolean }`. Apply
   `trimField` to each top-level field of `data`, each with its own budget.
   Skip `messages` when `data.type === "promptCompletion"`.

Keep each function short: one for scalars and strings, one for arrays, one
for objects, one for the event.

### 3d. Wiring

In `stringifyStatelogEvent`:

1. Serialize as today, with the string cap on the replacer's output.
2. If the text is no longer than the cap, no field can be over it. Set the
   flag if a string was cut (step 4) and return.
3. Otherwise parse the text and run `trimEventData`. If no field was cut
   and no string was cut, return the **original** text: parsing and
   serializing again can reorder integer-like keys.
4. If anything was cut, set `data.truncated = true` and serialize the
   trimmed value. This serialization uses no scrub rules: the text was
   already scrubbed.

When only a string was cut, the flag still has to be added. Add it by
parsing and serializing, as in step 4. A cut string is rare, so the extra
pass does not matter.

### 3e. Eval

In `lib/eval/extract.ts`, set `truncated: true` on the value when the
event it came from has `data.truncated === true`:

- in `returnValueOutputs`, for `agentEnd.result`;
- in `collectExplicit`, for `evalOutputRecorded` and `evalValueRecorded`.

`capValue` spreads the entry, so the flag survives eval's own cap.

`data.truncated` is one flag for the whole event. On these three event
types the value is the only field that can realistically be cut, so
reading the flag as "the value was cut" is right. Say so in a comment: it
would not be right for every event type.

### 3f. Docs

- `docs/site/guide/observability.md`: after the paragraph on binary data,
  say that checkpoints are not logged, that long strings and large fields
  are cut, what the markers look like, that `truncated: true` marks a cut
  event, and that an LLM call's `messages` list is never shortened.
- `docs/site/guide/agency-config-file.md`: add `log.maxValueChars` with its
  default, `0` to disable, and that a change needs a recompile.
- `docs/dev/hosting/statelog.md`, "Redaction" section: the string cap and
  why it runs on the replacer's output, the field budget, the second parse
  and serialize for an oversized event, and the `__truncated` key.

**Tests:**

`lib/runtime/trimStatelogEvent.test.ts`:

- A value under the budget is returned unchanged with `cut: false`.
- An array over the budget keeps a prefix and ends with the marker item.
- An object over the budget keeps its first keys and gains `__truncated`.
- A nested value is cut at the point the budget runs out, and what came
  before is whole.
- A long string field is cut to the budget.
- An array of one-digit numbers trims to at most the budget plus one item,
  measured with `JSON.stringify`.
- Two fields each get their own budget.
- `messages` on a `promptCompletion` is skipped; `messages` on another
  event type is not.

`lib/runtime/redactForStatelog.test.ts`:

- A string over the cap is cut and reports the count removed.
- A long string that contains a redacted secret is both redacted and cut.
- A value whose `toJSON` returns a long string is cut.
- An event under the cap is byte-for-byte what it is today.
- An event over the cap with no field over it, and with an integer-like
  key, is byte-for-byte what it is today.
- An event with one oversized field keeps its other fields and carries
  `truncated: true`.
- A redacted value inside an oversized field is still redacted.
- A cap of `0` turns both the string cap and the field budget off.
- A string of 40,000 characters in `agentEnd.result` is logged whole.

`lib/eval/extract.test.ts`:

- A truncated `agentEnd.result` gives an eval output with
  `truncated: true`.
- A truncated `evalOutputRecorded` value does too.

Compile test, beside the existing one for `requestTimeoutMs`:

- `log.maxValueChars` in the config appears in the generated
  `statelogConfig`, and is absent when unset.

**Commit:** `Cap the size of statelog strings and fields`.

## Verification

1. `pnpm vitest run` on the test files named above.
2. `pnpm typecheck`, which covers the tests.
3. One real run: build, then run a small agent that pauses on an interrupt
   with `--log` writing to a file inside the worktree. Confirm the log has
   no `checkpoint` object and one copy of the return value, and that
   `agency logs outline` and `agency logs view` open it.
4. Write a fixture agent that returns a wide value (tens of thousands of
   small values) and one that fails with large arguments. Record the log
   size before and after in the PR description.
5. `pnpm fmt:ts` before pushing.

## Not in this plan

- Logging only the messages each LLM call added. See "Not in this change"
  in the spec.
- The `std::statelog` readers (`traces`, `outline`, `search`, `showRow`).
  That is the next spec.
- Dropping the `args` field from failure results. The field budget bounds
  it.
