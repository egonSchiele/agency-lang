# Start a program in its own process: implementation plan

**Goal:** an Agency program can call `spawn` to start an Agency file as a separate process that outlives it, and a person can watch that process and answer its questions with `agency attach`.

**Spec:** `docs/superpowers/specs/2026-11-15-start-a-program-in-its-own-process.md`. Read it first. This plan says how to build what the spec decides, and does not repeat the reasons. Where this plan says "decision 4", it means the spec's.

**Review:** `docs/superpowers/plans/2026-11-15-start-a-program-in-its-own-process-review.md` was written against the first version of this plan. This version takes its fixes. The section "What changed after the review" says how.

**Two PRs, in this order:**

1. **Held questions and `agency attach`** (tasks 1 to 7). A program run with `--wait-for-response` holds a question nobody settled, and `agency attach` answers it. Nothing here needs `spawn`.
2. **`spawn`** (tasks 8 to 14). It passes `--wait-for-response` from its first commit.

The order matters. The owner ruled that a started process never approves or rejects on its own. With `spawn` first, `main` would hold a `spawn` that rejects questions until the second PR merged.

**How to work through it:** top to bottom. Each task builds on the one before. Make all the changes for a PR, then run one build and one test run, as "How to test" says at the end.

Paths are relative to `packages/agency-lang`. Work in the worktree `worktree-own-process`, on the branch `adit/own-process`.

Linear: the project is "Processes and background processes in Agency". Each task names its ticket.

## What this plan decides that the spec left open

The owner should read these before the build starts.

1. **`spawn` launches through a new `agency run --detach <output-file>` flag.** The command line is the one place that turns run flags into settings (`applyCliFlags`), so `spawn` builds an `agency run` command and does not copy that logic. A person gets the flag as well, on `run` and on `resume`. The flag takes the output file as its value, because a detached program always needs one.
2. **The pid `spawn` returns is the program's own pid.** `agency run` starts the compiled program as a child of the command. The program's pid is the one `ps` shows with the title, and the one `agency attach` takes.
3. **The seed conversation never touches the disk when `spawn` sends it.** `spawn` passes `--messages -`, and the messages travel through the program's standard input. A person who runs `agency run --messages history.json` names their own file, and Agency does not delete it.
4. **The count of starts lives on the run's context and is saved in every checkpoint.** It counts processes that were really started. A `fork` does not reset it, because every branch shares the context. A resume in a new process continues it, because the checkpoint carries it. A `restore()` does not lower it: applying a checkpoint keeps the larger of the live count and the saved one. The owner ruled that the count must survive a resume.
5. **The depth travels in an environment variable, `AGENCY_SPAWN_DEPTH`.** It is inherited on purpose: a shell job that runs `agency run --detach` counts too.
6. **The output cap is enforced inside the spawned program,** because the launcher has exited by then.
7. **The record a program writes for attach gains two optional fields:** whether it is holding a question, and the output file's path.
8. **The user pages under `docs/site/cli/` are not edited by this plan.** Tasks 7 and 14 list what they would say. Ask the owner before writing them.

9. **One name for the output file: `outputFile`.** The spec called the parameter and the result field `output`. The flag's value, the carrier, the record field, the payload field, the parameter, and the result field are all `outputFile` here, and the spec was changed to match.

Decided by the owner: `std::spawn` declares `@always(dir, filename)`, so an "always approve when" answer to a spawn prompt pins the file being started.

## What changed after the review

| Review item | What this version does |
| --- | --- |
| 1. The first PR shipped automatic rejection | The PRs are in the other order |
| 2. A spawned program inherited the trace id and config overrides | Task 12 builds the child's environment without them, and tests that |
| 3. The seed file was left on disk | The seed travels on standard input. Choice 3 above. |
| 3. The seed could be applied twice | It is applied once per process. Task 10. |
| 4. A `fork` reset the count | The count is on the context and in the checkpoint. Choice 4 above. The review suggested keeping it with the run's spend. That figure is set back by `restore()`, so a loop of `restore()` and `spawn` would have the same hole. |
| 5. `_checkPolicy` named an existing function | Task 12 uses `_validatePolicy` |
| 6. A new private-folder file | Dropped. Both callers use `host.files.privateDir`. |
| 7. `--detach` on `resume` | Both commands take it from task 11 |
| 8. `--` before the program's arguments | Task 12 |
| 9. A symlink at the output path | Task 11 opens with `O_NOFOLLOW` |
| 10. Test details | Tasks 6 and 13 say how each test waits, and name one design for the seed test |
| 11. A question nobody can answer | Task 2's log line |
| 12. A missing file in the flag task | Task 1's list |
| 13. "Always approve" on `std::spawn` | The owner said yes to the tag. Task 12. |
| 14. Smaller points | Tasks 10, 11, and 14 |

## Background: the code this builds on

Read this section before the tasks. Each part names the file to open.

### How `agency run` starts a program

`run()` in `lib/cli/commands.ts:293` compiles the file and then starts the compiled JavaScript with Node, as a child process whose input and output are the terminal's. So one `agency run` is two processes: the command, and the program. The compiled file is written beside the source and is not deleted, so a program can keep running after the command exits.

The command passes its settings to the program in environment variables. `withRootCarriers` in `lib/cli/childEnv.ts` sets them, and clears every one of them first so that a program never inherits a setting from an outer run. The names are in `lib/constants.ts`:

| Variable | What it carries |
| --- | --- |
| `AGENCY_RUN_POLICY` | The policy from `--policy`, `--approve`, `--reject`, as JSON |
| `AGENCY_RUN_POLICY_INTERACTIVE` | `1` under `--interactive` |
| `AGENCY_MAX_COST`, `AGENCY_MAX_TIME` | The budget |
| `AGENCY_ENTRY_NODE` | The node to start |
| `AGENCY_RESUME_FILE` and three more | An `agency resume` request |

`run()` takes the policy as `runPolicy?: { policyJson: string; interactive: boolean }`, and `RootCarriers.policy` has the same shape.

Two variables are not cleared by `withRootCarriers`: `AGENCY_TRACE_ID` and `AGENCY_CONFIG_OVERRIDES` (`lib/config/config.ts:1058`, `:1065`). `runChildOverrides` in `lib/cli/commands.ts` keeps inherited overrides on purpose, for the eval harness.

The flags are declared in `scripts/agency.ts`. `addRunOptions` (line 640) has the flags `run`, `resume`, and `debug` share. `addRunAndRecordingOptions` (line 509) adds the ones only `run` and `resume` take, such as `-i`. `runSettings` (line 358) turns the options into a config, a run policy, and a budget. `resolveRunPolicy` in `lib/cli/runPolicy.ts` builds the policy.

`docs/dev/cli/cli-arguments.md`, rule 1: everything after the filename belongs to the program, and `agency` prints a warning unless a `--` follows the filename.

### How a program starts and ends

The generated entry code calls `runCliEntry` (`lib/runtime/cliEntry.ts`), which starts the entry node or resumes a checkpoint. It then hands the result to `resolveCliInterrupts` (`lib/runtime/cliInterruptResolution.ts`):

```ts
const decide = buildDecider({ interactive, prompt, valuePrompt });
return resolveInterrupts(result, respond, decide);
```

`resolveInterrupts` (`lib/runtime/interruptResolution.ts:36`) loops: it decides each interrupt in the batch, calls `respond` with the answers, and repeats while the result still holds interrupts. `respond` is the compiled module's `respondToInterrupts`, so the run continues in the same process.

`buildDecider` rejects when the run is not interactive, and prompts at the terminal when it is. `terminalPrompt` (`lib/runtime/interruptPrompts.ts:64`) rejects when there is no terminal. The prompts read only `effect`, `message`, and `data` from an interrupt.

When no policy variable is set at all, `resolveCliInterrupts` reports the unhandled interrupt and exits (`hasRunPolicyMechanism`).

The root policy is installed by `installRunPolicyHandler` (`lib/runtime/runPolicyHandler.ts:96`). It passes `interactive` to `makeRunPolicyHandler`, which makes an approving rule stay silent for a raise that expects a value.

A time budget is paused while the run is halted on an interrupt (`lib/runtime/rootBudget.ts:53`). So time spent holding a question is not counted, with no new code.

`runNode` in `lib/runtime/node.ts` is the entry every exported node wrapper calls. A TypeScript helper that starts an Agency node calls it again in the same process.

### The debug socket

`docs/dev/cli/debugger-attach.md` covers all of this. The parts this plan touches:

- `registerAttach` in `lib/runtime/platform.node.ts` runs on every node run, and does its work on the first. It writes `<pid>.json` in `~/.agency/debug-sessions/` and opens `<pid>.sock` beside it. It does neither when `AGENCY_NO_ATTACH=1`.
- The record's shape is `AttachRecordSchema` in `lib/debugger/attach/registry.ts`. It is a strict schema.
- `startAttachServer` in `lib/debugger/attach/server.ts` accepts connections. A connection's first message is `client`, with a `kind`. The kinds are `terminal`, `cli`, and `probe` (`CLIENT_KINDS` in `protocol.ts`). Any kind but `probe` opens a debugger session.
- Every message has a zod schema in `lib/debugger/attach/protocol.ts`.
- `lib/cli/attach.ts` is `agency debug --attach`. `formatListing` prints the table of programs. `checkedRecord` checks a pid by its start time, so a changed process title does not affect it. `connectWithRetry` opens the socket.
- The server and its sockets are `unref`ed, so an open socket never keeps a finished program alive.

