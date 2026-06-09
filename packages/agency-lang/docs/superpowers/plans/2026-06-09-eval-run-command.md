# Eval Run Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agency eval run` and `std::agency/eval.evalRun` so users can run an Agency agent against a task suite and get per-task statelog/eval artifacts under `runs/<run-id>/`.

**Architecture:** Share task loading and artifact management between CLI and stdlib, but use different execution adapters for their different safety contexts. The CLI command is an explicit user action with no parent Agency handler stack, so it may spawn the compiled agent directly from TypeScript; the stdlib `evalRun` function may be called by an agent, so it must call `std::agency.run(...)` for every task to preserve parent-handler enforcement for subprocess interrupts.

**Tech Stack:** TypeScript, Vitest, Commander CLI, existing Agency compiler/runtime IPC, `std::agency`, existing `eval extract` core.

---

## Source Spec

Spec: `docs/superpowers/specs/2026-06-09-eval-run-command-design.md`

This plan intentionally implements the v1 spec only: sequential execution, no judging/comparison/optimization, no parallelism, no seed flag, no CLI-level resource-limit flags.

## File Structure

- Create `lib/eval/runTypes.ts`
  - Owns public TypeScript types for `EvalRunTask`, `EvalRunTaskResult`, `EvalRunResult`, `EvalRunConfig`, and internal dependency interfaces.
- Create `lib/eval/loadTasks.ts`
  - Loads `--tasks` file or directory form, creates one inline task for `--goal`, validates task ids/rubrics/duplicates, and resolves `working_dir` relative to task-file location.
- Create `lib/eval/runArtifacts.ts`
  - Shared filesystem helpers: create run layout, prepare/copy task workdirs, write `task.json`, decide whether to extract, write `error.txt`, write `config.json` / `summary.json`.
- Create `lib/cli/eval/run.ts`
  - CLI adapter: reuses shared target parsing, resolves agent file/directories, loads tasks, compiles the agent once, spawns each task directly from TypeScript with the per-task statelog override, prints summary/progress, and maps exit codes.
- Move existing eval CLI files into `lib/cli/eval/`
  - Move `lib/cli/evalExtract.ts` → `lib/cli/eval/extract.ts`.
  - Move `lib/cli/evalJudge.ts` → `lib/cli/eval/judge.ts`.
  - Update imports in `scripts/agency.ts` and tests.
- Modify `scripts/agency.ts`
  - Register `agency eval run` under the existing `eval` command.
- Modify `lib/config.ts`
  - Add `eval?: { runsDir?: string }` to `AgencyConfig` and zod schema.
- Modify `lib/runtime/ipc.ts`
  - Add optional `configOverrides?: Partial<AgencyConfig>` and `cwd?: string` to `_run(...)` and the IPC/fork path.
- Modify `lib/runtime/subprocess-bootstrap.ts`
  - Add `configOverrides` to `RunInstruction` and install those overrides before importing the compiled module.
- Modify `lib/runtime/state/context.ts` and/or add a small runtime helper
  - Apply installed runtime config overrides when a compiled module constructs `RuntimeContext`. This is required because compiled modules currently bake `agency.json` config into generated runtime-context arguments at compile time; bootstrap does not call `loadConfig()` itself.
- Create `stdlib/agency/eval.agency`
  - New eval-focused stdlib module exporting `evalRun(...)` and eval run task/result types. It imports and calls `run(...)` from `std::agency` for every task.
- Modify `stdlib/agency.agency`
  - Export `CompiledProgram` if needed by sibling stdlib modules, and extend `run(...)` with optional `logFile: string = ""` and `cwd: string = ""`; keep compile/run primitives here.
- Modify `lib/stdlib/agency.ts`
  - Pass `logFile` through `_run` as `configOverrides.log.logFile`, and pass non-empty `cwd` to the runtime `_run` implementation.
- Create `lib/stdlib/agencyEval.ts`
  - TS helpers backing `std::agency/eval`: run layout prep, task artifact writes, extraction, and summary aggregation. These helpers do not call `_run`; only Agency `evalRun(...)` calls `run(...)`.
- Modify docs:
  - `docs/site/cli/eval.md` or new `docs/site/cli/eval-run.md` linked from `eval.md`.
  - Generated stdlib docs should be updated by the normal docs generation flow if required by the repo.
- Tests:
  - `lib/eval/loadTasks.test.ts`
  - `lib/eval/runArtifacts.test.ts`
  - `lib/runtime/ipc.configOverrides.test.ts` or closest existing IPC test file
  - `lib/cli/eval/run.test.ts`
  - targeted Agency/stdlib test for `std::agency.run(..., logFile: ..., cwd: ...)` if feasible without expensive full suites

