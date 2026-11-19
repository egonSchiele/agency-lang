# Shared Session Core, Plan 1: The Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a session program to the agency agent that any front-end can run by answering interrupts, and export it from the package, so a second process can resume a session the first one saved.

**Architecture:** A new node, `session` in `lib/agents/agency-agent/core.agency`, loops: pause on `agent::sessionInput`, then run a turn or apply a command, then emit events. `program.agency` is the program around it: `main` does setup from data and goes to `session`. Its imports reach no terminal code, and `package.json` exports the compiled program as `agency-lang/agent-session`. No module moves. `agency agent` keeps working as it does today throughout this plan.

**Tech Stack:** Agency (agency and agency-js tests), TypeScript for the test drivers. Model calls in the agency-js tests are answered by a test client installed with `__setLLMClient`.

**Spec:** `docs/superpowers/specs/2026-11-18-shared-session-core-design.md`

**Review:** `docs/superpowers/plans/2026-11-18-shared-session-core-1-core-review.md` reviewed an earlier version that moved the modules into the stdlib. "What the review changed" at the end says what became of each finding.

All paths are relative to `packages/agency-lang/`. `AGENT` means `lib/agents/agency-agent`. Write the full path where a command shows `AGENT`.

## The four plans

Each leaves working software, and each is written when the one before it lands.

1. **The core** (this plan). Done when a test drives a session through the program, and a fresh process that imports it through the package export finishes a turn the first one paused.
2. **Perry on the core.** Perry already has a driver, so it gives the core a real user cheaply. It starts with the folder problem under "Known and left for Plan 2".
3. **The terminal on the core.** The shell run, the driver, approvals out of the run, the session file format. The first real handoff.
4. **The remaining commands.** `preset`, `compact`, `rename`, `fork`, `search`, `reload`.

## Global Constraints

- `agency agent` behaves the same after every task. Its tests in `AGENT/tests/` pass after every task.
- No file moves out of `AGENT/`. Nothing is added under `stdlib/`.
- The import closure of `AGENT/program.agency` contains none of: `agent.agency`, `lib/repl`, `lib/capabilitiesUi`, `lib/mcpMenu`, `lib/header`, `lib/transcript`, `lib/args`, `lib/policy`, `lib/trace`, `lib/runSession`, `lib/resume`, `lib/slashCommands/*`.
- Nothing the program can reach calls `_exit`, `pushMessage`, `chooseOption` or `clearScreen`. Two exceptions: `configureLocalModel` still exits when a local model fails to load, and startup warnings that `print` stay for now. Task 3 lists both.
- The core installs no policy handler. Its only handler in this plan is the budget stop. Perry's plan adds one for edit diffs.
- Job tools and spill tools are not passed to a turn the core runs.
- The effect is `agent::sessionInput`. Events are `session.reply`, `session.error`, `session.notice`, `session.budgetStop`.
- The `match` over an `Answer` has no `_` arm. The type checker does not check an object union for missing cases yet (B2 in `docs/dev/compiler/typechecker/narrowing/README.md`). When it does, a `_` arm would hide the case it reports.
- Do not run the full agency test suite locally. Run the named tests and save their output to a file.
- Never commit to `main`. Work on `adit/shared-session-core`.

## Review Focus

1. **A policy that answers the pause** (`approve-all`, with the pin forgotten). The run's policy answers a raise that expects a value with `null`. The core treats `null` as "end the session" and returns. It must not spin. Test in Task 5.
2. **A turn that fails.** The core emits `session.error`, counts the turn as the REPL does, and pauses again. Test in Task 5.
3. **An approval in the middle of a turn, resumed by a process that never ran `main`.** The turn finishes there. Test in Task 6.
4. **A setup that fails** (an unknown brain, a preset that cannot be used). The run ends with the reason and the process does not exit. Test in Task 5.
5. **A model switch that fails.** The models stay as they were, and the failure reaches the caller as a value, not only as a printed line. Tests in Tasks 4 and 5.