### How stdlib functions reach TypeScript

`stdlib/agency.agency` imports TypeScript helpers from `lib/stdlib/agency.ts`, such as `_compile` and `_subprocessDepth`. A helper calls `currentRun()` to reach the run and its host.

The host starts processes through `host.subprocess.run` and `host.subprocess.start` (`lib/host/host.ts:335`). `RunOptions.env` replaces the child's whole environment, and `RunOptions` can send text to the child's standard input.

`host.files.privateDir` (`lib/host/host.ts:146`) makes a folder with mode `0700`, or checks that an existing one is a real folder owned by the user with no access for anyone else.

`_runProgram` in `stdlib/agency.agency:235` shows the pattern `spawn` follows: build the payload, `return interrupt std::run(...)`, then do the work on the next line. A rejection returns the failure, and an approval carries on.

## Rules that apply to every task

- Use types, not interfaces. Use objects, not maps. Use arrays, not sets. No dynamic imports.
- No mutable state in a TypeScript module variable. Tasks 2 and 10 each keep one value on `process`, the way the attach target is kept, and say why. Both use the one helper task 2 adds.
- Name every number. A timeout, a poll interval, a size limit, and a cut-off length each get a constant with a name that says what it is. A usage error exits with `EXIT_CODE_USAGE_ERROR` from `lib/constants.ts`.
- A flag that cannot be combined with another says so where it is declared, with the vendored commander's `Option.conflicts`. Do not write an `if` for it in an action.
- Delete files through `host.files.remove`, which only reaches under the root it is given, or with the `safeDelete*` helpers in `lib/utils.ts`.
- Do not run `agency fmt` on any `.agency` file that already exists.
- Format the TypeScript files you touch with prettier, by name.
- `lib/stdlib/agency.ts` is 896 lines, under a limit of 1,250. New code goes in new files where this plan says so.
- Do not change `lib/runtime/interrupts.ts` or anything about how a handler chain runs. If a task seems to need that, stop and ask.
- Do not add code that follows symlinks. Where a path could be one, refuse it.
- Never hand-roll a delete in a test. Use `safeDeleteDirectoryWithin` (`lib/utils.ts:110`).
- No test sleeps. Each test that waits on a real process waits on a file the process writes. "How each test waits" in tasks 6 and 13 says where.
- Check every doc and comment you write against `docs/dev/contributing/anti-patterns.md` and the writing tips before the PR.
- Never edit `CHANGELOG.md`.

## Which new files may use Node

Files under `lib/runtime/` and `lib/stdlib/` can end up in a browser bundle. The linter refuses a Node module or a Node global such as `process` in them (`eslint.config.js`, `BROWSER_FILES`). A file that must use Node is listed in `eslint.node-exceptions.mjs` with its reason, and `scripts/lint-browser-reach.mjs` fails when a portable file imports a listed one. Read the comment at the top of `eslint.node-exceptions.mjs` before adding to it.

A portable file reaches Node code through `#platform`: a function in `lib/runtime/platform.node.ts` with a stand-in of the same name in `lib/runtime/platform.browser.ts`. `registerAttach` is an example.

| New file | Side | Who imports it |
| --- | --- | --- |
| `lib/runtime/processSlot.ts` | Node. It keeps a value on `process`. | `heldQuestions.ts`, `platform.node.ts` |
| `lib/runtime/heldQuestions.ts` | Node. It uses `processSlot.ts`. | `cliInterruptResolution.ts`, `platform.node.ts`, `lib/debugger/attach/watch.ts` |
| `lib/runtime/heldCheckpoint.ts` | Portable if it writes through `host.files`. Try that first. | `cliInterruptResolution.ts` |
| `lib/runtime/seedMessages.ts` | Portable. It only edits a list of messages. | `lib/runtime/node.ts` |
| `lib/runtime/outputCap.ts` | Node. It wraps `process.stdout`. | `lib/runtime/cliEntry.ts`, which is Node already |
| `lib/stdlib/spawn.ts` | Node. It starts a process. | `stdlib/agency.agency`. `lib/stdlib/agency.ts` is listed as Node already, so `std::agency` is a Node-only module today. |

`lib/stdlib/` has a second list, `FS_IMPORTERS` in `eslint.config.js`, for stdlib files that import `fs` directly. `lib/stdlib/spawn.ts` should not need it: it makes its folder through `host.files`.

## What a reviewer should look at hardest

Each has a test in the task named.

1. **A program run with `--wait-for-response` never approves or rejects on its own.** Task 6. With no rule and nobody attached, it must still be waiting.
2. **A rule never approves a raise that expects a value, under `--wait-for-response`.** Task 1.
3. **`--interactive` behaves exactly as before,** including with no terminal. Tasks 1 and 6.
4. **No answer set is accepted unless it matches the held questions.** Task 2.
5. **`agency attach` never pauses the program.** Task 4. A watching client must not open a debugger session.
6. **A rejected `std::spawn` starts nothing and writes nothing.** Task 12. The test must fail when the launch is moved above the raise.
7. **An approval of `std::run` does not approve a spawn.** Task 13. `std::spawn` must not be added to the `Shell` effect set.
8. **A spawned program shares nothing with its caller's run.** Task 12. Its environment has no trace id, no config overrides, and no IPC variables from the caller.
9. **Nothing is written to disk that the user was not shown.** The output path is in the effect payload. The checkpoint file is written only with the setting on. The seed is not written at all. Tasks 3, 10, and 12.

---

# The first PR: a held question, and `agency attach`

## Task 1: `--wait-for-response`

Ticket: ADI-304.

**Files:**
- Modify: `lib/constants.ts`, `lib/cli/childEnv.ts`, `lib/cli/runPolicy.ts`, `lib/cli/commands.ts`
- Modify: `scripts/agency.ts`
- Modify: `lib/runtime/runPolicyHandler.ts`
- Tests: `lib/cli/runPolicy.test.ts`, `lib/cli/childEnv.test.ts`, `lib/runtime/runPolicyHandler.test.ts`

Add the flag in `addRunAndRecordingOptions`, beside `-i`. It cannot be given with `-i`, and it says so in its declaration:

```ts
.addOption(
  new Option(
    "--wait-for-response",
    "Wait for `agency attach` to answer interrupts that surface unhandled (default: reject them)",
  ).conflicts("interactive"),
)
```

The vendored commander (`lib/vendor/commander/option.js`) reports the conflict and exits. No action checks for it.

Add a carrier, `AGENCY_RUN_POLICY_WAIT`, set to `1`. Three places carry the new field:

- `resolveRunPolicy` gains `waitForResponse` in its flags and in its result, and counts it in `hasAny`. The flag alone then installs the root policy handler with an empty policy, which is what stops `resolveCliInterrupts` from reporting the interrupt and exiting.
- `run()`'s `runPolicy` parameter and `RootCarriers.policy` each gain `waitForResponse?: boolean`.
- `withRootCarriers` clears the new variable with the others, and sets it when the field is true.

Add one function in `lib/runtime/runPolicyHandler.ts` that both readers use:

```ts
/** How the run answers an interrupt nobody settled. */
export type UnansweredMode = "reject" | "prompt" | "wait";

export function unansweredMode(settings: HostSettings): UnansweredMode
```

`installRunPolicyHandler` passes `unansweredMode(...) !== "reject"` where it passes `interactive` today. That keeps a rule from approving a raise that expects a value under the new flag.

**Tests.**

- `resolveRunPolicy` with only `waitForResponse` returns an empty policy and the flag.
- `withRootCarriers` clears the new variable when the field is not given, and sets it when it is.
- `unansweredMode` gives each of the three values.
- The root policy handler under `wait`: an approving rule returns nothing for an interrupt with `expectsValue: true`, and approves one without it.
- The existing tests for `--interactive` pass unchanged.

## Task 2: holding a question

Ticket: ADI-304.

**Files:**
- Create: `lib/runtime/heldQuestions.ts`
- Modify: `lib/runtime/interruptResolution.ts`
- Create: `lib/runtime/processSlot.ts`
- Modify: `lib/runtime/ipcChild.ts`
- Modify: `lib/runtime/cliInterruptResolution.ts`
- Modify: `lib/runtime/platform.node.ts`
- Modify: `eslint.node-exceptions.mjs`
- Tests: `lib/runtime/heldQuestions.test.ts`, `lib/runtime/interruptResolution.test.ts`, `lib/runtime/cliInterruptResolution.test.ts`

### Deciding a batch at once

`resolveInterrupts` decides one interrupt at a time. A held batch is answered as a whole. Add a second loop beside it and make the first one a caller of it:

```ts
/** Decide every interrupt in a batch. */
export type DecideBatchFn = (interrupts: Interrupt[]) => Promise<InterruptResponse[]>;

export async function resolveInterruptBatches<R extends InterruptResult>(
  result: R,
  respond: ResumeFn<R>,
  decideBatch: DecideBatchFn,
): Promise<R>
```

`resolveInterrupts(result, respond, decide)` becomes `resolveInterruptBatches` with a `decideBatch` that calls `decide` for each interrupt in turn. Its callers do not change.

### An interrupt as data

The codebase already has a type for an interrupt without its checkpoint: `SerializedInterrupt` in `lib/runtime/ipcChild.ts:48`. `serializeInterruptsForIpc` (line 71) builds one by dropping the two checkpoint fields. A held question is the same thing, so reuse both:

- Move the dropping into one exported function in `ipcChild.ts`, `withoutCheckpoint(interrupt): SerializedInterrupt`, and have `serializeInterruptsForIpc` call it.
- Add `expectsValue?: boolean` to `SerializedInterrupt`. The field already travels, because the function copies every other field, and an interrupt carries it when its raise expects a value. The prompt reads it.

Do not define a second type for a question.

### One value on `process`

`ATTACH_TARGET_SLOT` in `lib/runtime/platform.node.ts` keeps one value on `process` under a symbol, with a cast on each read and write. This plan needs two more such values. Write the pattern once:

```ts
/** One value kept on `process` under `name`, shared by every copy of the
 *  runtime in the process. */
export function processSlot<T>(name: string, initial: () => T): { get(): T; set(value: T): void }
```

Leave `ATTACH_TARGET_SLOT` as it is.

### The held batch

```ts
/** One answer to a held question. */
export type HeldAnswer = {
  interruptId: string;
  response: InterruptResponse;
};

/** Hold `interrupts` until `answerHeld` is given a valid set of answers.
 *  Keeps the process alive while it waits. */
export function holdForAnswers(interrupts: Interrupt[]): Promise<InterruptResponse[]>

/** The questions held right now, or an empty list. */
export function heldQuestions(): SerializedInterrupt[]

/** Answer the held batch. Returns null when the answers were accepted, or
 *  the reason they were refused. A refusal leaves the batch held. */
export function answerHeld(answers: HeldAnswer[]): string | null

/** Calls `listener` each time a batch starts or stops being held.
 *  Returns a function that removes the listener. */
export function onHeldChange(listener: (questions: SerializedInterrupt[]) => void): () => void
```

`heldQuestions.ts` does these four things and nothing else. It does not write a log line, save a checkpoint, or ask whether anything can attach. The root endpoint composes those, below.

**Where the held batch lives.** In a `processSlot`. The reason is the one the attach target has: the socket is one per process, and a process can hold more than one copy of the runtime. The root endpoint of a command-line run is one per process too. Nothing here belongs to a run, so it does not go on the run's context.

**`answerHeld`** does these checks, in order, and refuses with a sentence on the first that fails:

1. A batch is held.
2. There is exactly one answer for each held interrupt id, and no answer for any other id.
3. `validateResumeBatch(interrupts, responses)` from `lib/runtime/interrupts.ts` returns null, with the responses put in the interrupts' order.

Then it clears the batch, calls the listeners with an empty list, and resolves the promise.

**Staying alive.** A process waiting on a promise with no open handle exits. `holdForAnswers` starts a timer and clears it when the batch is answered. Name its interval `HOLD_KEEP_ALIVE_MS`. The socket cannot do this job: it is `unref`ed, and a program whose socket failed to open must still hold.

### The notice

What the program tells the person is one pure function of four facts:

```ts
export type HoldFacts = {
  questionCount: number;
  pid: number;
  /** Whether the program registered for attach. */
  canAttach: boolean;
  /** The file task 3 saved, or null. */
  checkpointFile: string | null;
};

/** The lines a program writes when it starts to hold a batch. */
export function holdNotice(facts: HoldFacts): string
```

| `canAttach` | `checkpointFile` | The text |
| --- | --- | --- |
| true | any | `[agency] Waiting for an answer to 1 question. Run: agency attach 48213` |
| false | set | `[agency] Waiting for an answer to 1 question. Nothing can attach to this process. Stop it with: kill 48213, then resume it.` |
| false | null | `[agency] Waiting for an answer to 1 question. Nothing can attach to this process, so nothing can answer. Stop it with: kill 48213` |

With a checkpoint file, a second line follows in every case:

```
If this process stops, resume it with: agency resume <file> <program> --wait-for-response
```

A program does not register when `AGENCY_NO_ATTACH=1` is set, on Windows, or when the sessions folder is refused. The process still waits in every case: the owner ruled that it must not answer by itself.

`platform.node.ts` exports `isAttachable(): boolean`, which says whether the attach target is set.

### The root endpoint

In `resolveCliInterrupts`, after the check that reports an unhandled interrupt:

```ts
const mode = unansweredMode(defaultHost().settings);
if (mode === "wait") {
  return resolveInterruptBatches(result, respond, waitForResponse);
}
```

The rest is as it is today, with `interactive` read from `mode === "prompt"`.

`waitForResponse` is a small function in `cliInterruptResolution.ts`. It is the one place that puts the pieces together:

```ts
async function waitForResponse(interrupts: Interrupt[]): Promise<InterruptResponse[]> {
  const host = defaultHost();
  const checkpointFile = await savedCheckpoint(interrupts, host); // task 3; null until then
  const facts: HoldFacts = {
    questionCount: interrupts.length,
    pid: process.pid,
    canAttach: isAttachable(),
    checkpointFile,
  };
  console.error(holdNotice(facts));
  try {
    return await holdForAnswers(interrupts);
  } finally {
    await removeSaved(checkpointFile, host); // task 3
  }
}
```

In this task `savedCheckpoint` returns null and `removeSaved` does nothing. Task 3 fills them in.

**Tests**, `heldQuestions.test.ts`:

- `holdForAnswers` does not resolve until `answerHeld` accepts.
- `heldQuestions` returns the batch as data while held, and an empty list after.
- A missing answer, an extra answer, and an unknown id are each refused, and the batch stays held.
- An approval with a value reaches the caller as an approve response with that value.
- A rejection with a reason reaches the caller.
- A listener is called when the batch starts and when it ends.
- `holdNotice` gives each of the three texts, and adds the resume line when there is a checkpoint file.
- `withoutCheckpoint` drops the two checkpoint fields and keeps `expectsValue`.

In `interruptResolution.test.ts`: `resolveInterruptBatches` calls `decideBatch` once per batch and loops while the result has interrupts. The existing tests for `resolveInterrupts` pass unchanged.

## Task 3: the checkpoint setting

Ticket: ADI-305.

**Files:**
- Modify: `lib/config/config.ts`
- Modify: `lib/constants.ts`, `lib/cli/childEnv.ts`, `lib/cli/commands.ts`
- Create: `lib/runtime/heldCheckpoint.ts`
- Modify: `lib/runtime/cliInterruptResolution.ts`
- Test: `lib/runtime/heldCheckpoint.test.ts`, `lib/runtime/cliInterruptResolution.test.ts`

### The setting

Add to the config types in `lib/config/config.ts`, with one named type for each level:

```ts
export type SpawnInterruptsConfig = {
  /** Save a held question's checkpoint to disk, so a process that dies
   *  while holding can be resumed. Off by default: a checkpoint holds
   *  the program's whole state. */
  preemptivelyCreateCheckpoint?: boolean;
};

/** Settings for programs started with spawn or run with --wait-for-response. */
export type SpawnConfig = {
  interrupts?: SpawnInterruptsConfig;
};
```

`AgencyConfig` gains `spawn?: SpawnConfig`, beside `checkpoints` (line 359).

Add the matching entry to the zod schema near line 734.

The command line reads the config, so it carries the setting to the program. Add a carrier, `AGENCY_SAVE_HELD_CHECKPOINT`, and a `saveHeldCheckpoint?: boolean` field on `RootCarriers`. `run()` sets it from `config.spawn?.interrupts?.preemptivelyCreateCheckpoint`. This keeps the setting out of the generated code and the runtime context.

### Writing and removing the file

```ts
/** Write the checkpoint the held interrupts carry to a file under
 *  `~/.agency/held/`, and return its path. */
export async function saveHeldCheckpoint(interrupts: Interrupt[], host: Host): Promise<string>

/** Remove a file `saveHeldCheckpoint` wrote. */
export async function removeHeldCheckpoint(file: string, host: Host): Promise<void>
```

- Make the folder with `host.files.privateDir`. Its parent, `~/.agency`, must exist first.
- Every interrupt in a batch carries the same checkpoint (`docs/dev/runtime/concurrent-interrupts.md:105`). Write the first one's, as `JSON.stringify(checkpoint.toJSON())`. A checkpoint is signed when it is made, if a key is set, and `toJSON` includes the signature.
- The name is the checkpoint's `traceId`, a dash, the process's pid, and `.json`. When there is no trace id, use `nanoid()` in its place.
- Write through `host.files`. Read `docs/dev/stdlib/contained-files.md` for how that part of the host refuses a symlink below its root, and use the write that creates a new file.
- `removeHeldCheckpoint` deletes with `host.files.remove`, rooted at `~/.agency/held/`, so it cannot reach a path outside that folder.

