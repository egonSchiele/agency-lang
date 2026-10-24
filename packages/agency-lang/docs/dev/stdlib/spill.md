# `std::spill`: where long tool output goes

`safeBash` used to cut a command's output at 2000 characters. That hid whether a build had finished, and the model re-ran the build through bash to find out. Now output past the cap is saved and the model gets a preview: the exit code, a few lines from each end, and the name the output was saved under. The same happens to any tool result longer than `maxToolResultChars`: in trace `wX5GvrUq` a 106 KB page from `fetchMarkdown` was cut at the loop's cap with a bare `[tool result truncated]` marker and nothing to read the rest with. The loop now saves it the same way.

`lib/runtime/toolOutputStore.ts` owns the store and the notice. `stdlib/spill.agency` is the three functions the Agency side sees: `keepOutput`, which `safeBash` calls on every output, and the two readers, `readSpill` and `grepSpill`. `lib/stdlib/spill.ts` joins the two.

## Decisions

**The store is in the run's globals, under the `__internal` module.** The first version wrote each output to a file in `~/.agency-agent/tool-output`. That broke pause and resume: a checkpoint restored in another process, or after the directory was cleaned, found no file, while the model's conversation still named it. It was also a write path, `std::spill::write`, that the recommended policy had to approve and that a fixed directory and a name check existed only to make safe. The output is already in memory when it is spilled, so disk bought nothing. The globals have every property the store needs, the ones the guide's state isolation and checkpointing pages describe: each run has its own copy, every checkpoint carries them, a resume brings them back in any process, a `fork` branch gets a copy, and a tool call made by `llm()` shares the caller's copy. The fetch cache (`fetch-cache.md`) keeps its one object the same way, under `__internal` as `__fetchCache`, and reaches it from TypeScript with `run.globals.get(GlobalStore.INTERNAL_MODULE, key)`. The store is `__toolOutput` beside it. A module `let` in `spill.agency` would have had the same properties, but the tool loop could not have written to it, and the loop is where the cap is applied.

**One array, oldest first.** `{ entries: [{ name, text }] }`. Eviction shifts from the front; a lookup walks at most a few dozen entries; the total is a sum over the same array. Nothing can drift. Names keep the shape the file version used, `<timestamp>-<hex>.log`, so a model that learned it from older logs sees the same thing. The name check that used to keep a path out of the directory now keeps a lookup from matching anything but a name the store issued.

**The cap is 1,000,000 characters, set by hosted resume.** In hosted serving each interrupt carries its own checkpoint, the response repeats the whole array as the `state` string, and the client posts the interrupts back to resume (`how-hosted-serving-works.md`). The server refuses a body over 10 MB (`MAX_BODY_BYTES` in `lib/serve/constants.ts`), and the MCP stdio transport has the same line limit. A checkpoint is JSON bytes, larger than the characters it holds, and an isolated branch paused on an interrupt holds its own copy of the globals. So one copy of the store has to stay well under a quarter of 10 MB. A million characters holds ten 100 KB pages and leaves room for two copies, escaping, and the rest of the checkpoint. Before an entry is added, the oldest entries go until it fits; an entry larger than the whole cap is kept alone, because the notice will already have promised its name.

**A miss is a `Result` failure, never an error.** `readSpill` and `grepSpill` answer a name that is not in the store with `Saved output <name> is no longer available. Run the command again if you need it.` One message for every cause: evicted, saved before a checkpoint this run resumed from, or saved by another run. A tool call that hits it gets an ordinary tool error and the run goes on.

**The loop's cap saves through the same store.** `capToolResultForLlm` in `lib/runtime/toolInvocation.ts` returns a result untouched under `maxToolResultChars`, as before. Over it, the stringified result is stored whole and the model gets the notice, at whatever cap the call resolved: per call, `setLlmOptions`, `agency.json`, or the default. `fetch` and `fetchMarkdown` are untouched, so a program that calls them directly gets the page; only what the loop sends to the model is capped. The loop also knows the model's tool list, so when it has no `readSpill` the notice ends with "This agent has no readSpill tool, so the rest cannot be read from here" instead of naming a tool the model lacks. That is a backstop; the fix for agents is the next decision.

**`spillTools()`, and every agent carries it once.** `readSpill` and `grepSpill` used to ride in `shellTools()`. The agents that fetch pages use `webTools()` and never had them, so the notice told the researcher to call tools it did not have. Adding the readers to `webTools()` too would have broken the coding agent, which carries both bundles: a duplicate tool name throws before the request is sent. So the readers are their own bundle, `spillTools()`, and each stdlib agent that uses `shellTools()` or `webTools()` adds it once. `everyAgentCarriesTheReadersOnce` in `tests/agency/agents/toolkits.agency` pings every one of those agents' tool lists for the two readers and for duplicate names.

