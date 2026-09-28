# Command Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agency eval run --agent-cmd '<command with {task}>'` benchmarks an Agency CLI (chiefly `agency agent`) under the eval framework, with the agent's own statelog as the eval record.

**Architecture:** The agent target becomes a discriminated union (`file` | `command`). One `runAgent` pipeline serves both kinds — the command kind skips closure/compile at seeding and executes via a new spawn-based runner instead of the IPC fork runner. The statelog handoff is `AGENCY_CONFIG_OVERRIDES` (existing) plus a new `AGENCY_TRACE_ID` env var so every descendant process — IPC-forked or bash-spawned — writes one coherent trace.

**Tech stack:** TypeScript, `child_process.spawn`, vitest, tarsec for the command tokenizer (the project's parser-combinator library — every parser in this repo uses it; see `lib/parsers/parsers.ts` for idioms and https://egonschiele.github.io/tarsec/ for docs). No new dependencies.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-31-eval-command-agents-design.md` — read it first; every decision below is justified there, including the experiment that validated the shared-statelog design and the two review rounds behind the sharp-edge fixes.

## Background for the implementer

The eval framework runs agents in isolated workdirs and grades what they leave behind. Today the only agent target is an `.agency` file: `runSuite` (`lib/eval/run/runSuite.ts`) resolves it via `resolveEvalRunTarget` (`lib/agentTarget.ts`), and `runAgent` (`lib/eval/run/runAgent.ts`) seeds the agent's import closure into the workdir, compiles it there, and forks it through `makeSubprocessRunner` (`lib/eval/run/subprocess.ts`), which passes the input's `task` over IPC. The statelog the child writes becomes `eval-record.json` via the extractor (`lib/eval/run/extract.ts`).

The bundled `agency agent` CLI cannot be run that way — it is a command, not a node. This plan adds command targets. The key mechanism: every compiled Agency process honors the `AGENCY_CONFIG_OVERRIDES` env var at startup (`lib/runtime/state/context.ts:263`), so pointing `log.logFile` at the harness's expected statelog path makes the agent's own record land exactly where the extractor reads. Verified by experiment (see spec): IPC-forked descendants inherit the parent's trace id, so the shared file stays single-trace; the one gap (bash-spawned descendants mint fresh ids) is closed by the new `AGENCY_TRACE_ID` var in Task 4.

## Global constraints

- No back-compat shims anywhere — this language has no external users; break and migrate.
- Commands never pass through a shell. Tokenize first, substitute `{task}` after.
- The command comes ONLY from the CLI flag, never from suite content (remote suites would otherwise be remote code execution).
- No per-run state in TS module globals.
- Coding standards: types not interfaces, objects not maps, no dynamic imports.
- Run only the tests named in each task; CI runs the full suite. Save test output to a file.

---

### Task 1: Command tokenizer and task substitution

**Files:**
- Create: `lib/eval/run/commandLine.ts`
- Test: `lib/eval/run/commandLine.test.ts`

**Interfaces:**
- Produces: `tokenizeCommand(command: string): string[]` (throws on unbalanced quotes), `substituteTask(tokens: string[], task: string | Record<string, any>): string[]` (throws if no token contains `{task}`), `TASK_PLACEHOLDER = "{task}"`.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/eval/run/commandLine.test.ts
import { describe, expect, it } from "vitest";

import { substituteTask, tokenizeCommand } from "./commandLine.js";

describe("tokenizeCommand", () => {
  it("splits on whitespace and honors single and double quotes", () => {
    expect(tokenizeCommand(`agency agent --policy approve-all -p -- {task}`))
      .toEqual(["agency", "agent", "--policy", "approve-all", "-p", "--", "{task}"]);
    expect(tokenizeCommand(`run "a b" 'c d' e`)).toEqual(["run", "a b", "c d", "e"]);
  });

  it("joins adjacent chunks and keeps empty quoted args", () => {
    expect(tokenizeCommand(`--flag="a b"`)).toEqual([`--flag=a b`]);
    expect(tokenizeCommand(`run ""`)).toEqual(["run", ""]);
    expect(tokenizeCommand(`  padded   spaces  `)).toEqual(["padded", "spaces"]);
  });

  it("does nothing shell-like: no expansion, no operators", () => {
    // $HOME, ;, && are ordinary bytes — there is no shell to interpret them
    expect(tokenizeCommand(`echo $HOME; rm -rf /`)).toEqual(["echo", "$HOME;", "rm", "-rf", "/"]);
  });

  it("throws on an unbalanced quote, naming the command", () => {
    expect(() => tokenizeCommand(`run "unclosed`)).toThrow(/unbalanced quote/);
  });
});

describe("substituteTask", () => {
  it("replaces every occurrence, inside tokens too", () => {
    expect(substituteTask(["-p", "{task}", "--again={task}"], "do it"))
      .toEqual(["-p", "do it", "--again=do it"]);
  });

  it("serializes an object task as JSON", () => {
    expect(substituteTask(["-p", "{task}"], { rows: [1] })).toEqual(["-p", `{"rows":[1]}`]);
  });

  it("throws when no token carries the placeholder — the task must reach the agent", () => {
    expect(() => substituteTask(["agency", "agent"], "t")).toThrow(/\{task\}/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/eval/run/commandLine.test.ts` — FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// lib/eval/run/commandLine.ts
export const TASK_PLACEHOLDER = "{task}";

/** One message, used by both the early check (resolveEvalTarget) and the
 *  invariant guard (substituteTask), so the two cannot drift. */
export const MISSING_TASK_PLACEHOLDER_ERROR =
  `--agent-cmd must contain ${TASK_PLACEHOLDER} — the command never receives the input's task without it`;

// The grammar, in tarsec (the project's parser-combinator library — same
// idioms as lib/parsers/parsers.ts): a command is tokens separated by
// whitespace; a token is one or more adjacent chunks; a chunk is a
// double-quoted span, a single-quoted span, or a bare run. Adjacency
// joins, so `--flag="a b"` is one token `--flag=a b`. NOTHING shell-like —
// no expansion, operators, or escapes; a hostile task is inert by
// construction, since substitution happens after this, per token.
import { between, char, many1, many1WithJoin, manyWithJoin, map, noneOf, oneOf, or, sepBy1, type Parser } from "tarsec";

const whitespace = many1(oneOf(" \t\n\r"));
const doubleQuoted = between(char('"'), char('"'), manyWithJoin(noneOf('"')));
const singleQuoted = between(char("'"), char("'"), manyWithJoin(noneOf("'")));
const bare = many1WithJoin(noneOf(" \t\n\r\"'"));
const token: Parser<string> = map(many1(or(doubleQuoted, singleQuoted, bare)), (chunks) => chunks.join(""));
const commandParser: Parser<string[]> = sepBy1(whitespace, token);

export function tokenizeCommand(command: string): string[] {
  // try/catch as well as the success check: an unclosed quote can make
  // tarsec throw internally (observed: "Invalid array length" from sepBy1)
  // rather than return a failure — both spellings mean the same mistake.
  let result;
  try {
    result = commandParser(command.trim());
  } catch {
    throw new Error(`--agent-cmd has an unbalanced quote: ${command}`);
  }
  if (!result.success || result.rest !== "") {
    throw new Error(`--agent-cmd has an unbalanced quote: ${command}`);
  }
  return result.result;
}

/** Replace every {task} occurrence. Objects serialize as JSON. At least one
 *  occurrence is required — a command that never receives the task is the
 *  silent-drop bug in new clothing. */
export function substituteTask(tokens: string[], task: string | Record<string, any>): string[] {
  const text = typeof task === "string" ? task : JSON.stringify(task);
  if (!tokens.some((t) => t.includes(TASK_PLACEHOLDER))) {
    throw new Error(MISSING_TASK_PLACEHOLDER_ERROR);
  }
  return tokens.map((t) => t.split(TASK_PLACEHOLDER).join(text));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run lib/eval/run/commandLine.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/eval/run/commandLine.ts lib/eval/run/commandLine.test.ts
git commit -m "eval: command tokenizer and {task} substitution (no shell, substitute-after-tokenize)"
```

---

### Task 2: The EvalTarget union

**Files:**
- Modify: `lib/agentTarget.ts`
- Test: `lib/agentTarget.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type EvalTarget =
    | { kind: "file"; agentFile: string; node: string; label: string }
    | { kind: "command"; tokens: string[]; label: string };
  export function resolveEvalTarget(opts: { agent?: string; agentCmd?: string }): EvalTarget;
  ```
  `resolveEvalRunTarget` (file-only) stays for existing callers; `resolveEvalTarget` wraps it. `tokens` are the tokenized command WITH the `{task}` placeholder still in place (substitution is per input, at run time). The `{task}`-presence check runs here so the mistake is caught before any run.

- [ ] **Step 1: Write the failing tests** (append to `lib/agentTarget.test.ts`)

```ts
describe("resolveEvalTarget", () => {
  it("resolves --agent into a file target", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-"));
    dirs.push(tmpDir);
    const file = path.join(tmpDir, "a.agency");
    fs.writeFileSync(file, "node main(task: string) {}\n");
    expect(resolveEvalTarget({ agent: `${file}:main` }))
      .toEqual({ kind: "file", agentFile: file, node: "main", label: `${file}:main` });
  });

  it("resolves --agent-cmd into a command target with the placeholder intact", () => {
    const t = resolveEvalTarget({ agentCmd: `agency agent -p -- {task}` });
    expect(t).toEqual({ kind: "command", tokens: ["agency", "agent", "-p", "--", "{task}"], label: "agency agent -p -- {task}" });
  });

  it("rejects both, neither, and a command without {task}", () => {
    expect(() => resolveEvalTarget({ agent: "a.agency", agentCmd: "x {task}" })).toThrow(/one of/);
    expect(() => resolveEvalTarget({})).toThrow(/one of/);
    expect(() => resolveEvalTarget({ agentCmd: "agency agent -p hello" })).toThrow(/\{task\}/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test:run lib/agentTarget.test.ts`

- [ ] **Step 3: Implement** in `lib/agentTarget.ts`

```ts
import { TASK_PLACEHOLDER, tokenizeCommand } from "@/eval/run/commandLine.js";

export type EvalTarget =
  | { kind: "file"; agentFile: string; node: string; label: string }
  | { kind: "command"; tokens: string[]; label: string };

/** Resolve the runner-side agent choice. Exactly one of --agent /
 *  --agent-cmd; the command's {task} placeholder is validated here, before
 *  any run. Commands come ONLY from these flags, never from suite content —
 *  suites can be remote git sources, and a suite that named its own command
 *  would be remote code execution. */
export function resolveEvalTarget(opts: { agent?: string; agentCmd?: string }): EvalTarget {
  if ((opts.agent ? 1 : 0) + (opts.agentCmd ? 1 : 0) !== 1) {
    throw new Error("Provide exactly one of --agent or --agent-cmd");
  }
  if (opts.agentCmd) {
    const tokens = tokenizeCommand(opts.agentCmd);
    if (!tokens.some((t) => t.includes(TASK_PLACEHOLDER))) {
      throw new Error(MISSING_TASK_PLACEHOLDER_ERROR);
    }
    return { kind: "command", tokens, label: opts.agentCmd };
  }
  const file = resolveEvalRunTarget(opts.agent as string);
  return { kind: "file", ...file };
}
```

- [ ] **Step 4: Run to verify pass, then commit**

```bash
pnpm test:run lib/agentTarget.test.ts lib/eval/run/commandLine.test.ts
git add lib/agentTarget.ts lib/agentTarget.test.ts
git commit -m "eval: EvalTarget union — file or command, resolved from CLI flags only"
```

---

### Task 3: runBundledAgent merges inherited config overrides

**Files:**
- Modify: `lib/cli/runBundledAgent.ts` (the `env[CONFIG_OVERRIDES_ENV]` assignment, lines ~136-141)
- Test: `lib/cli/runBundledAgent.test.ts`

**Interfaces:**
- Consumes: `readConfigOverrides(env)` and `serializeConfigOverrides` from `@/config.js` (both exist).
- Produces: no new exports — behavioral fix. Inherited env var + flag overrides now merge, "env first, flags on top", nested `log`/`trace` objects layered not clobbered (mirror the ordering documented at `lib/runtime/state/context.ts:258-263`).

- [ ] **Step 1: Write the failing tests** (append to `lib/cli/runBundledAgent.test.ts`, following its existing spawn-stub pattern — read the file first)

Two cases, asserting on the `env` the spawn stub receives:
1. Inherited `AGENCY_CONFIG_OVERRIDES` (observability + `log.logFile`) + `--trace foo.trace` in args → the child env's parsed overrides contain BOTH the inherited `log.logFile` AND the trace fields.
2. Inherited var + `--log other.jsonl` → the flag's `logFile` wins (explicit user intent; documented), but inherited `observability` survives.

- [ ] **Step 2: Run to verify failure** — `pnpm test:run lib/cli/runBundledAgent.test.ts`

- [ ] **Step 3: Implement.** Replace the assignment:

```ts
// Merge onto any inherited overrides rather than replacing them ("env
// first, flags on top", the ordering context.ts documents): an eval
// harness hands this process a statelog path via the same env var, and
// a --trace here must not destroy it. An explicit --log still wins the
// logFile key — that is user intent, and the eval harness detects the
// missing statelog and names this cause.
const inherited = readConfigOverrides(env);
const merged = {
  ...inherited,
  ...overrides,
  log: { ...inherited.log, ...overrides.log },
};
if (Object.keys(merged).length > 0) {
  env[CONFIG_OVERRIDES_ENV] = serializeConfigOverrides(merged);
}
```

(Adjust the `log` spread if `overrides` lacks a `log` key — do not introduce `log: {}` where neither side has one; check `Object.keys` before attaching.)

The comment must also carry this invariant: **among the flags this parser produces, only `log` is nested** — `trace`/`traceFile`/`traceDir`/`observability` are all top-level (`runBundledAgent.ts:62-85`), which is why the one-level merge is correct. If `agentConfigOverride` ever learns a flag that writes another nested key (`client`, for instance, is nested in `applyCliFlags`), this merge silently drops the inherited half of it.

- [ ] **Step 4: Run to verify pass, then commit**

```bash
pnpm test:run lib/cli/runBundledAgent.test.ts
git add lib/cli/runBundledAgent.ts lib/cli/runBundledAgent.test.ts
git commit -m "agent CLI: merge inherited AGENCY_CONFIG_OVERRIDES instead of clobbering"
```

---

### Task 4: AGENCY_TRACE_ID — one trace id for the whole process tree

**Files:**
- Modify: `lib/config.ts` (new exported const beside `CONFIG_OVERRIDES_ENV`), `lib/runtime/state/context.ts:271`
- Test: `lib/runtime/state/context.test.ts` (or the file where RuntimeContext construction is already tested — locate with `grep -rln "traceId" lib/runtime/*.test.ts`)

**Interfaces:**
- Produces: `export const TRACE_ID_ENV = "AGENCY_TRACE_ID";` in `lib/config.ts`. Mint order in context.ts becomes: explicit `statelogConfig.traceId` > `process.env[TRACE_ID_ENV]` > `nanoid()`.

- [ ] **Step 1: Write the failing test** — construct a RuntimeContext with no explicit traceId while `process.env.AGENCY_TRACE_ID = "trace-from-env"` (set in the test, restored in `finally`); assert `ctx.statelogConfig.traceId === "trace-from-env"`. Second case: an explicit traceId beats the env var.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** at `context.ts:271`:

```ts
      // Explicit > env > minted. The env var lets a harness (eval command
      // targets) give an entire process tree one trace id, including
      // descendants started without IPC (a bash `agency run ...`), so the
      // shared statelog stays single-trace for the extractor.
      traceId: args.statelogConfig.traceId || process.env[TRACE_ID_ENV] || nanoid(),
```

The env var is **global** — every compiled Agency process reads it, not only
eval command targets. Two consequences, both handled here:

- A stray exported `AGENCY_TRACE_ID` in a developer's shell would merge every
  subsequent run into one trace. Precedence contains the blast radius (an
  explicit `statelogConfig.traceId` — which IPC-forked children get from
  their `RunInstruction` identity — always wins), and the var's doc comment
  in `config.ts` says "set per-run by harnesses; do not export from a shell".
- The eval **fork** runner (file targets) inherits `process.env`, so a
  harness-set or stray var would leak into file-target children too. Delete
  it from the fork runner's child env in `lib/eval/run/subprocess.ts` — the
  exact precedent is `run()` deleting `AGENCY_RUN_POLICY`
  (`lib/cli/commands.ts:288`). Add a test: a file-target child env has no
  `AGENCY_TRACE_ID` even when the parent had one.

Note for reviewers of this task: the isolation test here proves the mint
order; the property the variable exists for — a spawned CLI and its own
bash-launched descendants landing in ONE trace — is proven end-to-end by
Task 10's single-trace-id assertion. Do not trim that assertion later as
redundant; it is this task's real proof.

- [ ] **Step 4: Run to verify pass, then commit**

```bash
pnpm test:run <the context test file> lib/eval/run/subprocess.test.ts
git add lib/config.ts lib/runtime/state/context.ts lib/eval/run/subprocess.ts <test file>
git commit -m "runtime: AGENCY_TRACE_ID env var seeds the trace id (explicit > env > minted)"
```

---

### Task 5: The spawn runner

**Files:**
- Create: `lib/eval/run/spawnRunner.ts`
- Test: `lib/eval/run/spawnRunner.test.ts`
- Modify: `lib/eval/run/subprocess.ts` (export `limitsFromConfig` already; no other change here)

**Interfaces:**
- Consumes: `RunLimits` + `limitsFromConfig` from `subprocess.ts`; `CONFIG_OVERRIDES_ENV`, `TRACE_ID_ENV`, `serializeConfigOverrides` from `@/config.js`.
- Produces:
  ```ts
  export function runCommandInSpawn(args: {
    argv: string[];              // substituted, task already in place
    cwd: string;
    statelogPath: string;
    traceId: string;
    pipeOutput: boolean;
    limits: RunLimits;
  }): Promise<{ ok: true } | { ok: false; errorMessage: string }>;
  ```

Behavior to implement, each with a test:
1. **Spawn shape:** `spawn(argv[0], argv.slice(1), { cwd, env })` — env is `process.env` plus `AGENCY_CONFIG_OVERRIDES` (`{ observability: true, log: { logFile: statelogPath } }`), `AGENCY_TRACE_ID: traceId`, and `NODE_OPTIONS` extended with `--max-old-space-size=<limits.memory in MB>` (append to any existing NODE_OPTIONS). Test with `argv = ["node", "-e", "<script printing env + cwd to a file>"]`. **The memory limit is weaker than the fork runner's and the code comment says so:** `--max-old-space-size` bounds the V8 heap of Node processes only — not native allocations, not non-Node commands. Acceptable exactly because the scope is Agency-CLI (Node) commands; a future non-Agency target must revisit.
2. **stdio:** always `["ignore", "pipe", "pipe"]`. With `pipeOutput` true, pipe child stdout/stderr through to the parent's; either way, DRAIN both and count bytes — an unread pipe blocks a chatty agent forever. When the drained total exceeds `limits.stdout`, keep draining but stop forwarding. **This is a deliberate divergence from the fork runner**, and the code comment must say so: the fork path FAILS the run at this limit (`lib/runtime/ipc.ts:788-799`, `settleWithLimitFailure(s, "stdout", ...)`), which is right for programmatic subprocess use; a benchmark must not score a chatty-but-correct agent zero for verbosity, and `agency agent` is chatty by design. Anyone tempted to "fix" the inconsistency in either direction should find the reasoning at both sites.
3. **Wall clock:** a timer at `limits.wallClock` sends SIGTERM, a second timer (+5s) SIGKILL; the settle message names the limit and adds "if the command waits for input it can never receive, this is the likely cause — one-shot flags and a headless policy are required under eval." Test with `node -e "setTimeout(()=>{}, 60000)"` and a tiny wallClock.
4. **ENOENT:** spawn `error` event with code ENOENT settles `{ ok: false }` naming `argv[0]` verbatim. Test with a nonsense executable.
5. **argv size cap:** before spawning, if the joined argv byte length exceeds 128 * 1024, settle with an error naming the size (the caller adds the input id). Test with a giant substituted task.
6. **SIGINT forwarding:** `process.once("SIGINT", () => child.kill("SIGINT"))`, removed on settle — same shape as the fork runner (`subprocess.ts`), double-signalling at a terminal is benign.
7. **Exit:** code 0 → ok; non-zero/signal → `{ ok: false }` with code, signal, and the last ~2000 chars of drained stderr.

- [ ] **Step 1: Write the failing tests** (behaviors 1-5 and 7; SIGINT listener lifetime via `process.listenerCount` inside a fake — same pattern as `runSuite.test.ts`'s SIGINT test).
- [ ] **Step 2: Run to verify failure** — `pnpm test:run lib/eval/run/spawnRunner.test.ts`
- [ ] **Step 3: Implement** (model the settle/once-guard structure on `runCompiledAgentInSubprocess` in `subprocess.ts` — read it first; it solves the same races).
- [ ] **Step 4: Run to verify pass, then commit**

```bash
git add lib/eval/run/spawnRunner.ts lib/eval/run/spawnRunner.test.ts
git commit -m "eval: spawn runner for command targets (statelog+trace env handoff, drained stdio, wall clock)"
```

---

### Task 6: One runAgent pipeline for both kinds

**Files:**
- Modify: `lib/eval/run/runAgent.ts`, `lib/eval/run/runSuite.ts`, `lib/eval/run/subprocess.ts` (the `EvalInputRunner` type)
- Test: `lib/eval/run/runAgent.test.ts`, `lib/eval/run/runSuite.test.ts`

**Interfaces:**
- `runAgent(target: EvalTarget, task, options, deps)` replaces `runAgent(agentPath, node, task, ...)`. Callers: `runSuite` only (verify with `grep -rn "runAgent(" lib --include="*.ts" | grep -v test`).
- `EvalInputRunner` input becomes a union mirroring the target:
  ```ts
  export type EvalRunnerJob =
    | { kind: "file"; compiledEntryPath: string; node: string; task: string | Record<string, any>; cwd: string; statelogPath: string }
    | { kind: "command"; argv: string[]; cwd: string; statelogPath: string; traceId: string };
  export type EvalInputRunner = (job: EvalRunnerJob) => Promise<{ ok: true; statelogPath?: string } | { ok: false; errorMessage: string }>;
  ```
- `RunSuiteOptions.agent: string | EvalTarget` — **decided, one shape, both tasks use it**: a plain string is file-target convenience (`runSuite` resolves it via `resolveEvalTarget({ agent })`), so every existing caller — the optimizer, all tests — is unchanged; an `EvalTarget` passes through with **no re-validation** (it already passed resolution, including the `{task}`-presence check — resolving twice was the smell the review named). The CLI (Task 8) always passes the resolved `EvalTarget`.

Branch points inside `AgentRunner` (keep ONE finalize path — extraction, salvage, error.txt writing are shared, which is the reason to branch rather than fork the class):

1. **seedWorkdir:** command targets skip the closure walk and compile. Seed = the input's `files` plus `PROJECT_CONFIG_FILES` from the invoking cwd (`process.cwd()`) when those files exist. Returns `null` for compiledPath. Named consequence (comment it): the agent under test sees the *invoking project's* `agency.json`, including any `eval.*` settings in it — harmless today, surprising if it ever matters.
2. **execute:** file → `makeSubprocessRunner` as today. Command → `substituteTask(target.tokens, this.task)` (catch the size error → fail), mint `traceId = nanoid()` per run, call `runCommandInSpawn` with `limitsFromConfig(config)`.
3. **fail message:** when a command target produced no statelog, append the hint: `"if your command passes --log, remove it — the harness sets the statelog path itself; if it is interactive, it must run one-shot (e.g. agency agent -p) with a headless policy"`.
4. **Entry-node check:** `assertEvalEntryNodeTakesOneParameter` applies to file targets only (it moves behind the `kind` branch in `runSuite`).
5. **Skip the suite-level closure walk** (`seedFromAgentFile`) for command targets in `runSuite`.

- [ ] **Step 1: Write the failing tests.** In `runAgent.test.ts`: a command-target run with an injected runner — asserts the runner receives `kind: "command"`, substituted argv (task in place), cwd = workdir, and that the workdir contains the input's files but no compiled agent. A second test: command target + missing statelog → error.txt contains the `--log` hint. A third: a command target whose substituted argv exceeds the size cap → an error **result** (not a throw) whose message names the input id and the size — this is the only place the cap-through-the-pipeline path is asserted. In `runSuite.test.ts`: a resolved command `EvalTarget` end-to-end with a fake runner (mirror the existing task-delivery test); and: file-target tests still pass unchanged (they pin the `kind: "file"` job shape now — update the fake runners' destructuring).
- [ ] **Step 2: Run to verify failure** — `pnpm test:run lib/eval/run/`
- [ ] **Step 3: Implement.** Mechanical per the branch list above. `runSuite`'s provenance for command targets: `buildProvenance` gains a command arm — see Task 7; for this task pass a stub `{ command: target.label }` and let Task 7 finish it.
- [ ] **Step 4: Run the full eval tree** — `pnpm test:run lib/eval lib/cli/eval lib/optimize > /tmp-scratch/task6.log 2>&1` (optimizer call sites compile against the widened `RunSuiteOptions.agent` without change — verify, don't assume).
- [ ] **Step 5: Commit**

```bash
git add lib/eval lib/agentTarget.ts
git commit -m "eval: runAgent/runSuite accept command targets through one pipeline"
```

---

### Task 7: Provenance for command targets

**Files:**
- Modify: `lib/eval/runArtifacts.ts` (`buildProvenance` and the `EvalRunProvenance` type)
- Test: `lib/eval/runArtifacts.test.ts`

**Interfaces:**
- The provenance agent block becomes a union: the existing closure record for file targets, or `{ command: string; harnessVersion: string; cliVersion?: string }` for command targets. `harnessVersion` = this package's version (read `package.json` the way the CLI already does — find precedent with `grep -rn "version" scripts/agency.ts | head`). `cliVersion`: best-effort `execFileSync(argv[0], ["--version"], { timeout: 5000 })` only when `path.basename(argv[0])` is `agency` or the token ends in `agency.js`; swallow failures (provenance must never fail a run).
- The spec names the accepted trade: command runs lose sha-comparability. The type's doc comment carries that sentence.

- [ ] **Step 1: Failing test** — `buildProvenance` with a command target records the command string and harness version; a fake `agency`-named script records its `--version` output.
- [ ] **Step 2-4: Implement, verify, commit** — `pnpm test:run lib/eval/runArtifacts.test.ts lib/eval/run/`

```bash
git commit -am "eval: command-target provenance (command string, harness + CLI versions)"
```

---

### Task 8: CLI flags

**Files:**
- Modify: `scripts/agency.ts` (eval run command), `lib/cli/eval/run.ts`
- Test: `lib/cli/eval/run.test.ts`

**Changes:**
1. `--agent` drops `requiredOption` → plain `.option(...)`; add `.option("--agent-cmd <command>", "Run this command as the agent; {task} is replaced with each input's task. Mutually exclusive with --agent. Agency CLIs only — the command's process must write the statelog the harness points it at.")`.
2. `EvalRunCliOptions` gains `agentCmd?: string`; `evalRun` builds the target via `resolveEvalTarget({ agent: opts.agent, agentCmd: opts.agentCmd })` and passes the resolved `EvalTarget` to `runSuite` (Task 6's decided shape — never the raw string/`{command}` pair, so validation runs exactly once).
3. Flag-compat errors in the eval run action, before anything runs: `--max-tool-call-rounds`, `--max-tool-result-chars`, or `--strict` together with `--agent-cmd` → `"these are compile-time flags and a command target compiles nothing — put the equivalent flags inside the command"`.
4. `eval optimize` needs no change: it has no `--agent-cmd` flag, so commander rejects it as an unknown option — the spec's "errors with that explanation" is satisfied by adding one line to the optimize command's description: `"(file agents only — the optimizer mutates agent files)"`.

- [ ] **Step 1: Failing tests** in `run.test.ts`: `evalRun({ agentCmd: "node x.js {task}", ... })` with an injected runner reaches the command path; `evalRun({})` and both-flags throw the mutual-exclusion error; the compile-time-flag combination throws naming the rule.
- [ ] **Step 2-4: Implement, verify (`pnpm test:run lib/cli/eval/run.test.ts`), verify help renders (`node dist/scripts/agency.js eval run --help` after `pnpm run build`), commit**

```bash
git commit -am "eval run: --agent-cmd flag, mutual exclusion, compile-time-flag rejection"
```

---

### Task 9: `agency run` argument passthrough (and the direct-run task bug it exposes)

Review resolved the open question the first draft deferred: `agency run` has
**no** surface for node arguments (`scripts/agency.ts:220` calls
`run(config, input, undefined, ...)`; `run()` in `lib/cli/commands.ts:264-296`
compiles and spawns without forwarding argv). Decision: add the passthrough
(review's option 1) — command targets need at least one non-LLM Agency CLI
that can receive a task, and it fixes a real bug found while sizing this:

**The bug.** The compiled entry's direct-invocation block passes the initial
state as the FIRST positional argument — `await main(initialState)` (see the
`__process.argv[1] === fileURLToPath(...)` block near the end of any compiled
file, e.g. `foo.js:1865-1872`). Pre-#739 that landed in the zero-param
`{ messages, callbacks }` options slot; under #739's one-parameter convention
it lands in **`task`** — `agency run foo.agency` today hands `main` the state
object as its task. The template predates #739 and nobody ran a one-param
agent directly since.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` (the direct-invocation emit — locate with `grep -n "argv\[1\]" lib/backends/typescriptBuilder.ts` or the template if it lives in `lib/templates/`), `lib/cli/commands.ts` (`run()` gains `nodeArgs: string[]`), `scripts/agency.ts` (`run` command takes trailing args after `--`)
- Test: the integration CLI suite (`tests/integration/cli/test.mjs`) — the direct-run block only executes in a real spawned process

**Behavior:**
- `agency run file.agency -- <text>` forwards everything after `--` to the
  spawned child's argv.
- The emitted direct-run block maps `process.argv.slice(2)` positionally onto
  the node's parameters (the emitter knows the count — it writes
  `__<node>NodeParams`), then passes `initialState` as the options argument:
  `await main(argv[2], initialState)` for one-param nodes,
  `await main(initialState)` for zero-param nodes (unchanged). Absent argv →
  `undefined` → parameter defaults apply, which is the bug fix: the state
  object never again lands in a declared parameter.

- [ ] **Step 1: Failing test** — add to `tests/integration/cli/test.mjs`: an agent `node main(task: string = "fallback"): string { return "got: " + task }`; `npx agency run t.agency -- hello` prints `got: hello`; `npx agency run t.agency` prints `got: fallback` (this second assertion is the bug fix pinned).
- [ ] **Step 2: Implement; verify with `npm pack` + `node tests/integration/cli/test.mjs ./agency-lang-*.tgz`** (the suite's own harness).
- [ ] **Step 3: Commit**

```bash
git commit -am "agency run: forward args after -- to the node; direct-run no longer passes state as the first parameter"
```

---

### Task 10: End-to-end integration test, no LLM

**Files:**
- Modify: `tests/integration/eval-run/test.mjs` (add scenarios alongside the interrupt one — same harness, same CI step)

**Scenario A — the load-bearing one** (pins the whole
`AGENCY_CONFIG_OVERRIDES` + `AGENCY_TRACE_ID` handoff over a real spawned
CLI):

1. Write `writer.agency` (one param, no LLM: writes the task to `out.txt`
   with a self-approving handler — copy the handler shape from
   `evals/terminal-bench-mini/regex-log/solution.agency`).
2. Input: `{ id: "cmd-e2e", goal: "writes the task to out.txt", task: "hello from a command target" }`, `files` seeding `writer.agency` into the workdir (legal for command targets — no agent ingredient to collide with).
3. Run: `node <AGENCY_CLI> eval run --agent-cmd "node <AGENCY_CLI> run writer.agency --policy approve-all -- {task}" ...` — clean now that Task 9 exists.
4. Assert: the run completes; `workdir/out.txt` contains the task text
   (argv delivery through a real CLI); the statelog at the harness path
   contains the spawned agent's own `agentStart`/`enterNode` events with
   **exactly one** `trace_id` (Task 4's real proof — do not trim); and
   `eval-record.json` exists with the agent's output.

**Scenario B — the `--log` clobber, end to end** (the spec's sharp edge 1,
never otherwise exercised whole): re-run with `--log elsewhere.jsonl` inside
the command → the run errors and the message names `--log` as the likely
cause.

**Scenario C — resolution-time failure:** `--agent-cmd` lacking `{task}` →
the CLI errors before any run directory is created.

- [ ] **Step 1: Write the scenarios; run `node tests/integration/eval-run/test.mjs`** (needs `pnpm run build` first) — iterate until green.
- [ ] **Step 2: Commit**

```bash
git commit -am "eval-run integration: command target end-to-end (argv delivery, single trace id, --log clobber)"
```

---

### Task 11: Docs

**Files:**
- Modify: `docs/site/cli/eval.md` (new "Command agents" section after the options list), `evals/terminal-bench-mini/README.md` (the real benchmark invocation)

**Content for eval.md** (write in full, not summarized):
- The flag, the `{task}` contract, tokenize-then-substitute and the no-shell guarantee (hostile task is inert).
- Agency CLIs only, and why (the statelog IS the evidence).
- The command must run headless and one-shot (`agency agent --policy approve-all -p -- {task}`); an interactive command hits the wall clock.
- Do not pass `--log` (clobbers the harness statelog path — the error names this); `--trace` is safe (merged).
- Compile-time flags (`--max-tool-call-rounds` etc.) and budget flags go inside the command.
- Keep credentials in the environment, never in the command — the label is stored verbatim in `summary.json`.
- Limits: wall clock and memory apply (memory via NODE_OPTIONS, Node processes only); stdout is capped; there is no IPC.

**Content for terminal-bench-mini README:** the real invocation —

```bash
agency eval run \
  --agent-cmd 'agency agent --agent code --policy approve-all --max-tool-call-rounds 100 -p -- {task}' \
  --inputs evals/terminal-bench-mini \
  --graders evals/terminal-bench-mini/graders.ts
```

- [ ] **Step 1: Write both, commit**

```bash
git commit -am "docs: command agents under agency eval run"
```

---

### Task 12: Full verification and PR

- [ ] `npx tsc --noEmit && npx tsc -p tsconfig.evals.json` — clean.
- [ ] `pnpm run build` then `pnpm test:run lib/eval lib/optimize lib/cli lib/runtime/ipc.test.ts lib/agentTarget.test.ts > /tmp-scratch/final.log 2>&1` — all pass.
- [ ] `pnpm run lint:structure` — clean.
- [ ] The no-LLM smoke still passes: `pnpm run agency eval run --agent evals/terminal-bench-mini/regex-log/solution.agency:main --inputs evals/terminal-bench-mini --graders evals/terminal-bench-mini/graders.ts` → objective 1.000.
- [ ] `node tests/integration/eval-run/test.mjs` — both scenarios pass.
- [ ] Manual, with cost (owner runs or approves): the real `--agent-cmd 'agency agent ...'` against regex-log.
- [ ] Audit the diff against `docs/dev/anti-patterns.md`.
- [ ] PR: title "eval: command agents (--agent-cmd) — benchmark the agency CLI with its own statelog as the record". Body from the spec's structure: the rejected-wrapper story, the handoff mechanism + experiment, the sharp-edge fixes (runBundledAgent merge, AGENCY_TRACE_ID), what does not carry over, testing. Write body to a file first (apostrophes).

## Self-review notes (already applied)

- The first draft left "how does `agency run` forward node args" to the implementer; review answered it (it doesn't) and the answer reshaped the work — Task 9 now adds the passthrough and fixes the direct-run bug it exposed (`main(initialState)` landing in a one-parameter node's task).
- Task 6 keeps one pipeline/finalize path rather than a parallel CommandRunner class — that is the no-parallel-mechanisms rule applied to our own feature.
- The `AGENCY_TRACE_ID` mint-order change (Task 4) touches the runtime proper; it is deliberately its own task with its own test so it can be reviewed in isolation.