---

### Task 1: Check `repl()` over a session run on a real terminal

This decides the shape of Plan 3 and depends on nothing else here. It needs a person at a terminal: the pinned approval prompt and the palette need a TTY. No other task waits on it.

**Files:**
- Create, on the throwaway branch `spike/run-in-run` and not on this one: `spike-run-in-run/shell.agency`, `spike-run-in-run/shellDriver.js`, `spike-run-in-run/shellRun.mjs`

**What to build:** a shell program whose `main` calls `repl(onSubmit: submit, prompt: "> ")`. `submit` hands the line to a driver that runs the spike's `programA` over `core.agency`, as `spike-run-in-run/driver.js` does now, and answers the core's `spike::approval` by calling `interruptChoice` from `std::ui/cli` in the shell's run.

- [ ] **Step 1:** Build it and compile it.
- [ ] **Step 2:** Ask the owner to run `node spike-run-in-run/shellRun.mjs` in a terminal and report five things: a line echoes; `approve:x` shows the pinned prompt and its answer reaches the core; Esc during `slow` returns to the prompt; the footer after a turn shows a time; Ctrl+D exits cleanly.
- [ ] **Step 3:** Put the answers in Task 7's doc. Any item that fails is listed with what `cli.ts` would need.

---

### Task 2: Untangle the imports that reach terminal code

Seven imports go from a module the program needs to a module that draws:

- `lib/answer.agency:18`, `lib/budget.agency:10`, `lib/cliTools.agency:23` import `isInteractive` from `trace`.
- `lib/grounding.agency:8` imports `parseAgentArgs` from `args`.
- `lib/sessionSearch.agency:8` imports `currentSessionId` from `resume`.
- `lib/turn.agency:20` imports from `policy`, and `lib/turn.agency:22` from `resume`.

**Files (under `AGENT/`):**
- Create: `lib/record.agency`, `lib/runSession.agency`
- Modify: `lib/answer.agency`, `lib/cliTools.agency`, `lib/grounding.agency`, `lib/resume.agency`, `lib/sessionSearch.agency`, `lib/turn.agency`, `lib/repl.agency`, `lib/slashCommands/policy.agency`, `agent.agency`, and any test that imports a moved name
- Test: `AGENT/tests/importClosure.agency`, `importClosure.test.json`

**Interfaces:**
- **`isInteractive`.** No shared flag replaces it. Each of its three uses gets its own switch:
  - **The reply style** (`answer.agency:41`): `setReplyStyle(style: string)`, a global that starts as `""`. `addReplStyle` adds the stored line when it is not `""`. The agent's `runSession(true)` calls `setReplyStyle(REPL_STYLE)`. The core sets it from its start data.
  - **Job and spill tools** (`cliTools.agency:48`): `setJobToolsOn(on: boolean)`, a global that starts as `false`. `sessionJobTools()` returns `jobTools()` only when on. Both places job tools come from go through it: `cliSettings().coderTools` and `jobAndSpillTools()`. The agent's `runSession(true)` turns it on. The core never does.
  - **The budget-stop line** (`budget.agency:22`): Task 3.
- **`lib/record.agency`** takes everything in `resume.agency` that is the record and not the picker: the globals `_current`, `_turnDone`, `_incognito`, `_renamed`, `_titlePinned`, `_conversationThread`; `SaveTarget`; `sessionTitle`, `markTurnDone`, `renameSession`, `currentSessionId`, `setConversationThread`, `conversationThread`, `forkSession`, `startIncognito`, `recordTurn`; and two new functions, `setCurrentRecord(record: SessionRecord | null)` and `currentRecord(): SessionRecord | null`. `resume.agency` keeps `incognitoProblem`, `chooseSession`, `pickSession`, `startSession`, `saveSeedTurn`, and `startSession` calls `setCurrentRecord`.
- **`lib/runSession.agency`** takes `setPolicyArg`, `usesSavedPolicy`, `policyHandlerFor`, `runSession` and the `_policyArg`, `_approveArg`, `_rejectArg` globals out of `turn.agency`.
- **`groundingText(brainName: string, startedWith: string): string`.** `sessionFactsText` takes the same string in place of `flags`, and leaves the "flags you were started with" block out when it is `""`. The agent's `runSession` passes `JSON.stringify(parseAgentArgs().flags, null, 2)`, so the agent's grounding is byte-for-byte what it was.
- **`commandPalette.agency`** is needed by `turn.agency` for `slashCommands()` and stays where it is. If it imports a module on the forbidden list, split `slashCommands()` and what it needs into `lib/userCommands.agency`.

