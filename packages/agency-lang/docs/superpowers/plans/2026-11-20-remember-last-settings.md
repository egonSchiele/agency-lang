# Remember the Last Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new chat in `agency agent`, or in any front-end that runs the session core (Perry), starts with the preset, model and effort the person last chose. That replaces the default preset.

**Architecture:** The session core writes the active preset's name and the session's own model choices to `<agent home>/last-settings.json` after a model, effort or preset answer works. A run that names no preset, model or effort flag starts from that file: its preset, then its choices on top, as if the person had chosen them again. A preset marked `"default": true` is read only to seed the start for people upgrading. The `setDefaultPreset` tool and the `setDefault` edit go away. Anything in the file that can't be used, including a model whose API key is missing, is dropped with a warning, and the run starts with no preset and no choices.

**Tech Stack:** Agency (`lib/agents/agency-agent/`), TypeScript (`lib/stdlib/`), vitest, `agency test`.

**Spec:** the Decisions section below. It comes from a conversation with the owner on 2026-11-20. Two reviews sit beside this plan: `-architecture-review.md` argues for the overall shape, and `-review.md` checks the tasks against the code. Both are folded in.

## Decisions

- **One concept, not two.** "What a new chat starts with" is the last settings. There is no default preset any more. To make new chats start with a preset, a person picks it in a chat (`/preset <name>`, or Perry's settings panel). The owner chose this over ranking the two.
- **What is kept:** the active preset's name and the session's `ModelChoices` (`pin`, `slots`, `effort`), with `llmOptions` removed. Never the budget or the tool limits. `llmOptions` can hold a server address (`baseUrl`), and the coordinator's `useLlmOptions` tool can set them. Keeping them would let text injected into one chat pick the server every later chat talks to.
- **Only the person writes it.**
  - The file is written after a `model`, `effort` or `preset` answer that worked, in a saved session (`currentRecord() != null`) that was started with no model or effort flag.
  - A front-end sends those answers; the model can't. The terminal's `/model` and `/preset` reach the core as answers (`lib/repl.agency:163`, `:185`), and Perry's settings panel sends all three.
  - Starting a run, a refused answer, an `options` answer, a `local` answer and a one-shot run write nothing. `/local` changes the models without changing `ModelChoices`, and `/preset save` already refuses to copy it (`movedByLocalCommand`), so don't add a fourth arm for it.
  - An incognito session has no record, so the record check covers it.
  - The `setDefaultPreset` tool is removed rather than pointed at the file, so the agent has no way to change what new chats start with.
  - Any chat counts, including an old one that was resumed, and the last write wins.
- **Flags make a run a one-off, both ways.** A run started with a model flag (`--model`, `--fastmodel`, `--slowmodel`, `--provider`, `--local`) or `--effort` doesn't read the file, and it doesn't write it either. Those flags live in the startup flags, not in `ModelChoices`, so a write would keep only part of what the session ran. `--preset` alone still reads nothing, but it does write: the active preset's name holds it exactly. Perry passes no flags.
- **When it is read:** at the start of every run whose `ProgramStart` names no preset (`preset == ""`), no model flag (`!hasModelFlags(models)`) and no effort flag (`models.effort == null`). That includes `-p`: with no default preset left, the file is the only "usual settings" a script can lean on. The PR description tells scripts that need a fixed model to pass `--preset`.
- **A remembered model is checked like a flag.** Startup's provider detection, which is also where a missing API key fails the start, reads the remembered choices first. A model whose key is gone falls back with a warning, instead of starting and then failing every turn.
- **Upgrading:** when there is no file and exactly one saved preset is marked `"default": true`, a run starts as if the file named that preset, with no choices. Nothing is written at start, so the mark keeps working until the person's first change. After that the mark is ignored. `checkPreset` still accepts the `default` field, and a save that replaces the marked preset keeps the mark (`keepDefaultFlag`), so the seed survives `/preset save`.
- **No interrupt for the read or the write.** A rule added to `recommended` would never reach a saved `policy.json` (approval-policies.md, "A saved policy does not follow `recommended`"), so every existing user would be asked on each model change. The file is agent housekeeping, like the session records `_saveSession` writes. Only the person's own answer causes the write, and it holds names that are checked against the known providers and presets when they are read.
- **A failure never stops anything that worked before.**
  - A write that fails is a warning notice, and the answer still counts.
  - A file that is missing or malformed is ignored without a word.
  - Settings in the file that no longer work are dropped with a warning, and the run starts with no preset and no choices.
  - If that start fails too (no API keys at all), the failure is returned and `main` throws, as it does today.
- **Breaking change:** `"default": true` stops deciding new chats once the person changes a setting, and `setDefaultPreset` is gone. The PR description says so. Don't edit `CHANGELOG.md`; it's written at release time.
- **No `docs/site/**` edits.** The owner writes the user-facing docs. The PR description names the pages that go stale: at least `docs/site/agent/models.md` and `docs/site/cli/agent.md`, plus any page `grep -rln "default" docs/site` shows to describe a default preset.

## Global Constraints

- File: `last-settings.json` in the agent home (`POLICY_DIR` in `lib/agents/agency-agent/lib/config.agency`). Shape: `{ "preset": string, "choices": { "pin": string, "slots": { [slot]: string }, "effort"?: string } }`.
- Warning texts, verbatim:
  - write failed: `Could not remember these settings for new chats: <error>`
  - preset gone: `The preset '<name>' your last chat used is gone or not valid; starting without it.`
  - settings fail to apply: `Your last settings could not be used: <reason>. Starting without them.`
- Run commands from `packages/agency-lang`. Run `make` before an `agency test js` run, since those tests load `dist/`.
- Never `git add` a folder. Restore `tests/agency-js/llm-provider-defaults/log.jsonl` before committing. Any new test that drives the core runs in a temp `AGENCY_AGENT_HOME`, as the session-core test does.

## Review Focus

1. **A saved `policy.json` with no new rule:** changing the effort must not raise any interrupt besides the next `agent::sessionInput` pause. The session-core test's `PIN` policy decides only that one effect. Task 3's `noPromptForRemembering` pins this.
2. **The agent can't change what new chats start with:**
   - no `llmOptions` in the file after the coordinator's `useLlmOptions` and a person's change (Task 2's `keepsNoOptions`, Task 3's `noOptionsKept`);
   - no `setDefaultPreset` tool (Task 5's `noSetDefaultTool`).
3. **Remembered settings that can't run in this environment** (a model whose key is missing here, a deleted preset, a local preset where local models are off): the run still starts, on no preset, with a warning. Task 4's `lastModelWithoutKeyFallsBack`, `rememberedPresetGone` and `localPresetFallsBack`.
4. **A run started with flags:** it doesn't read the file, and it doesn't write a partial copy of what it ran. Task 3's `flagSessionNotRemembered` and Task 4's `flagIgnoresLast`.
5. **Someone upgrading with `"default": true`:** their first chat after the upgrade starts on that preset, a `/preset save` keeps the mark, and their first change replaces it. Task 4's `seedFromDefaultMark` and `changeReplacesSeed`, plus the kept `saveKeepsTheDefaultFlag`.

---

### Task 1: The file

Agency-lang owns the file's format, and Perry writes it too (its onboarding, after the release). So the reader and the writer live in TS, where both can call them.

**Files:**
- Create: `lib/stdlib/agentLastSettings.ts`
- Test: `lib/stdlib/agentLastSettings.test.ts`

**Interfaces:**
- Produces, importable from Agency and from Perry as `agency-lang/stdlib-lib/agentLastSettings.js`:
  - `export type LastChoices = { pin: string; slots: Record<string, string>; effort?: string }`, the stored part of the Agency `ModelChoices`.
  - `export type LastSettings = { preset: string; choices: LastChoices }`
  - `export const LAST_SETTINGS_FILE = "last-settings.json"`
  - `export async function _readLastSettings(home: string): Promise<LastSettings | null>`
  - `export async function _writeLastSettings(home: string, settings: LastSettings): Promise<string>`, which returns "" on success, else the error message, like `_saveSession`.

- [ ] **Step 1: Write the failing tests** (vitest, each in a fresh temp home). Call `{ preset: "big", choices: { pin: "claude-opus-4-8", slots: { reasoning: "openai/o5" }, effort: "low" } }` VALID.
  - `round trip`: write VALID, then read it back and `toEqual` VALID.
  - `no effort`: VALID without `effort` reads back without an `effort` key.
  - `missing file`: `_readLastSettings(emptyHome)` is `null`.
  - `not JSON`: a file containing `{nope` reads as `null`.
  - `wrong shape`: each of these reads as `null`: `choices.slots` an array, `choices.slots.main` a number, `choices.effort` a number, `preset` null, and `choices` missing.
  - `extra keys dropped`: VALID with `choices.llmOptions: { baseUrl: { mlx: "https://x" } }` and a top-level `budget` reads as VALID exactly.
  - `home made`: writing into a home that doesn't exist yet returns "", and the file is there.
- [ ] **Step 2: Run them and see them fail.** Run `pnpm vitest run lib/stdlib/agentLastSettings.test.ts`. Expected: it fails because the module doesn't exist.
- [ ] **Step 3: Implement both functions with `currentHost()`**, as `_saveSession` in `agentSessions.ts` does. `host.files.writeText` renames a finished temp file over the target. Make the home first, as `writeInSessions` does. The read type-checks each field and builds a new object from the known fields only. It does not check the effort's value; Task 2 does.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit:** `git add lib/stdlib/agentLastSettings.ts lib/stdlib/agentLastSettings.test.ts && git commit -m "agent: a file for the last settings a person chose"`

### Task 2: Choices to the file and back

**Files:**
- Create: `lib/agents/agency-agent/lib/lastSettings.agency`
- Modify: `lib/agents/agency-agent/lib/session.agency`, to add `startedWithModelFlags`
- Test: `lib/agents/agency-agent/tests/lastSettings.agency`, `lib/agents/agency-agent/tests/lastSettings.test.json`

**Interfaces:**
- Consumes: Task 1's `_readLastSettings` and `_writeLastSettings`; `ModelChoices`, `ModelFlags`, `hasModelFlags` and `noModelChoices` (`modelRequest.agency`); `EFFORT_CHOICES` (`effort.agency`); `PresetTable` and `defaultNames` (`presets.agency`); `POLICY_DIR` (`config.agency`); `currentRecord` (`record.agency`); `notice` (`notice.agency`).
- Produces:
  - In `session.agency`: `export def startedWithModelFlags(): boolean`, which is `hasModelFlags(_startupFlags) || _startupFlags.effort != null`.
  - `export type LastSettings = { preset: string; choices: ModelChoices }`. This is the Agency side of Task 1's type, built on the existing `ModelChoices`. It's the only other copy, as `SessionRecord` has one in each language.
  - `export def lastSettingsOf(preset: string, choices: ModelChoices): LastSettings`: pure, and drops `choices.llmOptions`.
  - `export def checkedChoices(last: LastSettings): ModelChoices`: pure. It drops an `effort` that isn't in `EFFORT_CHOICES`.
  - `export def usesLastSettings(preset: string, flags: ModelFlags): boolean`: pure, true when `preset == ""`, `!hasModelFlags(flags)` and `flags.effort == null`.
  - `export def seedFromDefault(table: PresetTable): LastSettings | null`: pure. When `defaultNames(table)` has exactly one name, that name with `noModelChoices()`; otherwise null.
  - `export def readLastSettings(): LastSettings | null`: `_readLastSettings(POLICY_DIR)`.
  - `export def rememberSettings(preset: string, choices: ModelChoices)`: does nothing when `currentRecord() == null` or `startedWithModelFlags()`. Its doc comment says that an incognito session has no record. Otherwise it writes `lastSettingsOf(preset, choices)`, and a write that fails is a `notice(..., "warning")` with the write-failed text.

- [ ] **Step 1: Write the failing tests** (one node each, in the `effort.agency` test style):
  - `keepsNoOptions`: `lastSettingsOf("big", { pin: "opus", slots: {}, effort: "high", llmOptions: { temperature: 0.2 } })` as JSON is `{"preset":"big","choices":{"pin":"opus","slots":{},"effort":"high"}}`.
  - `badEffortDropped`: `checkedChoices` of a value with `effort: "max"` has no `effort` key. With `effort: "low"` it keeps it.
  - `flagsTurnItOff`: `usesLastSettings` is true for `("", noModelFlags())`, and false for preset `"big"`, for a `pin` flag, and for `effort: "high"`.
  - `seedNeedsOneDefault`: `seedFromDefault` gives `big` for a table with only `big` marked, and null for none marked or two marked.
- [ ] **Step 2: Run them and see them fail.** Run `pnpm run agency test lib/agents/agency-agent/tests/lastSettings.agency`. Expected: an unknown import.
- [ ] **Step 3: Implement the functions.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit:** `git add lib/agents/agency-agent/lib/lastSettings.agency lib/agents/agency-agent/lib/session.agency lib/agents/agency-agent/tests/lastSettings.agency lib/agents/agency-agent/tests/lastSettings.test.json && git commit -m "agent: last settings to and from a session's choices"`

### Task 3: The core remembers a change

**Files:**
- Modify: `lib/agents/agency-agent/core.agency`, the `model`, `effort` and `preset` arms of the answer `match` (around lines 413–440)
- Test: `tests/agency-js/session-core/test.js`, `tests/agency-js/session-core/fixture.json`

**Interfaces:**
- Consumes: `rememberSettings` (Task 2), `activePresetName()` (already imported) and `modelChoices()` (already imported).

- [ ] **Step 1: Make the existing script independent of the file.**
  - In `test.js`, `startSession` removes `path.join(process.env.AGENCY_AGENT_HOME, "last-settings.json")` (`rmSync` with `force: true`) before it starts, unless a third argument `{ keepLastSettings: true }` is passed.
  - Move the `noModelFlags` constant (line 417 today) to the top of the script, beside `startData`, so every section can use it.
- [ ] **Step 2: Write the failing checks**, as new `result` keys with their values in `fixture.json`. The `chat` session starts with a `pin` flag (`startData`), so it checks the flag rule. The `preset` session in the presets section starts with `noModelFlags`, so it checks the writes.
  - `lastSettingsAfterStart`: right after `const chat = await startSession()`, `existsSync(lastSettingsFile)` is `false`.
  - `flagSessionNotRemembered`: after `chat`'s existing `effort: "low"` answer, there is still no file.
  - `lastSettingsAfterEffort`: after `preset`'s existing `effort: "low"` answer, the file parses to `{ preset: "", choices: { pin: "", slots: {}, effort: "low" } }`.
  - `noPromptForRemembering`: the effect of the pause after that answer is `agent::sessionInput`.
  - `presetRemembered`: after `preset.answer({ kind: "preset", name: "big" })`, the file is `{ preset: "big", choices: { pin: "", slots: {} } }`.
  - `badAnswerLeavesIt`: after the existing `preset: "mine"` answer, which fails, the file's text is what it was before.
  - `noOptionsKept`: on `preset`, answer `{ kind: "options", options: { temperature: 0.3 } }`, then `{ kind: "effort", effort: "high" }`. The parsed file's `choices` has no `llmOptions` key.
  - `unsavedNotRemembered`: in a session started with `models: noModelFlags` and `session.record: null`, an effort answer leaves no file.
- [ ] **Step 3: Run it and see it fail.** Run `make && pnpm run agency test js tests/agency-js/session-core`. Expected: the new keys differ from the fixture.
- [ ] **Step 4: Call `rememberSettings(activePresetName(), modelChoices())`** in each of the three arms, only when the answer worked.
- [ ] **Step 5: Run the test and see it pass.**
- [ ] **Step 6: Commit:** `git add lib/agents/agency-agent/core.agency tests/agency-js/session-core/test.js tests/agency-js/session-core/fixture.json && git commit -m "agent: remember a model, effort or preset change for new chats"`

### Task 4: A new run starts from them

**Files:**
- Modify: `lib/agents/agency-agent/lib/modelRequest.agency` (`detectionInputs`)
- Modify: `lib/agents/agency-agent/lib/presets.agency` (`choosePreset`)
- Modify: `lib/agents/agency-agent/lib/session.agency` (`startModels`)
- Modify: `lib/agents/agency-agent/lib/lastSettings.agency`, to add the start functions
- Modify: `lib/agents/agency-agent/program.agency` (`main`)
- Test: `tests/modelRequest.agency`, `tests/presets.agency` and `tests/lastSettings.agency`, each with its `.test.json`; `tests/agency-js/session-core/test.js` and `fixture.json`

**Interfaces:**
- Consumes: `usesLastSettings`, `readLastSettings`, `seedFromDefault` and `checkedChoices` (Task 2); `readPresetTable` and `startPresetQuiet` (`presets.agency`).
- Produces:
  - `detectionInputs(request)` reads `request.choices` first: `pin` from `choices.pin`, then the flags, then the preset, and `main` and `reasoning` the same way from `choices.slots`. Nothing that runs today changes, since `startModels` and `switchPreset` both pass `noModelChoices()`. A remembered model whose key is missing now fails `startModels`, as a `--model` flag does.
  - `choosePreset(flag: string, table: PresetTable): Result<PresetChoice>` keeps its signature but stops picking a default: `flag == ""` chooses no preset. The multiple-defaults warning goes. The `startPresetQuiet` signature doesn't change.
  - `startModels(flags: ModelFlags, saveSearchChoice: boolean = true, choices: ModelChoices = noModelChoices()): Result<boolean>`, which builds the request from `choices` and calls `setModelChoices(choices)` on success.
  - In `lastSettings.agency`:
    - `export type StartRequest = { preset: string; flags: ModelFlags; saveSearchChoice: boolean; settings: Settings }`
    - `export def startWith(last: LastSettings | null, start: StartRequest): Result<string[]>`, which returns the warnings to show:
      - With a `last`, it calls `startPresetQuiet(last.preset, start.settings)`, then `startModels(start.flags, start.saveSearchChoice, checkedChoices(last))`.
      - If the preset fails, it adds the "gone" warning. If the models fail, it adds the "could not be used" warning, with the failure's text as `<reason>`. Either way it starts again with `""` and no choices.
      - The warnings returned are those of the attempt that was kept, plus the fallback warning. The first attempt's are dropped, so a table warning doesn't show twice.
      - If the fallback start fails too, that failure is returned.
      - Without a `last`, it does what `main` does today, and a failure is returned as before.
    - `export def startPresetAndModels(start: StartRequest): Result<string[]>`, which works out `last` and calls `startWith`. `last` is null unless `usesLastSettings(start.preset, start.flags)`; then it is `readLastSettings() ?? seedFromDefault(readPresetTable(start.settings.presets))`.
  - `main` builds a `StartRequest` from its `ProgramStart` and calls `startPresetAndModels` in place of its two steps, then shows the warnings. It keeps its `throw` on failure.

- [ ] **Step 1: Change the unit tests.**
  - `tests/modelRequest.agency`, `choicesComeFirstInDetection`: a request with `choices.pin: "openrouter/moonshotai/kimi-k3"` and a preset whose `pin` is `claude-opus-4-8` gives `detectionInputs(...).pin == "openrouter/moonshotai/kimi-k3"`. With `noModelChoices()`, it gives the preset's pin.
  - `tests/presets.agency`: every case that expects `choosePreset("", table)` to pick a marked default now expects `""`, with no warning. Delete the two-defaults warning case. Add `noFlagNoPreset`: a table with `big` marked default, and `choosePreset("", table)` chooses `""`.
  - `tests/lastSettings.agency`, `startFallsBackOnGonePreset`: `startWith({ preset: "deleted", choices: noModelChoices() }, request)`, with a `settings` that holds one valid preset. It succeeds, its warnings are exactly the "gone" text once, and `activePresetName() == ""` afterwards.
- [ ] **Step 2: Write the failing start checks** in `test.js`. Each prepares the agent home, then calls `startSession({ models: noModelFlags }, PIN, { keepLastSettings: true })`, with the presets section's `settings.json` (`big` is anthropic `claude-opus-4-8` with effort high; `mine` is local):
  - `startsFromLast`: the file `{ preset: "big", choices: { pin: "", slots: {}, effort: "low" } }` gives `pauseData.preset == "big"` and `pauseData.effort == "low"`.
  - `flagIgnoresLast`: the same file with `startData()`'s default `models` (a `pin` flag) gives `preset == ""`.
  - `rememberedPresetGone`: the file naming preset `deleted` gives a running session (not `ended`) with `preset == ""`, and one `session.notice` at level `warning` with the "gone" text.
  - `localPresetFallsBack`: with `_setLocalModelsAllowed(false)` and the file naming `mine`, the session runs with `preset == ""`, and there is a warning notice that starts with `Your last settings could not be used: Local models are not available here.`
  - `lastModelWithoutKeyFallsBack`: delete `OPENROUTER_API_KEY` from `process.env` and write the file `{ preset: "", choices: { pin: "openrouter/moonshotai/kimi-k3", slots: {} } }`. The session runs with `preset == ""`, and there is a warning notice that starts with `Your last settings could not be used:`. Put the key back if it was set.
  - `seedFromDefaultMark`: no file, and `settings.json` with `big` marked `"default": true`. It gives `preset == "big"`, and still no file exists after the start.
  - `changeReplacesSeed`: in that session, answer `{ kind: "effort", effort: "low" }`. The file then holds `{ preset: "big", choices: { pin: "", slots: {}, effort: "low" } }`. Next, rewrite `settings.json` with `big` unmarked and `small` (any valid preset) marked default, and start a new session: it starts on `big` with effort low, from the file, not from the mark.
  - `oneShotReadsLast`: the `startsFromLast` file with `oneShot: true` in the start data gives `preset == "big"`.
- [ ] **Step 3: Run them and see them fail.** Run `pnpm run agency test` on each of the three unit test files, then `make && pnpm run agency test js tests/agency-js/session-core`.
- [ ] **Step 4: Implement** the changes above.
- [ ] **Step 5: Run them and see them pass.** Also run `pnpm run agency test lib/agents/agency-agent/tests/presetSession.agency` and `tests/localRouter.agency`, which call `startModels`.
- [ ] **Step 6: Commit:** `git add` the files above by name, then `git commit -m "agent: a new run starts from the last settings, not a default preset"`

### Task 5: Retire the default preset

**Files:**
- Modify: `lib/agents/agency-agent/lib/presetTools.agency`: delete `setDefaultPreset`, the "still the default" text in `savePreset`'s reply, and the "it was the default" text in `deletePreset`'s reply.
- Modify: `lib/agents/agency-agent/lib/presets.agency`:
  - Delete the `setDefault` kind from `PresetEdit`, `withDefaultFlag`, `wasDefault` from `PresetEditOutcome`, the `default` mark in `presetMarks`, and the `default` field of `PresetListing`.
  - Keep `keepDefaultFlag`. While the mark seeds new chats, a save that replaces the marked preset must keep it.
  - Keep `defaultNames`, which Task 2's seed uses.
  - Reword the `serverNotice` comment: it is the last settings, not a default preset, that apply with no flag.
- Modify: wherever the coordinator's tools are registered, so `setDefaultPreset` is no longer one (find it with `grep -rn setDefaultPreset lib`).
- Modify: `lib/stdlib/agentToolTrace.ts:568`: delete the `setDefaultPreset` row. The `toolPresentations` test fails on a missing row but not on a leftover one, so nothing else catches it.
- Modify: `lib/agents/agency-agent/skills/presets.md`: the description, the tool list and the "make it my default" example. To have new chats start with a preset, the user switches to it with `/preset <name>`; the agent can't do it for them.
- Modify: `lib/agents/agency-agent/lib/presetRules.agency`: only the comment on line 22, which names `setDefaultPreset`. The `default` field and its rule stay, so old files stay valid.
- Test: `tests/presetTools.agency` and its `.test.json`, `tests/presets.agency`, `tests/presetSession.agency`, `tests/presetSnapshot.agency`, `tests/presetRules.agency`.

- [ ] **Step 1: Change the tests.**
  - Delete the cases for `setDefaultPreset` and the `setDefault` edit.
  - Change the expected listing and edit replies to the new text.
  - Keep `saveKeepsTheDefaultFlag` (`tests/presetSession.agency:283`) as it is.
  - Add `noSetDefaultTool`: the coordinator's tool names don't include `setDefaultPreset`.
- [ ] **Step 2: Run them and see them fail.** Run `pnpm run agency test lib/agents/agency-agent/tests/presetTools.agency`, and do the same for the four other files.
- [ ] **Step 3: Make the deletions above.** Then `grep -rn "setDefault\|wasDefault\|withDefaultFlag" lib` finds nothing outside the tests.
- [ ] **Step 4: Run the five test files and see them pass.**
- [ ] **Step 5: Commit:** `git add` the changed files by name, then `git commit -m "agent: the default preset gives way to the last settings"`

### Task 6: Dev docs

**Files:**
- Modify: `docs/dev/agents/agent-presets.md`:
  - The opening paragraph: say that new chats start with the last settings, not "a preset marked default".
  - "How a run picks its models": the new order, which is flags, then the last settings, then `settings.model`, then the provider's defaults. Add that `detectionInputs` reads the choices first, so a remembered model is checked like a flag.
  - A short new section, "The last settings", at most a screen:
    - what is kept, and why not `llmOptions`;
    - that only a person's answer, in a run without model or effort flags, writes it, and why `setDefaultPreset` went;
    - why there is no interrupt;
    - the seed from an old `default` mark, and why `keepDefaultFlag` stays;
    - the fallbacks.
  - Add `lastSettings.agency` and `agentLastSettings.ts` to "Where things live".

- [ ] **Step 1: Write the change.** Then `grep -rn "default preset\|setDefaultPreset" docs/dev/agents` finds only text about the seed.
- [ ] **Step 2: Commit:** `git add docs/dev/agents/agent-presets.md && git commit -m "docs: new chats start with the last settings"`

## The PR description

It carries what isn't in the code:
- the breaking change: `"default": true` and `setDefaultPreset`;
- the advice that scripts needing a fixed model pass `--preset`;
- the `docs/site` pages that are now stale, for the owner to rewrite (see Decisions).

## After the release: Perry

This is a separate, small Perry PR, once agency-lang is published with this change:

- Bump `agency-lang`. Perry passes `preset: ""` and no model flags (`src/agent/programStart.ts`), so new chats pick up the last settings with no other change.
- Onboarding stops marking a default preset (`src/engine/defaultPreset.ts`, `settingsChoices.ts`). It writes its pick with `_writeLastSettings(home, { preset: "", choices: { pin, slots: {} } })`.
  - `pin` follows the rule `agentShape` in `defaultPreset.ts` already uses for presets. When `settings.json` fixes a provider (`model.provider`), the core reads a spec whole, so the pin is the bare model. Otherwise it is `<provider>/<model>`.
  - A test starts a session from the written file and checks the model it reports.
- `needsOnboarding` (`Protocol.swift`) becomes "no last-settings file and no preset marked default". The wire field `defaultPreset` is replaced by what `_readLastSettings(home)` returns, bumping the protocol version.
- The app's Settings window says "New chats start with your last settings" and names their preset, or their model and effort. **Change…** writes the last settings.