In `waitForResponse` from task 2, `savedCheckpoint` calls `saveHeldCheckpoint` when the carrier is set and returns null otherwise, and `removeSaved` calls `removeHeldCheckpoint` when it is given a file. `holdNotice` already prints the resume line when it is given a file.

**Tests.**

- With the carrier unset, `waitForResponse` writes no file.
- With it set, the file exists while held, parses with `Checkpoint.fromJSON`, and is gone after the answer.
- The file's mode is `0600`.
- `removeHeldCheckpoint` refuses a path outside the folder.

## Task 4: a watching client on the socket

Ticket: ADI-306.

**Files:**
- Modify: `lib/debugger/attach/protocol.ts`
- Create: `lib/debugger/attach/watch.ts`
- Modify: `lib/debugger/attach/server.ts`
- Modify: `lib/debugger/attach/registry.ts`, `lib/runtime/platform.node.ts`
- Tests: `lib/debugger/attach/watch.test.ts`, `lib/debugger/attach/server.test.ts`

### The protocol

Add `watch` to `CLIENT_KINDS`. Do not add it to `PARTY_KINDS`: a watching client is not a party to a debugger session.

Add three messages to `AttachMessageSchema`:

```ts
// The run tells a watching client what it is holding. An empty list
// means nothing is held.
z.object({ type: z.literal("held"), questions: z.array(SerializedInterruptSchema) }).strict(),
// A watching client answers the held batch.
z.object({ type: z.literal("answers"), answers: z.array(HeldAnswerSchema) }).strict(),
// The run refuses a set of answers and says why.
z.object({ type: z.literal("answersRefused"), reason: z.string() }).strict(),
```

`HeldAnswerSchema` is an `interruptId` and a `response`. The response's schema is `InterruptResponseSchema`, which `protocol.ts` already has at line 187. Do not write it again.

`SerializedInterruptSchema` matches the type from `ipcChild.ts`. `protocol.ts` has a compile-time check, `SameShape`, that a schema matches its type. Use it for both new schemas.

### Serving a watching client

```ts
/** Serve one watching client on `channel`: tell it what is held now and
 *  each time that changes, and pass its answers to `answerHeld`. Never
 *  installs a debugger. */
export function serveWatch(channel: Channel): void
```

- On connect, send `held` with `heldQuestions()`.
- Subscribe with `onHeldChange` and send `held` on each change. Unsubscribe when the channel closes.
- On an `answers` message, call `answerHeld`. When it returns a reason, send `answersRefused`. When it accepts, the change listener sends the empty `held`.
- Ignore every other message.

When two clients watch one program, both get the same `held`. The first valid `answers` wins. The other client's later `answers` is refused with "nothing is held", and it has already been sent the empty `held`.

### The server

In `startAttachServer`, the `admit` function sends a `probe` its status and opens a session for anything else. Add one case before the session is opened:

```ts
if (kind === "watch") {
  serveWatch(channel);
  return;
}
```

A watching client must never reach `openSession`. That call installs a debugger driver, and the program would stop at its next step.

### The record

Add one optional field to `AttachRecordSchema`:

```ts
/** Whether the program is holding a question. */
holding: z.boolean().optional(),
```

Add one function to `lib/runtime/platform.node.ts` that rewrites the record with `holding` changed, and have `registerAttach` subscribe it with `onHeldChange` once the record is written. It keeps the record it wrote, so it does not read the file back.

**Tests.**

`watch.test.ts`, on `memoryChannelPair()`:

- A client is sent `held` on connect, with an empty list when nothing is held.
- It is sent `held` when a batch starts.
- Valid `answers` resolve the batch and the client is sent the empty `held`.
- Bad `answers` get `answersRefused` and the batch stays held.
- Two clients: the second one's answers after the first's are refused.

`server.test.ts`: a `watch` connection leaves `current()` null, so no session was opened.

## Task 5: `agency attach`

Ticket: ADI-306.

**Files:**
- Create: `lib/cli/attachWatch.ts`
- Modify: `lib/cli/attach.ts`
- Modify: `scripts/agency.ts`
- Test: `lib/cli/attachWatch.test.ts`

### The command

```
agency attach [pid]
```

Register it in `scripts/agency.ts` as a top-level command with the description "Watch a running Agency program and answer its questions".

### The listing

With no pid, it prints the table `agency debug --attach` prints. `formatListing` in `lib/cli/attach.ts` builds that table. Give it one more column, which reads `waiting` for a record whose `holding` is true and is empty otherwise. Both commands then show it.

### Attaching

```ts
export type WatchOptions = {
  pid: number;
  dir: string;
  /** Where the program's output and the prompts are written. */
  out: (text: string) => void;
  decide: DecideFn;
};

/** Attach to a program: answer what it holds, and return when it ends or
 *  the person detaches. Returns the exit code. */
export async function watchCommand(options: WatchOptions): Promise<number>
```

In order:

1. Refuse when standard input is not a terminal, before connecting.
2. `checkedRecord` and `missingSocket` from `lib/cli/attach.ts`, as `agency debug --attach` uses them. A refusal goes to standard error and the code is 1.
3. `connectWithRetry`, then send `{ type: "client", kind: "watch" }`.
4. On `held` with questions: call `decide` for each question in turn, and send `answers`.
5. On `answersRefused`: print the reason. The next `held` message shows whether there is still something to answer.
6. When the socket closes, print "The program ended or closed the connection." and return 0.

Task 11 adds printing the program's output, once a program has an output file.

`decide` is `buildDecider({ interactive: true })` from `lib/runtime/interruptResolution.ts`. It shows the prompt `--interactive` shows, including the value prompt for a raise that expects a value. A held question has the fields the prompt reads.

Each answer is the question's `interruptId` and the response `decide` returned, unchanged.

`buildDecider` remembers an "approve always" answer for an effect until the command exits. That is the existing behaviour of the `--interactive` prompt, and it applies only to this attach.

Ctrl-C ends the command. The program is another process and is not affected.

**Tests**, `attachWatch.test.ts`, with a memory channel and a scripted `decide`:

- A `held` message with two questions gets one `answers` message with two answers, in order.
- An approval with a value carries the value.
- `answersRefused` is printed.
- A closed channel returns 0.
- `formatListing` shows `waiting` for a holding record.

## Task 6: the end-to-end tests for the first PR

Ticket: ADI-304, ADI-305, ADI-306.

**Files:**
- Create: `lib/cli/wait.spawn.test.ts`
- Create: `lib/cli/spawnTestHelpers.ts`
- Create: a fixture folder beside it, as `lib/cli/resume.spawn.test.ts` makes one

**How each test waits.** This is a vitest file. It starts the built command line with `child_process.spawn`, as a background child of the test, and waits by polling for a marker file until a deadline. A program has no terminal here, which is what `--wait-for-response` is for.

`lib/cli/spawnTestHelpers.ts` holds what this file and the two test files of the second PR share, each written once:

- `waitForFile(path, deadlineMs)`. `lib/stdlib/herdr.test.ts:224` has a private `waitFor(condition)`. Move it here, have that test import it, and build `waitForFile` on it.
- `watchClient(socketPath)`, a small client that sends `client` with the kind `watch` and exposes the messages it is sent.
- `throwawayHome()`, which makes a folder for `AGENCY_HOME` and removes it afterwards with `safeDeleteDirectoryWithin`.

**Nothing a test starts can outlive it or be mistaken for another process.**

- Every fixture program that waits gives up and exits after its own deadline.
- A test stops a process through the handle `child_process.spawn` returned. No test kills a pid it read from a program's output.

The fixture programs:

- `asks.agency` writes a "started" marker, raises `test::ask`, and then writes a "finished" marker. When the raise is rejected it writes the reason to a third file.
- `asksForValue.agency` assigns the answer of a raise and writes it to a file.

The cases:

1. `agency run --wait-for-response asks.agency`: the "started" marker appears, the "finished" marker does not, and the process is alive.
2. A watching client is sent `held` with the question's effect, message, and data.
3. An approval lets the program finish.
4. A rejection with a reason reaches the program, which writes the reason.
5. `asksForValue.agency`, under `--approve` for its effect, still holds. The value the client sends is the one the program writes.
6. A client that closes without answering leaves the program alive and still holding.
7. With `spawn.interrupts.preemptivelyCreateCheckpoint` on in the fixture's `agency.json`: a file appears under the test's `~/.agency/held/`. Stop the process through its handle. `agency resume <file> asks.agency --wait-for-response` holds the question again, and an answer finishes it.
8. With the setting off, no file appears.
9. `-i` together with `--wait-for-response` exits non-zero and names both flags.
10. `agency run -i asks.agency` with no terminal still rejects the raise. This is the check that `--interactive` did not change.
11. A debugger client (`kind: "cli"`) on a program that is holding still gets its session, and a `watch` client on the same program is still served.

