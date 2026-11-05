# Review: Statelog smaller events (plan and spec)

Plan: `docs/superpowers/plans/2026-11-05-statelog-event-size.md`
Spec: `docs/superpowers/specs/2026-11-05-statelog-event-size.md`

## Verdict

Change 1 (leave checkpoints out) is sound and nearly ready. Change 2
(log the final value once) works for BMO but misses a common node shape.
Change 3 (the caps) has four problems to fix before building it:

1. The config wiring points at a factory nothing calls, so the
   `agency.json` keys would do nothing.
2. A string that redaction touched skips the string cap.
3. The 20,000-character string cap cuts eval outputs that eval keeps
   today.
4. On logs other than the two-day BMO sample, the field cap cuts
   LLM-call `messages`, and it cuts the newest messages, not the oldest.

The spec's statement "No LLM call, tool call, or interrupt event changes"
holds for the two-day BMO sample only. On `log.oct.jsonl` (the 92 MB log
in this package), 145 of 347 `promptCompletion` events have a `messages`
field over 100,000 characters, and 192 contain a string over 20,000
characters.

Everything else is below, most serious first.

## Must fix

### 1. The config never reaches the client

Step 3a.2 says to add the caps to `getStatelogClient` (the factory at
`lib/statelogClient.ts:1749`) "and its callers". That function has no
callers in `lib/`. A program's statelog config takes a different path:

1. `agency.json` `log` is read at **compile time** by
   `TypeScriptBuilder.generateImports` (`lib/backends/typescriptBuilder.ts:4687`),
   which writes each key into the generated `statelogConfig` object.
   `requestTimeoutMs` is the model to copy: it is written only when set,
   so no fixture changes.
2. `RuntimeContext` (`lib/runtime/state/context.ts:362` and `:572`)
   passes that object to `new StatelogClient(...)`.
3. A per-invocation override goes through the allowlist in
   `lib/runtime/invocationOptions.ts:171`.
4. A subprocess inherits its parent's statelog config in
   `lib/runtime/ipc.ts:1490`.

`SimpleMachine`'s constructor (`lib/simplemachine/graph.ts:36`) builds its
own client too.

If you follow the plan as written, `"log": { "maxStringChars": 0 }` in
`agency.json` has no effect. Rewrite 3a.2 to name these four places, and
add a test that a value set in config reaches `stringifyStatelogEvent`,
for example a compile test that the generated `statelogConfig` carries
`maxFieldChars`. Also say in the docs that, like the other `log` keys, a
change needs a recompile.

### 2. Redaction can stop the string cap from running

`makeScrubReplacer` (`lib/runtime/redactForStatelog.ts:35`) runs the rules
in order and **returns the first replacement**. `redactRule` returns a
replacement for any string that contains a redacted value: the same
string with the secret swapped out. So a string that contains a secret
never reaches `capStringRule`.

Example: a tool returns a 500,000-character page that includes a redacted
API key. `redactRule` returns the page with `[REDACTED]` in place of the
key, and the page is logged whole. The cap only fails for the strings
that also hold a secret.

There is a second, smaller gap. Rules see `raw`, the value before
`toJSON`. A value whose `toJSON` returns a long string is not a string in
`raw`, so the cap rule does not fire on it either.

**Fix:** do not make the cap a rule. Cap the replacer's **output** in
`stringifyStatelogEvent`:

```ts
const scrubbed = scrub.call(this, key, value);
return typeof scrubbed === "string" ? capString(scrubbed, caps.maxStringChars, onCut) : scrubbed;
```

This runs after every rule, whichever one fired, and on `toJSON` output
too. Add a test: a long string that contains a redacted secret comes out
both redacted and cut.

### 3. The string cap cuts eval outputs

The spec says the 100,000 field cap "keeps everything eval can use". The
string cap undoes that. `agentEnd.result` is often a single string, and
the string cap cuts it at 20,000 characters. Eval keeps up to 100,000
bytes (`EVAL_MAX_VALUE_BYTES`, `lib/eval/extract.ts:44`). A writing agent
that returns a 40,000-character essay would be graded on its first half,
with no warning beyond the `truncated` flag.

The same applies to `evalOutputRecorded` and `evalValueRecorded`. Eval
reads their `data.value` in `collectExplicit` (`lib/eval/extract.ts:334`),
and 3e only adds the `truncated` flag in `returnValueOutputs`.

