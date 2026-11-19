# Shared Session Core, Plan 3: The Terminal on the Core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session started with `agency agent` can be continued in Perry, and the other way round, at a message or in the middle of a turn.

**What gets built, in the order it lands:**

1. **One driver for both front-ends.** The code that starts a session run, resumes it, queues approvals, saves it and loads it moves out of Perry into agency-lang. Perry uses it from there. No behaviour changes.
2. **A session carries the policy it was started under.** A session started with `--policy minimal` runs under `minimal` wherever it is resumed, and never under the resuming front-end's saved policy.
3. **Every slash command works against a session run.** The core gets the answers it lacks (`/compact`, `/rename`, `/fork`, `/search`, `/preset save`, and with the switch `/local` and `/settings`).
4. **The terminal switches over.** `agency agent` runs its sessions through the driver. Its old loop is deleted.
5. **Both front-ends see each other's sessions** without stepping on them.

**Not in this plan: background jobs.** Jobs are designed in `docs/superpowers/specs/2026-11-19-jobs-interface-design.md` (on `adit/jobs-interface`). A job becomes a separate process with a record on disk. It no longer belongs to its run, so a pause does not stop it. **The switch (Part D) waits on one ticket, ADI-341:** the agent's job tools move onto the new jobs, and the run's job table is deleted. Until then the terminal keeps its old loop and its jobs. Parts A, B and C do not touch jobs and can land now.

**Architecture:** `agency agent` becomes two runs in one process. The *shell run* is `agent.agency`: it parses flags, picks the session, and runs `repl()`. It is never saved. The *session run* is `program.agency`, started and resumed by the driver, in TypeScript. For each line the REPL submits, the driver sends an answer to the session run. When the run pauses on an approval, the shell run draws the prompt and the driver resumes with the result. The driver saves at every pause.

**Tech Stack:** Agency and TypeScript in agency-lang. TypeScript and vitest in Perry.

**Spec:** `docs/superpowers/specs/2026-11-18-shared-session-core-design.md`. The core as built: `docs/dev/agents/session-core.md`. Revised after the review in `2026-11-19-shared-session-core-3-terminal-review.md` and an architecture review.