Every test runs under `throwawayHome()`, so the real `~/.agency` is never touched.

## Task 7: docs for the first PR

Ticket: ADI-304, ADI-305, ADI-306.

Dev docs record the mechanism and its rules. They do not record how the work went.

- Create `docs/dev/runtime/spawn.md`. In this PR it covers: the three ways a run answers an interrupt nobody settled, the held batch and where it lives, the keep-alive timer, the three log lines, the checkpoint setting and its carrier, and the rule that a program run with `--wait-for-response` never approves or rejects on its own.
- Add its line to the index in `CLAUDE.md`, under "Runtime". The description is one sentence of at most 150 characters.
- `docs/dev/cli/debugger-attach.md`: the `watch` client kind, that it never opens a session, the three new messages, and the new record field.
- `docs/dev/runtime/config.md`: a row for `spawn.interrupts.preemptivelyCreateCheckpoint`.
- `docs/dev/stdlib/jobs.md`: one sentence in "Checkpoints and pauses" that a program holding a question has paused, so its shell jobs have stopped. ADI-307 tracks the fix.

**User pages.** These are hand-written and this plan does not edit them. Ask the owner first. They would need a new `docs/site/cli/attach.md`, and `--wait-for-response` in `docs/site/cli/run.md`.

**This is the end of the first PR.** Run "How to test".

---

# The second PR: `spawn`

## Task 8: four new carriers

Ticket: ADI-302, ADI-301.

**Files:**
- Modify: `lib/constants.ts`
- Modify: `lib/cli/childEnv.ts`
- Test: `lib/cli/childEnv.test.ts`

Add four names to `lib/constants.ts`, beside `AGENCY_ENTRY_NODE`:

```ts
/** The title the program gives its process, so `ps` shows it. */
export const AGENCY_PROCESS_TITLE = "AGENCY_PROCESS_TITLE";
/** Where the seed messages are: a file's path, or `-` for standard input. */
export const AGENCY_SEED_MESSAGES = "AGENCY_SEED_MESSAGES";
/** The path of the file a detached program's output is saved to. */
export const AGENCY_OUTPUT_FILE = "AGENCY_OUTPUT_FILE";
/** How many `spawn` calls deep this process is. Inherited on purpose. */
export const AGENCY_SPAWN_DEPTH = "AGENCY_SPAWN_DEPTH";
```

Add three fields to `RootCarriers`:

```ts
/** The process title, from `--name` or the input file's name. */
title?: string;
/** The seed, from `--messages`: a path, or `-`. */
seedMessages?: string;
/** The output file, from `--detach`. */
outputFile?: string;
```

`withRootCarriers` clears and sets each carrier with its own pair of lines today, so a new carrier means two more lines there. The first PR added two that way. With these three that would be five new pairs. State the plain ones as data instead:

```ts
/** A carrier whose value is one string, copied as it is. */
type TextCarrier = { field: "title" | "seedMessages" | "outputFile"; variable: string };

const TEXT_CARRIERS: TextCarrier[] = [
  { field: "title", variable: AGENCY_PROCESS_TITLE },
  { field: "seedMessages", variable: AGENCY_SEED_MESSAGES },
  { field: "outputFile", variable: AGENCY_OUTPUT_FILE },
];
```

`withRootCarriers` clears every variable in the list, then sets each one whose field was given. A later carrier of this kind is one row. Leave the existing carriers' lines as they are.

`AGENCY_SPAWN_DEPTH` is not in the list: that one is meant to pass down.

**Tests.** Each of the three is cleared when not given, and set when given. `AGENCY_SPAWN_DEPTH` in the input environment is still there in the output.

## Task 9: the process title

Ticket: ADI-302.

**Files:**
- Modify: `scripts/agency.ts`
- Modify: `lib/cli/commands.ts`
- Modify: `lib/runtime/cliEntry.ts`
- Test: `lib/runtime/cliEntry.test.ts`

Add one flag in `addRunAndRecordingOptions`:

```ts
.option("--name <name>", "The name this run shows in `ps`, as `agency run <name>` (default: the input file's name)")
```

`run()` in `lib/cli/commands.ts` has ten positional parameters. Do not add an eleventh. Add one object parameter at the end and put the new settings in it:

```ts
/** What a run is told about how it was started. */
export type RunLaunch = {
  /** The title for `ps`. */
  title: string;
  /** The seed for the first thread: a file's path, or `-` for this
   *  command's standard input. */
  seedMessages?: string;
  /** When set, the program starts detached, with its output saved to
   *  this file. */
  detachedOutputFile?: string;
};
```

One function in `scripts/agency.ts`, `runLaunchFrom(options, input)`, builds it, and the actions for `run` and `resume` both call it. The title is `agency run ` followed by `--name`, or by the base name of the input file.

`run()` passes `title` to `withRootCarriers`.

In `runCliEntry`, before anything else:

```ts
const title = process.env[AGENCY_PROCESS_TITLE];
if (title) {
  process.title = title;
}
```

`cliEntry.ts` is a Node file already. Every `agency run` gets a title this way, spawned or not. On macOS a title longer than the original arguments still shows in `ps`.

**Test.** `runCliEntry` sets `process.title` from the variable, and leaves it alone when the variable is missing. Restore the title after the test.

## Task 10: `--messages` seeds the first thread

Ticket: ADI-301.

**Files:**
- Create: `lib/runtime/seedMessages.ts`
- Modify: `scripts/agency.ts`, `lib/cli/commands.ts`
- Modify: `lib/runtime/platform.node.ts`, `lib/runtime/platform.browser.ts`, `lib/runtime/platform.ts`
- Modify: `lib/runtime/node.ts`
- Test: `lib/runtime/seedMessages.test.ts`, `lib/runtime/platform.test.ts`

### The flag

On the `run` command only. A resumed program's threads come from its checkpoint, so `resume` does not take the flag at all, and nothing has to refuse it:

```ts
.option("--messages <file>", "A JSON file holding a list of messages; the program's first thread starts with them. `-` reads standard input, with --detach")
```

`runLaunchFrom` checks the value in one function, `seedSource(value, detached)`, which returns the value to carry or the reason it is refused:

- For a path, the file must exist and hold a JSON array. The value carried is the absolute path.
- For `-`, `--detach` must be given. Without it the program's standard input is the terminal.

A refusal prints the reason and exits with `EXIT_CODE_USAGE_ERROR`.

### Standard input, for `-`

When `launch.seedMessages` is `-`, `run()` reads its own standard input to the end, checks that it is a JSON array, and starts the program with a pipe for standard input. It writes the text to that pipe and closes it. The command returns once the write has finished. Task 11 has the code this joins.

The messages are never written to a file this way.

### The seed

```ts
/** The messages to seed a thread with: `raw` with every tool call in its
 *  last assistant message that has no result removed. A message left with
 *  no text and no calls is removed. */
export function seedFrom(raw: unknown): smoltalk.Message[]

/** Put `raw`'s messages, after `seedFrom`, on the store's first thread. */
export function seedFirstThread(threads: ThreadStore, raw: unknown): void
```

`seedFrom` builds a `MessageThread` from the array with `MessageThread.fromJSON`, which accepts a bare array. It finds the dangling calls with `unansweredToolCalls` from `lib/runtime/threadRepair.ts`, which looks only at the last assistant message.

There can be more than one dangling call. `dropHandoffToolCall` in `lib/runtime/handoff.ts:91` removes one call by its index, and a second removal would use a stale index. So `seedFrom` works out the calls to keep in one pass and replaces the message once, or removes it when nothing is left. Read `dropHandoffToolCall` for how a message's calls and text are edited, and share a small function with it if one falls out. Do not write a second copy of the edit.

### Reading the seed, once per process

Reading is Node's job, so it goes behind `#platform`:

```ts
// lib/runtime/platform.node.ts
/** The parsed seed a run was started with, or null. Returns the seed the
 *  first time it is called in a process, and null every time after.
 *  Throws when the seed cannot be read or parsed. */
export function takeSeedMessages(settings: HostSettings): unknown | null
```

It reads `AGENCY_SEED_MESSAGES`. For a path it reads the file, and leaves the file where it is. For `-` it reads standard input to the end with `fs.readFileSync(0, "utf8")`.

It remembers that it ran in a `processSlot` from task 2. `runNode` is called for every node a process runs, including a node a TypeScript helper starts, and only the first may be seeded.

`lib/runtime/platform.browser.ts` gets a stand-in that returns null.

### Where it is called

`runNode` in `lib/runtime/node.ts` starts a fresh run. Find where it has the run's `ThreadStore`, before the graph runs. When the process is not an IPC child (`isIpcMode`), call `takeSeedMessages`, and when it returns a value, call `seedFirstThread` with it. A resume does not go through `runNode`.

**Tests.**

For `seedFrom`:

- A list with no tool calls comes back unchanged.
- A last assistant message with one call and no result loses the call. With text, the message stays. With no text, it is removed.
- A last assistant message with two dangling calls loses both.
- A last assistant message with two calls, one answered, keeps the answered one and its result.
- A call with a result earlier in the list is untouched.
- An input that is not an array throws.

