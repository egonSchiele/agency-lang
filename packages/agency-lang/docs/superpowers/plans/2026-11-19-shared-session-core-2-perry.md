# Shared Session Core, Plan 2: Perry on the Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Perry's engine runs the agent's session program in place of its own core, so a Perry session is a session of the agency agent, with every brain.

**Architecture:** Two pull requests. Part A, in agency-lang, gives the core what an app needs that the terminal did not: the session's folder in place of the process's, an `effort` and a `preset` answer, a starting budget, and edit diffs as an event. Part B, in Perry, deletes `src/agency/core.agency` and binds the engine to `agency-lang/agent-session`. The engine's wire format does not change: it still sends a session's `settings`, now read from the core's pause, and turns a settings change into the core's answers.

**Tech Stack:** Agency and TypeScript in agency-lang. TypeScript, Agency (test fixtures only) and vitest in Perry.

**Spec:** `docs/superpowers/specs/2026-11-18-shared-session-core-design.md`. Read `docs/dev/agents/session-core.md` first: it is the core as built.

Paths in Part A are relative to `packages/agency-lang/`, and `AGENT` means `lib/agents/agency-agent`. Paths in Part B are relative to the Perry repo.

## Decisions made for this plan

- **Perry starts a session with the user's own models.** It passes no model flags, so the agent's resolution picks them: `settings.json`, the default preset, then the built-in defaults for whichever provider has a key. Perry's `DEFAULT_SETTINGS.provider` and `.model` go away. This is the rule in Perry's CLAUDE.md: one home, and a setting changed in one agent is there for the other.
- **Perry keeps its turn budget of $50 and 30 minutes** as the session's starting budget.
- **A new session uses the user's default brain.** A brain picker is not in this plan.
- **Perry keeps a test double for the core** (`echoCore.agency`), updated to the core's interface. Twelve test files use it. One new test file drives the real program.
- **Edit diffs are computed in agency-lang.** Perry's `src/lib/editDiff.ts` moves there, so the terminal can show them too.
- **MCP in Perry stays out.** Perry's engine configures no MCP servers, as today.
- **The Mac app is not touched.** The wire format keeps its shape.

## Global Constraints