**Fix:** leave the string cap off these three values (`agentEnd.result`,
`evalOutputRecorded.value`, `evalValueRecorded.value`) and let the field
budget bound them. That keeps the spec's promise: eval loses nothing
under 100,000. Also set `truncated` in `collectExplicit`, not only in
`returnValueOutputs`.

### 4. The field budget cuts the newest messages

The budget walks a field from the start and drops the rest. For
`promptCompletion.messages`, the rest is the newest turn: the tool result
the model just received and the user message it is answering. That is
the part a person opens the logs viewer to see. The system prompt and
early turns survive.

Measured: in BMO's two-day sample no `messages` field reaches 100,000.
In `log.oct.jsonl`, 145 of 347 do. Any long `agency agent` session will:
30,000 tokens of context is roughly 120,000 characters.

The viewer would also misread a cut list:

- The marker item `"[truncated: 131 more items]"` goes through
  `normalizeMessage` (`lib/statelog/wireAccessors.ts:272`) and shows as a
  message with role `unknown` and no content.
- The round-to-round delta (`lib/logsViewer/messageDelta.ts`) sees a
  history that got shorter and draws a "history rewritten" divider where
  nothing was rewritten.

Options, in order of how much they change:

- **(a) Leave `promptCompletion.messages` out of the field budget.** The
  string cap still bounds each message, so one huge tool result is still
  cut. This keeps the spec's measured results for BMO, where no LLM call
  was cut anyway. I recommend this for this PR.
- **(b) Cut arrays from the front**, keeping the first item (the system
  prompt) and the newest items. The viewer still needs to learn the
  marker.
- **(c) Log only the messages a round added.** This is the real fix for
  the repetition (every round re-logs the whole history), but it changes
  every reader. It needs its own spec.

This one is your call. The plan should name the choice and add a viewer
test for whatever marker reaches it.

## Should fix

### 5. `endsRun` misses a final node that has conditional edges

Task 2 sets `endsRun: this.edges[currentId] === undefined`. But Agency
gives every node that can go to another node a conditional edge with no
condition function (`graph.conditionalEdge(node, [adjacent…])`,
`lib/backends/typescriptBuilder.ts:4917`). When that node returns normally,
the run ends through the `else` branch at the bottom of `graph.run`
(`lib/simplemachine/graph.ts:206`), but `this.edges[currentId]` is set.
So the value is still logged twice for a node like this:

```
node main() {
  if (needsReview) {
    return review(draft)
  }
  return draft
}
```

BMO is not affected: I checked all 57 finished runs in the two-day log,
and every final node had no edges. So the measured numbers stand. The
spec's test "a finished run's return value appears once" would still fail
for the program above.

**Fix:** decide after the node returns:

```ts
const edge = this.edges[currentId];
const endsRun =
  !(result instanceof GoToNode) &&
  (edge === undefined || (!isRegularEdge(edge) && !edge.condition));
```

Add a test with a conditional-edge node that returns normally.

### 6. Importing `hasInterrupts` into the client creates an import cycle

`lib/statelogClient.ts` imports almost nothing from the runtime today.
`lib/runtime/interrupts.ts` imports `state/context.ts`, which imports
`statelogClient.ts`. Adding `import { hasInterrupts } from "./runtime/interrupts.js"`
closes the loop. It may load fine today, but it is fragile, and it pulls
the checkpoint store and the context into the client's module graph.

**Fix:** move `isInterrupt` and `hasInterrupts` to a small module with no
imports (for example `lib/runtime/isInterrupt.ts`), re-export them from
`interrupts.ts`, and import the small module in the client.

Also say exactly what to check. The client's `data` is the node state
`{ messages, data, … }`, so the check is `hasInterrupts(state.data)`, not
`hasInterrupts(state)`.

### 7. "Byte-for-byte unchanged" breaks for a large event with no large field

Step 3d.2 skips the trim only when the **whole** text is under
`maxFieldChars`. Step 3d.3 then parses and re-serializes. Take a
`promptCompletion` with 60,000 characters of `messages` and 50,000 of
`completion`. No field is over budget, but the text is, so it is parsed
and written again. That round trip can change bytes: `JSON.parse` puts
integer-like keys first, so `{"b":1,"10":2}` comes back as
`{"10":2,"b":1}`.