- [ ] **Step 1: Write the failing test.** `importClosure.agency` has one node, `turnReachesNoTerminalCode`, that walks the imports of `AGENT/lib/turn.agency`, `AGENT/lib/record.agency` and `AGENT/lib/sessionSearch.agency` (read the files, follow relative `import` lines) and returns the forbidden modules it reached, sorted and joined by commas. Expected output: `""`.
- [ ] **Step 2:** Run: `pnpm run agency test AGENT/tests/importClosure.agency`. Expected: FAIL, with `args`, `policy`, `resume` and `trace` in the list.
- [ ] **Step 3:** Make the changes above.
- [ ] **Step 4:** Run `make`, the new test, and the agent's tests: `pnpm run agency test AGENT/tests > /tmp/task2.log 2>&1`. Expected: all pass.
- [ ] **Step 5:** Commit: `Agent: keep the turn and the session record free of terminal code`.

---

### Task 3: Notices: mid-session lines become events

**Files:**
- Create: `AGENT/lib/notice.agency`
- Modify: `AGENT/lib/session.agency` (the `pushMessage` calls in `applyRequestOptions` and `reactToSlotChange`, at lines 172, 354, 369, 378), `AGENT/lib/mcp.agency` (`startPendingMcpServers`), `AGENT/lib/budget.agency` (`guardStopHandler`), `AGENT/lib/turn.agency` (`checkForAttachments`), `AGENT/lib/cliTools.agency` (`checkCliBundles`), `AGENT/lib/compaction.agency`, `AGENT/lib/repl.agency`, `AGENT/lib/trace.agency`, `AGENT/lib/runSession.agency`
- Test: `AGENT/tests/notices.agency`, `notices.test.json`

**Interfaces:**
- Produces: `notice(text: string, level: "info" | "warning" | "error" = "info")`, which calls `emit({ type: "session.notice", text: text, level: level })`. The text carries no color codes.
- `guardStopHandler` emits `{ type: "session.budgetStop", label: string, dimension: string }` in place of its `print`, on every run. It no longer imports `trace.agency`.
- `checkCliBundles(): Result<boolean>` returns the failure and no longer exits. `runSession` prints it and exits, as now.
- `compactAndReport(threadId: string, instructions: string): boolean` and `compactIfDue(threadId: string)` move from `repl.agency` to `compaction.agency`, with their three `pushMessage` lines as notices (the failure at level `warning`). `repl.agency` calls them with `conversationThread()`.
- `trace.agency`'s `onEmit` callback prints a `session.notice` with `pushMessage`: dim for `info`, yellow for `warning`, red for `error`. It prints a `session.budgetStop` with the sentence `guardStopHandler` printed before, and only when `isInteractive()`, which is when it printed before, so a `-p` run's output does not change.
- The three failure lines in `switchModel` (287, 301, 324) are Task 4's.

- [ ] **Step 1: Write the failing test.** A node `budgetStopIsAnEvent` calls `guardStopHandler` with `{ effect: "std::guard", data: { label: "the coder", dimension: "cost" } }`, collects `onEmit` events, and returns them. Expected: one event `{ type: "session.budgetStop", label: "the coder", dimension: "cost" }`.
- [ ] **Step 2:** Run it. Expected: FAIL, no such event.
- [ ] **Step 3:** Add `notice.agency`, convert the call sites, move the two compaction functions, add the `onEmit` branches.
- [ ] **Step 4:** Check what the program can still reach.

