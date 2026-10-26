# `spillToolResultsOver`: spilling becomes its own option, and `maxToolResultChars` is always a ceiling

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** What happens to a long tool result depends only on the options the `llm()` call sets, never on which tools the call offers. `maxToolResultChars` is a hard ceiling on what the model receives from one tool result. A new per-call option, `spillToolResultsOver`, turns spilling on: a long result is saved in the run, and the model gets a notice instead. With the option unset, nothing is saved.

**One PR, based on main.** Checked against `main` at `8d0439d68` on 2026-10-26. **Revised 2026-10-26** after `2026-10-26-spill-tool-results-over-review.md`. The main change: with spilling on, a result is saved once it is over the spill value *or* the limit, whichever is smaller. That answers review items 4 and 8 together (see decision 1). Every other item is folded in where it belongs.

**Built 2026-10-26.** Three things changed in the build:
- The truncation marker now counts toward the limit. Before, a cut result was `maxToolResultChars` characters plus about 60 characters of marker, so even a plain cut broke the ceiling. The `cap-tool-result` agency-js test capped at 50 characters, which the marker alone now fills, so it caps at 200 and also checks the tool message is within the cap.
- `spillSettings` takes the branch defaults object and checks for the key, instead of `runPrompt` pulling the key out. It runs before anything is sent, so the key never reaches smoltalk.
- `prompt.ts` was already at its 1,250-line limit, so the closure that applies the cap moved into `toolResultCapper` in `toolInvocation.ts`.

---

## What is wrong today

`runPrompt` searches the call's tool list for `readSpill` (`lib/runtime/prompt.ts:691`):

```ts
const readers = spillReaders(exposedFunctions);
const capForLlm = (value: any, tool: AgencyFunction) =>
  capToolResultForLlm(value, toolResultCap, overCapFor(run, readers, tool));
```

`overCapFor` (`lib/runtime/toolInvocation.ts:172`) then decides what a result over `maxToolResultChars` becomes:

- The tools include `readSpill`: the result is saved whole, and the model gets a preview and a name.
- They do not: the result is cut at the limit.

So the same call with the same options behaves differently depending on whether `shellTools()` or `spillTools()` happens to be in its tool list. Nothing in the call says "save long results".

There is a second problem. When a result is saved, the model gets the notice from `outputNotice`, which is about 2,000 characters (700 from each end plus the text around them). Nothing compares the notice with `maxToolResultChars`. With `maxToolResultChars: 500` and `readSpill` in the tools, the model receives about 2,000 characters.

---

## The new rules

For one tool result, measured as today (a string as is, anything else as compact JSON), where "the limit" is `maxToolResultChars` (`0` or less means no limit):

1. **A result from `readSpill` or `grepSpill`** is never saved again. If it is longer than the limit, or than `spillToolResultsOver` when that is set, it is cut at the smaller of the two, with a note saying to read a smaller slice. Saving it again would hand the model a notice naming a copy of the same text. This looks at which tool produced the result, not at the tool list, and the text is always in the store, so the note is always true.
2. **If `spillToolResultsOver` is set** and the result is longer than it or longer than the limit, the result is saved whole in the run's store, and the model gets the notice. The notice is built to fit under the limit.
3. **Otherwise, if the result is longer than the limit**, it is cut there with the `[tool result truncated: showing N of M chars]` marker, whatever the tools are.
4. **Otherwise** the result goes to the model unchanged.