**No effects.** There is no write, so `std::spill::write` is gone. `std::spill::read` is gone too: the store holds only text the model's conversation was handed a name for, so reading it exposes nothing the thread does not already hold, and an interrupt that is always approved is noise in `agency interrupts` and in the policy table. A policy that wants to stop the model reading saved output refuses the two tools by name.

**Two caps, two numbers.** `MAX_STDOUT_LEN` (2000) is what `safeBash` hands back inline, because command output is mostly noise. `maxToolResultChars` (100,000 by default) is the loop's limit for any tool, because a page is mostly wanted. A `safeBash` result is already under 2000 characters when it reaches the loop, so it is never stored twice.

**The preview is bounded by characters.** `previewHead` and `previewTail` each stop after `PREVIEW_CHARS`, and a single line is cut at `PREVIEW_LINE_LEN`. An earlier version showed fifteen lines from each end, which for 200-character lines made a preview three times longer than the output it replaced. The tail never reaches back into lines the head showed, so a two-line output is not printed twice.

## Where saved output ends up

Not in a directory of its own. It is in every checkpoint the run writes: the agent's session file after every turn (`docs/dev/agents/agent-sessions.md`), every trace step on which the globals changed, and every hosted interrupt. Those files already hold the conversation, so this adds nothing new in kind; `how-hosted-serving-works.md` says that an end user who receives an interrupt now receives the saved text as well as the previews. Files left in `~/.agency-agent/tool-output` by older versions are never read and can be deleted.

## What it costs per step

`debugStep` builds a checkpoint at every root-stack step whether or not a debugger is attached (`lib/runtime/debugger.ts`), and building one round-trips the globals through JSON; a `fork` or `parallel` clone does the same. With a full store of ten 100 KB entries that is about a millisecond per step; the review of this change timed forty such entries at about 5 ms. `instrument: false` removes the per-step checkpoint. The `__internal` module changes on every model call anyway, because the token stats live there, so a trace stores the module again on most steps; the cap is what bounds that.

## Branches and child processes

A `fork` or `parallel` branch runs on a copy of the globals, so an output saved inside a branch is readable by that branch's model and gone after the branch settles. The branch's conversation, where the name was announced, is gone with it, so nothing can ask for a name it never saw. A tool call inside `llm()` shares the caller's globals, which is the common case and needs nothing. A child run under `std::agency.run` (`subprocess-ipc.md`) is another run with its own globals, so its saved output is its own; the parent sees the child's result, as it always did.

## Where the pieces are

- `lib/runtime/toolOutputStore.ts`: the store shape and key, `MAX_STORE_CHARS`, `storeOutput`, `findOutput`, `isOutputName`, `missingOutputMessage`, and `outputNotice` with the preview helpers.
- `lib/runtime/toolInvocation.ts`: `capToolResultForLlm(result, cap, run, canRead)`.
- `lib/runtime/prompt.ts`: `canReadSpill`, computed from the offered tools, and `capForLlm`, the one closure the three cap sites (a result, a failure message, a rejection reason) call. `resultCap` in `lib/runtime/toolLoopGuards.ts` resolves the cap from the call, the branch default, and `agency.json`.
- `lib/stdlib/spill.ts`: `MAX_STDOUT_LEN`, `_keepOutput`, `_readSpill`, `_grepSpill` over `currentRun()`.
- `stdlib/spill.agency`: `keepOutput`, `readSpill`, `grepSpill`.
- `stdlib/safeBash.agency` and `stdlib/safeBash/actions.agency` call `keepOutput` on every output path.
- `stdlib/agents/lib/toolkits.agency`: `spillTools()`, and the twelve agents that spread it.
- Tests: `lib/runtime/toolOutputStore.test.ts`, the `capToolResultForLlm` cases in `lib/runtime/prompt.test.ts`, `lib/stdlib/spill.test.ts`, `tests/agency/spill.agency` (eviction, a miss, a checkpoint round trip, and an over-cap result through the loop), `longOutputIsKept` and `spillToolsTakeNamesOnly` in `tests/agency/safeBash.agency`, and `everyAgentCarriesTheReadersOnce` in `tests/agency/agents/toolkits.agency`.

## Things that are easy to miss

- `survivesACheckpoint` in `tests/agency/spill.agency` evicts the saved entry from the live store between the `checkpoint()` and the `restore()`. Without that, the test would pass even if the checkpoint left the globals out, because the entry would still be in memory. The pass counter lives in TypeScript (`tests/helpers/mutableVar.js`) because an Agency counter is rolled back by the restore too.
- A saved entry and the message naming it land in the same checkpoint, because both are state of the same run. There is no state in which the model holds a name the store never had, except after eviction or a resume from an older checkpoint, which the miss message covers.
- A failing `runBash` sends stdout and stderr through `keepOutput` separately, so one failing build can produce two entries. `cliOutcome` in `safeBash.agency` concatenates the streams first. Both shapes predate this module and were left alone.