Run: `grep -n -E 'pushMessage\(|chooseOption\(|clearScreen\(|_exit\(|\bprint\(' AGENT/shared.agency AGENT/lib/*.agency`, and drop the matches in files on the forbidden list.
Expected: the matches left are all in this list, which goes into Task 7's doc as it stands:

| Where | Why it is left |
| --- | --- |
| `session.agency`: `pickGuidedLocalModel`, `pickModelsForAgent`, `maybeEnableMemory`, and `switchModel`'s three failure lines | Terminal startup only. Task 4 handles the last two. |
| `presets.agency`: `startPreset` | Terminal startup only. Task 4 adds the quiet version. |
| `shared.agency`: `configureLocalModel` | A local model that fails to load ends the process. Left out of scope. |
| `settings.agency`, `capabilities.agency`, `globalInstructions.agency`, `search.agency`: `configureSearch` | Warnings that `print` when a settings file or a key is wrong. They reach the engine's log in Perry. Plan 2 turns them into notices. |
| `mcp.agency`: `maybeLoadMcp` | The front-end's own startup. The program does not call it. |

A match outside this list is converted or reported.

- [ ] **Step 5:** Run the new test and the agent's tests. Expected: all pass.
- [ ] **Step 6:** Commit: `Agent: report mid-session lines as session.notice events`.

---

### Task 4: Startup and `/model` that report failure to their caller

The program's `main` runs the agent's startup. Two of those functions print and call `_exit`, which would stop Perry's engine. `switchModel` prints its failures and returns the old session, so a caller cannot tell a failed switch from a switch to the model already in use.

**Files:**
- Modify: `AGENT/lib/session.agency`, `AGENT/lib/presets.agency`, `AGENT/lib/repl.agency`, and the tests that call `switchModel`
- Test: `AGENT/tests/quietStartup.agency`, `quietStartup.test.json`

**Interfaces:**
- Changes: `switchModel(prior, spec, ctx, before): Result<{ session: Session; resolved: Record<string, Resolved>; changes: SlotChange[] }>`. Its three failure branches return `failure(reason)` with the text they print today, and print nothing. `modelSlashCommand` (`repl.agency:189`) pushes the reason in red on a failure, so the terminal shows what it showed.
- Produces, in `presets.agency`: `startPresetQuiet(flag: string, settings: Settings): Result<string[]>`. It sets the table and the active preset and returns the warnings. `startPreset` calls it, prints the warnings, and prints and exits on failure, as now.
- Produces, in `session.agency`: `startModels(flags: ModelFlags): Result<boolean>`. It is `pickModelsForAgent` from `setStartupModelFlags` on, with the failure returned. It does not open the guided local picker. `pickModelsForAgent` parses the args, applies `withGuidedLocal`, calls it, and prints and exits on failure, as now.
- Produces, in `session.agency`: a global `_choices: ModelChoices = noModelChoices()` with `modelChoices()` and `setModelChoices(choices)`. `repl.agency` holds this today as `_session`, in a file the program does not load. `repl.agency` drops `_session` and uses these.
- Produces, in `session.agency`: `applyModelSpec(spec: string): Result<Record<string, Resolved>>`. It does what `modelSlashCommand` does after its picker: builds the `Ctx` from `currentProvider()`, calls `switchModel` with `modelChoices()` and `getResolvedSlots()`, and on success stores the new choices, calls `reactToSlotChange` for each change, and returns the resolved slots. `modelSlashCommand` calls it.
- Produces, in `session.agency`: `applyLlmOptionsAnswer(options: LlmOptions)`, which stores `applySessionLlmOptions(modelChoices(), options)`.

