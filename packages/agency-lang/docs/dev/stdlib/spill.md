# `std::spill`: where long tool output goes

`safeBash` used to cut a command's output at 2000 characters. That hid whether a build had finished, and the model re-ran the build through bash to find out. Now output past the cap is saved and the model gets a preview: the exit code, a few lines from each end, and the name the output was saved under. The same can happen to any tool result, when the `llm()` call sets `spillToolResultsOver`: in trace `wX5GvrUq` a 106 KB page from `fetchMarkdown` was cut at the loop's cap with a bare `[tool result truncated]` marker and nothing to read the rest with. With the option set, the loop saves it the same way.

`lib/runtime/toolOutputStore.ts` owns the store and the notice. `stdlib/spill.agency` is the three functions the Agency side sees: `keepOutput`, which `safeBash` calls on every output, and the two readers, `readSpill` and `grepSpill`. `lib/stdlib/spill.ts` joins the two.

## Decisions

**The store is in the run's globals, under the `__internal` module.** Saved output used to be written to files in `~/.agency-agent/tool-output`. That broke pause and resume: a checkpoint restored in another process, or after the directory was cleaned, found no file, while the model's conversation still named it. It was also a write path, `std::spill::write`, that the recommended policy had to approve. The output is already in memory when it is spilled, so the disk bought nothing.

The globals have every property the store needs, the ones the guide's state isolation and checkpointing pages describe: each run has its own copy, every checkpoint carries them, a resume brings them back in any process, a `fork` branch gets a copy, and a tool call made by `llm()` shares the caller's copy. The fetch cache (`fetch-cache.md`) keeps its one object the same way, under `__internal` as `__fetchCache`, and reaches it from TypeScript with `run.globals.get(GlobalStore.INTERNAL_MODULE, key)`. The store is `__toolOutput` beside it. A module `let` in `spill.agency` would have had the same properties, but the tool loop could not write to it, and the loop is where the cap is applied.

**One array, oldest first.** `{ entries: [{ name, text }] }`. Eviction shifts from the front, a lookup walks at most a few dozen entries, and the total is a sum over the same array, so there is no second structure to keep in step. Names have the shape `<timestamp>-<hex>.log`, for example `2026-09-04T01-02-03-000Z-a1b2c3.log`. The readers accept only that shape, so a lookup can match nothing but a name the store issued.

**The cap is 1,000,000 characters, set by hosted resume.** In hosted serving each interrupt carries its own checkpoint, the response repeats the whole array as the `state` string, and the client posts the interrupts back to resume (`how-hosted-serving-works.md`). The server refuses a body over 10 MB (`MAX_BODY_BYTES` in `lib/serve/constants.ts`), and the MCP stdio transport has the same line limit. A checkpoint is JSON bytes, larger than the characters it holds, and an isolated branch paused on an interrupt holds its own copy of the globals. So one copy of the store has to stay well under a quarter of 10 MB. A million characters holds ten 100 KB pages and leaves room for two copies, escaping, and the rest of the checkpoint. Before an entry is added, the oldest entries go until it fits. An entry larger than the whole cap is kept alone, because the notice will already have promised its name.

**A miss is a `Result` failure, never an error.** `readSpill` and `grepSpill` answer a name that is not in the store with `Saved output <name> is no longer available. Call the tool again if you need it.` One message covers every cause: evicted, saved before a checkpoint this run resumed from, or saved by another run. A tool call that hits it gets an ordinary tool error and the run goes on.

**The loop saves through the same store when the call asks it to.** Two `llm()` options decide what happens to a long tool result, and nothing else does. `maxToolResultChars` is a ceiling on what the model receives from one tool result. `spillToolResultsOver` turns spilling on. `capToolResultForLlm` in `lib/runtime/toolInvocation.ts` applies four rules, in order:

| The result | What the model gets |
| --- | --- |
| came from `readSpill` or `grepSpill`, and is over the limit, or over `spillToolResultsOver` when that is set | the result cut at the smaller of the two, with a note saying to read a smaller slice; nothing is saved |
| any other, with `spillToolResultsOver` set, and over it or over the limit | the result saved whole, and the notice, which fits under the limit |
| any other, with spilling off, and over the limit | the result cut at the limit, with `[tool result truncated: showing N of M chars]` |
| within the limits | the result unchanged |

The marker counts toward the limit, so a cut result is never longer than `maxToolResultChars` either.