**Fix:** when no string and no field was cut, return the original text.
Re-serialize only when something changed. Add the "large event, no large
field" case to the byte-for-byte test.

### 8. The budget does not count punctuation, so a field can far exceed it

3c.1 counts "the length of each key and of each scalar as JSON text". It
does not count commas, colons, or brackets. For the shape the spec says
causes the problem, many small values, that is most of the text. An array
of one-digit numbers, `[1,2,3,…]`, is about twice as long as the count.
The spec's promise of a field of "100,000 characters" and a largest line
of "about 100 KB" would not hold for that shape.

**Fix:** count each scalar's JSON length plus one (for the comma), each
key's JSON length plus one (for the colon), and two per array or object.
Then the count matches the serialized length closely. Test that a trimmed
field's `JSON.stringify` length is at most the budget plus the size of
one item.

### 9. With the string cap off, a long string field is never bounded

`trimField` cuts arrays and objects but treats a string as one scalar. If
a user sets `maxStringChars` to `0` and keeps `maxFieldChars`, a 5 MB
string in `agentEnd.result` is logged whole. A string result is common.

**Fix:** let `trimField` cut a string to the budget it has left. Then the
field budget means what its name says, whatever the string cap is set to.
This also gives finding 3 a clean shape: the eval fields skip the string
cap but are still bounded by the field budget.

### 10. Failure results can carry a whole checkpoint

`ResultFailure` has a `checkpoint` field (`lib/runtime/result.ts:113`).
`functionCatchFailure.mustache:38` and `interruptReturn.mustache` (a
rejected interrupt) fill it with `ctx.getResultCheckpoint()`, a full
checkpoint. The new rule only matches a parent with
`type === "interrupt"`, so a failure that reaches `agentEnd.result` or a
tool-call result still logs the whole checkpoint.

In the two-day BMO log all four failure results had `checkpoint: null`,
so the numbers stand. But the spec's goal, "checkpoints are never
logged", is not met.

**Fix:** have the rule also match a parent with
`__type === "resultType"` and `success === false`. Name the checkpoint by
its own id if it has one, else `[checkpoint]`. Add a test.

### 11. The dev doc is not in the plan

`docs/dev/hosting/statelog.md` has a "Redaction" section that lists the
scrub rules in order and explains their cost. It needs the checkpoint
rule, the string cap (and why it runs on the replacer's output), the
field budget, and the second parse and serialize for an oversized event.
Add it to 3f, and add a line for change 1 in commit 1.

## Minor

- The Background bullet on `safeStatelogValue` says "Both new rules are
  correct there". 3b says the string cap is **not** added to the shared
  list. Only the checkpoint rule reaches `safeStatelogValue`; fix the
  bullet.
- The reader list in Task 2 names `tree.ts`, `summary.ts`, and
  `extract.ts`. None of them mentions `exitNode`; only
  `lib/logsViewer/timeline/turns.ts` does. The grep step will find that,
  but the list should match it.
- The spec says a node that hands off logs its data in `exitNode` because
  "no other event has it". `followEdge` and the next node's `enterNode`
  both log the same node state. The plan's choice to keep it in
  `exitNode` is fine; only the reason is wrong.
- `data.truncated` is one flag per event. For `agentEnd` only `result` can
  realistically be cut, so eval reading it as "the result was cut" is
  right. Say so in a comment, since it would not be right for every
  event type.
- An object that really has a key named `__truncated` would be confused
  with the marker. Harmless in a log, but worth one line in the doc.

## Tests to add

Beyond the plan's list:

- A long string containing a redacted secret is both redacted and cut
  (finding 2).
- An `agentEnd` string result of 40,000 characters is logged whole, and
  so is an `evalOutputRecorded` value of that size (finding 3).
- The chosen `messages` behaviour, and the viewer showing a cut list
  (finding 4).
- A final node with conditional edges that returns normally logs its
  value once (finding 5).
- An event over `maxFieldChars` with no field over it is byte-for-byte
  unchanged (finding 7).
- A trimmed field's serialized length stays near the budget for an array
  of small numbers (finding 8).
- `maxStringChars: 0` with the field cap on still bounds a long string
  result (finding 9).
- A rejected interrupt's failure result logs `[checkpoint …]` in place of
  its checkpoint (finding 10).
- A cap set in `agency.json` reaches the client (finding 1).