- `agency agent` behaves the same after Part A. Its tests pass.
- The import closure of `AGENT/program.agency` reaches no terminal module and no module with a top-level `callback(` (`lib/stdlib/agentSessionImports.test.ts`).
- The `match` over an `Answer` has no `_` arm.
- No call inside the argument of a `try` call (#1506).
- Perry: follow its CLAUDE.md. Absolute imports with `.js`, `Result` and not exceptions, types and not interfaces, no `Map`, no `any`, named parameters past two.
- Perry: everything a client shows has had `showControlCharacters` applied. A notice's text is model-adjacent and gets it too.
- Perry: every question still leaves the run. The engine installs nothing that answers an approval inside a run.
- Perry pins `agent::sessionInput` to `propagate` in every policy it gives a run.
- Never commit to `main` in either repo.

## Review Focus

1. **Two sessions in different folders in one engine.** Each gets its own folder's user commands, Claude skills and `AGENTS.md`, not the engine's. Test in A1 and B6.
2. **A session saved by Perry before this change.** It loads as ended with the reason, as any session from other code does today, and does not crash the engine. Test in B4.
3. **A settings change that the core refuses** (a model that does not resolve, a preset that cannot be used). The session shows the reason and its settings are unchanged. Test in B3.
4. **A setup that fails when a session is created** (no API key for any provider). `POST /sessions` reports the reason and the engine goes on. Test in B2.
5. **An approval on an edit, loaded after an engine restart.** The card still shows its diff. Test in B5.

---

# Part A: agency-lang

One branch and one pull request. When it merges, a release of agency-lang is needed before Part B can start (Task B1).

### Task A1: The session's folder, not the process's

Three reads use the process's `cwd()`. Two run when the modules load.

**Files:**
- Modify: `AGENT/lib/claudeSkills.agency`, `AGENT/lib/commandPalette.agency`, `AGENT/lib/sessions.agency`, `AGENT/lib/sessionSearch.agency`, and their callers
- Test: `tests/agency-js/session-core-folders/agent.agency`, `test.js`, `fixture.json`

**Interfaces:**
- `claudeSkills.agency`: the static `SKILL_SOURCES` goes. `claudeSkillTools()` and `claudeSkillCommands()` read the sources for `getAgentCwd()`, and keep them in a global keyed by that folder, so a turn does not scan again unless the folder moved.
- `commandPalette.agency`: the statics `projectCommands` and `INIT_FILE` go. `slashCommands()` and `mergedPalette()` build from `getAgentCwd()`, with the same one-folder cache.
- `sessions.agency`: `projectDir()` takes the folder: `projectDir(dir: string): string`. The terminal's callers pass `cwd()`. `sessionSearch.agency` passes the session record's `cwd`.
- The terminal sets the agent's folder to `cwd()` before any of these run, so its behaviour is unchanged.

- [ ] **Step 1: Write the failing test.** `test.js` makes two temp folders, each with a `.claude/commands/hello.md` whose body names its own folder, starts two sessions of `agency-lang/agent-session` in one process, one per folder, and sends each the message `/hello` under a test client that returns the last user message as the reply. `fixture.json` expects each reply to hold its own folder's body:

```json
{ "firstSessionSawItsOwnCommand": true, "secondSessionSawItsOwnCommand": true }
```

- [ ] **Step 2:** Run: `pnpm run agency test js tests/agency-js/session-core-folders`. Expected: FAIL, both sessions get the process folder's commands or none.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the new test, `AGENT/tests/userCommands.agency`, `claudeSkills.agency`, `commandPalette.agency`, `sessionSearch.agency`, and `tests/agency/agency-agent-sessions.agency`. Expected: all pass.
- [ ] **Step 5:** Update "Not solved yet" in `docs/dev/agents/session-core.md`. Commit: `Agent: read a session's commands and skills from its own folder`.

### Task A2: The effort and the preset as answers, and a starting budget

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

- [ ] **Step 1: Write the failing tests.** In `test.js`, with the client recording `config.reasoningEffort`: after `{ kind: "effort", effort: "low" }`, a turn's call is sent `low` and the pause reports `effort: "low"`; after `{ kind: "effort", effort: "default" }`, a turn's call is sent none; `{ kind: "effort", effort: "extreme" }` is an error notice and the pause still reports the old effort; `{ kind: "preset", name: "no-such-preset" }` is an error notice and the pause's `preset` is unchanged; a session started with `budget: { maxCost: 3, maxTime: 1000 }` reports it at its first pause. A preset that works is tested with a `settings.json` written into the temp home before the import: `{ "presets": { "big": { "provider": "anthropic", "pin": "claude-opus-4-8" } } }`, then `{ kind: "preset", name: "big" }` and the pause reports `preset: "big"` and a main model of `claude-opus-4-8`.
- [ ] **Step 2:** Run. Expected: FAIL, the answers are refused as unreadable.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the js test, `quietStartup`, `presetSession`, `effort`, `agentTurn`. Expected: all pass.
- [ ] **Step 5:** Update the answers table in `session-core.md` and the spec. Commit: `Session core: effort and preset answers, and a starting budget`.

### Task A3: Edit diffs as an event

**Files:**
- Create: `lib/stdlib/editDiff.ts`, `lib/stdlib/editDiff.test.ts`
- Modify: `stdlib/syntax.agency`, `AGENT/core.agency`
- Test: extend `tests/agency-js/session-core-handoff/test.js`

**Interfaces:**
- `lib/stdlib/editDiff.ts` is Perry's `src/lib/editDiff.ts` and its test, moved: the same hunks, the same limits (`MAX_DIFF_*`), the same rule that a character is never split. It is exported to Agency from `std::syntax` as `editDiff(before: string, after: string): EditHunk[] | null`, with null for an edit past a limit or one Agency's diff throws on.
- The core gets its second handler, around the turn: for `std::edit` it emits `{ type: "session.editDiff", filename, edits, hunks }` from the interrupt's `filename`, `edits`, `before` and `after`, then passes. Every other effect passes untouched. It never approves and never rejects.
- The event is emitted for an edit the run's policy approves too, since a handler sees an interrupt even when the policy answers it.

- [ ] **Step 1: Write the failing test.** Move Perry's `editDiff.test.ts` cases into `lib/stdlib/editDiff.test.ts`. In the handoff test, add a second message whose scripted reply is an `edit` tool call on a file in the project, under a policy that approves `std::edit` in `.`. Expect one `session.editDiff` event whose `filename` is the file and whose `hunks` is not empty, and no interrupt.
- [ ] **Step 2:** Run both. Expected: FAIL.
- [ ] **Step 3:** Implement. Check with `pnpm vitest run lib/stdlibCapabilities.test.ts` that the new stdlib export has the capability tag it needs.
- [ ] **Step 4:** Run the tests, and `make` in full, since `stdlib/` changed. Expected: pass, and the generated page for `std::syntax` lists `editDiff`.
- [ ] **Step 5:** Update "Approvals" in `session-core.md` to name the handler. Commit: `Session core: report each edit's diff`.

### Task A4: Release

- [ ] **Step 1:** Open the pull request for Part A.
- [ ] **Step 2:** After it merges, the owner publishes a release of agency-lang. Part B needs its version number.

---

# Part B: Perry

One branch, off Perry's `main`, in a worktree under `.worktrees/`.

### Task B1: Bind the engine to the agent's program

**Files:**
- Modify: `package.json` (the agency-lang version from A4), `src/agent/agentModule.ts`, `src/agent/session.ts`, `src/agent/settings.ts`
- Create: `src/agent/sessionProgram.ts`
- Delete: `src/agency/perry.agency`, `src/agency/core.agency`, `src/agency/answers.agency`, `src/agency/editDiffs.agency`, `src/agency/echoEditDiffs.agency`
- Test: `src/agent/sessionProgram.test.ts`

**Interfaces:**
- `sessionProgram.ts` is the one file that imports `agency-lang/agent-session`. The compiled program has no type declarations, so this file declares the part Perry uses, as `agentModule.ts` does for the generated module today:

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
export function pauseData(pause: Interrupt[]): PauseData | null;
```

- `USER_MESSAGE_EFFECT` in `session.ts` becomes `"agent::sessionInput"`. `withPerrysPauseLeftAlone` in `src/agent/policy.ts` and `runPolicy` in `src/engine/engine.ts` pin it.
- `perryAgentIn({ cwd, logFile, record })` builds the `ProgramStart`: `brain: ""`, `preset: ""`, no model flags, no limits, `replyStyle: ""`, `flags: null`, `budget: { maxCost: 50, maxTime: 30 * 60_000 }`, and the record the engine made for the session.
- `messageAnswer(text)` returns the core's `message` answer with `notes: []` and `target: ""`.
- The import of `agency-lang/agent-session` runs the agent's module statics. `AGENCY_AGENT_HOME` must be final before it: `src/engine/main.ts` already settles the home first. Make the import dynamic, behind a function, so a test can set the home before it loads.

- [ ] **Step 1: Write the failing test.** `sessionProgram.test.ts` sets a temp `AGENCY_AGENT_HOME` and `ANTHROPIC_API_KEY=test-key`, installs a client with the program's `__setLLMClient` that replies `stub reply`, starts a session in a temp folder through `perryAgentIn`, and checks: the first pause's effect is `agent::sessionInput`; `pauseData` reads a main model and the $50 budget; a `messageAnswer("hello")` emits `session.reply` with `stub reply`; the checkpoint's `moduleFingerprints` name no file under Perry's `src/`.
- [ ] **Step 2:** Run: `pnpm vitest run src/agent/sessionProgram.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. The rest of the tests will not compile yet. That is Tasks B2 to B5.
- [ ] **Step 4:** Run the new test. Expected: PASS.
- [ ] **Step 5:** Commit: `Run the agency agent's session program in place of Perry's core`.

### Task B2: The test double speaks the core's interface

**Files:**
- Modify: `src/agency/echoCore.agency`, `src/agency/echoFixture.agency`, `src/agency/echoOther.agency`, `src/agent/echoAgent.ts`, `src/agent/events.ts`
- Test: the existing tests that use the echo agents

**Interfaces:**
- `echoCore.agency` raises `agent::sessionInput` with the core's pause data (`thread`, `cwd`, `record`, `models`, `preset`, `effort`, `budget`, `context`), takes the core's answers, and emits `session.reply`, `session.error`, `session.notice`, `session.budgetStop`. It keeps its test messages (`slow`, `approve:…`, `fail`, `turns`, `read:…`). `model`, `effort`, `preset` and `budget` answers change what its next pause reports, and a `model` spec of `bad/model` is an error notice.
- `EMIT_TO_ITEM` in `events.ts` maps `session.reply`, `session.error`, `session.budgetStop`, and `session.notice` to a notice item whose text is the notice's.
- When creating a session fails (the program's `main` resolves with a failure), `startRun` returns that failure, and the engine's `POST /sessions` answers 500 with the reason. Review Focus 4.

- [ ] **Step 1:** Change the fixtures and `events.ts`, and fix the tests that name the old events or the old answer.
- [ ] **Step 2:** Add to `src/engine/engine.test.ts`: a session whose start fails reports the reason, and a second session then starts.
- [ ] **Step 3:** Run: `pnpm vitest run src/agent src/agency src/hooks`. Expected: PASS.
- [ ] **Step 4:** Commit: `Give the echo fixture the session core's interface`.

### Task B3: Settings, read from the pause and sent as answers

The wire format keeps `SessionView.settings` and `PATCH /sessions/:id/settings`.

**Files:**
- Modify: `src/agent/settings.ts`, `src/agent/sessionMachine.ts`, `src/engine/settingsChange.ts`, `src/engine/settingsChoices.ts`, `src/engine/engine.ts`, `src/engine/sessionView.ts`
- Test: `src/engine/settingsChange.test.ts`, `src/engine/settingsChoices.test.ts`, `src/engine/engine.test.ts`, `src/engine/sessionView.test.ts`

**Interfaces:**
- `Settings` loses `openRouter`. `settingsIn(pause)` builds a `Settings` from `pauseData`: `provider` and `model` from `models.main`, `effort`, `maxCost` and `maxTime` from `budget`, `preset` (null for `""`). `openai-responses` is still shown as `openai` (`shownProvider`).
- `DEFAULT_SETTINGS` goes. What a new session has is what its first pause reports.
- `changedSettings` returns the one answer a request means:

| The request holds | The answer |
| --- | --- |
| `provider`, `model`, or both | `{ kind: "model", spec: "<provider>/<model>" }`, filling the missing one from the session |
| `effort` | `{ kind: "effort", effort }` |
| `maxCost`, `maxTime`, or both | `{ kind: "budget", maxCost, maxTime }`, filling the missing one |
| `preset` | `{ kind: "preset", name }` |

  A request that holds fields from two rows is refused with a 400 that names them. The Mac app sends one control's change at a time, so it never does.
- The `configured` action carries the answer in place of a whole `Settings`. After the leg, the notice is added only when the pause's settings differ from before. When the core refused the change it has already sent a `session.notice` with the reason, which Task B2 shows.
- `settingsChoices.ts` drops its copy of the agent's preset reader and the "can't be picked" reasons. The core applies a preset whole, including slots and tool limits. It lists the names from `<home>/settings.json`.

- [ ] **Step 1: Write the failing tests.** In `settingsChange.test.ts`: each row of the table; a request across two rows is refused; a provider alone takes the session's model. In `engine.test.ts`, against the echo fixture: a model change shows in the next `settings`; `bad/model` leaves `settings` unchanged and adds the error notice to the transcript. Review Focus 3.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: `pnpm vitest run src/engine src/agent`. Expected: PASS. Run `src/engine/samples.test.ts` and check the sample file's `settings` still has the fields the Mac app decodes. If `openRouter` was in the sample, write the sample again and raise `PROTOCOL_VERSION` in `protocol.ts` and `Protocol.swift`.
- [ ] **Step 5:** Commit: `Read a session's settings from the core's pause, and change them with its answers`.

### Task B4: The session record is the core's

**Files:**
- Modify: `src/engine/sessionFiles.ts`, `src/engine/engine.ts`
- Test: `src/engine/sessionFiles.test.ts`, `src/engine/engine.test.ts`

**Interfaces:**
- The engine makes a session's record when it creates the session (`id`, `cwd`, `brain: ""`, `created`, `lastActive`, `turns: 0`, `title: ""`) and gives it to the program. After that, the record it saves is the one in the pause's data, which the core keeps: the real brain, the turn count, the title.
- `PERRY_BRAIN` and the filter on it go. `loadSessions` lists every record. A record whose run file is not a `SavedRun` is left out with one log line: until the terminal's plan lands, the agent's own sessions are saved in its old format.
- A `SavedRun` whose code no longer matches still loads as ended with the reason (`canResume`). Review Focus 2.

- [ ] **Step 1: Write the failing tests.** A saved session's `.meta.json` has the brain the pause reported and a turn count of 1 after one turn; a folder holding a record with `brain: "coordinator"` and a run file that is not a `SavedRun` loads without it and without throwing; a `SavedRun` with a foreign fingerprint loads as ended.
- [ ] **Step 2:** Run. Expected: FAIL on the first two.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: `pnpm vitest run src/engine`. Expected: PASS.
- [ ] **Step 5:** Commit: `Save the session record the core keeps`.

### Task B5: Edit diffs from the core's event

**Files:**
- Modify: `src/agent/events.ts`, `src/agent/editDiffEvent.ts`, `src/engine/approvalDiff.ts`
- Delete: `src/lib/editDiff.ts`, `src/lib/editDiff.test.ts`
- Test: `src/agent/events.test.ts`, `src/engine/approvalDiff.test.ts`

**Interfaces:**
- The row's diff comes from `session.editDiff` (`EDIT_DIFF_EMIT`), with the fields it had.
- The approval's diff is made by agency-lang's function, imported from `agency-lang/stdlib-lib/editDiff.js`, from the interrupt's `before` and `after`. It is the same code that made the row's, so the two cannot differ.

- [ ] **Step 1:** Change the event name in the tests, and add the test for Review Focus 5: a session saved while it waits on an edit's approval, loaded by a new engine, has a diff on its approval.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: `pnpm vitest run src/agent src/engine`. Expected: PASS.
- [ ] **Step 5:** Commit: `Take edit diffs from the session core`.

### Task B6: The real program, end to end

**Files:**
- Test: `src/engine/realProgram.test.ts`

- [ ] **Step 1: Write the test.** With a temp home and a stub client, one engine holds two sessions in two temp folders, each with its own `.claude/commands/hello.md`. Check: each session's `/hello` reply holds its own folder's text (Review Focus 1); a second engine over the same home loads both and each takes another message; the saved records' `brain` is `coordinator`.
- [ ] **Step 2:** Run: `pnpm vitest run src/engine/realProgram.test.ts`. Expected: PASS. A failure is a finding about the core. Stop and report it.
- [ ] **Step 3:** Run everything: `pnpm test:run`, `pnpm typecheck`, `pnpm lint`. Expected: clean.
- [ ] **Step 4:** Commit: `Test: two sessions of the real program in one engine`.

### Task B7: The terminal UI, the one-shot run, and the docs

**Files:**
- Modify: `src/hooks/useAgentSession.ts`, `src/agent/oneShot.ts`, `src/cli/startup.ts`, and the components that read `Settings`
- Modify: `docs/idea.md`, `docs/dev/agent-run.md`, `docs/dev/engine.md`, `docs/dev/approvals.md`, `docs/dev/one-shot.md`, `docs/dev/build.md`, `CLAUDE.md`

- [ ] **Step 1:** The Ink terminal UI and `perry -p` start the same program through `perryAgentIn`. Neither sends a settings change. Fix what no longer compiles.
- [ ] **Step 2:** Run `pnpm test:run`. Expected: PASS.
- [ ] **Step 3:** Rewrite the docs for what is true now. `agent-run.md` loses "The agent core", "What the pause accepts" and "The settings" as they stand, and points at agency-lang's `session-core.md` for the core. `idea.md` and `CLAUDE.md` no longer say the two agents cannot continue each other's sessions because their cores differ: they say Perry runs the agent's program, and that the terminal still saves in its old format until it moves onto the core.
- [ ] **Step 4:** Run `pnpm app` and check by hand: a new chat answers, a model change in the panel shows in the subtitle, an edit shows its diff, an approval can be answered, and the chat is there after the engine restarts.
- [ ] **Step 5:** Commit: `Docs: Perry runs the agency agent's session program`. Open the pull request.