For `takeSeedMessages`, in `platform.test.ts`: it returns the file's contents once and null the second time, and the file is still there.

## Task 11: `--detach`

Ticket: ADI-299, ADI-302.

**Files:**
- Modify: `scripts/agency.ts`
- Modify: `lib/cli/commands.ts`
- Create: `lib/runtime/outputCap.ts`
- Modify: `lib/runtime/cliEntry.ts`, `eslint.node-exceptions.mjs`
- Modify: `lib/debugger/attach/registry.ts`, `lib/runtime/platform.node.ts`
- Modify: `lib/cli/attachWatch.ts`
- Test: `lib/cli/detach.spawn.test.ts`, `lib/runtime/outputCap.test.ts`, `lib/cli/attachWatch.test.ts`

### The flag

One flag, in `addRunAndRecordingOptions`, so that both `run` and `resume` take it. Its value is the output file, so there is no second flag and no rule that one needs the other:

```ts
.addOption(
  new Option(
    "--detach <output-file>",
    "Start the program in the background, save its output to this file, and return at once; prints its pid as JSON",
  ).conflicts(["interactive", "captureWorkdir"]),
)
```

The command line never picks a file for the user. `spawn` always passes one.

`runLaunchFrom` from task 9 puts the absolute path in `RunLaunch.detachedOutputFile`. `resume` reaches `run()` through `runWithOptions`, as `run` does.

### Starting detached

In `run()`, when `launch.detachedOutputFile` is set, the start differs:

```ts
const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
const appendWithoutFollowing = O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW;
const out = fs.openSync(launch.detachedOutputFile, appendWithoutFollowing, OUTPUT_FILE_MODE);
const seeded = launch.seedMessages === "-";
const child = spawn(process.execPath, argv, {
  stdio: [seeded ? "pipe" : "ignore", out, out],
  detached: true,
  shell: false,
  env,
});
child.unref();
console.log(JSON.stringify({ pid: child.pid, outputFile: launch.detachedOutputFile }));
```

`OUTPUT_FILE_MODE` is `0o600`.

1. `O_NOFOLLOW` refuses a symlink at the output path. Catch the error and exit with `EXIT_CODE_USAGE_ERROR` and a message that names the path.
2. The mode `0600` applies only when the file is created. An existing file keeps its mode.
3. Both output streams go to the file.
4. `detached: true` puts the program in its own process group, so Ctrl-C in the caller's terminal does not reach it.
5. `unref()` lets the command exit while the program runs.
6. The command prints one line of JSON. It does not print the "Running ..." banner, and it registers no `exit` listener.
7. With a seed on standard input, the command writes it to `child.stdin`, ends the stream, and returns when the write has finished.

`outputFile` also goes to `withRootCarriers`.

Keep the two starts in one function with the shared parts (the argv, the env) built once. Do not copy the block.

A compile error still exits non-zero before anything is started, as it does today.

### The cap

The launcher is gone once the program runs, so the program caps its own output.

```ts
/** Stop writing to standard output and standard error once each has
 *  written `limitBytes`. The line written at the limit says so. */
export function capOutput(limitBytes: number): void
```

It wraps `process.stdout.write` and `process.stderr.write`. Each wrapper counts bytes. Past the limit it writes one last line, `[agency] output limit of 10 MiB reached; nothing more is saved`, and drops what follows.

`runCliEntry` calls `capOutput(SPAWN_OUTPUT_LIMIT_BYTES)` when `AGENCY_OUTPUT_FILE` is set. Put the number in `lib/constants.ts`.

The cap covers what the program itself writes. Check whether a child of the program can write to the same file directly: read how `lib/host/node/nodeSubprocess.ts` sets a child's output, for `std::shell` and for shell jobs. If a child inherits the program's output, the cap does not reach it. Write what you find in `spawn.md`.

### The record, and attach

Add the second optional field to `AttachRecordSchema`:

```ts
/** The file a detached program's output is saved to. */
outputFile: z.string().optional(),
```

`registerAttach` sets it from `AGENCY_OUTPUT_FILE`.

`watchCommand` in `lib/cli/attachWatch.ts` gains output printing, as the spec's decision 5 describes. When the record has an `outputFile`:

- After `checkedRecord`, print what the file holds, then print what is added to it. Poll the file's size every `OUTPUT_POLL_MS`. Do not use `fs.watch`, which behaves differently on each platform.
- Put the following in one small type, `outputFollower(file, out, timer)`, with `start`, `pause`, `resume`, and `finish`. `watchCommand` calls those four and holds no read position of its own.
- Stop printing while a prompt is open, and catch up afterwards.
- When the socket closes, print the rest of the file before the last line.

Refuse an `outputFile` that is a symlink.

**Tests.**

`outputCap.test.ts`: a write under the limit passes through. A write that crosses it is cut, and the notice is written once. Later writes are dropped. Give `capOutput` the two streams as an argument with the real ones as the default, so the test passes fakes.

`attachWatch.test.ts`: with an output file, the text already in it is printed, and text appended later is printed. Drive the polling with an injected timer so the test does not wait on a clock.

`detach.spawn.test.ts` is a vitest file that uses `lib/cli/spawnTestHelpers.ts` from task 6. Its program writes a marker file and then waits on a second file, and gives up after its own deadline:

- `agency run --detach out.log prog.agency` exits 0 and prints JSON with a pid.
- The marker file appears, so the program is running after the command exited.
- `ps -p <pid> -o command=` for the pid in the JSON starts with `agency run`. The test reads the pid and never signals it.
- Creating the second file lets the program end, and its printed line is in `out.log`.
- `--detach` with `-i` exits non-zero and names both flags.
- An output path that is a symlink exits with a usage error and starts nothing.
- A seed on standard input: a program that writes its first thread's messages to a file writes the seed. See task 13 for the program.
- `--messages -` without `--detach` exits with a usage error.

## Task 12: `spawn` and `std::spawn`

Ticket: ADI-299, ADI-300.

**Files:**
- Create: `lib/stdlib/spawn.ts`
- Create: `lib/cli/cliPath.ts`
- Modify: `lib/eval/grading/agencyTestGrader.ts`
- Modify: `lib/runtime/state/context.ts`, `lib/runtime/state/checkpointStore.ts`, `lib/runtime/resumeSetup.ts`
- Modify: `stdlib/agency.agency`
- Modify: `eslint.node-exceptions.mjs`
- Test: `lib/stdlib/spawn.test.ts`, `lib/runtime/state/checkpointStore.test.ts`

### The count

The count has three rules, from choice 4: a `fork` does not reset it, a resume continues it, and a `restore()` does not lower it.

**On the context.** Add to `RuntimeContext` in `lib/runtime/state/context.ts`, beside `jobs`:

```ts
/** How many programs this run has started with spawn. */
spawnCount: number = 0;

/** Take the count a checkpoint saved. The count is of processes that
 *  were really started, and applying a checkpoint does not un-start one,
 *  so the larger of the two is kept. */
adoptSpawnCount(saved: number | undefined): void {
  this.spawnCount = Math.max(this.spawnCount, saved ?? 0);
}
```

Every branch of a run shares the run's context, so a `fork` does not reset the count.

**In the checkpoint.** `Checkpoint.fromStateStack` in `lib/runtime/state/checkpointStore.ts` builds its arguments near line 827, where it reads `usage` and `traceId` from the context. Add `spawnCount: ctx.spawnCount` there, a `spawnCount?: number` field on the class and on `CheckpointArgs`, and the field in `toJSON` and `fromJSON`. Write it only when it is above zero, so a program that never spawns has checkpoints with the same bytes as today.

The signature covers the field with no change: `canonicalString` in `lib/runtime/checkpointChecksum.ts:68` signs the checkpoint's whole JSON.

**When a checkpoint is applied.** Call `ctx.adoptSpawnCount(checkpoint.spawnCount)` in the two places a checkpoint becomes the run's state:

- `restoreForResume` in `lib/runtime/resumeSetup.ts`, which `agency resume`, `respondToInterrupts`, and the debugger's rewind all go through. A new process starts at zero, so it takes the saved count.
- `applyRestoreSignal` in the same file, which a `restore()` inside a program goes through. The live count is at least the saved one, so it stays.

Callers do not compare the two numbers themselves. `adoptSpawnCount` is the one place that rule is written.

This differs from how a run's spend behaves. `docs/dev/runtime/cost-is-state.md` sets spend back on a restore. Say in `spawn.md` why the count does not follow it.

### The TypeScript side

`lib/stdlib/spawn.ts` holds everything `spawn` needs from TypeScript. Each function calls `currentRun()` on its first line.

