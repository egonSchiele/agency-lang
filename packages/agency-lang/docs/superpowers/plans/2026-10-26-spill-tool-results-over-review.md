# Review: `spillToolResultsOver`

Plan reviewed: `2026-10-26-spill-tool-results-over.md`, checked against the code in this worktree (`main` at `8d0439d68`).

## Verdict

The plan is sound and should go ahead. The core idea is right: what happens to a long result is decided by the call's options, and `maxToolResultChars` is always a ceiling. The new `capToolResultForLlm` in decision 3 reads well and the task list is complete enough to implement from.

Three things should change before implementation. The rest are smaller notes, in rough order of weight.

## Must fix

### 1. A reader's own result should get the slice note under rule 2 as well

Decision 3 only gives the "read a smaller slice" note inside rule 1, when `spillToolResultsOver` is set. With the option unset, a `readSpill` result over the ceiling falls to rule 2 and gets the bare `[tool result truncated: showing N of M chars]` marker.

That is a regression from today. Today, with the readers offered, a reader's over-cap result gets the slice note (the second row of the table in `spill.md`). After the plan, the same call with `maxToolResultChars: 20000` and no spill option gives the model a cut and no hint that `offset` and `limit` exist. The text is in the store either way, so the note is always true.

The plan's own argument for keeping the check ("it looks at which tool produced the result, not at the tool list") applies to both rules. Suggested shape:

```ts
const ceiling = Number.isFinite(cap) && cap > 0 ? cap : Infinity;
const text = stringifyToolResult(result);
const over = spill === null ? Infinity : spill.over;
if (isSpillReader(tool)) {
  const limit = Math.min(over, ceiling);
  return text.length > limit ? cutAt(text, limit, SLICE_NOTE) : result;
}
if (spill !== null && text.length > over) { ...save and notice... }
if (text.length <= ceiling) return result;
return cutAt(text, ceiling, "");
```

Add a test case for it: no spill, a reader's result over the limit, expect the slice note and nothing saved.

### 2. Say what happens when the option reaches `setLlmOptions` or `agency.json`

Decision 1 makes the option per call, but the plan does not say what stops it arriving another way. Two paths exist today:

- `_setLlmOptions` in `lib/stdlib/llm.ts:72` copies every key of its argument onto `stack.other.llmDefaults`. In `prompt.ts:661` the stack defaults are destructured, `maxToolResultChars` and the two round options are pulled out, and the rest is spread into the smoltalk config. A `spillToolResultsOver` set with `setLlmOptions` would reach smoltalk as a foreign key and do nothing visible.
- `agency.json` goes through the zod schema at `lib/config/config.ts:631`. Check whether it refuses an unknown `client` key. If it does, nothing to do. If it does not, the same foreign-key path applies.

For `setLlmOptions`, destructure `spillToolResultsOver` out of `stackDefaults` next to `stackMaxToolResultChars` and either ignore it or throw with a one-line message saying the option is per call. Throwing is more in keeping with the plan's "fail loudly" stance. Also check the `LlmDefaults` Agency type: if the key is not on it, the type checker already refuses `setLlmOptions({ spillToolResultsOver: 1 })`, which is the best outcome, and the plan should say so. Add one test either way.

### 3. Add `docs/dev/agents/tool-loop-guards.md` to the files list

Its section "A result over the cap" (lines 182 to 190) describes the current tool-list rule in full: "When the call offers `readSpill`, a tool result longer than `maxToolResultChars` is not cut." After this change that paragraph is wrong. Rewrite it to state the three rules or point at `spill.md`. The `resultCap` comment fix in `toolLoopGuards.ts` is in the plan; this doc is not.

## Should consider

### 4. The agents' constant: 100,000 may be the wrong number

Decision 4 is honest about the trade: a user who lowers `maxToolResultChars` (in `agency.json` or with `--max-tool-result-chars`) loses spilling for results between their limit and 100,000, which is exactly the range a long page lands in. The trace that motivated the loop spilling was a 106 KB page, so at the default limit the agents still spill it. But a user who set a 20,000 limit did so because 100,000 characters in one result was too much for them, and now the agents hand them a cut page with nothing to read the rest with.

Two ways out, either is fine:

- Set `AGENT_SPILL_OVER` lower, around 20,000 to 30,000. An agent that can read slices rarely needs a whole 100,000-character result in one message, and a page that long is mostly navigation and boilerplate. This changes agent behavior at default settings, so say so in the PR.
- Keep 100,000 and accept the regression for lowered limits, as the plan does.

Whichever is chosen, the PR description should give the before and after for the `agency.json` case in one example, since this is the change most likely to surprise someone.

### 5. The cut notice loses its most important lines first

When the notice is cut at the ceiling (decision 2), `slice(0, ceiling)` removes the end: the `--- full output saved as <name> ---` line and the instructions. Those are the only lines the model needs. With the fixed text around 300 characters this only bites for a ceiling under about 300, and the plan is right that nobody sets that on purpose. Two small things would make it safe anyway:

- In the Task 1 test with `maxChars: 600`, assert the name and the `readSpill(...)` instruction survive, not just the length. The plan says "still names the saved output and `readSpill`", so keep that assertion in.
- Compute the fixed text with the final digits in mind: `head.length` and `tail.length` are not known until the preview is built, and `lines.length` and `text.length` can be seven digits. Reserve a few characters for them, or build the fixed text with placeholder counts and let the final slice absorb the difference. Either way, say which in the code comment so a reader does not think the slice is covering a bug.

### 6. Treat negative values as unset

The plan says `0` means unset. `spillFor` should treat `over <= 0` as unset, matching `cap <= 0` in the ceiling, so a `-1` does not save every result.

### 7. The three cap sites spill error text too

`capForLlm` is called for a tool result (`prompt.ts:1322`), a rejection reason (`prompt.ts:959`), and a tool error message (`prompt.ts:989`). Under rule 1, an error message longer than `spillToolResultsOver` is saved and the model gets a notice with no exit code. That is what happens today when the readers are offered, so there is no change, but the plan and `spill.md` should say so in one sentence, because someone reading `spillToolResultsOver` will assume it means results only.

### 8. Spill value above the limit: at least warn

Decision 6 accepts that `spillToolResultsOver: 50000` with `maxToolResultChars: 20000` cuts results between 20,000 and 50,000 and spills only above 50,000. That is a configuration nobody wants. A guide row is easy to miss. Since `spillFor` already throws for a missing reader, it could also throw when `over` is above a finite ceiling, or at least log a warning through `run.log`. If the plan keeps "each rule does its one thing", say in the dev doc why no check was added.

## Small notes

- The error message in "The new rules" is good. Add the actual tool names the call did offer, so a `.rename()` mistake is obvious: "its tools (fetchMarkdown, readOutput) do not include readSpill".
- `spillFor` runs at `prompt.ts:691`, before the thread is restored or any request is built, so the throw does come before the first request, including on a resume. The Task 2 check item can be ticked by reading, no test needed beyond `spillWithoutReadersFails`.
- `Spill` as a type name is terse. `SpillSettings` or `SpillOption` reads better beside `SpillReaders`, which already exists.
- Task 3's `spillWithoutReadersFails` relies on the `def`'s automatic try-catch turning the throw into a failure. `docs/site/guide/error-handling.md:170` confirms that, so the test design holds.
- The `llmOptions` parameter in `shared.agency`: add a case to whatever already tests `llmOptions` (`tests/agency/agents/` or the toolkits test) that `spillToolResultsOver: 100000` writes the key and `0` leaves it out, matching how `maxToolCallRounds` is tested.
- `everyAgentCarriesTheReadersOnce` in `tests/agency/agents/toolkits.agency` still holds and still matters: after this change, an agent that drops the readers would throw at its first `llm()` call instead of silently cutting. Mention that in the test's comment.
- `PREVIEW_CHARS` comment fix is in the plan; the `DEFAULT_READERS` comment in `toolOutputStore.ts` and the `shellTools` docstring both say the readers "read back the output safeBash saved", which stays true. Nothing else in the store file needs rewording.
- `docs/dev/runtime/config.md:284` describes `client.maxToolResultChars` without mentioning spilling. It does not need the new option, since the option is per call, but one clause saying "a longer result is cut unless the call sets `spillToolResultsOver`" would keep the two docs in step.