Put shortly: with spilling off, nothing is saved and anything over the limit is cut. With spilling on, nothing is cut (except a reader's own result), and anything over either number is saved.

These rules apply to everything the loop sends back for a tool call: a result, a tool's error message, and a rejection reason. All three go through `capForLlm` today (`prompt.ts:959`, `:989`, `:1322`), and today a long error message is already saved when the readers are offered. So `spillToolResultsOver` covers error text too, and the docs say so.

**`spillToolResultsOver` set with no `readSpill` in the tools is an error**, thrown before the first request. A saved result the model cannot read back is useless, and failing loudly is better than cutting quietly. The message names the tools the call did offer, so a `.rename()` mistake is easy to see:

```
llm() was given spillToolResultsOver, but its tools (fetchMarkdown, readOutput)
do not include readSpill from std::spill, so the model could not read a saved
result back. Add readSpill and grepSpill to the tools, for example with
spillTools() from std::agents/lib/toolkits.
```

`0` or a negative number means the same as unset, the way `0` turns `maxToolResultChars` off.

### Examples

```ts
// Today: cut at 20,000, because the tools have no readSpill.
// After: the same.
llm("read the page", { tools: [fetchMarkdown], maxToolResultChars: 20000 })

// Today: saved, because readSpill is in the tools.
// After: cut at 20,000. Offering the readers no longer changes anything.
llm("read the page", {
  tools: [fetchMarkdown, readSpill, grepSpill],
  maxToolResultChars: 20000
})

// After: a 30,000-character result is saved, though it is under the default
// limit of 100,000. The notice the model gets is under 100,000.
llm("read the page", {
  tools: [fetchMarkdown, readSpill, grepSpill],
  spillToolResultsOver: 20000
})

// After: a 30,000-character result is saved. It is under the spill value but
// over the limit, and with spilling on, nothing is cut.
llm("read the page", {
  tools: [fetchMarkdown, readSpill, grepSpill],
  spillToolResultsOver: 50000,
  maxToolResultChars: 20000
})

// After: throws before the request, because nothing could read a saved result.
llm("read the page", { tools: [fetchMarkdown], spillToolResultsOver: 20000 })
```

---

## Decisions

### 1. With spilling on, a result over either number is saved

The first draft of this plan saved a result only when it was over `spillToolResultsOver`, and cut anything between the limit and the spill value. That made `spillToolResultsOver: 50000` with `maxToolResultChars: 20000` a setting nobody wants: results from 20,000 to 50,000 cut, with nothing to read the rest with. The review asked for an error or a warning there.

Saving at the smaller of the two removes the case altogether. It also means a user who lowers the limit (in `agency.json`, with `--max-tool-result-chars`, or with `setLlmOptions`) keeps spilling at the new limit, as today. So the stdlib agents behave exactly as they do now at every limit, not only the default (decision 5). The rule still depends only on the call's options.

### 2. Per call only: `setLlmOptions` refuses it, `agency.json` ignores it

`maxToolResultChars` can be set per call, with `setLlmOptions`, or in `agency.json`. `spillToolResultsOver` is per call only. Set as a default, it would apply to every later `llm()` call in the branch, and every one of those calls that offers no `readSpill`, including a plain call with no tools, would throw. Per call, the option and the tool list are written next to each other, so the error points at a line the author wrote.

What stops it arriving the other two ways:

- **`setLlmOptions`.** `LlmDefaults` in `stdlib/llm.agency` does not get the key, so the type checker refuses it from Agency. A TypeScript caller can still reach `_setLlmOptions` (`lib/stdlib/llm.ts:72`), which copies every key onto the branch defaults, and `runPrompt` would spread it into the smoltalk config as a foreign key. So `runPrompt` pulls `spillToolResultsOver` out of the branch defaults next to `stackMaxToolResultChars` and passes it to `spillSettings` (decision 3), which throws: `spillToolResultsOver is set per llm() call, not with setLlmOptions.`
- **`agency.json`.** The `client` schema in `lib/config/config.ts` is a plain zod object, which drops keys it does not know, so a `client.spillToolResultsOver` is ignored like any other misspelled key. Nothing to do here.

If a default is wanted later, it needs its own answer for calls without the readers, and that is a separate change.

### 3. One helper decides the spill settings, and it is the only place that reads the tool list

```ts
/** What the call's spill option says: save a result over `over`, and name
 *  the readers by the names the model sees. */
export type SpillSettings = { over: number; run: Run; readers: SpillReaders };

/** The call's spill settings, or null when `spillToolResultsOver` is unset
 *  or not above 0. Throws when it came from setLlmOptions, or when `tools`
 *  has no `readSpill`. */
export function spillSettings(
  run: Run,
  perCall: number | undefined,
  branch: number | undefined,
  tools: ToolIdentity[],
): SpillSettings | null
```

It still searches the tool list, but only to fail loudly and to get the names the model sees the readers under (a `.rename()` keeps working). Neither changes what happens to a result. `OverCap` and `overCapFor` go away. `capToolResultForLlm` becomes:

```ts
export function capToolResultForLlm(
  result: any,
  cap: number,
  spill: SpillSettings | null,
  tool: ToolIdentity,
): any {
  const ceiling = Number.isFinite(cap) && cap > 0 ? cap : Infinity;
  const saveOver = spill === null ? Infinity : Math.min(spill.over, ceiling);
  const text = stringifyToolResult(result);
  if (isSpillReader(tool)) {
    // Its text is already saved: cut it, never save a copy.
    const limit = Math.min(saveOver, ceiling);
    return text.length > limit ? cutAt(text, limit, SLICE_NOTE) : result;
  }
  if (spill !== null && text.length > saveOver) {
    // An object is saved indented, so readSpill and grepSpill have lines to work on.
    const saved = stringifyToolResult(result, 2);
    const notice = outputNotice(saved, storeOutput(spill.run, saved), null, spill.readers, ceiling);
    return notice.slice(0, ceiling);
  }
  if (text.length <= ceiling) return result;
  return cutAt(text, ceiling, "");
}
```

`cutAt` is today's "cut and add the marker" code with the optional note appended. A result within both numbers is still returned as the original value, so smoltalk serializes it exactly as before.

### 4. The notice shrinks its preview to fit

`outputNotice(text, name, exitCode, readers, maxChars = Infinity)` works out the fixed text first: the header line, the two `--- first/last N lines ---` lines, the "saved as" line, and the instructions. The head and tail line counts are not known until the preview is built, so the fixed text is measured with both counts set to `lines.length`, which is an upper bound. Each end of the preview then gets `min(PREVIEW_CHARS, floor((maxChars - fixed) / 2))` characters, and the real notice is never longer than the measured one.

The caller still cuts the notice at `maxChars`. That cut only does anything when the fixed text alone is over the limit, which takes a limit under about 300 characters. Then it removes the end of the notice, which holds the name and the instructions, but nothing shorter could hold them either. The comment on the cut says this, so a reader does not take it for a patch over a bug.

`previewHead` and `previewTail` take the budget as a parameter. `previewHead` today always shows at least one line; it changes to "stop at the first line that does not fit". At the default budget nothing changes, because `cutLine` caps a line at 201 characters, which always fits in 700. Under a small budget, the preview can now be empty.

`safeBash` calls `outputNotice` with no limit, so its notice is unchanged.

### 5. The stdlib agents keep spilling by setting the option

Every stdlib agent that carries the readers spills today. After this change they would cut instead, so each one sets `spillToolResultsOver` on its `llm()` call that offers tools.

`llmOptions` in `stdlib/agents/lib/shared.agency` gets a `spillToolResultsOver: number = 0` parameter, written into the options when it is above 0, like `maxToolCallRounds`. `shared.agency` gets one constant:

```
export static const AGENT_SPILL_OVER = 100000
```

Because of decision 1, the agents now save at the smaller of 100,000 and the resolved limit, which is exactly what they do today: at the default limit, at 100,000; with `maxToolResultChars: 20000` in `agency.json`, at 20,000. No user sees a change in agent behavior. Lowering the constant would make the agents save results that today reach the model whole, so it stays at 100,000 here; changing it is a separate decision.

The calls to change, all through `llmOptions` unless noted:

| File | Call |
|---|---|
| `stdlib/agents/researcher.agency` | the two calls with `tools: tools` (lines 221 and 252); not the `NO_ANSWER_FOLLOWUP` call, which has no tools |
| `stdlib/agents/coding.agency` | line 98 |
| `stdlib/agents/review.agency` | line 61 |
| `stdlib/agents/oracle.agency` | line 111 |
| `stdlib/agents/explorer.agency` | line 141 |
| `stdlib/agents/verifier.agency` | line 62 |
| `stdlib/agents/expert.agency` | line 58 |
| `stdlib/agents/data.agency` | line 98 |
| `stdlib/agents/typescript/review.agency` | line 138 |
| `stdlib/agents/agency/review.agency` | line 196 |
| `stdlib/agents/agency/verifier.agency` | line 50 |
| `stdlib/agents/composable/researcher.agency` | line 45, which builds its options inline: add `spillToolResultsOver: AGENT_SPILL_OVER` |

The list is every file that calls `shellTools()` or `spillTools()`. Re-run that grep before starting, in case an agent was added since.

`everyAgentCarriesTheReadersOnce` in `tests/agency/agents/toolkits.agency` matters more after this change: an agent that drops the readers would now throw at its first `llm()` call. Its comment says so.

### 6. What stays the same

- `safeBash`'s own 2,000-character limit (`MAX_STDOUT_LEN`) and its notice. That is the bash tool limiting its own output, not the `llm()` call.
- The store, its million-character cap, eviction, and the readers.
- `resultCap`: `maxToolResultChars` is resolved per call, then `setLlmOptions`, then `agency.json`, then the default, as today.

### 7. One edge case, not handled specially

**`spillToolResultsOver` below about 2,000.** `safeBash`'s own notice can then be longer than the spill value, so it gets saved again, and the model gets a notice pointing at a notice. Nobody sets a value that low on purpose, and special-casing `safeBash` would be another hidden rule. `spill.md` mentions it.

---

## Files

- `lib/runtime/toolInvocation.ts`: `SpillSettings`, `spillSettings`, the new `capToolResultForLlm`; remove `OverCap` and `overCapFor`.
- `lib/runtime/toolOutputStore.ts`: `outputNotice` takes `maxChars`; `previewHead` and `previewTail` take a budget. Fix the comment on `PREVIEW_CHARS`, which says the notice is never longer than a cut result would be (only true for `safeBash`'s 2,000).
- `lib/runtime/prompt.ts`: take `spillToolResultsOver` out of the per-call client config next to `maxToolResultChars` (so it never reaches smoltalk) and add it to the type there; take it out of the branch defaults next to `stackMaxToolResultChars`; replace `spillReaders` and `overCapFor` at line 691 with `spillSettings`. That line runs before the thread is restored or any request is built, so the throw comes before the first request, on a resume too.
- `lib/runtime/toolLoopGuards.ts`: the `resultCap` comment points at `capToolResultForLlm` instead of `overCapFor`.
- `lib/typeChecker/builtins.ts`: `{ key: "spillToolResultsOver", value: optional(number) }` next to `maxToolResultChars`, with a comment.
- `stdlib/agents/lib/shared.agency`: `AGENT_SPILL_OVER` and the `llmOptions` parameter with its `@param` line.
- The twelve agent files in decision 5.
- `stdlib/agents/lib/toolkits.agency`: the `shellTools` and `spillTools` docstrings say results are saved when the `llm()` call sets `spillToolResultsOver`.
- `stdlib/spill.agency`: the module doc's paragraph about the loop (lines 17-20).
- Tests and docs below.

---

## Tasks

### Task 1: The notice fits a limit

- [ ] In `lib/runtime/toolOutputStore.ts`, give `previewHead` and `previewTail` a `budget` parameter and change `previewHead` to stop at the first line that does not fit.
- [ ] Add `maxChars: number = Infinity` to `outputNotice` and compute the per-end budget from the fixed text as in decision 4.
- [ ] In `lib/runtime/toolOutputStore.test.ts`, add:
  - with no limit, the notice is the same as before (the existing "under 2000 characters" test covers this; keep it);
  - with `maxChars: 600` and an output of several thousand lines, the notice is at most 600 characters, contains `--- full output saved as <name> ---` and `readSpill(filename: "<name>")`, and shows fewer preview lines than with no limit;
  - with `maxChars` below the fixed text, the preview is empty.

### Task 2: The cap and the spill

- [ ] In `lib/runtime/toolInvocation.ts`, add `SpillSettings` and `spillSettings`, rewrite `capToolResultForLlm` as in decision 3, and delete `OverCap` and `overCapFor`.
- [ ] In `lib/runtime/prompt.ts`, make the three changes in the Files list.
- [ ] Add the option to `lib/typeChecker/builtins.ts`.
- [ ] Rewrite the `capToolResultForLlm` block in `lib/runtime/prompt.test.ts`. The cases:
  - no spill, readers in the tools: an over-limit result is cut with the marker, and nothing is saved. This is the regression test for the bug.
  - no spill, a reader's own result over the limit: cut with the slice note, nothing saved.
  - spill 20,000, limit 100,000, a 30,000-character result: saved, and the model gets the notice.
  - spill 50,000, limit 20,000, a 30,000-character result: saved, not cut.
  - spill set, limit 500: the notice is at most 500 characters.
  - spill set, limit 0: saved, and the notice is not cut.
  - a reader's own result over the spill value but under the limit: cut at the spill value with the slice note, nothing saved.
  - an object result is saved indented (keep the existing test).
  - renamed readers are named by their new names (keep the existing test).
  - limit 0 and `Infinity` with no spill return the original value (keep).
  - default limit is 100,000 (keep).
- [ ] Add a `spillSettings` block:
  - unset, 0, and -1 give null;
  - set with readers gives the readers' names;
  - set without `readSpill` throws, and the message lists the tools offered;
  - a branch value throws the "set per llm() call" message.

### Task 3: Agency tests

In `tests/agency/spill.agency` and its `.test.json`:

- [ ] `overCapToolResultIsKept` sets `spillToolResultsOver: 20000` and drops `maxToolResultChars: 20000`, so it shows a result saved while under the default limit.
- [ ] New node `readersWithoutSpillAreCut`: the same call with `tools: [longPage, readSpill, grepSpill]`, `maxToolResultChars: 20000`, and no spill option. Expect the truncation marker and no "full output saved as". This is the user-visible version of the bug.
- [ ] New node `spillWithoutReadersFails`: a `def` that calls `llm` with `tools: [longPage]` and `spillToolResultsOver: 20000`. The function's automatic try-catch turns the throw into a failure (`docs/site/guide/error-handling.md:170`); the node returns whether it is a failure and whether its message mentions `readSpill`. It throws before the request, so no mock round is used, but the test can keep `useTestLLMProvider` like its neighbours.
- [ ] Keep `overCapResultWithoutReadersIsCut` as it is.

In `tests/agency/agents/libShared.agency`:

- [ ] A node that checks `llmOptions("", "", spillToolResultsOver: 100000)` writes the key and `llmOptions("", "")` leaves it out, next to the existing `llmOptions` nodes.

In `tests/agency/agents/toolkits.agency`:

- [ ] Add the sentence from decision 5 to the comment on `everyAgentCarriesTheReadersOnce`.

Run only these three files, each with its output saved to a file.

### Task 4: Agents

- [ ] Add `AGENT_SPILL_OVER` and the `llmOptions` parameter to `stdlib/agents/lib/shared.agency`.
- [ ] Pass it in each call in the decision 5 table.
- [ ] Update the `shellTools` and `spillTools` docstrings and the `std::spill` module doc.
- [ ] `make`, since stdlib files changed.

### Task 5: Docs

- [ ] `docs/site/guide/llm-part-2.md`, the Tools & context table:
  - `maxToolResultChars`: "The most characters from one tool result that are sent to the model (`0` for no limit). A longer result is cut at the limit, unless the call sets `spillToolResultsOver`."
  - new row `spillToolResultsOver`: "Save a tool result in the run when it is longer than this many characters or longer than `maxToolResultChars`, and send the model a short preview and a name to read the rest with. The preview fits under `maxToolResultChars`. Applies to a tool's error messages too. The call's tools must include `readSpill` from `std::spill`, or the call fails before it starts. Unset or `0`: nothing is saved."
- [ ] `docs/dev/stdlib/spill.md`: replace the three-row table and the paragraph after it with the four rules; say the tool list is read only for the error and the readers' names, and why (a call never changes behavior based on its tools); say why spilling saves at the smaller of the two numbers (decision 1) and why the option is per call only (decision 2); note that the notice fits the limit, that error text is covered, and the edge case in decision 7.
- [ ] `docs/dev/agents/tool-loop-guards.md`, "A result over the cap" (lines 182-190): replace the paragraph, which describes the tool-list rule, with the short version of the rules and a pointer to `spill.md`.
- [ ] `docs/dev/runtime/config.md:284`: add to the `client.maxToolResultChars` row: "A longer result is cut, unless the `llm()` call sets `spillToolResultsOver`."
- [ ] Regenerate the stdlib pages (`docs/site/stdlib/spill.md`, `docs/site/stdlib/agents/lib/toolkits.md`, and the page for `shared.agency` if there is one) with `make` or `agency doc`, not by hand.

### Task 6: Checks

- [ ] `pnpm vitest run lib/runtime/prompt.test.ts lib/runtime/toolOutputStore.test.ts` (save the output to a file).
- [ ] The Agency tests from Task 3.
- [ ] `pnpm run lint:structure`, the typecheck, and `pnpm run fmt:ts` on the changed `.ts` files only.
- [ ] Chain the checks with `&&` and read the log before pushing.
- [ ] PR description: say this changes behavior for any program that relied on offering `readSpill` to get spilling; such a program now has to set `spillToolResultsOver`. Give the before and after in one example (the second example in "The new rules"). Say that the stdlib agents behave as before at every limit.