## Implementation Notes and Constraints

- Do not add env vars for statelog routing. Use IPC `configOverrides` per spec.
- Current generated TypeScript bakes config into `RuntimeContext` construction in `lib/backends/typescriptBuilder.ts`; do not write a plan or implementation that assumes `subprocess-bootstrap.ts` independently loads `agency.json`. The override path must be visible to the generated module at runtime, before its top-level `RuntimeContext` is constructed.
- Each task must execute with subprocess `cwd` set to its prepared `workdir/` in both CLI and stdlib paths. This requires plumbing `cwd` through `std::agency.run(...)`/`_run(...)`; artifact helpers alone cannot provide isolation.
- Stdlib eval-run subprocess execution must go through `std::agency.run(...)`, never direct Node spawn and never runtime `_run(...)` from stdlib eval-run orchestration. This is a safety boundary for agent-invoked evals: subprocess interrupts must be resolved through the child handler chain plus the parent handler stack.
- Keep handler safety explicit:
  - CLI may spawn directly because invoking `agency eval run` is explicit human consent and there is no parent Agency handler stack to preserve.
  - Stdlib `evalRun` does not install its own approval handler; callers must wrap it in their own `handle { ... } with approve` or stricter handler.
- Prefer arrays/objects over maps/sets in new code, per repo guidance. Temporary local `Set` use for duplicate detection is already present elsewhere, but use an object counter here to stay aligned.
- Do not hand-edit generated docs unless the repo’s current docs process requires it for this change.
- Save test outputs to `/tmp/*.log` when running slower or broader commands.

## Safety Architecture: Why Stdlib `evalRun` Must Call `run`

`std::agency.run` does two safety-critical things that stdlib `evalRun` must preserve:

1. Before spawning, it raises `interrupt std::run(...)`, so the caller can approve or reject subprocess execution.
2. During subprocess execution, interrupts from the child are routed through IPC to the parent; even if the child approves an interrupt, the parent handler stack can still reject it.

That second property is the long-term security boundary for agents that write and optimize Agency code. Generated code can be evaluated, but parent policy still controls what that generated code may read, write, fetch, or execute. Therefore:

- `std::agency/eval.evalRun` must call `run(...)` from `std::agency` for every task.
- TypeScript helpers used by the stdlib path may prepare files and extract records, but must not bypass `run(...)` for subprocess execution.
- `agency eval run` is different: it is a human-invoked CLI command with no parent Agency handler stack, so a direct TypeScript spawn path is acceptable as long as it still uses the same task/artifact/extract helpers and routes statelog via config overrides.

For the CLI path, "direct spawn" means the CLI owns the subprocess policy explicitly. It must not pretend to provide parent-handler enforcement, because there is no parent Agency execution context. Child interrupts should either follow the same behavior as normal human-invoked CLI execution or be handled by an explicit CLI policy documented in `lib/cli/eval/run.ts` tests. The stdlib path is the only path that needs the parent-handler safety guarantee, and it gets that guarantee by calling `run(...)`.

---

### Task 1: Add task/result types

**Files:**
- Create: `lib/eval/runTypes.ts`
- Test: type usage through later tests; no standalone runtime test needed.

- [ ] **Step 1: Define JSON-facing task/result types**

Create `lib/eval/runTypes.ts`:

```ts
export type EvalRunTask = {
  task_id: string;
  rubric: string;
  args: Record<string, any>;
  node?: string;
  working_dir?: string;
};

export type EvalRunTaskResult = {
  taskId: string;
  status: "success" | "error";
  evalRecordPath: string;
  statelogPath: string;
  workdirPath: string;
  errorMessage?: string;
};

export type EvalRunResult = {
  runId: string;
  runDir: string;
  agent: string;
  tasks: EvalRunTaskResult[];
  okCount: number;
  errorCount: number;
};

export type EvalRunConfig = {
  runId: string;
  runsDir: string;
  agent: string;
  tasks: EvalRunTask[];
  tasksSource: string;
  continueOnError: boolean;
  verbose?: boolean;
};
```

- [ ] **Step 2: Add execution dependency types**

In the same file, add:

```ts
export type EvalRunCompiledAgent = {
  moduleId: string;
  path?: string;
};

export type EvalRunDependencies = {
  runTask(args: {
    compiled: EvalRunCompiledAgent;
    node: string;
    args: Record<string, any>;
    cwd: string;
    statelogPath: string;
  }): Promise<{ ok: true } | { ok: false; errorMessage: string }>;
  extract(args: {
    statelogPath: string;
    outPath: string;
    task: EvalRunTask;
  }): Promise<void>;
  now(): Date;
};
```