**Written against:** agency-lang `main` at `cfc225a6f` (0.42.0) and Perry `main` at `e794183` (#26, Perry on the core).

Paths are relative to `packages/agency-lang/` unless they start with `perry/`. `AGENT` means `lib/agents/agency-agent`.

## What was found out

The draft of this plan listed facts to find first. These are the answers, each read from the code (the first was also run).

- **Top-level `callback` blocks fire for every run in the process.** `trace.agency`'s callbacks are registered per loaded module and given to each run (`lib/runtime/crossModuleInitRegistry.ts`). So once the shell run has loaded `trace.agency`, it prints the session run's tool calls and notices with no help from the driver. The driver must not print them again.
- **But a module's globals are per run.** `setDebug`, `setVerbose` and `setInteractive(false)` called in the shell run do not reach the session run's copy of `trace.agency`. They are facts about the terminal process, so they move to process state.
- **Every result of `main` and `respondToInterrupts` carries the run's total usage** (`usage: RunUsage`). The footer and `/cost` read it from the driver. Nothing has to be summed.
- **The runtime installs the run's policy as a handler,** and every handler is consulted: a reject from any wins, then a propagate, then an approve, and a policy with no matching rule says nothing (`lib/runtime/interrupts.ts`). So a second, stricter policy beside a front-end's own would carry over only its rejects. Where `minimal` is silent, the front-end's `recommended` would still approve. That is why the session's policy replaces the front-end's saved one and is not added to it.
- **Flags already replace the saved policy at start.** With any policy flag, `getPolicyForAgent` (`AGENT/lib/policy.agency`) does not use `policy.json`: it runs on the policy the flags resolved to, and saves "always" answers to `session-policy.json`.
- **`cliPolicyHandler` cannot ask about an interrupt it is handed.** Its prompt code is private and tied to module globals. The option list and the rule an answer saves are already in TypeScript (`promptOptions`, `resolvePromptOption`), which Perry uses.
- **Parallel approvals:** today each waiting prompt re-checks the policy after the one before it saved a rule. Perry's queue (`perry/src/agent/approvals.ts`) does the same loop. It lacks two things the terminal has: it rejects a raise that wants a typed value where the terminal asks, and it prints no "approved by the rule just saved" line.
- **What the terminal answers without a rule** is all answered by the core itself already, with one gap: `AGENT/lib/learned.agency` reads the learned skills and tools with no `with approve` (Linear ADI-334).
- **A reverse gap:** the core approves writes to `settings.json` and the presets file with `with approve`. The terminal's handler still asked about them. See "Decisions".
- **`program.agency`'s `main` lacks three things `agent.agency`'s does:** it never calls `setAgentName`, it fixes the tool limits to a session's (a `-p` run gets more rounds today), and it never saves the search choice.
- **MCP servers are process state.** A process must call `configureMcpServers` before it starts or resumes a session, and a stdio server's connect question arrives as an interrupt.
- **Not known, and Task A1 settles it first:** a session run started in the terminal initialises the globals of every module the *process* has loaded, the terminal's own included. Whether Perry, which never loads those modules, resumes such a checkpoint cleanly is untested. If it does not, the handoff does not work and the rest of the plan changes.

## Decisions

- **The driver lives in agency-lang and Perry uses it.** Two drivers would have to agree exactly on the file format and on what a crash mid-turn means.
- **Policy flags follow the session** (the owner's decision). The session's start data holds the policy the flags resolved to, and the core reports it at every pause. A front-end that resumes such a session runs it under that policy **in place of** its own saved policy, exactly as the terminal does at start when it is given flags. So "follows the session" means at resume what a flag means at start.
- **Flags given at resume are layered on the session's policy,** as `--approve` and `--reject` are layered on a base today. Someone who types `--approve std::bash` when they resume has said so on purpose. Nothing else can loosen a session's policy: not a saved policy file, and not a front-end that has no flags.
- **"Always" answers in such a session do not follow it.** The terminal keeps them in `session-policy.json`, as now. Perry keeps them in memory for that session. The other front-end asks again.
- **No runtime change for this.** A run still takes one policy. Two were considered: the runtime taking a list of policies, and the core installing the session's policy as a handler of its own. Both carry over only rejects (see "What was found out"), and the first changes a public option of every run.
- **The stored policy is the resolved rules, not the flag strings.** A `--policy ./strict.json` path may not exist where the session resumes. Folder placeholders (`.`, `<agent-home>`) stay in the rules and are resolved where the run is.
- **The driver pins the core's pause in every policy it gives a run.** A stored `{"*": reject}` would otherwise answer `agent::sessionInput` and end the session.
- **Sessions saved by the old terminal loop cannot be resumed after the switch** (the owner's decision). The picker and `--continue` leave them out, and `--resume <id>` says why.
- **One session, one holder.** A session's record names the front-end that last resumed it. A front-end takes hold when it resumes, before its first leg, and checks it still holds the session before each leg and each save. If another took it, the first stops and says so. Nothing is locked: this is two programs of one user on one machine.
- **The driver is not a new package export.** It lives in `lib/stdlib/agentDriver/` and is reached as `agency-lang/stdlib-lib/agentDriver/index.js`, like the agent's other TypeScript. Its only users are front-ends of the agent.
- **Perry lists sessions without loading them.** It loads one when a client opens it.
- **The core asks nobody about its own settings writes.** `/settings`, `/search` and `/preset save` write the user's settings files as a direct result of a command the user just gave. The terminal asked about them only because its handler saw every interrupt. After the switch it does not ask.
- **The prompt stays Agency code in the shell run.** One hidden function is added to `std::policy` that asks about one interrupt passed as data. `std::policy`'s own state stays the one copy of the policy in the terminal, and its own writer stays the one writer of the policy file. The driver keeps no copy.
- **The switch lands as its own pull request,** after the driver and the answers are in a release. The old loop is deleted in it. There is no flag.

## Global Constraints

- `agency agent` behaves the same until Part D. Its tests pass after every task.
- The import closure of `AGENT/program.agency` reaches no terminal module and no module with a top-level `callback(` (`lib/stdlib/agentSessionImports.test.ts`).
- The driver imports no terminal code and nothing of Perry's.
- The `match` over an `Answer` has no `_` arm.
- No call inside the argument of a `try` call (#1506).
- No dynamic imports.
- Every pause stays in the session program. Nothing in the driver or the shell run adds a frame to a saved session.
- A session that carries a policy is never run under a front-end's saved policy file.
- Every policy the driver gives a run has `agent::sessionInput` pinned to `propagate`.
- Perry: follow its CLAUDE.md. Every commit passes `pnpm typecheck`, `pnpm test:run` and `pnpm lint`.
- Never commit to `main` in either repo. No pull request that holds only docs.

## Review Focus

1. **A session saved in the terminal, resumed in a process that never loaded the terminal's modules.** It resumes, and its first turn runs. Test in A1 and E1.
2. **A session started under `--policy minimal`, resumed by a front-end whose saved policy is `recommended`.** A read that `recommended` approves and `minimal` has no rule for is asked about, not approved. A session started with `--reject '*'` takes a second message. Test in B1 and E1.
3. **Two front-ends with the same session open.** The second to resume takes it at once, before it has saved anything. The first does not run a leg or overwrite the file, and says the session moved. Test in A3, D2 and E1.
4. **Several approvals in one pause, the first answered "always".** The rest are settled by the saved rule without a prompt, and the terminal prints the line that says so. Test in A3 and D2.
5. **Esc during an approval prompt.** The prompt's cancellation arrives inside the driver as an exception. The turn is dropped and the session is back at its last message. Test in D2.
6. **A `-p` run.** It prints only the reply, rejects what no rule decides with the reason the model reads today, and saves nothing. Test in D3.

---

# Part A: the shared driver (agency-lang, then Perry)

One pull request in agency-lang, a release, then one in Perry.

### Task A1: Prove a terminal-started session resumes elsewhere

Do this before anything else. It needs no new code.

**Files:**
- Test: `tests/agency-js/session-core-foreign-modules/test.js`, `fixture.json`

- [ ] **Step 1: Write the test.** Process one imports `dist/lib/agents/agency-agent/agent.js` (which loads every terminal module, `trace.agency` among them) and then starts `program.js`'s `main` with `brain: "simple"`, sends one message, and writes the pause to a file. Process two imports only `program.js`, reads the file, and sends a second message. It also records whether the second result's `usage` total is at least the first's, since the footer and `/cost` will read usage across a resume, and prints the pause file's size. `fixture.json`: `{ "secondProcessReplied": true, "secondProcessError": "", "usageCarriedOver": true }`.
- [ ] **Step 2:** Run: `pnpm run agency test js tests/agency-js/session-core-foreign-modules`. Expected: PASS.
- [ ] **Step 3:** If it fails, stop and report the error. The likely cause is that the checkpoint holds globals of modules the second process lacks. The fix is then in the runtime (a run initialises only the modules its own program imports), and it comes before every other task here.
- [ ] **Step 4:** Commit: `Test: a session run started beside the terminal's modules resumes without them`.

### Task A2: The saved session's format, in agency-lang

`SavedRun`, its check and its reader are Perry's (`perry/src/engine/sessionFiles.ts`). They move here unchanged.

**Files:**
- Modify: `lib/stdlib/agentSessions.ts`, `lib/stdlib/agentSessions.test.ts`

**Interfaces:**
- Produces, exported from `agency-lang/stdlib-lib/agentSessions.js`:
  - `type SavedTurn = { text: string; approvals: Interrupt[] | null }`
  - `type SavedRun = { version: 1; pause: Interrupt[]; cancelledTexts: string[]; turn: SavedTurn | null }`
  - `isSavedRun(value: unknown): value is SavedRun`
  - `readSavedRun(dir: string, id: string): Promise<SavedRun | null>`
  - `canResume(run: SavedRun): boolean`, Perry's check of each interrupt's `moduleFingerprints` against the loaded code
  - `checkpointIn(runFile: unknown): unknown`, which exists and is now exported
- `SessionRecord` gains `heldBy?: { frontEnd: string; pid: number }`.

- [ ] **Step 1: Write the failing tests.** Move Perry's cases from `sessionFiles.test.ts` for `isSavedRun` (another version, no pause, an interrupt with no checkpoint, an empty approval list) and `canResume` (a fingerprint that differs, a module that is not loaded).
- [ ] **Step 2:** Run: `pnpm vitest run lib/stdlib/agentSessions.test.ts`. Expected: FAIL, the exports do not exist.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. Expected: PASS.
- [ ] **Step 5:** Commit: `Agent sessions: the saved run's format`.

### Task A3: The driver

Perry's state machine does two jobs: it decides what the run does next, and it builds Perry's transcript. Only the first moves. The driver reports what happened, and each front-end shows it its own way.

**Files:**
- Create: `lib/stdlib/agentDriver/run.ts`, `approvals.ts`, `machine.ts`, `savedRun.ts`, `interface.ts`, `policy.ts`, `index.ts`, and a test beside each
- Modify: `lib/stdlib/agentSessionImports.test.ts`

**Interfaces:**
- Reached as `agency-lang/stdlib-lib/agentDriver/index.js`, which the package's `./stdlib-lib/*` export already covers.
- `policy.ts`: `withPauseLeftAlone(policy: Policy): Policy`, Perry's `withPerrysPauseLeftAlone`, moved. `startRun` and `resumeRun` apply it to the policy they are given, so no front-end can forget it.
- `interface.ts` is `perry/src/agent/coreInterface.ts`, moved: `SESSION_INPUT_EFFECT`, `ProgramStart`, `SessionStart`, `PauseData`, `Answer`, `SettingsAnswer`, `pauseData(pause)`, `messageAnswer(text)`. `programStart` stays in Perry: its defaults are Perry's.
- `run.ts` is `perry/src/agent/session.ts`, moved: `startRun`, `resumeRun`, `toStep`, `withCancelNote`, `AgentStep`. `AgentModule` is `{ main, respondToInterrupts }`. Each returns the step and the result's `usage`.
- `approvals.ts` is `perry/src/agent/approvals.ts` without Perry's three-answer decisions: `ApprovalQueue`, `Settle`, `currentApproval`, `startQueue({ interrupts, settle })`, `respondWith`, `declineUndecided`. Changed from Perry's:
  - a raise that expects a typed value is not rejected by the queue. `settle` decides it or it is asked;
  - `settle` returns `{ response, by: "rule" } | null`, so a front-end can say an answer came from a rule just saved.
- `machine.ts` is the phase half of `perry/src/agent/sessionMachine.ts`:

```ts
export type DriverPhase =
  | { kind: "starting" }
  | { kind: "waitingForUser"; pause: Interrupt[]; cancelledTexts: string[] }
  | { kind: "working"; pause: Interrupt[]; text: string; cancelledTexts: string[]; leg: Leg }
  | { kind: "approving"; pause: Interrupt[]; text: string; cancelledTexts: string[]; queue: ApprovalQueue }
  | { kind: "answering"; pause: Interrupt[]; cancelledTexts: string[]; answer: Answer; leg: Leg }
  | { kind: "ended"; reason: string };

/** What a front-end shows for a step the machine took. */
export type Happened =
  | { type: "submitted"; text: string }
  | { type: "turnCancelled" }
  | { type: "legFailed"; error: string }
  | { type: "startFailed"; error: string }
  // An approval answered without asking. `by` says what answered it.
  | { type: "settled"; interrupt: Interrupt; response: InterruptResponse; by: "rule" }
  | { type: "answered"; before: PauseData | null; after: PauseData | null };

export function reduceDriver(phase: DriverPhase, action: DriverAction): { phase: DriverPhase; happened: Happened[] };
```

  `DriverAction` is Perry's `SessionAction` without `agentEvent`: `submitted`, `answered` (was `configured`: any answer that is not a message), `decided`, `legFinished`, `approvalCancelled`, `undecidedDeclined`. `answering` is Perry's `configuring`.
- `savedRun.ts`: `savedRun(phase): SavedRun | null` and `restoredPhase(run): { phase: DriverPhase; happened: Happened[] }`, from Perry's `savedRun` and `restoredState`. `saveRun({ dir, record, run, holder })` writes the run and the record with `runFormat: "savedRun"` and `heldBy: holder`. `takeHold({ dir, id, holder }): Promise<void>` writes `heldBy` on the record alone, and a front-end calls it when it resumes a session, before its first leg. `stillHeld({ dir, id, holder }): Promise<boolean>` reads the record.

- [ ] **Step 1: Write the failing tests.** Move Perry's cases from `sessionMachine.test.ts`, `approvals.test.ts`, `session.test.ts` and the `savedRun`/`restoredState` cases of `sessionFiles.test.ts`, with transcript assertions rewritten as `happened` assertions. Add:
  - a queue of three interrupts where answering the first makes `settle` approve the other two gives three responses and two `settled` events (Review Focus 4);
  - a typed-value raise that `settle` does not decide is the current approval, not a reject;
  - `stillHeld` is false after another holder's `takeHold`, before that holder has saved anything (Review Focus 3);
  - a run started under `{ "*": [{ action: "reject" }] }` reaches its pause and takes a second message.
  The tests that drive a real run use a small Agency fixture in `tests/agency-js/agent-driver/`, written to the core's interface as Perry's `echoCore.agency` is.
- [ ] **Step 2:** Run: `pnpm vitest run lib/stdlib/agentDriver`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it, and `lib/stdlib/agentSessionImports.test.ts` extended to walk `lib/stdlib/agentDriver`'s imports for terminal modules. Expected: PASS.
- [ ] **Step 5:** Add `docs/dev/agents/session-driver.md`: the phases, what is saved and when, where a loaded session picks up, the holder rule. Commit: `Agent driver: start, resume, approve, save and load a session run`.

### Task A4: Three fixes the core owes (ADI-334)

**Files:**
- Modify: `AGENT/lib/learned.agency`, `AGENT/lib/models.agency` (where `parseModelSpec` is), `AGENT/core.agency`
- Test: `tests/agency-js/session-core/test.js`, `fixture.json`

**Interfaces:**
- The learned skills and tools scans (`std::skills::skillsDir`, `std::toolbox::scan`, `std::ls` under the agent's home) are made `with approve`, as the `.claude/commands` scan is.
- `applyModelSpec` returns `failure("Unknown provider: <name>. Known: …")` for a spec whose part before the first `/` is not a provider it knows, when no provider is fixed.
- `PauseData` gains `brain: string`, from `currentBrainName()`. The record already has it (`record.brain`), but a run that saves no session has no record. A front-end reads the brain from this field only.

- [ ] **Step 1: Write the failing tests.** Under a policy with no rules, a turn asks no approval for the learned scans. `{ kind: "model", spec: "groq/llama-3" }` is an error notice and the pause's models are unchanged. The first pause reports `brain: "simple"`.
- [ ] **Step 2:** Run. Expected: FAIL on all three.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it, and `AGENT/tests/learned.agency`. Expected: PASS.
- [ ] **Step 5:** Update `session-core.md`. Commit: `Session core: approve its own scans, refuse an unknown provider, report the brain`.

### Task A5: Release, then Perry on the driver

- [ ] **Step 1:** Open the pull request for A1 to A4. After it merges, the owner publishes a release.
- [ ] **Step 2 (Perry, one branch):**
  - Delete `perry/src/agent/session.ts`, `coreInterface.ts` (keeping `programStart` and `STARTING_BUDGET` in `sessionProgram.ts`), `withPerrysPauseLeftAlone`, and the `SavedRun` half of `perry/src/engine/sessionFiles.ts`.
  - `perry/src/agent/approvals.ts` keeps what is the Ink UI's own, in `perry/src/agent/sessionApprovals.ts`: `approvalKey`, `SessionApprovals`, `rememberDecision`, and the `yes` / `yesSession` / `no` answers. The queue itself is the driver's.
  - The driver's queue no longer rejects a raise that wants a typed value. Perry cannot answer one yet, so its `settle` functions (the Ink UI's and the engine's `settledByPolicy`) decline it themselves, with `CANNOT_ANSWER_REASON`. Without this the Mac app would be shown a prompt it cannot answer.
  - `sessionMachine.ts` becomes a thin reducer over `reduceDriver` that turns each `Happened` into transcript items.
  - Delete `withAgentsOwnReads` in `perry/src/agent/policy.ts` and the `providers` check in `perry/src/engine/settingsChange.ts`. Show the brain again in `Header.tsx` and `StatusBar.tsx`, from the pause.
- [ ] **Step 3:** Run `pnpm typecheck`, `pnpm test:run`, `pnpm lint`. Expected: PASS, with the moved tests deleted and the rest unchanged. The sample file the Mac app decodes does not change.
- [ ] **Step 4:** Commit and open the pull request: `Use agency-lang's session driver`.

---

# Part B: a session's policy follows it (agency-lang)

### Task B1: The session reports the policy it was started under, and a front-end runs it under that

**Files:**
- Modify: `AGENT/core.agency`, `lib/stdlib/agentDriver/policy.ts`, `lib/stdlib/agentDriver/interface.ts`
- Test: `tests/agency-js/session-core/test.js`, `tests/agency-js/session-core-handoff/test.js`, `lib/stdlib/agentDriver/policy.test.ts`

**Interfaces:**
- `SessionStart` gains `policy: any`: the policy the session's flags resolved to, or null when it was started with no policy flag. It is `any` for the reason `options` is: checking it against a type would fill fields in.
- `PauseData` gains `policy: any`, the same value, kept in a `let` so every checkpoint holds it.
- `pauseData` reads it and checks it with `validatePolicy`. A session whose policy is not valid is not resumed: "This session's own policy can't be read, so it can't be continued here."
- Produces, in `policy.ts`:

```ts
/** The policy a front-end runs this session under: the session's own when
 *  it carries one, else `saved`. `extra` is what the front-end adds for
 *  this sitting, layered on top as flags are: flags given at resume, and
 *  "always" answers given in a session that carries a policy. */
export function sessionRunPolicy(args: {
  carried: Policy | null;
  saved: Policy;
  extra: Policy | null;
}): Policy;
```

  The layering is `policyOverlayFromFlags`'s (`lib/runtime/policyFlags.ts`): an effect's rules in `extra` go ahead of the base's.

- [ ] **Step 1: Write the failing tests.**
  - A session started with `policy: { "std::edit": [{ action: "reject" }] }` reports it at its first pause, and at the pause after a turn.
  - `sessionRunPolicy` with `carried` = `minimal`'s rules and `saved` = `recommended`'s has no rule for `std::read` (Review Focus 2). With `carried: null` it is `saved`. With `extra: { "std::bash": [{ action: "approve" }] }` over a carried `{ "std::bash": [{ action: "reject" }] }`, the approve rule comes first.
  - In the handoff test: a session started with `minimal`'s rules is resumed by a second process whose saved policy approves every read. A message whose scripted reply reads a file pauses on a `std::read` approval.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Update `session-core.md` and `session-driver.md`. Commit: `A session keeps the policy it was started under`.

### Task B2: One function resolves policy flags

Perry's `resolvePolicy` (`perry/src/agent/policy.ts`) says of itself that it is a copy of agency-lang's `resolveRunPolicy`, which is not exported. Both front-ends now need "the policy the flags resolved to" worked out the same way.

**Files:**
- Modify: `lib/stdlib/policy.ts`, `lib/cli/runPolicy.ts`
- Test: `lib/cli/runPolicy.test.ts`

**Interfaces:**
- Produces, exported from `agency-lang/stdlib-lib/policy.js`: `_resolveRunPolicy(flags: { policy?: string; approve?: string; reject?: string }, cwd: string): { policy: Policy; fromFlags: boolean } | null`, the existing function. `fromFlags` is true when any of the three was given.

- [ ] **Step 1: Write the failing test.** The export exists and gives `fromFlags: false` for no flags and `true` for `--approve std::read` alone.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `Export the function that resolves policy flags`.

**Perry, with the next release:** `resolvePolicy` calls `_resolveRunPolicy` and its copy goes. The engine gives every run `sessionRunPolicy({ carried, saved: policy.json, extra })`, where `extra` is the "always" rules given in a session that carries a policy, kept in memory per session and never written to `policy.json`. Perry's engine takes no policy flags, so a session it starts carries none: `programStart` passes `policy: null`. Its Ink UI and `perry -p` do take flags, and save no session, so there is nothing for the flags to follow.

---

# Part C: every command as an answer, and what the pickers read (agency-lang)

### Task C1: The process's trace settings

**Files:**
- Modify: `lib/stdlib/agentProcess.ts`, `AGENT/lib/trace.agency`, `AGENT/agent.agency`
- Test: `AGENT/tests/quietStartup.agency`

**Interfaces:**
- `agentProcess.ts` gains `_setTraceOptions({ debug, verbose, interactive }: TraceOptions): void` and `_traceOptions(): TraceOptions`. Defaults: `debug: false`, `verbose: false`, `interactive: true`.
- `trace.agency` reads them in place of its own `let`s. `setDebug`, `setVerbose` and `setInteractive` call the setter. Nothing else changes for the terminal.

- [ ] **Step 1: Write the failing test.** After `setVerbose(true)` in one run, a second run started from TypeScript in the same process sees `_traceOptions().verbose == true`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it and `AGENT/tests/turn.agency`. Expected: PASS.
- [ ] **Step 5:** Commit: `Agent: trace settings are the process's`.

### Task C2: The answers the core lacks

Which command needs what, after the switch:

| Command | After the switch |
| --- | --- |
| `/exit`, `/quit`, `/clear`, `/clear-history`, `/help`, `/paste`, `/models`, `/mcp`, `/policy` | Shell run only |
| `/cost` | Shell run, from the driver's `usage` |
| `/model` | `model` answer (exists). The picker reads `models` and `fixedProvider` from the pause |
| `/preset` (list), `/preset <name>` | `preset` answer (exists). The list marks the pause's `preset` |
| `/image`, `!cmd` | Shell run, in the pause's `cwd`. Sent as `notes` on the next message |
| `/init`, a skill, a user command | `message` answer |
| `/compact`, `/rename`, `/fork`, `/search`, `/preset save` | **New answers, below.** Perry can use these too |
| `/local`, `/settings` | New answers, added with the switch (Task D2). Only the terminal uses them |
| `/jobs` | Kept, same name |

**Files:**
- Modify: `AGENT/core.agency`, `AGENT/program.agency`, `AGENT/lib/record.agency`, `AGENT/lib/session.agency`, `AGENT/lib/search.agency`, `lib/stdlib/agentDriver/interface.ts`
- Test: `tests/agency-js/session-core/test.js`, `fixture.json`

**Interfaces:**
- `Answer` gains:

| Kind | Fields | What the core calls |
| --- | --- | --- |
| `compact` | `keep: string` | what `compactSlashCommand` calls |
| `rename` | `title: string` | `renameSession` |
| `fork` | none | `forkSession` |
| `search` | `backend: string` | `configureSearch` and the save to `settings.json` |
| `savePreset` | `name: string` | `saveSessionPreset` |

- `renameSession` and `forkSession` return a `Result` with a fact, not terminal wording: `success({ title })`, `success({ id, forkedFrom })`, or `failure` with one of `"not saved"`, `"empty title"`, `"no turns"`. The REPL words them as today. The core sends each as a notice.
- `PauseData` gains `search: string`, the backend in force.
- `ProgramStart` gains `agentName: string` (`main` calls `setAgentName`) and `oneShot: boolean` (given to `applyToolLimits`).

- [ ] **Step 1: Write the failing tests.** One case per answer: the answer is taken, the pause that follows reports the change (`record.title`, a new `record.id` with `forkedFrom`, `search`), and a refusal is an error notice that changes nothing. `compact` on a conversation of two turns leaves a thread the next message still answers. A start with `oneShot: true` reports the one-shot tool limits.
- [ ] **Step 2:** Run. Expected: FAIL, the answers are refused as unreadable.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it, `AGENT/tests/agentTurn.agency`, `presetSession.agency`, `sessionSearch.agency`, and `tests/agency/agency-agent-sessions.agency`. Expected: PASS.
- [ ] **Step 5:** Update the answers table in `session-core.md`. Commit: `Session core: the rest of the terminal's commands as answers`.

### Task C3: Ask about one interrupt

**Files:**
- Modify: `stdlib/policy.agency`
- Test: `tests/agency-js/policy-ask-about/agent.agency`, `test.js`, `fixture.json`

**Interfaces:**
- Produces, in `std::policy`, both marked `@hidden` as `askUserChoices` is (they are for a program that shows another run's interrupts, not for the guide):

```
/** Ask the user about an interrupt another run raised. */
export def askAbout(intr: any): any
/** The policy this program's handler is using now. */
export def currentPolicy(): Policy
```

- `askAbout` is `askUser` made callable with an interrupt as data. It needs `cliPolicyHandler` to have been called first, as `askUser` does, and it uses that handler's own state: it draws the same prompt (the diff for an edit, the folder picker, the "what should the agent do instead?" follow-up, the typed-value input), records an "always" answer in `_policy`, and saves it with the writer `askUser` uses (`maybeFlush`), to the same file. It returns the response. So the terminal has one copy of the policy and one writer of its file.
- Esc at the prompt raises the cancellation `askUser` raises today. `askAbout` does not catch it.
- `cliPolicyHandler`'s own `_handler` calls the same code, so there is one prompt.

- [ ] **Step 1: Write the failing test.** With scripted terminal input and `cliPolicyHandler(file: <temp>)` installed: `askAbout` on a `std::read` interrupt answered "always approve" returns an approve, `currentPolicy()` then has the rule, and the file has it. A `std::read` the program itself raises next is approved with no prompt. Answered "reject once", it returns a reject and `currentPolicy()` is unchanged.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it and `tests/agency-js/cli-policy-handler-parallel`, `-parallel-reject`, `-parallel-value`. Expected: PASS.
- [ ] **Step 5:** Commit: `std::policy: ask about one interrupt`.

Open the pull request for Parts B and C together. A release follows.

---

# Part D: the switch (agency-lang). Waits on ADI-341.

One pull request. Until it merges, nothing above changes what `agency agent` does.

### Task D1: The footer reads usage it is given

**Files:**
- Modify: `lib/stdlib/cli.ts`, `stdlib/ui/cli.agency`
- Test: `lib/stdlib/cli.test.ts`

**Interfaces:**
- `repl()` takes an optional `tokens: () => TokenSnapshot`. `_runLineRepl` calls it in place of `readTokenSnapshot(replCtx)` at its three call sites. With none given it reads the run it is in, as now. This is a new argument on a public stdlib function, for any REPL that drives another run. It is not added to the guide's first example.
- The terminal builds a `TokenSnapshot` from the driver's `RunUsage`: the totals, and `models` from `RunUsage.entries`.

- [ ] **Step 1: Write the failing test.** A REPL given `tokens` that returns 120 in and 30 out prints a footer with those counts after a turn.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm vitest run lib/stdlib/cli.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `REPL: the footer's token counts can come from the caller`.

### Task D2: The terminal's driver loop

**Files:**
- Create: `lib/stdlib/agentTerminalDriver.ts`, `agentTerminalDriver.test.ts`
- Modify: `AGENT/agent.agency`, `AGENT/lib/repl.agency`, `AGENT/lib/resume.agency`, `AGENT/lib/slashCommands/*.agency`, `AGENT/lib/capabilitiesUi.agency`, `AGENT/lib/header.agency`
- Test: `AGENT/tests/userCommands.agency`, `tests/agency-js/agent-terminal/`

**Interfaces:**
- `agentTerminalDriver.ts` holds one session for the process: the driver's phase and the last `usage`. It holds no policy. It exports, for the shell run's Agency code:
  - `_startSession(start: ProgramStart, shell: Shell): Promise<string>`: "" or the reason it could not start.
  - `_resumeSession(dir: string, id: string, shell: Shell): Promise<string>`. It calls `takeHold` before its first leg.
  - `Shell` is the two functions of `std::policy` the driver calls back into the shell run, through `callBridgeFn` (`lib/stdlib/cli.ts`): `{ ask: (intr) => response, policy: () => Policy }`. The shell gives `askAbout` and `currentPolicy`.
  - `_send(answer: Answer): Promise<void>`: runs legs until the session waits for a message again.
  - `_cancel()`: aborts a running leg (Esc while the model works).
  - `_pause(): PauseData | null`, `_usage(): RunUsage`.
- **The policy of each leg** is `shell.policy()`, read just before the leg, so the session run always has the rules as they are now.
- **Approvals in one pause.** The driver walks the queue. `settle` checks each waiting interrupt against `shell.policy()` (a reject rule answers anything; an approve rule answers only a raise that wants no typed value, as `cliPolicyHandler` does). What it does not decide is asked with `shell.ask`. After each answer the rest are checked again, so an "always" settles them (Review Focus 4). For each `settled` in `Happened` the driver prints the line `std::policy` prints today ("Approved … by the rule just saved", "Policy rejected …"), and an edit's diff.
- **Esc at a prompt** arrives as the cancellation `shell.ask` throws. `_send` catches it and dispatches `approvalCancelled`, so the turn is dropped as it is for an abort (Review Focus 5).
- It prints `session.reply`, `session.error` and an edit's diff. `trace.agency`'s callbacks print the rest.
- **The line printed when a job ends** comes from the process's one job watcher, not the run's job table. The terminal driver subscribes to it with `onWatchedJobEnd` (from the jobs plan).
- It saves at every pause with `saveRun`, holder `{ frontEnd: "terminal", pid }`, and reports to Herdr where `_sessionOnSubmit` did. Before each leg it checks `stillHeld`. When it is not, it stops with `This session was continued in <heldBy.frontEnd>. Reopen it with: agency agent --resume <id>` (Review Focus 3).
- `agent.agency`'s `main`:
  - resolves the policy as now with `getPolicyForAgent`. When any policy flag was given, the resolved policy goes in `ProgramStart.session.policy`. With none, that is null.
  - **On a resume of a session that carries a policy,** it installs `cliPolicyHandler` with `sessionRunPolicy({ carried, saved, extra: <the flags given now, or null> })` and the file `SESSION_POLICY_PATH`, which is what it does today for a session started with flags. So the shell run's own interrupts (`!cmd`, an MCP connect) are judged by the session's policy too.
  - calls `maybeLoadMcp` and the guided local picker as now, then `_startSession` or `_resumeSession`, prints the header from the first pause, and runs `repl()` with `onSubmit` → `_send`, and `status` and `tokens` from `_pause()` and `_usage()`.
- **Two more answers land here,** since only the terminal sends them: `{ kind: "local"; model: string }` (`configureLocalModel`, then `reactToSlotChange`) and `{ kind: "capabilities"; settings: any }` (what `/settings` writes, then `refreshCapabilities`), with `PauseData.capabilities: any` for the `/settings` screen to read. Each gets a case in `tests/agency-js/session-core/test.js`: taken and reported at the next pause, and `local` refused when local models are off.
- Each slash command sends its answer through `_send`, or reads `_pause()` or `_usage()`, as the table in Task C2 says.
- `--continue`, `--resume` and the picker list `savedRun` records and resume with `_resumeSession`. The transcript shown is read with `checkpointIn`. `--resume <id>` on a `checkpoint` record prints `Session <id> was saved by an older version of the agent and can't be resumed.` and exits with 1.

- [ ] **Step 1: Write the failing tests.** In `tests/agency-js/agent-terminal/`, with a stub model and scripted input:
  - a line gets its reply, and the session's files exist;
  - three parallel edits with the first answered "always" ask once and print "Approved … by the rule just saved" twice;
  - Esc at a prompt leaves the session at its last message, and the next message carries the cancel note;
  - a second holder's `takeHold` makes the next line print the "continued in" message, run no leg and write nothing;
  - a session saved with `policy` = `minimal`'s rules, resumed with no flags while `policy.json` approves every read, asks about a read;
  - `/rename x`, then `--resume` in a new process, shows the title and the transcript.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them and every test in `AGENT/tests/`. Expected: PASS, apart from the tests of the old loop, which go in D4.
- [ ] **Step 5:** Commit: `agency agent runs its sessions through the session core`.

### Task D3: One-shot runs

**Files:**
- Modify: `lib/stdlib/agentTerminalDriver.ts`, `AGENT/agent.agency`
- Test: `tests/agency-js/agent-terminal-oneshot/`

**Interfaces:**
- `_runOnce(start: ProgramStart, message: Answer): Promise<{ reply: string; error: string }>`: starts with `oneShot: true` and a null record, sends the message, declines every approval no rule decides with the reason `std::policy` gives a non-interactive run today, and saves nothing.

- [ ] **Step 1: Write the failing test.** A `-p` run whose scripted reply asks for a write no rule covers prints the reply, the model was sent the non-interactive reason, no session file exists, and stdout holds only the reply (Review Focus 6).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it and `AGENT/tests/quietStartup.agency`. Expected: PASS.
- [ ] **Step 5:** Commit: `agency agent -p runs through the session core`.

### Task D4: Delete the old loop

**Files:**
- Delete: `AGENT/lib/runSession.agency`; `_sessionOnSubmit` and `_installSessionHooks` in `lib/stdlib/agentSessions.ts`; `saveSeedTurn` and the in-run `restore` in `AGENT/lib/resume.agency`; `approvingInstructionReads` in `AGENT/lib/projectContext.agency`; the tests of each
- Modify: `lib/stdlib/agentSessionImports.test.ts` (the terminal list loses `runSession`)

- [ ] **Step 1:** Delete them. The job tools and `/jobs` stay. `setJobToolsOn(false)` in `core.agency` is not removed here: the jobs plan removes it in its last task.
- [ ] **Step 2:** Run the agent's tests in full once, and `pnpm vitest run`. Expected: PASS.
- [ ] **Step 3:** Run `agency agent` by hand: a turn, an approval answered "always", Esc mid-turn, `/model`, `/compact`, `/fork`, `--continue`, `-p`, and one MCP tool call that asks for approval. Compare the order of an attachment line, a tool trace and the reply with the version before.
- [ ] **Step 4:** Commit: `Remove the terminal's own session loop`.

---

# Part E: both ways (Perry, then by hand)

### Task E1: Perry lists every session and loads on open

Once the terminal saves the same format, Perry's sessions folder holds every terminal session in every folder.

**Files:**
- Modify: `perry/src/engine/engine.ts`, `sessionFiles.ts`, `sessionView.ts`, `protocol.ts`, `http.ts`; `perry/apps/macos/Sources/PerryKit/Protocol.swift`, `SessionsModel.swift`
- Test: `perry/src/engine/engine.test.ts`, `realProgram.test.ts`, `samples.test.ts`

**Interfaces:**
- At startup the engine reads records only. A session it has not loaded is listed from its record: `id`, `title`, `cwd`, `created`, `lastActive`, `status: "saved"`, no items, no settings.
- `POST /sessions/:id/open` loads it (as `loadSession` does today), calls `takeHold`, and answers its whole view. A `send` to a session that is not loaded opens it first.
- `SessionStatus` gains `"saved"`. `PROTOCOL_VERSION` is raised, in `protocol.ts` and `Protocol.swift`.
- The engine's saves use holder `{ frontEnd: "perry", pid }`. Before a leg it checks `stillHeld`. When another front-end took the session, the engine drops its copy back to `"saved"` and the request is refused with a 409 that names the holder from `heldBy.frontEnd`: "This session was continued in the terminal. Open it again to pick it up." (or "in another Perry", for another engine's pid).

- [ ] **Step 1: Write the failing tests.**
  - An engine over a home with three saved sessions starts no run and lists three with `status: "saved"`. Opening one gives its conversation.
  - In `realProgram.test.ts`: a session started through the driver with holder `terminal` and `minimal`'s rules as its policy is opened by an engine whose `policy.json` approves every read. It takes a message, and a read is asked about (Review Focus 1 and 2). An "always" answer to it is not written to `policy.json`.
  - A session the engine has open, then taken by another holder's `takeHold`, refuses the next message with the 409 (Review Focus 3).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, and write the sample file again with `vitest -u`.
- [ ] **Step 4:** Run `pnpm test:run`, `pnpm typecheck`, `pnpm lint`, `pnpm app:test`. Expected: PASS.
- [ ] **Step 5:** Update `perry/docs/dev/engine.md` and `mac-app.md`. Commit: `List saved sessions without loading them, and hold the ones in use`.

### Task E2: The handoff by hand, and the docs

- [ ] **Step 1:** Start a session with `agency agent --reject std::bash`, send a message, and quit in the middle of an approval. Open it in the Mac app: the approval is asked again, bash is still rejected, and the conversation is there. Send a message. Run `agency agent --resume <id>`: the Perry turn is in the transcript.
- [ ] **Step 2:** With the session open in both, send a message in the terminal, then one in the app. The app says the session moved.
- [ ] **Step 3:** Rewrite for what is true now: `docs/dev/agents/agent-brains.md`, `agent-sessions.md`, `session-core.md`; the user guide's pages on the agent; `perry/docs/idea.md` and `perry/CLAUDE.md`, which say the two cannot continue each other's sessions.
- [ ] **Step 4:** Commit in each repo: `Docs: a session moves between the terminal and Perry`.

## What is most likely to go wrong

- **Task A1 fails.** Then a terminal-started session cannot be resumed elsewhere at all, and a runtime change comes first.
- **The first turn after a resume in a fresh process.** The terminal has never resumed in the middle of a turn. #1506 was found this way.
- **Output order.** Today a notice prints when the code reaches it. After the switch, `trace.agency` prints from callbacks and the driver prints the reply. D4's hand check compares them.
- **The size of a saved session.** A pause in the middle of a turn holds every frame of the turn, and it is written at every approval. Measure the files A1 writes before D2. If a long session's file is many megabytes, saving at every approval needs a second look.
- **MCP tools held across a pause** in the middle of a turn. Not checked. D4's hand check includes one.