```ts
/** How many `spawn` calls deep this process is: 0 for a program a person
 *  started. */
export function _spawnDepth(): number

/** How many programs this run has started with spawn. */
export function _spawnCount(): number

/** The folder one spawned program will get under `~/.agency/spawned/`,
 *  and the path of the output file in it. Creates nothing. */
export function _spawnPaths(): { dir: string; outputFile: string }

/** What `std::spawn` asks about. The Agency side raises the interrupt
 *  with this value and then starts the program from the same value, so
 *  what was approved is what runs. */
export type SpawnQuestion = {
  dir: string;
  filename: string;
  node: string;
  args: string[];
  policy: Policy;
  maxCost: number | null;
  maxTime: number | null;
  messageCount: number;
  name: string;
  cwd: string;
  outputFile: string;
  depth: number;
};

/** Starts an approved program and returns its pid. Raises nothing: its
 *  only caller raised std::spawn first. `spawnDir` is the folder from
 *  `_spawnPaths`, where the policy file goes. */
export async function _spawn(
  question: SpawnQuestion,
  messages: unknown[],
  spawnDir: string,
): Promise<{ pid: number }>

/** The `agency run` arguments that start `question`'s program. */
export function spawnCommand(question: SpawnQuestion, policyFile: string, seeded: boolean): string[]

/** The environment a spawned program's launcher gets: `own` without the
 *  variables that tie a process to its caller's run, and with the depth. */
export function spawnEnvironment(own: Record<string, string>, depth: number): Record<string, string>
```

`_spawnDepth` reads `AGENCY_SPAWN_DEPTH` through `host.settings` and returns 0 when it is missing or not a whole number.

`_spawnPaths` builds two paths and creates nothing. The folder is `~/.agency/spawned/` followed by a name from `nanoid()`. `agencyHomeDir` in `lib/runtime/agencyHome.ts` gives `~/.agency`. The output file is `output.log` in that folder. It runs before the raise so that the payload can show the output path, and a rejected start leaves nothing on disk.

**`spawnCommand`** is a pure function. It states the flags as a list of pairs, and one line turns the list into arguments:

```ts
const flags: [string, string | null][] = [
  ["--detach", question.outputFile],
  ["--wait-for-response", ""],
  ["--policy", policyFile],
  ["--name", question.name],
  ["--max-cost", question.maxCost === null ? null : String(question.maxCost)],
  ["--max-time", question.maxTime === null ? null : `${question.maxTime}ms`],
  ["--messages", seeded ? "-" : null],
];
```

A pair whose value is null is left out. A pair whose value is the empty string is a flag with no value. The arguments are `run`, the flags, the target `<dir>/<filename>:<node>`, then `--`, then the program's arguments. The `--` is always written, so the program's arguments are never read as `agency`'s. To add a flag later, add a row.

Check how `--max-time` parses its value (`resolveBudget` in `lib/cli/budget.ts`) and write the time in a form it accepts.

**`spawnEnvironment`** is a pure function too. It states what is not inherited as data:

```ts
/** Variables that tie a process to its caller's run. */
const NOT_INHERITED = [TRACE_ID_ENV, CONFIG_OVERRIDES_ENV];
const NOT_INHERITED_PREFIX = "AGENCY_IPC";
```

It returns `own` without those, and with `AGENCY_SPAWN_DEPTH` set. `RunOptions.env` replaces the child's whole environment, which is why the whole list is built. The spawned program then has its own trace, and reads its own `agency.json`.

**`_spawn`** does these things in order:

1. Make `~/.agency/spawned/` and then `spawnDir` with `host.files.privateDir`. It throws, naming the folder, when one cannot be used.
2. Write the policy to `policy.json` in `spawnDir`, through `host.files`.
3. Run `process.execPath` with the command line's path and `spawnCommand(...)`, through `host.subprocess.run`. Pass `cwd`, the environment from `spawnEnvironment`, and a timeout of `SPAWN_LAUNCH_TIMEOUT_MS`, which covers the compile. When `messages` is not empty, pass its JSON as the standard input.

   `agencyCliPath` in `lib/eval/grading/agencyTestGrader.ts:41` finds the command line's path today. Move that function to `lib/cli/cliPath.ts` and call it from both.

4. A non-zero exit throws the command's error output, cut to its last `SPAWN_ERROR_TAIL_CHARS` characters. This is how a compile error reaches the caller.
5. Parse the one line of JSON on standard output.
6. Delete `policy.json` with `host.files.remove`. The command has read it by then.
7. Add one to `ctx.spawnCount`, and return the pid.

Put the two new constants in `lib/constants.ts`: two minutes, and 2,000 characters.

### The Agency side

Add the effect beside `std::run` (`stdlib/agency.agency:69`), with the fields the spec's decision 2 lists, and the tag the owner decided on:

```agency
@always(dir, filename)
effect std::spawn {
  dir: string;
  filename: string;
  node: string;
  args: string[];
  policy: Record<string, any>;
  maxCost: number | null;
  maxTime: number | null;
  messageCount: number;
  name: string;
  cwd: string;
  outputFile: string;
  depth: number
}
```

Read `docs/dev/language/effect-always-tag.md` before adding the tag. With it, an "always approve when" answer to a spawn prompt pins the folder and the file being started.

Then the function:

```agency
const MAX_SPAWN_DEPTH = 5
const MAX_SPAWNS_PER_RUN = 500

@capabilities(fileWrite, subprocess)
export def spawn(
  dir: string,
  filename: string,
  node: string = "main",
  args: string[] = [],
  policy: Record<string, any> = {},
  maxCost?: number,
  maxTime?: number,
  messages: any[] = [],
  name: string = "",
  cwd?: string,
  outputFile?: string,
): Result<ProcessInfo> raises <std::spawn> {
  """
  Start an Agency file as a separate process and return at once. The process keeps running after this program ends. It has its own approval rules, given here as policy, and its own cost and time limits. A handler around this call approves the start and nothing the process does later. A question the process cannot settle waits for a person, who answers it with agency attach. What the process prints is saved to the output file in the result.

  @param dir - The directory containing the file.
  @param filename - The Agency file to run.
  @param node - The node to start.
  @param args - Arguments the program reads with std::args.
  @param policy - The approval rules the process runs under. The default has no rules.
  @param maxCost - The most the process may spend, in dollars, or null for no limit.
  @param maxTime - The longest the process may work, in milliseconds, or null for no limit.
  @param messages - A conversation the process's first thread starts with.
  @param name - The name the process shows in ps. The default is the filename.
  @param cwd - The working directory. The default is this program's.
  @param outputFile - The file the process's output is saved to. The default is a new file under ~/.agency/spawned.
  """
  if (_subprocessDepth() > 0) {
    return failure("spawn cannot be called inside a run() subprocess.")
  }
  const depth = _spawnDepth() + 1
  if (depth > MAX_SPAWN_DEPTH) {
    return failure("spawn is ${depth} levels deep, past the limit of ${MAX_SPAWN_DEPTH}.")
  }
  if (_spawnCount() >= MAX_SPAWNS_PER_RUN) {
    return failure("This run has started ${MAX_SPAWNS_PER_RUN} processes, which is the limit.")
  }
  const valid = _validatePolicy(policy)
  if (!valid.success) {
    return failure("Invalid policy: ${valid.error}")
  }
  const paths = _spawnPaths()
  const question: SpawnQuestion = {
    dir: dir,
    filename: filename,
    node: node,
    args: args,
    policy: policy,
    maxCost: maxCost,
    maxTime: maxTime,
    messageCount: messages.length,
    name: if name != "" then name else filename,
    cwd: cwd ?? _cwd(),
    outputFile: outputFile ?? paths.outputFile,
    depth: depth
  }
  return interrupt std::spawn("Start ${filename} as a separate process?", question)
  const started = try _spawn(question, messages, paths.dir)?
  return success({ pid: started.pid, name: question.name, outputFile: question.outputFile })
}
```

The value is built once. The interrupt shows it, and `_spawn` starts the program from it, so the two cannot drift apart. Declare `SpawnQuestion` in `stdlib/agency.agency` with the effect's fields. If the type checker wants the effect's own payload type at the raise, give the constant that type and keep the one value.

The helpers:

- `_validatePolicy` is exported by `lib/stdlib/policy.ts:16` and returns `{ success, error }`. Do not use `_checkPolicy` from the same file. That one matches an interrupt against a policy.
- `_cwd` is the helper `cwd()` in `stdlib/system.agency:105` calls. Import it the way that file does.

Do not add `std::spawn` to any set in `stdlib/effectSets.agency`. `Shell` holds `std::run`, and a rule that approves `Shell` must not approve a spawn.

**Tests**, `lib/stdlib/spawn.test.ts`, with a fake host subprocess:

- `spawnCommand` gives every flag in the order above, leaves out the ones whose value is null, and writes `--` before the program's arguments.
- `spawnEnvironment` sets `AGENCY_SPAWN_DEPTH`, and drops `AGENCY_TRACE_ID`, `AGENCY_CONFIG_OVERRIDES`, and an `AGENCY_IPC` variable when the input had all three.
- A non-empty `messages` is sent as standard input, and no file holds it.
- A non-zero exit throws the error output, and `spawnCount` does not change.
- `policy.json` is gone afterwards.
- `spawnCount` goes up by one for each start.
- `_spawnDepth` returns 0 with the variable missing, and its value otherwise.
- `_spawnPaths` creates nothing.