- [ ] **Step 3: Export only stable names**

Keep internal helper types out of broad index exports unless another file needs them.

- [ ] **Step 4: Commit**

```bash
git add lib/eval/runTypes.ts
git commit -m "eval: add eval run types"
```

---

### Task 2: Load and validate task suites

**Files:**
- Create: `lib/eval/loadTasks.ts`
- Test: `lib/eval/loadTasks.test.ts`

- [ ] **Step 1: Write failing tests for file-form suites**

In `lib/eval/loadTasks.test.ts`, create temp files and assert:

```ts
it("loads tasks from a suite file and fills defaults", () => {
  // Write { tasks: [{ rubric: "do it", args: { prompt: "x" } }] }
  // Expect one task with generated task_id, args preserved, no node, no working_dir.
});
```

Use `vi.spyOn` or dependency injection for ID generation so the default id is deterministic.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/eval/loadTasks.test.ts > /tmp/eval-run-loadTasks-red.log 2>&1
cat /tmp/eval-run-loadTasks-red.log
```

Expected: fails because `loadTasks.ts` does not exist.

- [ ] **Step 3: Implement minimal file loader**

Implement:

```ts
export function loadTasksFromFile(filePath: string, makeId = nanoid): EvalRunTask[]
```

Rules:
- JSON must parse.
- Top-level must have `tasks` array.
- Each task requires `rubric: string` and optional fields.
- `args` defaults to `{}`.
- missing `task_id` becomes `makeId()`.

- [ ] **Step 4: Run GREEN for file-form test**

```bash
pnpm test:run lib/eval/loadTasks.test.ts > /tmp/eval-run-loadTasks-green1.log 2>&1
cat /tmp/eval-run-loadTasks-green1.log
```

- [ ] **Step 5: Add failing validation tests**

Add tests for:
- missing `rubric` throws a clear error
- invalid `task_id` characters throw
- duplicate `task_id` throws
- empty suite succeeds with `[]`

- [ ] **Step 6: Run RED**

Expected: validation tests fail.

- [ ] **Step 7: Implement validation**

Use object-based duplicate tracking:

```ts
const seen: Record<string, true> = {};
```

Accept id regex: `/^[A-Za-z0-9._-]+$/`.

- [ ] **Step 8: Add failing directory-form tests**

Assert:
- loads every `*.json` file in lexical order
- resolves `working_dir` relative to each task file
- malformed JSON aborts load
- directory with no `.json` files returns `[]`

- [ ] **Step 9: Implement directory-form loader and public dispatcher**

Implement:

```ts
export function loadTasks(sourcePath: string, makeId = nanoid): EvalRunTask[]
```

If `sourcePath` is directory, read direct `.json` children only.

- [ ] **Step 10: Add inline goal test**

Test:

```ts
expect(taskFromGoal("rubric", () => "id1")).toEqual({
  task_id: "id1",
  rubric: "rubric",
  args: {},
});
```

- [ ] **Step 11: Implement `taskFromGoal`**

- [ ] **Step 12: Run all loader tests**

```bash
pnpm test:run lib/eval/loadTasks.test.ts > /tmp/eval-run-loadTasks-final.log 2>&1
cat /tmp/eval-run-loadTasks-final.log
```

- [ ] **Step 13: Commit**

```bash
git add lib/eval/loadTasks.ts lib/eval/loadTasks.test.ts
git commit -m "eval: load eval run task suites"
```

---

### Task 3: Add IPC config overrides and `run(..., logFile, cwd)`

**Files:**
- Modify: `lib/runtime/ipc.ts`
- Modify: `lib/runtime/subprocess-bootstrap.ts`
- Modify: `lib/runtime/state/context.ts`
- Add or modify: a small runtime override helper if needed
- Modify: `stdlib/agency.agency`
- Modify: `lib/stdlib/agency.ts`
- Test: existing or new focused runtime/stdlib tests

- [ ] **Step 1: Write failing IPC run-instruction test**

Find the closest existing IPC test file. If none fits, create `lib/runtime/ipc.configOverrides.test.ts` with narrow tests around exported pure helpers.

Preferred seam: extract `buildRunInstruction(...)` from `attachSessionHandlers(...)` so it can be tested without forking:

```ts
expect(buildRunInstruction({ scriptPath, node, args, limits, configOverrides })).toMatchObject({
  type: "run",
  configOverrides: { log: { logFile: "task/statelog.jsonl" } },
});
```

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/runtime/ipc.configOverrides.test.ts > /tmp/eval-run-ipc-red.log 2>&1
cat /tmp/eval-run-ipc-red.log
```

- [ ] **Step 3: Add `configOverrides` to IPC types and `_run` signature**