- [ ] **Step 1: Write the failing tests.** Each starts the models the way the existing agent tests do (see how `AGENT/tests/models.agency` and `resolution.agency` set up slots without real keys).
  - `unusablePresetIsAFailure`: `startPresetQuiet("no-such-preset", {})` is a failure. Expected `"true"`.
  - `mainSlotIsSetAfterStartup`: after `startModels(noModelFlags())`, `getResolvedSlots()["main"]` is not null. Expected `"true"`.
  - `specChangesTheMainSlot`: `applyModelSpec("anthropic/claude-sonnet-5-5")` succeeds and the main slot's model is `"claude-sonnet-5-5"`.
  - `badSpecChangesNothing`: with a non-null main slot recorded first, `applyModelSpec("no-such-provider/x")` is a failure, and the main slot is what it was. Expected `"true|true"`.
- [ ] **Step 2:** Run to see them fail on the missing functions.
- [ ] **Step 3:** Implement, and switch the callers over.
- [ ] **Step 4:** Run the new tests and the agent's tests. Expected: all pass.
- [ ] **Step 5:** Commit: `Agent: startup and /model that report a failure to their caller`.

---

### Task 5: The core and the session program

**Files:**
- Create: `AGENT/core.agency`, `AGENT/program.agency`
- Modify: `AGENT/lib/answer.agency`
- Test: `tests/agency-js/session-core/test.js`, `fixture.json`; extend `AGENT/tests/importClosure.agency`

**Interfaces:**
- Consumes: `runTurn`, `setBrainName`, `resolveBrainName`, `currentBrainName` (`lib/turn`); `withPendingNotes`, `addNote` (`lib/pendingNotes`); `startModels`, `applyModelSpec`, `applyLlmOptionsAnswer`, `takePendingLlmOptions` (`lib/session`); `startPresetQuiet`, `activePreset`, `activePresetName` (`lib/presets`); `applyToolLimits`, `setStartupLimitFlags` (`lib/toolLimits`); `setCurrentRecord`, `currentRecord`, `markTurnDone`, `recordTurn`, `conversationThread` (`lib/record`); `getResolvedSlots`, `getCapabilities` (`shared`); `contextStatus`, `compactIfDue` (`lib/compaction`); `setGrounding`, `groundingText` (`lib/grounding`); `guardStopHandler` (`lib/budget`); `setReplyStyle` (`lib/answer`); `checkCliBundles` (`lib/cliTools`); `loadSettings` (`lib/settings`); `notice` (`lib/notice`); `agencyAgentBrains` (`std::agents/agency`); `getAgentCwd`, `setAgentCwd` (`std::index`).
- Produces, in `core.agency`:

```ts
effect agent::sessionInput {
  thread: string;
  cwd: string;
  record: SessionRecord | null;
  models: Record<string, Resolved>;
  preset: string;
  budget: TurnBudget;
  context: string
}

export type TurnBudget = { maxCost: number; maxTime: number }

export type SessionStart = {
  cwd: string;
  replyStyle: string;
  record: SessionRecord | null;
  startedWith: string
}

export type Answer =
  | { kind: "message"; text: string; notes: string[]; target: string }
  | { kind: "model"; spec: string }
  | { kind: "options"; options: LlmOptions }
  | { kind: "budget"; maxCost: number; maxTime: number }

export node session(start: SessionStart)
```

- Produces, in `program.agency`, which imports the core with `import node { session } from "./core.agency"`:

```ts
export type ProgramStart = {
  brain: string;
  preset: string;
  models: ModelFlags;
  limits: LimitFlags;
  oneShot: boolean;
  session: SessionStart
}

node main(start: ProgramStart)
```