In `checkpointStore.test.ts`, for the count:

- A checkpoint taken at a count of 3 has `spawnCount: 3` in its JSON, and one taken at 0 has no such field.
- `adoptSpawnCount(3)` on a fresh context gives 3. This is a resume.
- `adoptSpawnCount(3)` on a context at 5 leaves 5. This is a `restore()` after two more starts.
- `adoptSpawnCount(undefined)` changes nothing. This is a checkpoint from before the field.
- A signed checkpoint whose `spawnCount` is edited fails `verifyCheckpointChecksum`.

## Task 13: the tests for `spawn`

Ticket: ADI-299, ADI-300.

**Files:**
- Create: `tests/agency/spawn.agency`, `tests/agency/spawn.test.json`
- Create: `lib/cli/spawn.spawn.test.ts`, and a fixture folder beside it

**How each test waits.** Agency has no function that waits for a file, and a loop with no pause spins the processor. So the cases are split by whether they wait:

- Cases that never wait are Agency tests, in `tests/agency/spawn.agency`.
- Cases that wait on a spawned program are in `lib/cli/spawn.spawn.test.ts`. Vitest runs a small Agency program with the built command line, and uses `lib/cli/spawnTestHelpers.ts` from task 6 to wait, to watch a socket, and to make a throwaway home. The rules there apply: every fixture program that waits gives up after its own deadline, and no test signals a pid it read from output.

### Agency tests, no waiting

One node per case:

1. A rejected `std::spawn` starts nothing. The handler records `intr.data.outputFile`, then rejects. The test checks that the folder holding that path does not exist. It does not list `~/.agency/spawned/`, which other cases write to.
2. A handler that approves `std::run` and rejects every other effect does not let a program start. The result is a failure.
3. A policy that is not valid fails the call. A handler that counts raises sees none.
4. `spawn` inside a `run()` subprocess returns a failure. The node runs a child that calls it.
5. With `AGENCY_SPAWN_DEPTH` set to 5 in the test's environment, `spawn` returns a failure before it raises.
6. The payload a handler sees has the policy, both limits, the message count, and an output path.

### Spawn tests, with waiting

The fixture programs:

- `caller.agency` takes the name of a program to spawn and a policy as arguments, calls `spawn` with `with approve`, and prints the result as JSON.
- `marks.agency` prints a line, writes a marker file named in its first argument, and ends.
- `asks.agency` is the one from task 6.
- `writesThread.agency` writes its first thread's messages to a file. It reads them with `getThread(currentThreadId())` from `std::thread`, and writes with `write(...) with approve`. It makes no model call.

The cases:

1. `caller.agency` spawns `marks.agency`. The marker appears after `caller.agency` has exited. The result has a pid, a name, and an output path, and the output file holds the printed line.
2. The spawned program's pid shows in `ps` as `agency run marks.agency`.
3. `caller.agency` spawns `asks.agency` with a policy that approves `test::ask`. The "finished" marker appears.
4. `caller.agency` spawns `asks.agency` with no policy. Its own `with approve` is around the `spawn` call. The "started" marker appears and the "finished" marker does not, and a watching client is sent the question. An approval from the client finishes it.
5. `caller.agency` spawns `writesThread.agency` with `messages`. The file it writes holds the seed, and no file under the test's `~/.agency/spawned/` holds it.
6. `caller.agency` is run with `AGENCY_TRACE_ID` set. The spawned program's statelog events carry a different trace id. Give the fixture a `log.logFile` in its `agency.json` to read them from.
7. `agency attach` logic on a spawned program: `watchCommand` with a scripted `decide` prints the program's earlier output and answers its question.

Every test runs under `throwawayHome()`.

**The count** is checked in `lib/stdlib/spawn.test.ts`, in task 12. Starting 500 processes in a test is not worth it.

## Task 14: docs for the second PR

Ticket: ADI-299.

- `docs/dev/runtime/spawn.md`: add what `spawn` is and how it differs from `run()`, the launch through `agency run --detach`, the carriers, the environment a spawned program gets and what is removed from it, the seed on standard input and the once-per-process rule, the folder under `~/.agency/spawned/`, the depth and the count, the output cap and what it does not reach, that an existing output file keeps its mode, and the rule that `std::spawn` is in no effect set.
- In the same doc: `std::spawn` declares `@always(dir, filename)`, and what an "always approve when" answer to a spawn prompt therefore pins.
- In the same doc: why the count of starts is kept at the larger value when a checkpoint is applied, where a run's spend is set back.
- `docs/dev/cli/cli-arguments.md`: the new flags, if that doc lists flags.
- `docs/dev/cli/debugger-attach.md`: the `outputFile` record field.
- `docs/dev/runtime/subprocess-ipc.md`: one sentence pointing to `spawn.md` for a process that outlives its caller.
- Update the description of `spawn.md` in `CLAUDE.md` if the one from task 7 no longer covers it.

`make` regenerates the stdlib pages under `docs/site/stdlib/` from the docstrings. Do not edit those by hand.

**User pages.** Ask the owner first. They would need `--detach`, `--name`, and `--messages` in `docs/site/cli/run.md`, a guide page on `spawn`, and a line in `docs/site/guide/handlers.md` that a handler around `spawn` approves the start only.

---

## How to test

Do this once per PR, after every change for that PR is made. Save each command's output to a file, and read the file when something fails.

A fresh worktree needs `make` before anything runs.

**First PR:**

1. `make`.
2. `pnpm run typecheck`.
3. `pnpm run lint:structure`, and the lint that covers `eslint.node-exceptions.mjs`.
4. Prettier, by name, on each TypeScript file touched.
5. The unit tests for the files touched: `lib/cli/runPolicy.test.ts`, `lib/cli/childEnv.test.ts`, `lib/runtime/runPolicyHandler.test.ts`, `lib/runtime/heldQuestions.test.ts`, `lib/runtime/heldCheckpoint.test.ts`, `lib/runtime/interruptResolution.test.ts`, `lib/runtime/cliInterruptResolution.test.ts`, `lib/stdlib/herdr.test.ts`, `lib/debugger/attach/watch.test.ts`, `lib/debugger/attach/server.test.ts`, `lib/debugger/attach/sessionRules.test.ts`, `lib/debugger/attach/registry.test.ts`, `lib/cli/attach.test.ts`, `lib/cli/attachWatch.test.ts`.
6. The spawn tests: `lib/cli/wait.spawn.test.ts`. They need the build from step 1.
7. `lib/cli/resume.spawn.test.ts` and `lib/cli/runPolicy.spawn.test.ts`, which must pass unchanged.

**Second PR:**

1. `make`. Task 12 changes a stdlib `.agency` file, and `make` regenerates the stdlib module table and docs.
2. `pnpm run typecheck`, `pnpm run lint:structure`, and prettier on the TypeScript files touched.
3. The unit tests: `lib/cli/childEnv.test.ts`, `lib/runtime/cliEntry.test.ts`, `lib/runtime/seedMessages.test.ts`, `lib/runtime/platform.test.ts`, `lib/runtime/outputCap.test.ts`, `lib/stdlib/spawn.test.ts`, `lib/runtime/state/checkpointStore.test.ts`, `lib/cli/attachWatch.test.ts`, `lib/eval/grading/agencyTestGrader.test.ts`.
4. The spawn tests: `lib/cli/detach.spawn.test.ts`, `lib/cli/spawn.spawn.test.ts`, `lib/cli/wait.spawn.test.ts`, `lib/cli/resume.spawn.test.ts`, `lib/cli/runPolicy.spawn.test.ts`.
5. The Agency tests, each with `--check-capabilities` after the path:
   - `tests/agency/spawn.agency`
   - the files in `tests/agency/subprocess/`, which must pass unchanged

Do not run the whole Agency test suite locally. CI runs it.

**By hand, after the second PR.** These need a terminal:

- Run a program that spawns another, and let the first one end. `ps` shows the second as `agency run <name>`.
- Press Ctrl-C in the first program's terminal while the second runs. The second keeps running.
- `agency attach` with no pid lists the program, with `waiting` once it holds a question.
- `agency attach <pid>` prints the program's earlier output, then shows the approval prompt. Approving lets the program finish.
- Attach to a program that asks for a value. The typed line reaches it.
- Attach, watch output arrive, and press Ctrl-C. The program keeps running.
- With `agency debug --attach <pid>` on the same program, the debugger still works as before.
- Quit everything and check with `pgrep` that no process is left.

## What is not in this plan

The spec's section "What this does not cover" lists these, and none of them is built here:

- How processes find and talk to each other, and a result that comes back to the caller.
- A list of spawned processes, and stopping one from Agency code.
- Stdlib functions for answering another program's questions (ADI-308).
- A `resume` function in the standard library (ADI-318).
- `agency agent` starting agents as processes.
- Shell jobs that survive a held question (ADI-307).
- Running a tool call in a child process, and moving running code to the background.
- Removing old folders under `~/.agency/spawned/`.
- Windows. `spawn` and `--detach` work there, but a program cannot open its socket, so nothing can answer a held question.