In `lib/runtime/ipc.ts`:
- import `type { AgencyConfig }`
- add optional `configOverrides?: Partial<AgencyConfig>` to `_run(...)`
- add optional `cwd?: string` to `_run(...)`
- include it in the run instruction returned by `buildRunInstruction(...)`
- pass non-empty `cwd` to `fork(subprocessBootstrapPath, [], { cwd, ... })`; omit it when empty/undefined to preserve current behavior

Preserve existing `_run` parameter order by adding the new optional parameter at the end.

- [ ] **Step 4: Run IPC test GREEN**

- [ ] **Step 5: Write failing runtime override application tests**

Do not assume bootstrap loads config. It currently imports a compiled module whose generated top-level code creates `RuntimeContext` from compile-time config. Add tests for the actual seam:

```ts
setRuntimeConfigOverrides({ observability: true, log: { logFile: "x.jsonl" } });
const ctx = new RuntimeContext({
  statelogConfig: { host: "h", observability: false },
  smoltalkDefaults: {},
  dirname: process.cwd(),
});
expect(/* ctx statelog config via helper or mock */).toMatchObject({
  host: "h",
  observability: true,
  logFile: "x.jsonl",
});
```

If `StatelogClient` does not expose config, test an exported pure helper instead:

```ts
applyRuntimeConfigOverridesToContextArgs(args, overrides)
```

- [ ] **Step 6: Implement runtime override installation and application**

Implement the smallest mechanism that makes overrides visible before compiled-module top-level initialization:

- In `lib/runtime/subprocess-bootstrap.ts`, read `msg.configOverrides` before the dynamic import and install it through a runtime helper such as `setRuntimeConfigOverrides(...)`.
- In `lib/runtime/state/context.ts` or a tiny helper imported by it, apply the installed overrides when constructing runtime context args. At minimum support:
  - `observability` → `StatelogConfig.observability`
  - `log.logFile` → `StatelogConfig.logFile`
  - preserve existing statelog fields such as `host`, `apiKey`, `projectId`, `debugMode`, `requestTimeoutMs`, and `metadata`
- Clear or replace overrides per subprocess run instruction; the bootstrap process handles one run and exits, so no long-lived reset path is required beyond tests.

Prefer an object-only deep merge helper for this task; arrays should be replaced, not concatenated.

Do not add environment variables for this path.

- [ ] **Step 7: Extend `std::agency.run` signature**

In `stdlib/agency.agency`, export `CompiledProgram` if sibling modules need to import it:

```agency
export type CompiledProgram = {
  moduleId: string
}
```

Then add final parameters to `run(...)`:

```agency
logFile: string = "",
cwd: string = "",
```

Update docstring:

```agency
@param logFile - Optional statelog JSONL file path for this subprocess run
@param cwd - Optional working directory for this subprocess run
```

When calling `_run`, pass `logFile` and `cwd` as final arguments.

- [ ] **Step 8: Update `_run` wrapper in `lib/stdlib/agency.ts`**

Find the exported `_run` binding in `lib/stdlib/agency.ts`. Convert non-empty `logFile` to:

```ts
const configOverrides = logFile
  ? { log: { logFile }, observability: true }
  : undefined;
return runtimeRun(compiled, node, args, wallClock, memory, ipcPayload, stdout, configOverrides, cwd || undefined);
```

Do not change defaults for callers that omit `logFile` and `cwd`.

- [ ] **Step 9: Add/adjust tests for `run(..., logFile, cwd)`**

Add focused tests that:
- the stdlib wrapper calls runtime `_run` with `configOverrides.log.logFile` when `logFile` is supplied
- `_run` forks with the supplied `cwd`
- an actual subprocess run with `configOverrides.log.logFile` writes statelog to that file, proving overrides are installed before compiled-module top-level `RuntimeContext` construction

- [ ] **Step 10: Run focused IPC/stdlib tests**

```bash
pnpm test:run <ipc-test-file> <stdlib-agency-test-file> > /tmp/eval-run-ipc-stdlib.log 2>&1
cat /tmp/eval-run-ipc-stdlib.log
```

- [ ] **Step 11: Commit**

```bash
git add lib/runtime/ipc.ts lib/runtime/subprocess-bootstrap.ts stdlib/agency.agency lib/stdlib/agency.ts <tests>
git commit -m "runtime: allow subprocess config overrides"
```

---

### Task 4: Implement shared eval run artifact helpers

**Files:**
- Create: `lib/eval/runArtifacts.ts`
- Test: `lib/eval/runArtifacts.test.ts`

- [ ] **Step 1: Write failing run-directory initialization test**

Test should call artifact helpers directly:

```ts
const run = initializeEvalRun({ runId: "r1", runsDir, agent: "agent.agency:main", tasksSource: "tasks.json", continueOnError: true, startedAt: fixedDate });
expect(fs.existsSync(path.join(runsDir, "r1", "tasks"))).toBe(true);
expect(JSON.parse(fs.readFileSync(path.join(runsDir, "r1", "config.json"), "utf8"))).toMatchObject({ runId: "r1" });
```

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/eval/runArtifacts.test.ts > /tmp/eval-run-artifacts-red1.log 2>&1
cat /tmp/eval-run-artifacts-red1.log
```

- [ ] **Step 3: Implement run directory initialization**

Create:
- `runsDir/runId/`
- `tasks/`
- `config.json`
- empty `summary.json` only when explicitly finalized

Use absolute paths in returned `runDir` and later task paths.

- [ ] **Step 4: Run GREEN for run-directory test**

- [ ] **Step 5: Write failing task preparation test**

Assert:
- `task.json` is written
- `workdir/` exists
- `statelogPath`, `evalRecordPath`, and `workdirPath` point inside the task directory
- empty workdirs are created without source fixtures

- [ ] **Step 6: Implement task preparation helper**

Create per-task dirs and write artifacts. Do not execute subprocesses here.

- [ ] **Step 7: Add failing `working_dir` copy test**

Create fixture directory with a file, task references it, assert copied file appears under task `workdir/` and source file is unchanged.

- [ ] **Step 8: Implement recursive copy**

Use `fs.cpSync(source, dest, { recursive: true })`. If source omitted, create empty workdir.

- [ ] **Step 9: Add failing result/failure artifact tests**

Cover:
- copy failure records `error.txt`
- subprocess failure message records `error.txt`
- missing statelog records `error.txt`
- extract failure records `error.txt`
- `writeSummary(...)` writes the final `RunResult`

- [ ] **Step 10: Implement result/failure artifact helpers**

Rules:
- Config/load errors throw before artifact helpers are called.
- Per-task runtime errors create `error.txt` and task result `error`.
- Extraction runs only when statelog exists and size > 0.

- [ ] **Step 11: Add statelog extraction-condition test**

Assert helper returns true only when statelog path exists and is non-empty.

- [ ] **Step 12: Implement statelog extraction-condition helper**

Keep this helper pure so both CLI execution and stdlib helper code can use the same condition.

- [ ] **Step 13: Run all artifact tests**

```bash
pnpm test:run lib/eval/runArtifacts.test.ts > /tmp/eval-run-artifacts-final.log 2>&1
cat /tmp/eval-run-artifacts-final.log
```

- [ ] **Step 14: Commit**

```bash
git add lib/eval/runArtifacts.ts lib/eval/runArtifacts.test.ts lib/eval/runTypes.ts
git commit -m "eval: add eval run artifact helpers"
```

---

### Task 5: Add CLI adapter and command registration

**Files:**
- Create: `lib/cli/eval/run.ts`
- Create or keep local: CLI-only subprocess adapter inside `lib/cli/eval/run.ts` unless it grows large enough to split
- Test: `lib/cli/eval/run.test.ts`
- Move: `lib/cli/evalExtract.ts` → `lib/cli/eval/extract.ts`
- Move: `lib/cli/evalJudge.ts` → `lib/cli/eval/judge.ts`
- Modify: `scripts/agency.ts`

- [ ] **Step 1: Move existing eval CLI files and update imports**

Move the existing `eval extract` and `eval judge` CLI implementation/tests into `lib/cli/eval/`. Update `scripts/agency.ts` imports from:

```ts
import { evalExtract } from "@/cli/evalExtract.js";
import { evalJudge } from "@/cli/evalJudge.js";
```

to:

```ts
import { evalExtract } from "@/cli/eval/extract.js";
import { evalJudge } from "@/cli/eval/judge.js";
```

- [ ] **Step 2: Run existing eval CLI tests after move**

```bash
pnpm test:run lib/cli/eval/extract.test.ts lib/cli/eval/judge.test.ts > /tmp/eval-run-cli-move.log 2>&1
cat /tmp/eval-run-cli-move.log
```

- [ ] **Step 3: Write failing target-resolution tests**

Reuse the existing shared `parseTarget` from `lib/cli/util.ts`; do not create a second parser. Test only eval-run-specific resolution around it:

- `parseTarget("foo.agency:evalMain")` is used to resolve file `foo.agency`, node `evalMain`
- `parseTarget("foo.agency")` produces empty node, and eval-run defaults that to `main`
- directory target resolves to `dir/main.agency`
- exactly one of tasks/goal is required

- [ ] **Step 4: Run RED**

```bash
pnpm test:run lib/cli/eval/run.test.ts > /tmp/eval-run-cli-red1.log 2>&1
cat /tmp/eval-run-cli-red1.log
```

- [ ] **Step 5: Implement target/options helpers**

Keep helpers exported for tests but not documented as public API.

- [ ] **Step 6: Write failing CLI handler test**

Mock task loading and compiled-agent execution. Assert handler builds config:
- `runsDir` from option
- `runId` from option or generated
- `tasksSource` absolute path for `--tasks`
- inline `--goal` source is `inline:--goal`
- `continueOnError` default true

- [ ] **Step 7: Implement `evalRun` CLI handler**

Shape:

```ts
export async function evalRun(opts: EvalRunCliOptions): Promise<EvalRunResult>
```

Real behavior:
- resolve/load tasks in TS
- compile the target agent once using the existing CLI compile path
- for each task, prepare artifacts with `lib/eval/runArtifacts.ts`
- spawn the compiled agent through a CLI-only low-level fork adapter with the task's `cwd`, args, and per-task statelog override
- extract the statelog into `eval-record.json` when appropriate

This direct-spawn path is CLI-only. Do not reuse it for `std::agency/eval.evalRun`, because stdlib evals may be initiated by an agent and must preserve parent-handler enforcement via `run(...)`.

The CLI executor cannot call runtime `_run(...)` directly because `_run(...)` reads the active parent `RuntimeContext` from `getRuntimeContext()`, and a human-invoked CLI command does not have an Agency runtime frame. Instead, implement a tiny adapter that uses the same `subprocessBootstrapPath` IPC protocol directly:

- `fork(subprocessBootstrapPath, [], { cwd: prepared.workdirPath, stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env, AGENCY_IPC: "1" } })`
- send a `RunInstruction` with `scriptPath`, `node`, `args`, `ipcPayload`, and `configOverrides`
- forward stdout/stderr normally; v1 may skip byte-count resource enforcement in the CLI adapter if tests document that stdlib `run(...)` remains the path with parent-handler/resource-limit semantics
- when the child sends `interrupt`, immediately reply with `{ type: "decision", approved: true, value: undefined }` because invoking `agency eval run` is the explicit CLI approval boundary
- convert child `result` / `error` / abnormal close into the same per-task success/error shape used by artifact helpers

Use the IPC `configOverrides` mechanism from Task 3 for statelog routing. Do not write per-task `agency.json` files and do not add env-var-based statelog overrides.

CLI execution sketch:

```ts
const compiledPath = compile(config, agentFile, undefined, { importStrategy: new RunStrategy() });
for (const task of tasks) {
  const prepared = prepareEvalRunTask(runState, task);
  await runCompiledAgent({
    compiledPath,
    node: task.node ?? defaultNode,
    args: task.args,
    cwd: prepared.workdirPath,
    configOverrides: {
      observability: true,
      log: { logFile: prepared.statelogPath },
    },
  });
}
```

- [ ] **Step 8: Register `agency eval run` in `scripts/agency.ts`**

Add under existing `eval` command:

```ts
evalCmd
  .command("run")
  .requiredOption("--agent <target>", "...")
  .option("--tasks <fileOrDir>", "...")
  .option("--goal <text>", "...")
  .option("--run-id <id>", "...")
  .option("--runs-dir <path>", "...")
  .option("--continue-on-error", "Continue after task failures", true)
  .option("--no-continue-on-error", "Stop after first task failure")
  .option("-v, --verbose", "Log per-task progress to stderr")