**The tool list never changes what happens to a result.** Until October 2026 the loop saved a long result exactly when the call's tools included `readSpill`, and cut it otherwise. So the same call with the same options behaved differently depending on whether `shellTools()` happened to be in its tools, which nothing in the call said. Now the tools are read for two things only: to refuse a call that sets `spillToolResultsOver` without offering `readSpill`, since the model could never read a saved result back, and to name the readers in the notice. `spillSettings` in `toolInvocation.ts` does both, once per call, before the first request, so the refusal comes before any model call, on a resume too. The check that a result came from a reader looks at the tool that produced it, not at the list. A reader's own result is never saved again, because `readSpill(name)` with no offset or limit returns the whole entry, and saving the read again would hand the model a notice naming a copy, which it could read the same way.

**With spilling on, a result over either number is saved.** A result is saved when it is longer than `spillToolResultsOver` or longer than `maxToolResultChars`, whichever is smaller. Saving only above the spill value would make `spillToolResultsOver: 50000` with `maxToolResultChars: 20000` cut every result between the two, with nothing to read the rest with. It also means a user who lowers the limit (in `agency.json`, with `--max-tool-result-chars`, or with `setLlmOptions`) still gets spilling at their limit. So with spilling off, nothing is saved and anything over the limit is cut; with spilling on, nothing is cut except a reader's own result.

**`spillToolResultsOver` is per call only.** As a branch default it would apply to every later `llm()` call, and every one of those that offers no `readSpill`, including a plain call with no tools, would throw. Per call, the option and the tool list are written side by side. `LlmDefaults` does not have the key, so the type checker refuses `setLlmOptions({ spillToolResultsOver })`; a TypeScript caller that puts it on the branch defaults anyway gets a "set per llm() call" error from `spillSettings`. The `agency.json` schema does not know the key, so it is dropped like any other unknown key. The stdlib agents pass `AGENT_SPILL_OVER` (100,000, the default limit) from `std::agents/lib/shared` through `llmOptions`, so they save a long result exactly when they did before this option existed, at any limit.

**The notice fits the limit.** `outputNotice` takes the limit. It measures the text around the preview with both line counts at their largest, then gives each end of the preview what is left, up to `PREVIEW_CHARS`. The loop still cuts the notice at the limit, which only does anything when the limit is too small for the text around the preview (about 300 characters). Then the name and the instructions at the end are lost, but nothing shorter could hold them either.

**Error text is covered too.** The loop sends three things back for a tool call: its result, its error message when it fails, and the reason when it was rejected. All three go through the same cap, so a long error message is saved when spilling is on, and its notice has no exit code.

`maxToolResultChars` is resolved per call, then `setLlmOptions`, then `agency.json`, then the default (`resultCap` in `lib/runtime/toolLoopGuards.ts`). `fetch` and `fetchMarkdown` themselves do not change, so a program that calls them directly gets the page. Only what the loop sends to the model is capped.

**An object result is saved indented.** A result that is not a string is measured against the cap as compact JSON, which is what the model would have seen. It is saved as `JSON.stringify(result, null, 2)`. Compact JSON is one line, and the readers work in lines: `readSpill`'s offset and limit would return the whole line, and `grepSpill` would match it whole. Indented, a 150,000-character JSON result has lines to slice and search, and the preview shows real lines from each end.

**The readers are found by module and registered name.** `spillReaders` looks through the call's tools, for the refusal and the notice, for functions from `stdlib/spill.agency` whose registered name is `readSpill` or `grepSpill`. A `.rename()` or `.partial()` keeps both, so a renamed reader still counts, and the notice uses the name the model sees. A user function that happens to be called `readSpill` does not count. When only `readSpill` is offered, the notice leaves out the `grepSpill` sentence. `safeBash` does not know the call's tool list, so its notice always names the two by their own names.

**`shellTools()` carries the readers, and `spillTools()` is for agents that fetch without it.** The agents that fetch pages build their tools from `webTools()`, which has no readers, so a long page would have reached them as a cut result. Each of those agents adds `spillTools()`, which is the two readers on their own. The agents that carry `shellTools()` already have them, and adding `spillTools()` too would list each reader twice, which throws before the request is sent. `everyAgentCarriesTheReadersOnce` in `tests/agency/agents/toolkits.agency` checks every stdlib agent's tool list for the two readers and for duplicate names.

**No effects.** There is no write, so there is no `std::spill::write`. There is no `std::spill::read` either: the store holds only text the model's conversation was handed a name for, so reading it exposes nothing the thread does not already hold, and an interrupt that is always approved is noise in `agency interrupts` and in the policy table. A policy that wants to stop the model reading saved output refuses the two tools by name.

