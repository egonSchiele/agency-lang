# Shared Session Core, Plan 2: Perry on the Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Perry's engine runs the agent's session program in place of its own core, so a Perry session is a session of the agency agent, with every brain.

**Architecture:** Two pull requests. Part A, in agency-lang, gives the core what an app needs that the terminal did not: a local model that fails without ending the process, the session's folder in place of the process's, an `effort` and a `preset` answer, a starting budget, edit diffs as an event, and a session record that says which format its run file is in. Part B, in Perry, deletes `src/agency/core.agency` and binds the engine to `agency-lang/agent-session`. The engine's wire format does not change: it still sends a session's `settings`, now read from the core's pause, and turns a settings change into the core's answers.

**Tech Stack:** Agency and TypeScript in agency-lang. TypeScript, Agency (test fixtures only) and vitest in Perry.

**Spec:** `docs/superpowers/specs/2026-11-18-shared-session-core-design.md`. Read `docs/dev/agents/session-core.md` first: it is the core as built.

**Written against:** agency-lang `main` at `5055e87c9` (#1505 merged) and Perry `main` at `24226dc` (#25, onboarding). Revised after the review in `2026-11-19-shared-session-core-2-perry-review.md`.

Paths in Part A are relative to `packages/agency-lang/`, and `AGENT` means `lib/agents/agency-agent`. Paths in Part B are relative to the Perry repo.

## Decisions made for this plan

- **Perry starts a session with the user's own models.** It passes no model flags, so the agent's resolution picks them: `settings.json`, the default preset, then the built-in defaults for whichever provider has a key. Perry's `DEFAULT_SETTINGS.provider` and `.model` go away.
- **Perry does not run local models.** The engine is one process for every chat, and a local model is a server that process would host. The core refuses a local request once the engine has called `_setLocalModelsAllowed(false)`. Perry's lists keep the reason on a local preset, and onboarding still reports a local default preset as unusable.
- **Perry keeps its turn budget of $50 and 30 minutes** as the session's starting budget.
- **A new session uses the user's default brain.** A brain picker is not in this plan.
- **Perry keeps a test double for the core** (`echoCore.agency`), updated to the core's interface. Twelve test files use it. One new test file drives the real program.
- **Edit diffs are computed in agency-lang**, by a TypeScript helper the core and Perry both import. It is not a new function in `std::syntax`.
- **A session record names its run file's format.** That is how the terminal and Perry leave each other's sessions alone until the terminal moves onto the core (Plan 3).
- **MCP in Perry stays out.** Perry's engine configures no MCP servers, as today.
- **The Mac app is not touched.** The wire format keeps its shape.

## Global Constraints

- `agency agent` behaves the same after Part A. Its tests pass. In particular it asks no new approval question, and a `-p` run loses no command or skill.
- The import closure of `AGENT/program.agency` reaches no terminal module and no module with a top-level `callback(` (`lib/stdlib/agentSessionImports.test.ts`).
- The `match` over an `Answer` has no `_` arm.
- No call inside the argument of a `try` call (#1506).
- No dynamic imports in either repo.
- Perry: follow its CLAUDE.md. Absolute imports with `.js`, `Result` and not exceptions, types and not interfaces, no `Map`, no `any`, named parameters past two.
- Perry: every commit passes `pnpm typecheck` and `pnpm test:run`.
- Perry: everything a client shows has had `showControlCharacters` applied. A notice's text is model-adjacent and gets it too.
- Perry: every question still leaves the run. The engine installs nothing that answers an approval inside a run.
- Perry pins `agent::sessionInput` to `propagate` in every policy it gives a run.
- Never commit to `main` in either repo.

## Review Focus

1. **Two sessions in different folders in one engine.** Each gets its own folder's user commands, Claude skills and `AGENTS.md`, not the engine's. Test in A2 and B6.
2. **A local model that cannot run.** A default preset or a picked preset that is local reports the reason, and the process goes on. Test in A1, A3 and B3.
3. **A settings change that the core refuses** (a model that does not resolve, a preset that cannot be used). The session shows the reason and its settings are unchanged. Test in B2.
4. **A session the other program saved, in the same folder.** The terminal's `--continue` and picker skip a session Perry saved, and Perry skips one the terminal saved. Neither restores a file it cannot read. Test in A5 and B4.
5. **A setup that fails when a session is created.** `POST /sessions` reports the reason and the engine goes on. Test in B2.
6. **An approval on an edit, loaded after an engine restart.** The card still shows its diff. Test in B5.

---

# Part A: agency-lang

**Part A is done** (branch `adit/session-core-app`). It differs from the tasks below in these ways, and Part B should follow what was built:

- **The pause reports `fixedProvider`.** When a preset, `--provider` or `settings.model` fixes the provider, a `model` answer's spec is read whole, as a model of that provider. `openai/gpt-4o` under a fixed `anthropic` is a model by that name. So in Task B2, Perry sends `<provider>/<model>` only when `fixedProvider` is "". When one is fixed, it sends the bare model for that provider, and refuses a change to another provider with a reason that names the preset.
- **The pause's `effort` is "" when no one named one.** The models' own rule then decides what is sent. Perry shows that as its default.
- **`projectDir()` kept its signature.** It reads `sessionFolder()`, a new global the core sets from `start.cwd`.
- **The core scans its folder each time it reads the commands or skills,** and its run's policy is asked. Only the terminal keeps a scan.
- **`localModels` is not in `ProgramStart`.** It is a fact about the process. Perry calls `_setLocalModelsAllowed(false)` and `_setManySessions(true)` from `agency-lang/stdlib-lib/agentProcess.js` once, when the engine starts, in `sessionProgram.ts`. Both default to the terminal's answer, so forgetting one gives no error.
- **`main` checks its `start` against the type.** A start with a missing field is refused by name.
- **`SavedRun` did not move.** Task A5 added only the record's `runFormat` and `_recordRunFormat`. Perry keeps its own `SavedRun`, `isSavedRun` and reader in Task B4. They move when the terminal writes the format (Plan 3).
- **The terminal's own approval diff has no size limit still.** It renders through `diff` in `std::syntax`, not through hunks, so `editDiff` does not fit it.
- **With no provider key, `main` fails** with "No LLM API key found. Set one of: …".

One branch and one pull request. When it merges, a release of agency-lang is needed before Part B can start.

Tests in Part A that send a message name their brain: `brain: "simple"`. The coordinator may make its own model calls to route a message, and a test client that echoes the last user message would answer those too.

### Task A1: A local model that fails does not end the process

`configureLocalModel` (`AGENT/shared.agency`) prints and calls `_exit(1)` when the model, its embedding or its backend fails to load. `applyModelRequest` and `switchPreset` both reach it.

**Files:**
- Modify: `AGENT/shared.agency`, `AGENT/lib/session.agency`, `AGENT/program.agency`, `AGENT/agent.agency` and any other caller of `configureLocalModel`
- Test: `AGENT/tests/quietStartup.agency`, `tests/agency-js/session-core/test.js`

**Interfaces:**
- `configureLocalModel(...)` returns `Result<boolean>`. Every `print` + `_exit(1)` in it becomes a returned failure with the same text.
- `applyModelRequest` returns that failure, as it does for a hosted model that does not resolve. Nothing is changed when it fails.
- The terminal's startup prints the failure and exits with 1, as now. `/preset` and `/local` in the REPL print it and keep the session.
- Whether local models may run is a setting of the process: `_setLocalModelsAllowed(allowed: boolean)` in `lib/stdlib/agentProcess.ts`. When it is false, `applyModelRequest` returns `failure("Local models are not available here.")` for a local request before it loads anything. The terminal never calls the setter, and the default is true.

- [ ] **Step 1: Write the failing tests.** In `quietStartup.agency`: `applyModelRequest` for a local model whose name does not resolve returns a failure and the run goes on to the next line. In `session-core/test.js`, with a `settings.json` in the temp home that holds `{ "presets": { "mine": { "local": "no-such-model", "default": true } } }`: after `_setLocalModelsAllowed(false)`, a program throws "Local models are not available here." from `main`, and the test's process is still running to assert it.
- [ ] **Step 2:** Run: `pnpm run agency test lib/agents/agency-agent/tests/quietStartup.agency` and `pnpm run agency test js tests/agency-js/session-core`. Expected: FAIL. The first ends the test process.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both, and `AGENT/tests/presetSession.agency`. Expected: pass.
- [ ] **Step 5:** Remove "a local model that fails to load still ends the process" from "Not solved yet" in `docs/dev/agents/session-core.md`. Commit: `Agent: a local model that fails to load returns a failure`.

### Task A2: The session's folder, not the process's

Three reads use the process's `cwd()`. Two are statics, which run once when the modules load: `projectCommands` in `commandPalette.agency` and `SKILL_SOURCES` in `claudeSkills.agency`.

They cannot simply move into functions that run during a turn. In the terminal a turn runs inside `runSession`'s handler, and every handler is asked. A scan with no policy rule would make the terminal ask the user, and a `-p` run would reject it and lose the commands without a word.

So the scans stay once per process and per folder, and the terminal still does its own before it installs its handler.

**Files:**
- Create: `lib/stdlib/agentFolderScans.ts`
- Modify: `AGENT/lib/claudeSkills.agency`, `AGENT/lib/commandPalette.agency`, `AGENT/lib/sessions.agency`, `AGENT/lib/sessionSearch.agency`, `AGENT/lib/runSession.agency`, and their callers
- Test: `tests/agency-js/session-core-folders/agent.agency`, `test.js`, `fixture.json`; extend `tests/agency-js/session-core-handoff/test.js`

**Interfaces:**
- `agentFolderScans.ts` holds one module-level object, keyed by kind and folder: `_folderScan(kind: string, folder: string): unknown | null` and `_keepFolderScan(kind: string, folder: string, value: unknown): void`. It is process state, like an MCP connection. It is never in a checkpoint, so a new process scans again and sees a command added since, as the statics do today. A static cannot hold it: statics are deeply immutable.
- The folder is the one the session started in: `sessionFolder(): string` in `record.agency`, the current record's `cwd`, or `cwd()` before there is a record. It does not move when a coder changes the working folder. Today's statics do not follow that either.
- `claudeSkills.agency`: `SKILL_SOURCES` goes. `skillSources(): SkillSource[]` returns the kept scan for `sessionFolder()`, or scans (`loadSkillSources`, each scan `with approve` as now) and keeps it. The kept value is the scan: names, paths and text. `claudeSkillTools()` builds the tool from it on each call and keeps no tool value.
- `commandPalette.agency`: `projectCommands` goes. `projectCommandsHere(): SkillCommand[]` does the same for `commandsDir`. `INIT_FILE` becomes a function of `sessionFolder()`.
- `runSession.agency`: before it installs the policy handler, the terminal calls `skillSources()` and `projectCommandsHere()` once, next to where it builds the grounding. Every later call in the process is answered from the kept scan, inside the handler or not.
- In the core there is no handler around a turn, so the first call scans under its own `with approve`. Task A4 adds a handler that only passes, which does not change this.
- `sessions.agency`: `projectDir()` takes the folder: `projectDir(dir: string): string`. The terminal's callers pass `cwd()`. `sessionSearch.agency` passes `sessionFolder()`.

- [ ] **Step 1: Write the failing tests.**
  - `session-core-folders/test.js` makes two temp folders, each with a `.claude/commands/hello.md` whose body names its own folder, starts two sessions of the program in one process with `brain: "simple"`, one per folder, under a policy with no rule for `std::skills::commandsDir`, and sends each the message `/hello` under a test client that returns the last user message as the reply. `fixture.json`:

    ```json
    { "firstSessionSawItsOwnCommand": true, "secondSessionSawItsOwnCommand": true, "approvalsAsked": 0 }
    ```

  - In `session-core-handoff/test.js`: the project folder has a `.claude/commands/hello.md`, and the second process, which never ran `main`, sends `/hello` and gets its body.
  - A terminal test, in `AGENT/tests/userCommands.agency`: under `runSession` with an empty policy and no one to ask (the `-p` shape), `/hello` still expands. Under the interactive shape with a prompt function that records its calls, a first turn records none.
- [ ] **Step 2:** Run: `pnpm run agency test js tests/agency-js/session-core-folders`. Expected: FAIL, both sessions get the process folder's commands or none.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the new tests, `AGENT/tests/userCommands.agency`, `claudeSkills.agency`, `commandPalette.agency`, `sessionSearch.agency`, `turn.agency`, and `tests/agency/agency-agent-sessions.agency`. Expected: all pass. If `approvalsAsked` is not 0 in the core, the run's policy is being asked about a call that has its own `with approve`. Stop and report that: it changes this task's design.
- [ ] **Step 5:** Update "Not solved yet" in `session-core.md`. Commit: `Agent: read a session's commands and skills from its own folder`.

### Task A3: The effort and the preset as answers, and a starting budget

**Files:**
- Modify: `AGENT/core.agency`, `AGENT/lib/modelRequest.agency`, `AGENT/lib/session.agency`
- Test: extend `tests/agency-js/session-core/test.js` and `fixture.json`; `AGENT/tests/quietStartup.agency`

**Interfaces:**
- `ModelChoices` gains `effort?: EffortChoice`. `requestEffort(request)` returns `request.choices.effort` first, then the flag, then the preset's.
- Produces, in `session.agency`: `applyEffortAnswer(effort: EffortChoice): Result<boolean>`. It stores the choice and applies the request's options again, as `applySessionLlmOptions` does. An effort that is not one of `effort.agency`'s choices is a failure.
- Produces, in `session.agency`: `applyPresetAnswer(name: string): Result<boolean>`. It is the `switch` branch of `presetSlashCommand` in `repl.agency`: `switchPreset(name)`, then store the session, then `reactToSlotChange` for each change. `presetSlashCommand` calls it.
- `Answer` gains `{ kind: "effort"; effort: string }` and `{ kind: "preset"; name: string }`. A failure from either is a `session.notice` at level `error`, as for `model`.
- The pause's data gains `effort: string`: the choice in force, `"default"` when none is named.
- `SessionStart` gains `budget: TurnBudget`. The core starts from it in place of `{ maxCost: -1, maxTime: -1 }`.

- [ ] **Step 1: Write the failing tests.** In `test.js`, with the client recording `config.reasoningEffort`:
  - After `{ kind: "effort", effort: "low" }`, a turn's call is sent `low` and the pause reports `effort: "low"`. After `"default"`, a turn's call is sent none. `"extreme"` is an error notice and the pause still reports the old effort.
  - `{ kind: "preset", name: "no-such-preset" }` is an error notice and the pause's `preset` is unchanged.
  - With `{ "presets": { "big": { "provider": "anthropic", "pin": "claude-opus-4-8" } } }` in the temp home's `settings.json`: `{ kind: "preset", name: "big" }`, and the pause reports `preset: "big"` and a main model of `claude-opus-4-8`.
  - After `_setLocalModelsAllowed(false)`, with a preset `{ "local": "no-such-model" }`: picking it is an error notice that says "Local models are not available here.", and the pause is unchanged. Review Focus 2.
  - A session started with `budget: { maxCost: 3, maxTime: 1000 }` reports it at its first pause.
  - With `OPENAI_API_KEY` set: `{ kind: "model", spec: "openai/gpt-5.5" }`, and the pause reports the main model's provider as `openai-responses`. This pins that a spec with the public provider name resolves, which Task B2 depends on.
  - With no provider key in the environment: start the program and record whether `main` throws or the first turn's reply is a `session.error`. Either is accepted. Write which one it is into `session-core.md`, since Perry's Task B2 words its message from it.
- [ ] **Step 2:** Run. Expected: FAIL, the answers are refused as unreadable.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the js test, `quietStartup`, `presetSession`, `effort`, `agentTurn`. Expected: all pass.
- [ ] **Step 5:** Update the answers table in `session-core.md` and the spec. Commit: `Session core: effort and preset answers, and a starting budget`.

### Task A4: Edit diffs as an event

Perry's `src/lib/editDiff.ts` is a wrapper over agency-lang's `_diffTokens`. It adds size limits and fixes the options. It moves here as a TypeScript helper. `std::syntax` is not changed: it would gain a second diff function that differs from `diffTokens` only in fixed arguments.

**Files:**
- Create: `lib/stdlib/editDiff.ts`, `lib/stdlib/editDiff.test.ts`
- Modify: `AGENT/core.agency`
- Test: extend `tests/agency-js/session-core-handoff/test.js`

**Interfaces:**
- `lib/stdlib/editDiff.ts` is Perry's file and its test, moved: `editDiff(before: string, after: string): EditHunk[] | null`, the same hunks, the same limits (`MAX_DIFF_*`), the same rule that a character is never split, and null for an edit past a limit or one the diff throws on. `EditHunk` and its token type are declared in this file. Perry reaches it as `agency-lang/stdlib-lib/editDiff.js`, which the package's `./stdlib-lib/*` export already covers.
- `core.agency` imports it directly, as Perry's `editDiffs.agency` does: `import { editDiff } from "../../stdlib/editDiff.js"` (the path the compiled file needs).
- The core gets its second handler, around the turn: for `std::edit` it emits `{ type: "session.editDiff", filename, edits, hunks }` from the interrupt's `filename`, `edits`, `before` and `after`, then passes. Every other effect passes untouched. It never approves and never rejects.
- The event is emitted for an edit the run's policy approves too, since a handler sees an interrupt even when the policy answers it.

- [ ] **Step 1: Write the failing test.** Move Perry's `editDiff.test.ts` cases into `lib/stdlib/editDiff.test.ts`. In the handoff test, add a second message whose scripted reply is an `edit` tool call on a file in the project, under a policy that approves `std::edit` in `.`. Expect one `session.editDiff` event whose `filename` is the file and whose `hunks` is not empty, and no interrupt.
- [ ] **Step 2:** Run both. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and `lib/stdlib/agentSessionImports.test.ts`. Expected: pass.
- [ ] **Step 5:** Read the terminal's approval diff (#1504, `stdlib/policy.agency` and what it calls). If it diffs an edit with no limit on input or line length, make it call `editDiff` so it gets the limits, and add a test with one 100,000-character line that returns within a second. If it already has limits, write one line in `session-core.md` saying where.
- [ ] **Step 6:** Update "Approvals" in `session-core.md` to name the handler. Commit: `Session core: report each edit's diff`.

### Task A5: A record names its run file's format

The terminal and Perry save into the same folders, `<home>/sessions/<cwd as a slug>`. The terminal's run file is a checkpoint. Perry's is a `SavedRun`: `{ version, pause, cancelledTexts, turn }`. Today `mostRecentSession` returns the newest record of any kind and `startSession` calls `restore` on its file, so `agency agent --continue` in a folder where Perry saved last restores a file that is not a checkpoint.

A record says which it is, so no one has to open a run file to find out.

**Files:**
- Modify: `lib/stdlib/agentSessions.ts`, `AGENT/lib/sessions.agency`, `AGENT/lib/resume.agency`, `AGENT/lib/record.agency`
- Test: `lib/stdlib/agentSessions.test.ts`, `tests/agency/agency-agent-sessions.agency`

**Interfaces:**
- `SessionRecord` gains `runFormat?: "checkpoint" | "savedRun"`. A record without it is a checkpoint, except one whose `brain` is `"perry"`, which is a `SavedRun` from before this change.
- In `agentSessions.ts`: `recordRunFormat(record: SessionRecord): "checkpoint" | "savedRun"`, the rule above in one place.
- In `agentSessions.ts`, moved from Perry's `src/engine/sessionFiles.ts`: the type `SavedRun`, `isSavedRun(value: unknown): value is SavedRun`, and `readSavedRun(file: string): SavedRun | null`. Perry's `savedRun(phase)`, `canResume` and `restoredState` stay in Perry: they are about its state machine.
- `listSessions()` in `sessions.agency` returns only records whose format is `checkpoint`, so the picker and `--continue` never offer another. `findSession(id)` still finds any record.
- `startSession` for `--resume <id>` on a `savedRun` record prints `Session <id> was saved by another app and can't be opened here yet.` and exits with 1. It never reaches `restore`.
- The core keeps `runFormat` on its record as it was given: it does not set it. The front-end that saves the file sets it.

- [ ] **Step 1: Write the failing tests.** In `agentSessions.test.ts`: `recordRunFormat` for a record with each value, with none, and with none and `brain: "perry"`; `isSavedRun` on a `SavedRun`, on a checkpoint, on `null`. In `agency-agent-sessions.agency`: a folder with a newer `savedRun` record and an older checkpoint record gives the older one from `mostRecentSession`, and `listSessions` has one entry.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both, and `AGENT/tests/sessionSearch.agency`. Expected: pass.
- [ ] **Step 5:** Add the field to `docs/dev/agents/agent-sessions.md`. Commit: `Agent sessions: a record names its run file's format`.

### Task A6: Release

- [ ] **Step 1:** Run the agent's tests in full once (about 25 minutes; `toolPresentations` fails on `main` when a Brave key is in the environment). Restore `tests/agency-js/llm-provider-defaults/log.jsonl` with `git checkout` before committing. Open the pull request for Part A.
- [ ] **Step 2:** After it merges, the owner publishes a release of agency-lang. Part B needs its version number.

---

# Part B: Perry

One branch, off Perry's `main`, in a worktree under `.worktrees/`. Every commit passes `pnpm typecheck` and `pnpm test:run`.

### Task B1: A typed binding for the agent's program

This task adds a file and its test. Nothing uses it yet.

**Files:**
- Modify: `package.json` (the agency-lang version from A6), `vitest.config.ts`
- Create: `src/agent/sessionProgram.ts`, `src/test/agentHome.setup.ts`
- Test: `src/agent/sessionProgram.test.ts`

**Interfaces:**
- `sessionProgram.ts` is the one file that imports `agency-lang/agent-session`, with a static import. The compiled program has no type declarations, so this file declares the part Perry uses:

```ts
export type ProgramStart = {
  brain: string;
  preset: string;
  models: { pin: string; slots: Record<string, string>; provider: string; local: string | null; effort: string | null };
  limits: { maxToolCallRounds: number | null; maxToolResultChars: number | null };
  session: SessionStart;
};
export type SessionStart = {
  cwd: string;
  replyStyle: string;
  record: SessionRecord | null;
  flags: Record<string, unknown> | null;
  budget: { maxCost: number; maxTime: number };
};
export type PauseData = {
  thread: string; cwd: string; record: SessionRecord | null;
  models: Record<string, { model: string; provider: string; via: string }>;
  preset: string; effort: string; budget: { maxCost: number; maxTime: number }; context: string;
};
export type Answer =
  | { kind: "message"; text: string; notes: string[]; target: string }
  | { kind: "model"; spec: string }
  | { kind: "effort"; effort: string }
  | { kind: "preset"; name: string }
  | { kind: "budget"; maxCost: number; maxTime: number };
export const SESSION_INPUT_EFFECT = "agent::sessionInput";
export function pauseData(pause: Interrupt[]): PauseData | null;
export function programStart(args: { cwd: string; record: SessionRecord; brain?: string }): ProgramStart;
export function messageAnswer(text: string): Answer;
```

- `programStart` fills in: `brain` as given or `""`, `preset: ""`, no model flags, no limits, `replyStyle: ""`, `flags: null`, `budget: { maxCost: 50, maxTime: 30 * 60_000 }`.
- The import runs the agent's module statics, and one of them reads `AGENCY_AGENT_HOME` (`AGENT/lib/config.agency`). The engine takes its home from the same variable (`src/lib/agentHome.ts`), so the two agree with a static import. Tests set the variable in a vitest `setupFiles` entry, `src/test/agentHome.setup.ts`, which makes a temp home before any test module loads.

- [ ] **Step 1: Write the failing test.** Two cases check the engine's process settings, since nothing else fails when one is forgotten: with a local default preset in the temp home's `settings.json`, starting the program fails with "Local models are not available here."; and a `.claude/commands` file added after a session's first turn is expanded on its next. Then: `sessionProgram.test.ts` sets `ANTHROPIC_API_KEY=test-key`, installs a client with the program's `__setLLMClient` that replies `stub reply`, starts the program in a temp folder with `programStart({ cwd, record, brain: "simple" })`, and checks: the first pause's effect is `SESSION_INPUT_EFFECT`; `pauseData` reads a main model and the $50 budget; a `messageAnswer("hello")` emits `session.reply` with `stub reply`; the checkpoint's `moduleFingerprints` name no file under Perry's `src/`. A second case starts with `brain: ""` and checks only that the first pause's record has `brain: "coordinator"`. It sends no message.
- [ ] **Step 2:** Run: `pnpm vitest run src/agent/sessionProgram.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test:run` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `A typed binding for the agency agent's session program`.

### Task B2: The engine speaks the core's interface

The effect's name, the events and the answers are one interface. The engine, its test double and the program it binds change together, in one commit, and Perry's own core goes in the same commit. A smaller commit would leave the tests passing and the app bound to a core the engine can no longer talk to.

**Files:**
- Modify: `src/agency/echoCore.agency`, `src/agency/echoFixture.agency`, `src/agency/echoOther.agency`, `src/agency/echoEditDiffs.agency`, `src/agent/echoAgent.ts`, `src/agent/events.ts`, `src/agent/editDiffEvent.ts`, `src/agent/agentModule.ts`, `src/agent/session.ts`, `src/agent/settings.ts`, `src/agent/sessionMachine.ts`, `src/agent/policy.ts`, `src/engine/settingsChange.ts`, `src/engine/engine.ts`, `src/engine/sessionView.ts`, `src/engine/main.ts`
- Delete: `src/agency/perry.agency`, `src/agency/core.agency`, `src/agency/answers.agency`, `src/agency/editDiffs.agency`, and their generated `.ts` files
- Delete: `src/agency/core.test.ts` (it tests the deleted core; the agent's own tests cover the core now) and `src/agency/editDiffs.test.ts` (its cases are in agency-lang's handoff test from Task A4)
- Modify: `src/agency/echoFixture.test.ts`, for the new events and answers
- Test: `src/engine/settingsChange.test.ts`, `src/engine/engine.test.ts`, `src/engine/sessionView.test.ts`, and the existing tests that use the echo agents

**Interfaces:**
- `echoCore.agency` raises `agent::sessionInput` with the core's pause data (`thread`, `cwd`, `record`, `models`, `preset`, `effort`, `budget`, `context`), takes the core's answers, and emits `session.reply`, `session.error`, `session.notice`, `session.budgetStop`. It keeps its test messages (`slow`, `approve:…`, `fail`, `turns`, `read:…`). `model`, `effort`, `preset` and `budget` answers change what its next pause reports. A `model` spec of `bad/model` and a `preset` named `local-one` are error notices that change nothing. `echoEditDiffs.agency` emits `session.editDiff`.
- `EMIT_TO_ITEM` in `events.ts` maps `session.reply`, `session.error`, `session.budgetStop`, and `session.notice` to a notice item whose text is the notice's. `EDIT_DIFF_EMIT` is `session.editDiff`.
- `USER_MESSAGE_EFFECT` is `SESSION_INPUT_EFFECT`. `withPerrysPauseLeftAlone` in `policy.ts` and `runPolicy` in `engine.ts` pin it.
- `perryAgentIn({ cwd, logFile, record })` starts the program with `programStart`. Its `initial` parameter goes, and `main.ts` and `engine.ts` stop passing one.
- `Settings` loses `openRouter`. `settingsIn(pause)` builds a `Settings` from `pauseData`: `provider` and `model` from `models.main`, `effort`, `maxCost` and `maxTime` from `budget`, `preset` (null for `""`). `openai-responses` is still shown as `openai` (`shownProvider`). `DEFAULT_SETTINGS` goes: what a session has is what its last pause reported. Task B3 fixes the onboarding code that used it, so in this task `defaultPreset.ts` keeps compiling by taking the two values it needs as its own constants.
- `changedSettings` returns the one answer a request means:

| The request holds | The answer |
| --- | --- |
| `provider` and `model` | `{ kind: "model", spec: "<provider>/<model>" }` |
| `model` alone | the same, with the session's provider as a person sees it (`shownProvider`) |
| `provider` alone | refused with a 400: "Send the model with the provider." A model belongs to one provider. |
| `effort` | `{ kind: "effort", effort }` |
| `maxCost`, `maxTime`, or both | `{ kind: "budget", maxCost, maxTime }`, filling the missing one from the session |
| `preset` | `{ kind: "preset", name }` |

  A request that holds fields from two answers is refused with a 400 that names them.
- The `configured` action carries the answer in place of a whole `Settings`. After the leg, the "settings changed" notice is added only when the pause's settings differ from before. When the core refused the change it has already sent a `session.notice` with the reason.
- When the program's `main` fails, `startRun` returns that failure, and `POST /sessions` answers 500 with the reason. Review Focus 5.

- [ ] **Step 1:** Before changing anything, read how the Mac app sends a model change (`apps/macos`, the settings panel's request). If it ever sends a provider with no model, stop and report it: the table above refuses that.
- [ ] **Step 2: Write the failing tests.** In `settingsChange.test.ts`: each row of the table; a request across two answers is refused; a model alone on a session whose pause reports `openai-responses` gives the spec `openai/<model>`. In `engine.test.ts`, against the echo fixture: a model change shows in the next `settings`; `bad/model` leaves `settings` unchanged and adds the error notice to the transcript (Review Focus 3); a session whose start fails reports the reason, and a second session then starts (Review Focus 5).
- [ ] **Step 3:** Run. Expected: FAIL.
- [ ] **Step 4:** Implement, and fix the tests that name the old events or the old answer.
- [ ] **Step 5:** Run `pnpm test:run` and `pnpm typecheck`. Expected: PASS. Run `src/engine/samples.test.ts` and check the sample file's `settings` still has the fields the Mac app decodes. If `openRouter` was in the sample, write the sample again and raise `PROTOCOL_VERSION` in `protocol.ts` and `Protocol.swift`.
- [ ] **Step 6:** Commit: `Run the agency agent's session program in place of Perry's core`.

### Task B3: Onboarding and presets after the change

Perry #25 gave a new chat its settings from the default preset, which Perry read itself. The core applies the default preset now (`startPresetQuiet` with `""`), so Perry's copy of that rule goes. What stays is what the core does not do: saving the preset onboarding picks, listing presets for the panel, and telling the app when no chat can start.

**Files:**
- Modify: `src/engine/defaultPreset.ts`, `src/engine/presets.ts`, `src/engine/settingsChoices.ts`, `src/engine/engine.ts`
- Test: `src/engine/defaultPreset.test.ts`, `src/engine/settingsChoices.test.ts`, `src/engine/engine.test.ts`

**Interfaces:**
- `defaultPreset.ts`: `newChatSettings` goes, with the constants Task B2 left. `readDefaultPreset` stays, for the wire format's `defaultPreset` and `unusableDefault`. `unusable` now has one cause: the preset is local. `saveDefaultPreset` is unchanged.
- `presets.ts`: `presetSettings`, `APPLIED_FIELDS`, `APPLIED_LLM_OPTIONS` and the slot rules that decided whether Perry could apply a preset go. `unavailable(preset)` returns `"local models are not supported yet"` for a preset with `local`, and null for every other: the core applies a preset whole, with its slots and tool limits. `presetModel` stays, only to show a provider and a model beside a preset's name. `shownProvider` and `runProvider` stay.
- `SettingsSource.preset` goes. Nothing looks a preset up by name: the name is sent to the core.
- The wire format is unchanged: `defaultPreset`, `unusableDefault`, and each `PresetChoice`'s `unavailable`.
- When the default preset is local, the app's onboarding asks for a hosted one before a chat is made, as it does today. If a chat is made anyway, the core refuses the local model and Task B2's failure path reports it.

- [ ] **Step 1: Write the failing tests.** `unavailable` is null for a preset with `slots` for other roles and for one with an unknown `llmOptions` key, and is the local reason for one with `local`. `readDefaultPreset` reports a local default as unusable and a preset with tool limits as usable. In `engine.test.ts`, against the echo fixture: a `preset` change to `local-one` leaves `settings` unchanged and adds the notice (Review Focus 2).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: `pnpm test:run` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `Leave applying a preset to the core`.

### Task B4: The session record is the core's

**Files:**
- Modify: `src/engine/sessionFiles.ts`, `src/engine/engine.ts`
- Test: `src/engine/sessionFiles.test.ts`, `src/engine/engine.test.ts`

**Interfaces:**
- The engine makes a session's record when it creates the session (`id`, `cwd`, `brain: ""`, `created`, `lastActive`, `turns: 0`, `title: ""`, `runFormat: "savedRun"`) and gives it to the program. After that, the record it saves is the one in the pause's data, which the core keeps: the real brain, the turn count, the title.
- `SavedRun`, `isSavedRun` and the reader come from `agency-lang/stdlib-lib/agentSessions.js`. Perry's copies go.
- `PERRY_BRAIN` and the filter on it go. `loadSessions` lists the records whose `recordRunFormat` is `savedRun`, and leaves the terminal's out with no log line: they are another program's, not a fault.
- A `SavedRun` whose code no longer matches still loads as ended with the reason (`canResume`). That includes every session Perry saved before this change, whose records say `brain: "perry"`.

- [ ] **Step 1: Write the failing tests.** A saved session's `.meta.json` has `runFormat: "savedRun"`, the brain the pause reported and a turn count of 1 after one turn. A folder holding a `checkpoint` record with `brain: "coordinator"` loads without it and without throwing (Review Focus 4). A record with `brain: "perry"`, no `runFormat` and a `SavedRun` with a foreign fingerprint loads as ended.
- [ ] **Step 2:** Run. Expected: FAIL on the first two.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: `pnpm test:run`. Expected: PASS.
- [ ] **Step 5:** Commit: `Save the session record the core keeps`.

### Task B5: The approval's diff from agency-lang's helper

The row's diff already comes from `session.editDiff` after Task B2.

**Files:**
- Modify: `src/engine/approvalDiff.ts`, `src/agent/editDiffEvent.ts`, `src/engine/protocol.ts` if it declares the hunk type
- Delete: `src/lib/editDiff.ts`, `src/lib/editDiff.test.ts`
- Test: `src/engine/approvalDiff.test.ts`

**Interfaces:**
- The approval's diff is made by `editDiff` from `agency-lang/stdlib-lib/editDiff.js`, from the interrupt's `before` and `after`. It is the same code that made the row's, so the two cannot differ.
- The wire format's `DiffHunk` and `DiffToken` keep their shape. A test asserts agency-lang's `EditHunk` is assignable to `DiffHunk`.

- [ ] **Step 1:** Add the test for Review Focus 6: a session saved while it waits on an edit's approval, loaded by a new engine, has a diff on its approval.
- [ ] **Step 2:** Run. Expected: PASS before the change if the restart path already works, and then it guards the change. Otherwise FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: `pnpm test:run` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `Take the edit diff from agency-lang`.

### Task B6: The real program, end to end

**Files:**
- Test: `src/engine/realProgram.test.ts`

- [ ] **Step 1: Write the test.** With the temp home and a stub client, one engine holds two sessions in two temp folders, each with its own `.claude/commands/hello.md`, started with `brain: "simple"` through a test-only `agentFor`. Check: each session's `/hello` reply holds its own folder's text (Review Focus 1); a second engine over the same home loads both and each takes another message; the saved records have `brain: "simple"` and `runFormat: "savedRun"`.
- [ ] **Step 2:** Run: `pnpm vitest run src/engine/realProgram.test.ts`. Expected: PASS. A failure is a finding about the core. Stop and report it.
- [ ] **Step 3:** Run everything: `pnpm test:run`, `pnpm typecheck`, `pnpm lint`. Expected: clean.
- [ ] **Step 4:** Commit: `Test: two sessions of the real program in one engine`.

### Task B7: The terminal UI, the one-shot run, and the docs

**Files:**
- Modify: `src/hooks/useAgentSession.ts`, `src/agent/oneShot.ts`, `src/cli/startup.ts`, and the components that read `Settings`
- Modify: `docs/idea.md`, `docs/dev/agent-run.md`, `docs/dev/engine.md`, `docs/dev/approvals.md`, `docs/dev/one-shot.md`, `docs/dev/build.md`, `docs/dev/mac-app.md`, `CLAUDE.md`

- [ ] **Step 1:** Check the Ink terminal UI and `perry -p` by running each once. Both start the program through `perryAgentIn` since Task B2, and neither sends a settings change.
- [ ] **Step 2:** Rewrite the docs for what is true now. `agent-run.md` loses "The agent core", "What the pause accepts" and "The settings" as they stand, and points at agency-lang's `session-core.md` for the core. `engine.md` and `mac-app.md` say what onboarding still reads and writes (Task B3). `idea.md` and `CLAUDE.md` no longer say the two agents cannot continue each other's sessions because their cores differ: they say Perry runs the agent's program, and that the terminal still saves in its old format until it moves onto the core.
- [ ] **Step 3:** Run `pnpm app` and check by hand: a new chat answers, a model change in the panel shows in the subtitle, an edit shows its diff, an approval can be answered, and the chat is there after the engine restarts. Run `agency agent --continue` in the same folder and check it does not pick the Perry session.
- [ ] **Step 4:** Commit: `Docs: Perry runs the agency agent's session program`. Open the pull request.