```

Use Commander’s boolean negation for `--no-continue-on-error`.

- [ ] **Step 9: Add exit-code behavior tests if practical**

At minimum unit-test the handler’s returned result and expose a small wrapper that maps result/config errors to exit codes.

- [ ] **Step 10: Run CLI tests**

```bash
pnpm test:run lib/cli/eval/run.test.ts > /tmp/eval-run-cli-final.log 2>&1
cat /tmp/eval-run-cli-final.log
```

- [ ] **Step 11: Commit**

```bash
git add lib/cli/eval scripts/agency.ts
git commit -m "cli: add eval run command"
```

---

### Task 6: Add `std::agency/eval.evalRun(...)`

**Files:**
- Create: `stdlib/agency/eval.agency`
- Create: `lib/stdlib/agencyEval.ts`
- Modify: `stdlib/agency.agency` only for `run(..., logFile, cwd)` from Task 3
- Modify: `lib/stdlib/agency.ts` only for `run(..., logFile, cwd)` from Task 3
- Test: `tests/agency-js/...` or focused TS unit tests

- [ ] **Step 1: Write failing Agency stdlib eval-run test**

Prefer an Agency execution test if it can avoid LLM/network. The test should import from `std::agency/eval` and use a compiled no-op/simple agent.

Test expectations:
- `evalRun(compiled, tasks, node, runsDir, runId, continueOnError)` returns `RunResult`.
- `evalRun` calls `run(...)` for each task, so the caller must wrap it in `handle { ... } with approve`.
- A parent handler can reject the subprocess approval interrupt, proving evalRun did not bypass `run(...)`.
- A task with `working_dir` observes that directory as subprocess `cwd`, proving stdlib eval uses isolated task workdirs.
- Fixture copy and extraction failures are recorded as per-task errors and honor `continueOnError`.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run <stdlib-eval-run-test> > /tmp/eval-run-stdlib-red.log 2>&1
cat /tmp/eval-run-stdlib-red.log
```