**Two caps, two numbers.** `MAX_STDOUT_LEN` (2000) is what `safeBash` hands back inline, because command output is mostly noise. `maxToolResultChars` (100,000 by default) is the loop's limit for any tool, because a page is mostly wanted. A `safeBash` notice is under 2000 characters when it reaches the loop, so it is never saved twice, unless the call sets `spillToolResultsOver` below that. Then the notice is saved again and the model gets a notice pointing at a notice. Nobody sets a value that low on purpose, and special-casing `safeBash` would be another hidden rule.

**The preview is bounded by characters.** `previewHead` and `previewTail` each stop after `PREVIEW_CHARS`, or less when the notice has to fit a smaller limit, and a single line is cut at `PREVIEW_LINE_LEN`. Fifteen lines from each end of 200-character lines would make a preview three times longer than the output it replaced. The tail never reaches back into lines the head showed, so a two-line output is not printed twice.

## Where saved output ends up

In every checkpoint the run writes: the agent's session file after every turn (`docs/dev/agents/agent-sessions.md`), every trace step on which the globals changed, and every hosted interrupt. Those files already hold the conversation. `how-hosted-serving-works.md` says that an end user who receives an interrupt receives the saved text as well as the previews. Files left in `~/.agency-agent/tool-output` by older versions are never read and can be deleted.

## What it costs per step

`debugStep` builds a checkpoint at every root-stack step whether or not a debugger is attached (`lib/runtime/debugger.ts`), and building one round-trips the globals through JSON. A `fork` or `parallel` clone does the same. A JSON round trip of ten 100,000-character entries takes about a millisecond in Node, and of forty such entries about 5 ms, so the cap also bounds this. `instrument: false` removes the per-step checkpoint. The `__internal` module changes on every model call anyway, because the token stats live there, so a trace stores the module again on most steps.

## Branches and child processes

A `fork` or `parallel` branch runs on a copy of the globals, so an output saved inside a branch is readable by that branch's model and gone after the branch settles. The branch's conversation, where the name was announced, is gone with it, so nothing can ask for a name it never saw. A tool call inside `llm()` shares the caller's globals, which is the common case. A child run under `std::agency.run` (`subprocess-ipc.md`) is another run with its own globals, so its saved output is its own. The parent sees the child's result.

## Where the pieces are

- `lib/runtime/toolOutputStore.ts`: the store shape and key, `MAX_STORE_CHARS`, `storeOutput`, `findOutput`, `isOutputName`, `missingOutputMessage`, `spillReaders`, `isSpillReader`, and `outputNotice` with the preview helpers.
- `lib/runtime/toolInvocation.ts`: `spillSettings`, which reads the call's option and tools once, and `capToolResultForLlm`, which applies the rules in the table above.
- `lib/runtime/prompt.ts`: `capForLlm`, the one closure the three cap sites (a result, a failure message, a rejection reason) call, with the spill settings found once per call.
- `lib/stdlib/spill.ts`: `MAX_STDOUT_LEN`, `_keepOutput`, `_readSpill`, `_grepSpill` over `currentRun()`.
- `stdlib/spill.agency`: `keepOutput`, `readSpill`, `grepSpill`.
- `stdlib/safeBash.agency` and `stdlib/safeBash/actions.agency` call `keepOutput` on every output path.
- `stdlib/agents/lib/toolkits.agency`: `shellTools()` with the readers, and `spillTools()` for the agents that fetch without it.
- `stdlib/agents/lib/shared.agency`: `AGENT_SPILL_OVER` and the `spillToolResultsOver` parameter of `llmOptions`.
- Tests: `lib/runtime/toolOutputStore.test.ts`, the `capToolResultForLlm` cases in `lib/runtime/prompt.test.ts`, `lib/stdlib/spill.test.ts`, `tests/agency/spill.agency` (eviction, a miss, a checkpoint round trip, a result saved through the loop, a result cut though the readers are offered, the refusal without `readSpill`, and a result cut without the readers), `longOutputIsKept` and `spillToolsTakeNamesOnly` in `tests/agency/safeBash.agency`, and `everyAgentCarriesTheReadersOnce` in `tests/agency/agents/toolkits.agency`.

## Things that are easy to miss

- A saved entry and the message naming it land in the same checkpoint, because both are state of the same run. The model can only hold a name the store does not have after an eviction, or after a resume from a checkpoint older than the save, and the miss message covers both.
- A failing `runBash` sends stdout and stderr through `keepOutput` separately, so one failing build can produce two entries. `cliOutcome` in `safeBash.agency` joins the streams first and produces one.
- The table's first row depends on the reader check. A tool that wraps `readSpill` in a function of its own is not a reader to the loop, so its long results are saved again. Offer the readers themselves.