**Behaviour the tests pin:**
- **`main`**, in this order: resolve the brain with `resolveBrainName(start.brain, loadSettings())` and check it against `agencyAgentBrains()`; `setBrainName`; `startPresetQuiet`; `startModels`; `setStartupLimitFlags` and `applyToolLimits(activePreset(), start.oneShot)`; set `maxTokens` from `getCapabilities()` as `agent.agency` does; `disableMemory() with approve`; `goto session(start.session)`. A step that fails throws its reason, so the run ends with it. A preset's warnings are emitted as notices at level `warning`.
- **`session`, before the loop:** `setAgentCwd`, `setCurrentRecord`, `setReplyStyle(start.replyStyle)`, `checkCliBundles` (a failure throws), and the grounding built once with `groundingText(currentBrainName(), start.startedWith)`. No handler is needed around it: `projectContextText` reads the instruction files under its own `with approve`, and a run policy says nothing about a read it has no rule for. A reject rule in the run's policy still rejects the read.
- **The pause:** `const answer: Answer! = raise agent::sessionInput("Waiting for the user", data)`, with `data` from `conversationThread()`, `getAgentCwd()`, `currentRecord()`, `getResolvedSlots()`, `activePresetName()`, the core's budget, and `contextStatus(conversationThread())`.
- **`null` ends the session.** A raw answer of `null` makes the node return, before the `Answer` check. This is what a run policy sends when an approve rule matches the pause (`lib/runtime/runPolicyHandler.ts:47-66`), and without it the core would raise again forever without pausing. Since `Answer!` turns `null` into a failure, the raise is first received untyped and then checked.
- **The budget** is a local of the node, `{ maxCost: -1, maxTime: -1 }` until a `budget` answer. `answerTurn` takes `maxCost` and `maxTime` as two parameters that default to its `NO_LIMIT`, so the agent's own calls are unchanged. The core's value reaches it through a global in `answer.agency`, `setTurnBudget(maxCost: number, maxTime: number)`, since `runTurn` stands between them.
- **A `message`:**

```
{ kind: "message", text, notes, target } => {
  for (note in notes) { addNote(note) }
  let reply: Result<string> = failure("no reply")
  handle {
    reply = try runTurn(target, withPendingNotes(text))
  } with guardStopHandler
  if (reply is success(replyText)) {
    emit({ type: "session.reply", text: replyText })
  } else if (reply is failure(err)) {
    emit({ type: "session.error", message: "${err}" })
  }
  // then, as the REPL does after every turn, failed or not:
  // apply the pending LLM options, markTurnDone(), recordTurn(text),
  // compactIfDue(conversationThread())
}
```

  `runTurn` installs `guardStopHandler` itself today. Leave that as it is and do not add a second one if the first already covers the call. The outline shows where it sits, not that it is added twice.
- **A front-end sends an image as a note with its path,** as `/image` does now. `runTurn` finds attachments by scanning the message text, so the answer has no attachments field.
- **`model`** calls `applyModelSpec`. A failure is a notice at level `error` with the reason.
- **A value that is not an `Answer`** emits `session.error` with `The run was sent an answer it can't read: <problem>` and pauses again. Each one costs the front-end a resume, so it cannot spin.

- [ ] **Step 1: Prove the program shape first.** Write `core.agency` with a stub `session` that raises the pause once and returns, and `program.agency` whose `main` only does `goto session(start.session)`. Run a three-line `test.js` that imports `AGENT/program.js`, calls `main`, and checks that the result holds an interrupt whose effect is `agent::sessionInput`. Expected: it does. This separates a problem with the import or the effect's declaration from a problem with the core.
- [ ] **Step 2: Write the failing tests.** `test.js` imports the compiled `AGENT/program.js` and installs a test client with `__setLLMClient`, as `tests/agency-js/agent-effort/test.js:13` does. The client answers by the last user message: `stub reply` for an ordinary message, a short title for the title call `recordTurn` makes on turn 1, and it throws for the message `fail this turn`. The program starts with `brain: "simple"` and a policy option that pins `agent::sessionInput` to `propagate`. `fixture.json` expects:

```json
{
  "firstPauseEffect": "agent::sessionInput",
  "mainSlotIsSet": true,
  "reply": "stub reply",
  "turnsAfterOneMessage": 1,
  "badAnswer": "The run was sent an answer it can't read",
  "badAnswerPausedAgain": true,
  "nullAnswerEndsTheRun": true,
  "approveAllWithoutThePinEndsTheRun": true,
  "budgetAfterAnswer": { "maxCost": 2, "maxTime": 60000 },
  "badModelNoticeLevel": "error",
  "badModelKeptMainSlot": true,
  "unknownBrainEndsTheRun": "Unknown brain",
  "unusablePresetEndsTheRun": true,
  "processStillAliveAfterFailedSetups": true,
  "turnFailureEmitsError": true,
  "pausedAgainAfterFailure": true,
  "turnsAfterTheFailedTurn": 2
}
```

`badAnswer` and `unknownBrainEndsTheRun` are checked as prefixes. `approveAllWithoutThePinEndsTheRun` starts the program with the built-in `approve-all` policy (`builtinPolicy("approve-all", cwd)` in `std::policy`) and no pin, and is true when `main` resolves with no interrupt within five seconds. For the failed turn, assert what the run does: if the throw from the client comes back as reply text ("The agent stopped before finishing: ..."), as `answerTurn` suggests it may, report that and pin the behaviour found, with `turnFailureEmitsError` renamed to say so.

Add a node `programReachesNoTerminalCode` to `importClosure.agency`, the same walk from `AGENT/program.agency`. Expected output: `""`.

- [ ] **Step 3:** Run: `pnpm run agency test js tests/agency-js/session-core > /tmp/task5.log 2>&1`. Expected: FAIL.
- [ ] **Step 4:** Write the real `core.agency` and `program.agency`, and add the budget to `answerTurn`.
- [ ] **Step 5:** Run `make`, then both tests. Expected: PASS.
- [ ] **Step 6:** Run the agent's tests. Expected: all pass.
- [ ] **Step 7:** Commit: `Agent: the session core and its program`.

---

### Task 6: The export, and a fresh process finishing a paused turn

**Files:**
- Modify: `package.json`
- Test: `tests/agency-js/session-core-handoff/test.js`, `resume-stage.js`, `fixture.json`

**Interfaces:**
- Produces: the export `"./agent-session": { "import": "./dist/lib/agents/agency-agent/program.js" }`. It has no `types` entry: compiled Agency has no declarations, and a front-end types its own binding, as Perry does for its generated modules today.

- [ ] **Step 1: Write the test.** `test.js` imports `agency-lang/agent-session` and installs a test client as Task 5 does. It starts the program on the `minimal` brain and sends a message for which the client returns a tool call that reads a file outside the working folder, so the turn pauses on a `std::read` approval. It writes the pause to `pause.json` and runs `resume-stage.js` in a fresh Node process, as `tests/agency-js/agent-session-resume` does. `resume-stage.js` imports `agency-lang/agent-session`, installs the same client, never calls `main`, approves the read, and writes the result. `fixture.json` expects:

```json
{
  "pausedOn": "std::read",
  "pauseModulesHoldNoTerminalCode": true,
  "reply": "stub reply after the read",
  "turnsAfterResume": 1,
  "nextPauseEffect": "agent::sessionInput",
  "brainAfterResume": "minimal"
}
```

`pauseModulesHoldNoTerminalCode` is true when no key of the approval's `checkpoint.moduleFingerprints` names a module on the forbidden list in Global Constraints. `brainAfterResume` is the `brain` of the record in the next pause's data.

- [ ] **Step 2:** Run: `pnpm run agency test js tests/agency-js/session-core-handoff > /tmp/task6.log 2>&1`. Expected: FAIL, the package has no such export.
- [ ] **Step 3:** Add the export and run `make`.
- [ ] **Step 4:** Run. Expected: PASS. A failure after the export exists is a finding about the core, not about the test: stop and report which module was on the stack.
- [ ] **Step 5:** Commit: `Export the agent's session program as agency-lang/agent-session`.

---

### Task 7: Dev doc