- [ ] **Step 3: Add Agency eval module types and wrapper**

In `stdlib/agency/eval.agency`, import `run` and the compiled program type from `std::agency`, plus TS helpers from `agency-lang/stdlib-lib/agencyEval.js`. Add `EvalRunTask`, `EvalRunTaskResult`, and `EvalRunResult` types.

Do not use `nanoid()` directly in Agency source unless a real Agency stdlib export exists by the time this task is implemented. In the current codebase, `nanoid` is only used from TypeScript helpers. Use `runId: string = ""` in Agency and let `_initializeEvalRun(...)` generate a `nanoid()` when it receives an empty string.

Add:

```agency
import { run, CompiledProgram } from "std::agency"
import { isFailure } from "std::result"
import {
  _initializeEvalRun,
  _prepareEvalRunTask,
  _extractEvalRunTask,
  _recordEvalRunTaskError,
  _formatEvalRunFailure,
  _finishEvalRun,
} from "agency-lang/stdlib-lib/agencyEval.js"

export def evalRun(
  compiled: CompiledProgram,
  tasks: EvalRunTask[],
  node: string = "main",
  runsDir: string = "runs/",
  runId: string = "",
  continueOnError: boolean = true,
): EvalRunResult {
  """Run a compiled Agency program against eval tasks..."""
  const runState = _initializeEvalRun(compiled, tasks, node, runsDir, runId, continueOnError)
  for (task in runState.tasks) {
    const preparedResult = _prepareEvalRunTask(runState, task)
    if (isFailure(preparedResult)) {
      _recordEvalRunTaskError(runState, task, _formatEvalRunFailure(preparedResult))
      if (!continueOnError) {
        return _finishEvalRun(runState)
      }
      continue
    }
    const prepared = preparedResult.value
    const taskNode = task.node ?? node
    const runResult = run(
      compiled: compiled,
      node: taskNode,
      args: task.args,
      logFile: prepared.statelogPath,
      cwd: prepared.workdirPath,
    )
    if (isFailure(runResult)) {
      _recordEvalRunTaskError(runState, prepared, _formatEvalRunFailure(runResult))
      if (!continueOnError) {
        return _finishEvalRun(runState)
      }
    } else {
      const extracted = _extractEvalRunTask(runState, prepared)
      if (isFailure(extracted)) {
        _recordEvalRunTaskError(runState, prepared, _formatEvalRunFailure(extracted))
        if (!continueOnError) {
          return _finishEvalRun(runState)
        }
      }
    }
  }
  return _finishEvalRun(runState)
}
```

Add `_formatEvalRunFailure(...)` to `lib/stdlib/agencyEval.ts` (or inline an equivalent helper in Agency if the exact failure shape is already confirmed). It should convert the current `Result` failure object into a human-readable string without assuming a non-existent `error.message` field. Verify against existing subprocess tests under `tests/agency/subprocess/` before finalizing the Agency code.

Verify Agency syntax with `pnpm run ast stdlib/agency/eval.agency`.

- [ ] **Step 4: Implement `agencyEval.ts` artifact helpers**

In `lib/stdlib/agencyEval.ts`, wrap `lib/eval/runArtifacts.ts` helpers for Agency use:

- `_initializeEvalRun(...)`
- `_prepareEvalRunTask(...)` returns `Result<PreparedEvalRunTask>` so fixture copy errors do not abort the whole eval run
- `_extractEvalRunTask(...)` returns `Result<boolean>` or equivalent so extract failures become per-task errors
- `_recordEvalRunTaskError(...)`
- `_formatEvalRunFailure(...)`
- `_finishEvalRun(...)`

These helpers may read/write files and call `extractEvalRecord`, but must not call runtime `_run`.

- [ ] **Step 5: Run stdlib tests and parse stdlib**

```bash
pnpm test:run <stdlib-eval-run-test> > /tmp/eval-run-stdlib-green.log 2>&1
cat /tmp/eval-run-stdlib-green.log
pnpm run ast stdlib/agency/eval.agency > /tmp/eval-run-stdlib-ast.log 2>&1
cat /tmp/eval-run-stdlib-ast.log | head -80
```

- [ ] **Step 6: Commit**

```bash
git add stdlib/agency/eval.agency lib/stdlib/agencyEval.ts <tests>
git commit -m "stdlib: expose evalRun"
```

---

### Task 7: Config, docs, and smoke coverage

**Files:**
- Modify: `lib/config.ts`
- Modify: `docs/site/cli/eval.md`
- Create or modify docs page for `eval run`
- Modify integration CLI tests only if a non-LLM smoke path is stable

- [ ] **Step 1: Write failing config schema test**

Find existing config tests. Add:

```ts
expect(loadConfigSafe(pathToAgencyJsonWithEvalRunsDir).config.eval?.runsDir).toBe("custom-runs");
```

- [ ] **Step 2: Add `eval.runsDir` to `AgencyConfig` and schema**

Add:

```ts
eval?: { runsDir?: string };
```

and zod partial object.

- [ ] **Step 3: Add docs**

Document:
- synopsis
- task file/directory formats
- `--goal`
- run directory layout
- exit code behavior
- relationship to `eval extract` and `eval judge`

- [ ] **Step 4: Add CLI smoke if feasible without LLM/network**

If a deterministic local Agency task can run without LLM calls, add a tarball smoke test for `agency eval run` that:
- creates a simple agent with `evalInput`/`evalOutput`
- creates one task JSON
- runs `agency eval run --agent agent.agency:evalMain --tasks tasks.json --run-id smoke --runs-dir runs`
- asserts `runs/smoke/summary.json` and per-task `eval-record.json`

If this requires real LLM or fragile runtime setup, skip integration smoke and rely on focused unit tests plus `eval extract` smoke already on main.

- [ ] **Step 5: Run docs/config tests**

```bash
pnpm test:run <config-test> <cli-doc-or-smoke-test-if-any> > /tmp/eval-run-docs-config.log 2>&1
cat /tmp/eval-run-docs-config.log
```

- [ ] **Step 6: Commit**

```bash
git add lib/config.ts docs/site/cli/eval.md docs/site/cli/eval-run.md <tests>
git commit -m "docs: document eval run"
```

---

### Task 8: Final verification

**Files:**
- All touched files

- [ ] **Step 1: Run focused test suite**

```bash
pnpm test:run \
  lib/eval/loadTasks.test.ts \
  lib/eval/runArtifacts.test.ts \
  lib/cli/eval/run.test.ts \
  <ipc-test-file> \
  <stdlib-test-file> \
  > /tmp/eval-run-focused.log 2>&1
cat /tmp/eval-run-focused.log
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm run typecheck > /tmp/eval-run-typecheck.log 2>&1
cat /tmp/eval-run-typecheck.log
```

- [ ] **Step 3: Parse stdlib Agency file**

```bash
pnpm run ast stdlib/agency.agency > /tmp/eval-run-stdlib-final-ast.log 2>&1
pnpm run ast stdlib/agency/eval.agency >> /tmp/eval-run-stdlib-final-ast.log 2>&1
cat /tmp/eval-run-stdlib-final-ast.log | head -80
```

- [ ] **Step 4: Run a manual smoke command if available**

Use a no-LLM agent/task pair and verify:

```bash
pnpm run agency eval run --agent <agent>:<node> --tasks <tasks.json> --run-id smoke --runs-dir /tmp/eval-run-smoke
```

Expected:
- final stdout summary
- `summary.json`
- per-task `statelog.jsonl`
- per-task `eval-record.json`

- [ ] **Step 5: Inspect git diff**

```bash
git diff --stat
git status --short
```

Confirm no temp files, generated JS, or logs are staged.

- [ ] **Step 6: Commit any final fixes**

```bash
git add <final-files>
git commit -m "eval: finalize eval run command"
```

---

## Open Questions for Implementer

1. **Full `configOverrides` breadth:** Task 3 only requires `observability` and `log.logFile` for eval-run statelog routing. If the implementation naturally supports more of `Partial<AgencyConfig>` without extra complexity, do so; otherwise leave broader per-subprocess client/model/API-key overrides for a follow-up.
2. **Result failure shape:** Confirm the exact `Result` failure field exposed to Agency before writing the final `evalRun` loop. Prefer `_formatEvalRunFailure(...)` in `lib/stdlib/agencyEval.ts` so the Agency source does not assume a brittle object shape.

Resolve these with the smallest code change that preserves the spec’s externally visible behavior.