**Files:**
- Create: `docs/dev/agents/session-core.md`, with its line in the dev docs index (`node scripts/lint-dev-docs-index.mjs` checks it)
- Modify: `docs/dev/agents/agent-brains.md` and `docs/dev/agents/agent-sessions.md`, where they name `runSession` in `lib/turn.agency` or the record in `lib/resume.agency`

**Content of `session-core.md`**, one page: what the program is for; that both front-ends load the same compiled files, which is why a session crosses; the interface (`ProgramStart`, the pause's data, the four answers, the events); that `null` ends the session and why; the rule that the program's imports reach no terminal code, and the test that holds it; that the export is the one public thing and the modules behind it are not; Task 3's table of what still prints or exits; "Known and left for Plan 2" below; and "The terminal: what the check found", which says "not run yet" until Task 1 is done.

- [ ] **Step 1:** Write and update the docs.
- [ ] **Step 2:** Run `pnpm run lint:structure` and `pnpm run fmt:ts`. Expected: clean.
- [ ] **Step 3:** Commit: `Docs: the session core`.

---

## Known and left for Plan 2

**The program reads the process's folder where it should read the session's.** These run when the modules load, in whichever process loads them, and use the process's `cwd()`:

| File | Line | What it reads |
| --- | --- | --- |
| `lib/claudeSkills.agency` | 194 | `loadSkillSources(cwd(), os.homedir())` |
| `lib/commandPalette.agency` | 7, 11 | `${cwd()}/.claude/commands`, and the init file under `cwd()` |
| `lib/sessions.agency` | 42 | `projectDir()`, the folder a session is saved under |

For the terminal the two folders are the same. Perry's engine runs every session from one folder, so each session would get the engine folder's user commands and Claude skills, at a fresh start and after a handoff. Task 6 cannot catch it, because both of its processes run in one folder. Each read has to become a function of the session's folder (`getAgentCwd()`), and that is the first task of Perry's plan.

**Startup warnings that `print`** (Task 3's table) reach the engine's log and no client.

**Terminal wording.** Lines such as "reopen it with: agency agent --resume <id>" are written for the terminal. They matter once `rename` and `fork` are answers, in Plan 4.

## What the review changed

The review was written against a version of this plan that moved 45 modules into the stdlib.

| Finding | What became of it |
| --- | --- |
| 1. A turn that fails | Taken. The turn is `try runTurn(...)`, a failure is `session.error`, and the test pins what the run really does. |
| 2. The scripted model | Taken. The tests install a client with `__setLLMClient`, which also answers the title call. |
| 3. No missing-case check for the union | Taken. The claim is gone from the plan and the spec, and the `match` has no `_` arm. |
| 4. Stdlib-wide checks | No longer applies. Nothing moves into `stdlib/`. |
| 5. Statics | The safety half no longer applies: the modules are not in the stdlib. The folder half is real and is recorded under "Known and left for Plan 2". |
| 6. `sessionSearch.agency` | Taken, in Task 2. |
| 7. Job tools and `isInteractive` | Taken, in Task 2, as a switch of its own for each use. |
| 8. `switchModel` cannot report failure | Taken, in Task 4. It returns a `Result`. |
| 9. Tests need the model startup | Taken. `main` runs it, and the tests assert the main slot is set first. |
| 10. `approvingInstructionReads` | Taken. Dropped from the core, with the task that replaced it. |
| 11. The effect, and `null` | Taken. The effect is declared in `core.agency`, and `null` ends the session. This replaces the "two unreadable answers" rule. |
| 12. A node exported from the stdlib | No longer applies. Step 1 of Task 5 still proves the program shape first. |
| 13. `attachments` | Taken. The field is gone. |
| 14. Automatic compaction | Taken. The core calls `compactIfDue` after a turn. |
| 15. The budget-stop line | Taken, in Task 3. |
| 16. The check leaves out `print` and `_exit` | Taken. Task 3's check covers all five, with a table of what is left and why. |
| Minor notes | The `brains/` deletion is gone with the move. The pause's record is `SessionRecord \| null`. The doc does not wait on the terminal check. |
