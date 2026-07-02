# Subprocess Pause/Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. (This project's owner has said NOT to use subagent-driven development — work inline in the main session.) Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unhandled subprocess interrupts surface to the user and the subprocess resumes from a checkpoint, with correct distributed handler-chain vote combining and (final increment) nested subprocesses unblocked behind a depth cap.

**Architecture:** The parent stops issuing verdicts and instead reports its handler-chain *outcome*; the child merges outcomes and decides. A "propagate" verdict makes the child take its existing normal-mode interrupt path — checkpoint itself, send a new `interrupted` terminal IPC message, and exit. The parent's `_run` becomes a `runBatch` adopter that stores the child checkpoint as an opaque frame-local payload and re-forks with a `resume` instruction on replay. `CompiledProgram` carries the compiled JS text so parent checkpoints are fully self-contained.

**Tech Stack:** TypeScript (Node), `child_process.fork` IPC, existing Agency runtime (`runBatch`, `interruptWithHandlers`, `respondToInterrupts`), vitest unit tests, Agency execution tests (`tests/agency/`), agency-js tests (`tests/agency-js/`).

**Spec:** `docs/superpowers/specs/2026-07-01-subprocess-pause-resume-design.md` — read it first. All file paths below are relative to `packages/agency-lang/`.

## Global Constraints

- **Agency syntax in test files**: `def`/`node` with `{}`, `if (cond) { }`, `let`/`const` declarations, `for (x in xs) { }`. Verify against `docs/site/guide/basic-syntax.md` if unsure. Run `pnpm run ast <file>` to confirm a test file parses.
- **Run `make` after changing any `stdlib/*.agency` file** (never just `pnpm run build`).
- **Save all test output to a log file** (e.g. `> /tmp/subprocess-plan/task1.log 2>&1`); never rerun a slow test just to re-read its failure. `mkdir -p /tmp/subprocess-plan` once.
- Test commands: unit = `pnpm vitest run <file>`; agency execution test = `pnpm run agency test <file>`; agency-js test = `pnpm run agency test js <dir>`. Do NOT run the full agency test suite locally — CI does that.
- **No dynamic imports** (the bootstrap's compiled-script import is the one lint-annotated exception).
- Use objects not Maps, arrays not Sets, `type` not `interface`. Never amend or force-push. Commit messages must not contain apostrophes when passed with `-m` (use a `-F` file if you need one).
- Spec invariants that every task must preserve: the parent always replies to a child interrupt explicitly (never silence); child interrupt IDs are preserved verbatim end-to-end; the child checkpoint is opaque data in the parent (never spliced into `State.toJSON` composition); handlers re-register during replay before any interrupt site resolves; `runBatch` `invoke` returns `Interrupt[]`, never throws it.
- Handlers are safety infrastructure (see CLAUDE.md). Any risk of a skipped handler is a critical bug — stop and flag it.

## File Structure

| File | Role in this plan |
|---|---|
| `lib/runtime/interrupts.ts` | Export `HandlerChainOutcome`; add `mergeChainOutcomes` + `gatherChainOutcome`; rewrite the IPC branch of `interruptWithHandlers` to merge-and-decide |
| `lib/runtime/ipc.ts` | Protocol types; `sendInterruptToParent` returns outcome; `handleInterruptMessage` reports outcome; `_run` → runBatch adopter; `runSubprocessSession` extraction; materialize/cleanup; depth cap (Task 10) |
| `lib/runtime/subprocess-bootstrap.ts` | `interrupted` terminal message; `resume` instruction handling; subprocess run-info seeding |
| `lib/stdlib/agency.ts` | `_compile`/`_compileFile` return `{ moduleId, code }`; `_subprocessDepth` helper (Task 10) |
| `stdlib/agency.agency` | `std::run` effect payload gains `depth` (Task 10) |
| `lib/runtime/state/context.ts` | `subprocessDepth` field on `RuntimeContext` (Task 10) |
| `lib/runtime/ipc.test.ts`, `lib/runtime/interrupts.test.ts` | Unit tests |
| `tests/agency/subprocess/*`, `tests/agency-js/subprocess-*` | Execution tests |
| `docs/dev/subprocess-ipc.md` | Rewritten sections (Task 9) |

Increment order (from the spec): vote combining → self-contained CompiledProgram → child pause → parent surface → resume → concurrency/durability tests → statelog → limits/docs → nesting last.

---

### Task 0: Branch setup

- [ ] **Step 1: Create the working branch and log dir**

```bash
cd packages/agency-lang
git checkout -b subprocess-pause-resume
mkdir -p /tmp/subprocess-plan
```

---

### Task 1: Outcome-shaped decision protocol + child-side vote combining

Fixes the two vote bugs (child-approve + parent-silent → wrongly rejected; all-silent → wrongly rejected *as a distinct outcome*) while keeping the propagate case temporarily mapped to reject (replaced in Task 3).

**Files:**
- Modify: `lib/runtime/interrupts.ts` (export `HandlerChainOutcome` at ~line 155; IPC branch at ~lines 270-293; add `mergeChainOutcomes`, `gatherChainOutcome`)
- Modify: `lib/runtime/ipc.ts` (`IpcDecisionMessage` ~line 175, `SubprocessVotes` deletion ~line 149, `sendInterruptToParent` ~line 260, `handleInterruptMessage` ~line 541)
- Test: `lib/runtime/interrupts.test.ts`, `lib/runtime/ipc.test.ts`
- Test: `tests/agency/subprocess/vote-child-approve-parent-silent.agency` + `.test.json`

**Interfaces:**
- Consumes: existing `runHandlerChain` (private), `isIpcMode()`, `sendInterruptToParent`.
- Produces (later tasks rely on these exact shapes):

```typescript
// interrupts.ts — the existing private type, now EXPORTED verbatim:
export type HandlerChainOutcome =
  | { kind: "rejected"; value: any }
  | { kind: "approved"; value: any }
  | { kind: "propagated" }
  | { kind: "noResponse" };

export function mergeChainOutcomes(
  inner: HandlerChainOutcome,   // closer to the interrupt (child side)
  outer: HandlerChainOutcome,   // farther from it (parent side)
): HandlerChainOutcome;

// Runs the LOCAL chain; if this process is itself a subprocess, recurses
// to its parent and merges. Used by the parent side of the IPC bridge —
// and it is what makes nesting compose in Task 10 with no further change.
// `interruptId` is the CHILD's interrupt-level id when relaying (so parent
// statelog events correlate end-to-end); minted fresh only when absent.
export function gatherChainOutcome(
  interruptObj: { effect: string; message: string; data: any; origin: string },
  ctx: RuntimeContext<any>,
  stack?: StateStack,
  interruptId?: string,
): Promise<HandlerChainOutcome>;

// Renders the merged outcome into the verdict shape interruptWithHandlers
// returns, emitting the interruptResolved/interruptThrown statelog event.
// Shared by the IPC branch; the non-IPC tail may adopt it too if trivial.
function renderVerdict(
  merged: HandlerChainOutcome,
  ctx: RuntimeContext<any>,
  interruptId: string,
  interruptObj: { effect: string; message: string; data: any; origin: string },
  resolvedBy: "ipc" | "handler",
): Interrupt[] | Approved | Rejected;

// ipc.ts — decision message replaces {approved, value} with the outcome:
export type IpcDecisionMessage = {
  type: "decision";
  interruptId: string;
  outcome: HandlerChainOutcome;
};
// SubprocessVotes and the votes param of sendInterruptToParent are DELETED.
// The message id IS the child's interrupt-level id — preserved verbatim
// (today's code mints a separate message-level nanoid; that goes away).
export async function sendInterruptToParent(
  interruptData: { effect: string; message: string; data: any; origin: string },
  interruptId: string,
): Promise<HandlerChainOutcome>;
```

- [ ] **Step 1: Write failing unit tests for `mergeChainOutcomes`**

Add to `lib/runtime/interrupts.test.ts`:

```typescript
import { mergeChainOutcomes } from "./interrupts.js";

describe("mergeChainOutcomes", () => {
  const approvedA = { kind: "approved", value: "a" } as const;
  const approvedB = { kind: "approved", value: "b" } as const;
  const approvedNoValue = { kind: "approved", value: undefined } as const;
  const rejected = { kind: "rejected", value: "no" } as const;
  const propagated = { kind: "propagated" } as const;
  const silent = { kind: "noResponse" } as const;

  it("outer reject wins over inner approve", () => {
    expect(mergeChainOutcomes(approvedA, rejected)).toEqual(rejected);
  });
  it("any propagate beats approve", () => {
    expect(mergeChainOutcomes(propagated, approvedA)).toEqual(propagated);
    expect(mergeChainOutcomes(approvedA, propagated)).toEqual(propagated);
  });
  it("inner approve + outer silence = approve (the regression fix)", () => {
    expect(mergeChainOutcomes(approvedA, silent)).toEqual(approvedA);
  });
  it("outer approved value wins; falls back to inner value", () => {
    expect(mergeChainOutcomes(approvedA, approvedB)).toEqual(approvedB);
    expect(mergeChainOutcomes(approvedA, approvedNoValue))
      .toEqual({ kind: "approved", value: "a" });
  });
  it("total silence = propagate... reported as noResponse for the caller to map", () => {
    expect(mergeChainOutcomes(silent, silent)).toEqual(silent);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run lib/runtime/interrupts.test.ts > /tmp/subprocess-plan/task1-red.log 2>&1; tail -20 /tmp/subprocess-plan/task1-red.log
```
Expected: FAIL — `mergeChainOutcomes` is not exported.

- [ ] **Step 3: Implement in `lib/runtime/interrupts.ts`**

Export the existing `HandlerChainOutcome` type (add `export` keyword at its definition, ~line 155). Add below `runHandlerChain`:

```typescript
/** Merge two chain-segment outcomes with single-process precedence:
 * reject > propagate > approve > noResponse. `inner` is the segment closer
 * to the interrupt (e.g. the child process), `outer` the segment farther
 * from it (e.g. the parent). On double-approve the OUTER value wins,
 * falling back to the inner value — matching how a single-process chain
 * overwrites approvedValue as it walks outward. */
export function mergeChainOutcomes(
  inner: HandlerChainOutcome,
  outer: HandlerChainOutcome,
): HandlerChainOutcome {
  if (inner.kind === "rejected") return inner;
  if (outer.kind === "rejected") return outer;
  if (inner.kind === "propagated" || outer.kind === "propagated") {
    return { kind: "propagated" };
  }
  if (outer.kind === "approved") {
    const innerValue = inner.kind === "approved" ? inner.value : undefined;
    return { kind: "approved", value: outer.value ?? innerValue };
  }
  if (inner.kind === "approved") return inner;
  return { kind: "noResponse" };
}

/** The distributed handler chain, evaluated from this process outward:
 * run the local chain; local reject is final (fail-fast, matching the
 * single-process short-circuit); otherwise, if this process is itself a
 * subprocess, consult the parent and merge. Nested subprocesses recurse
 * through this same function on each hop.
 *
 * `interruptId`: when relaying a child's interrupt, pass the CHILD's id so
 * this process's handlerDecision/interruptResolved statelog events
 * correlate with the originating interrupt (ids are preserved verbatim
 * end-to-end). Minted fresh only for direct local dispatches. */
export async function gatherChainOutcome(
  interruptObj: { effect: string; message: string; data: any; origin: string },
  ctx: RuntimeContext<any>,
  stack?: StateStack,
  interruptId: string = nanoid(),
): Promise<HandlerChainOutcome> {
  const local = await runHandlerChain(ctx, stack, interruptId, interruptObj);
  if (local.kind === "rejected") return local;
  if (isIpcMode()) {
    const parentOutcome = await sendInterruptToParent(interruptObj, interruptId);
    return mergeChainOutcomes(local, parentOutcome);
  }
  return local;
}
```

- [ ] **Step 4: Rewrite the IPC branch of `interruptWithHandlers`**

Replace the current block at ~lines 270-293 (`if (isIpcMode()) { ... }`) with:

```typescript
  // IPC mode: consult the parent segment of the distributed chain (unless a
  // local handler rejected — that already returned above), merge outcomes,
  // and render the verdict LOCALLY. The parent reports; the child decides.
  // The child's interruptId travels with the message so both processes'
  // statelog events correlate to the same interrupt.
  if (isIpcMode()) {
    const parentOutcome = await sendInterruptToParent({ effect, message, data, origin }, interruptId);
    let local: HandlerChainOutcome;
    if (hasPropagation) {
      local = { kind: "propagated" };
    } else if (hasApproval) {
      local = { kind: "approved", value: approvedValue };
    } else {
      local = { kind: "noResponse" };
    }
    const merged = mergeChainOutcomes(local, parentOutcome);
    // TEMPORARY (removed in Task 3): renderVerdict maps propagated/noResponse
    // to the interrupt-array return; until the pause path exists, convert
    // that case to a reject here.
    const verdict = renderVerdict(merged, ctx, interruptId, interruptObj, "ipc");
    if (hasInterrupts(verdict)) {
      return { type: "reject", value: "Interrupt propagated to user (subprocess slow-path not yet supported)" };
    }
    return verdict;
  }
```

Extract `renderVerdict` as a private helper above `interruptWithHandlers`, moving the statelog-dispatch + return-shape logic there (approved → `interruptResolved` + `{type:"approve"}`; rejected → `interruptResolved` + `{type:"reject"}`; propagated/noResponse → `interruptThrown` + `[interrupt({...})]`). Then rewrite the existing non-IPC tail (lines ~295-324) to call the same helper with `resolvedBy: "handler"` — one verdict-rendering path for both modes, no duplicated statelog dispatch.

- [ ] **Step 5: Update `lib/runtime/ipc.ts` — protocol + both endpoints**

Delete `SubprocessVotes` (~line 149) and the `subprocessVotes` field from `IpcInterruptMessage`. Change `IpcDecisionMessage` to the new shape (Interfaces block above). Change `sendInterruptToParent` — drop the `votes` param, take the child's interrupt id (no more separate message-level nanoid), return the outcome:

```typescript
export async function sendInterruptToParent(
  interruptData: { effect: string; message: string; data: any; origin: string },
  interruptId: string,
): Promise<HandlerChainOutcome> {
  // ... unchanged guard + size checks; outMsg drops subprocessVotes and
  // uses `interruptId` (the caller's) instead of nanoid(); the
  // serialize-failure and payload-limit early returns become:
  //   return { kind: "rejected", value };
  return new Promise((resolve) => {
    const handler = (msg: any) => {
      if (msg.type === "decision" && msg.interruptId === interruptId) {
        process.removeListener("message", handler);
        ipcLog("recv", msg);
        resolve(msg.outcome as HandlerChainOutcome);
      }
    };
    process.on("message", handler);
    process.send!(outMsg);
  });
}
```

Replace `handleInterruptMessage` so the parent reports its chain outcome instead of a verdict, relaying the child's interrupt id into its own chain walk:

```typescript
async function handleInterruptMessage(s: RunSession, msg: any): Promise<void> {
  const { effect, message, data, origin } = msg.interrupt;
  try {
    const outcome = await gatherChainOutcome(
      { effect, message, data, origin },
      s.ctx,
      s.stateStack,
      msg.interruptId,
    );
    trySendDecision(s, { type: "decision", interruptId: msg.interruptId, outcome });
  } catch (err) {
    trySendDecision(s, {
      type: "decision",
      interruptId: msg.interruptId,
      outcome: {
        kind: "rejected",
        value: `Parent handler error: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }
}
```

Update imports (`gatherChainOutcome` instead of `interruptWithHandlers`/`isApproved`/`hasInterrupts` if now unused) and `ipcLog`'s decision detail line: `detail = \`outcome=${msg.outcome?.kind}\``.

- [ ] **Step 6: Run unit tests + typecheck**

```bash
pnpm vitest run lib/runtime/interrupts.test.ts lib/runtime/ipc.test.ts > /tmp/subprocess-plan/task1-green.log 2>&1; tail -20 /tmp/subprocess-plan/task1-green.log
npx tsc --noEmit >> /tmp/subprocess-plan/task1-green.log 2>&1; tail -5 /tmp/subprocess-plan/task1-green.log
```
Expected: PASS (fix any pre-existing ipc.test.ts assertions that used `approved: boolean` — update them to the outcome shape; that is part of this task).

- [ ] **Step 7: Add the regression execution test**

Create `tests/agency/subprocess/vote-child-approve-parent-silent.agency`:

```agency
import { compile, run } from "std::agency"

// Child handler approves bash locally; the parent has NO bash handler.
// Distributed-chain semantics: approve + noResponse = approve.
// (Pre-fix behavior: the parent silence overrode the child approval.)
node main() {
  const source = """
import { bash } from "std::shell"
node main() {
  handle {
    let r = bash("echo child-approved")
    return r.stdout
  } with (e) {
    return approve()
  }
}
"""
  const compileResult = compile(source)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(compiled: compileResult.value, node: "main")
    if (isSuccess(result)) {
      return result.value.data
    }
    return "run failed"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

Create `tests/agency/subprocess/vote-child-approve-parent-silent.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Child-local approve with a silent parent chain is an approve, not a reject",
      "input": "",
      "expectedOutput": "\"child-approved\\n\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

Note the parent handler approves only `std::run` and returns nothing for `std::bash` — that is the "silent parent" (a handler returning nothing is a non-response).

- [ ] **Step 8: Run the new test and the existing subprocess tests that exercise the round-trip**

```bash
pnpm run ast tests/agency/subprocess/vote-child-approve-parent-silent.agency > /tmp/subprocess-plan/task1-ast.log 2>&1
pnpm run agency test tests/agency/subprocess/vote-child-approve-parent-silent.agency > /tmp/subprocess-plan/task1-exec.log 2>&1
pnpm run agency test tests/agency/subprocess/handler-approve.agency >> /tmp/subprocess-plan/task1-exec.log 2>&1
pnpm run agency test tests/agency/subprocess/handler-reject.agency >> /tmp/subprocess-plan/task1-exec.log 2>&1
pnpm run agency test tests/agency/subprocess/run-multiple-interrupts.agency >> /tmp/subprocess-plan/task1-exec.log 2>&1
tail -40 /tmp/subprocess-plan/task1-exec.log
```
Expected: all PASS. (`handler-reject` still passes: parent chain outcome `rejected` merges to reject.)

Vote-matrix coverage map (for the PR description; do not duplicate tests): child-approve+parent-silent → this task's new test; parent-reject → existing `handler-reject`; child-reject-fail-fast → existing `handler-reject` sibling behavior (verify the fixture covers a child-local reject; if not, extend it here); child-propagate and all-silent cells → Task 6's surface tests once the pause path exists.

- [ ] **Step 9: Commit**

```bash
git add lib/runtime/interrupts.ts lib/runtime/ipc.ts lib/runtime/interrupts.test.ts lib/runtime/ipc.test.ts tests/agency/subprocess/vote-child-approve-parent-silent.*
git commit -m "feat: outcome-shaped IPC decisions with child-side vote combining"
```

---

### Task 2: `CompiledProgram` carries the compiled code

**Files:**
- Modify: `lib/stdlib/agency.ts` (`_compile` ~line 103, `_compileFile` ~line 160 — stop writing to disk, return `{ moduleId, code }`)
- Modify: `lib/runtime/ipc.ts` (`_run` signature; materialize-at-fork helper)
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache` ONLY IF the `_run` param descriptors name `path` (check; param count is unchanged)
- Test: `lib/stdlib/agency.test.ts` (or wherever `_compile` is unit-tested — `grep -rn "_compile" lib/stdlib/*.test.ts`)

**Interfaces:**
- Produces: `_compile(source): { moduleId: string; code: string }` (same for `_compileFile`); `materializeCompiledScript(compiled: { moduleId: string; code: string }): string` in `ipc.ts` returning the absolute script path under `.agency-tmp/<nanoid>/`.
- Consumers: `_run` (this task), the resume path (Task 5), durability (Task 7). The user-facing `CompiledProgram` type in `stdlib/agency.agency` stays `{ moduleId: string }` — `code` is carried at runtime just as `path` invisibly was.

- [ ] **Step 1: Write the failing unit test**

```typescript
// in the file that tests _compile (create lib/stdlib/agency.compile.test.ts if none)
import { _compile } from "./agency.js";
import { readdirSync, existsSync } from "fs";
import { join } from "path";

it("_compile returns code text and writes nothing to disk", () => {
  const tmpRoot = join(process.cwd(), ".agency-tmp");
  const before = existsSync(tmpRoot) ? readdirSync(tmpRoot) : [];
  const result = _compile("node main() { return 42 }");
  const after = existsSync(tmpRoot) ? readdirSync(tmpRoot) : [];
  expect(typeof result.moduleId).toBe("string");
  expect(result.code).toContain("main");          // transpiled JS text
  expect((result as any).path).toBeUndefined();   // no file reference
  expect(after).toEqual(before);                  // no temp-dir writes at compile time
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run lib/stdlib/agency.compile.test.ts > /tmp/subprocess-plan/task2-red.log 2>&1; tail -10 /tmp/subprocess-plan/task2-red.log
```
Expected: FAIL — result has `path`, not `code`.

- [ ] **Step 3: Implement**

In `lib/stdlib/agency.ts`, `_compile` currently ends with (approximately — lines 93-103):

```typescript
  const tempDir = join(process.cwd(), ".agency-tmp", nanoid());
  mkdirSync(tempDir, { recursive: true });
  const tempPath = join(tempDir, `${moduleId}.js`);
  writeFileSync(tempPath, result.code, "utf-8");
  return { moduleId, path: tempPath };
```

Replace with:

```typescript
  // The compiled JS travels IN the CompiledProgram value so that any
  // checkpoint containing it is fully self-contained — the code is
  // generated at runtime and cannot be assumed present on disk at resume
  // time. _run materializes it to .agency-tmp/ at fork time.
  return { moduleId, code: result.code };
```

Apply the same to `_compileFile`. In `lib/runtime/ipc.ts`, change `_run`'s first param type to `{ moduleId: string; code: string }` and add:

```typescript
import { writeFileSync, mkdirSync } from "fs";

/** Write the compiled JS to a fresh .agency-tmp/<nanoid>/ dir (under cwd so
 * Node resolves agency-lang/runtime against the project node_modules) and
 * return the script path. Called at every fork — initial run and resume —
 * and paired with cleanupTempDir on settle. */
export function materializeCompiledScript(compiled: { moduleId: string; code: string }): string {
  const tempDir = path.join(process.cwd(), ".agency-tmp", nanoid());
  mkdirSync(tempDir, { recursive: true });
  const scriptPath = path.join(tempDir, `${compiled.moduleId}.js`);
  writeFileSync(scriptPath, compiled.code, "utf-8");
  return scriptPath;
}
```

Inside `_run`, replace `compiledPath: compiled.path` with a call to `materializeCompiledScript(compiled)` (stored in a local, passed as `compiledPath`). Check `imports.mustache`'s `_run` param descriptors (`grep -n "_run" lib/templates/backends/typescriptGenerator/imports.mustache`) — the `compiled` param is a single object either way; update its description only if it names `path`.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run lib/stdlib/agency.compile.test.ts lib/runtime/ipc.test.ts > /tmp/subprocess-plan/task2-green.log 2>&1
pnpm run agency test tests/agency/subprocess/run-basic.agency >> /tmp/subprocess-plan/task2-green.log 2>&1
pnpm run agency test tests/agency/subprocess/run-file.agency >> /tmp/subprocess-plan/task2-green.log 2>&1
pnpm run agency test tests/agency/subprocess/compile-only.agency >> /tmp/subprocess-plan/task2-green.log 2>&1
tail -40 /tmp/subprocess-plan/task2-green.log
```
Expected: PASS. If `compile-only`'s expected output asserted on a `path` field, update the fixture — that is a deliberate behavior change.

- [ ] **Step 5: Rebuild and commit**

```bash
make > /tmp/subprocess-plan/task2-make.log 2>&1; tail -5 /tmp/subprocess-plan/task2-make.log
git add -A lib/stdlib lib/runtime lib/templates tests/agency/subprocess
git commit -m "feat: CompiledProgram carries compiled code text for self-contained checkpoints"
```

---

### Task 3: Child pause path — `interrupted` terminal message

**Files:**
- Modify: `lib/runtime/interrupts.ts` (remove the Task 1 temporary reject)
- Modify: `lib/runtime/ipc.ts` (add `IpcInterruptedMessage`, `SerializedInterrupt` types)
- Modify: `lib/runtime/subprocess-bootstrap.ts` (detect interrupt result; send `interrupted`)
- Test: `lib/runtime/ipc.test.ts` (message shape), full flow tested in Tasks 4-5

**Interfaces:**
- Produces:

```typescript
// ipc.ts
export type SerializedInterrupt = {
  type: "interrupt";
  interruptId: string;
  runId: string;
  effect: string;
  message: string;
  data: any;
  origin: string;
  // checkpoint / checkpointId deliberately stripped — the batch checkpoint
  // travels once, at the message level.
};
export type IpcInterruptedMessage = {
  type: "interrupted";
  interrupts: SerializedInterrupt[];
  checkpoint: any;                 // interrupts[0].checkpoint, JSON tree
  subprocessSessionId: string;
};
// SubprocessToParent union gains IpcInterruptedMessage.
export function serializeInterruptsForIpc(interrupts: Interrupt[]): IpcInterruptedMessage; // sessionId param added Task 8
```

- [ ] **Step 1: Write the failing unit test**

```typescript
// lib/runtime/ipc.test.ts
import { serializeInterruptsForIpc } from "./ipc.js";

it("serializeInterruptsForIpc strips per-interrupt checkpoints and hoists the shared one", () => {
  const cp = { id: 1, nodeId: "main", stack: [] };
  const interrupts = [
    { type: "interrupt", interruptId: "i1", runId: "r", effect: "std::bash", message: "m", data: {}, origin: "o", checkpoint: cp, checkpointId: 1 },
    { type: "interrupt", interruptId: "i2", runId: "r", effect: "std::bash", message: "m", data: {}, origin: "o", checkpoint: cp, checkpointId: 1 },
  ] as any[];
  const msg = serializeInterruptsForIpc(interrupts as any);
  expect(msg.type).toBe("interrupted");
  expect(msg.checkpoint).toBe(cp);
  expect(msg.interrupts.map((i) => i.interruptId)).toEqual(["i1", "i2"]);
  expect(msg.interrupts[0].runId).toBe("r");
  expect((msg.interrupts[0] as any).checkpoint).toBeUndefined();
  expect((msg.interrupts[0] as any).checkpointId).toBeUndefined();
  // The message must survive the JSON round-trip process.send performs —
  // a class instance anywhere in the tree would silently degrade here.
  expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm vitest run lib/runtime/ipc.test.ts > /tmp/subprocess-plan/task3-red.log 2>&1; tail -10 /tmp/subprocess-plan/task3-red.log
```
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the types + serializer in `ipc.ts`**

```typescript
export function serializeInterruptsForIpc(interrupts: Interrupt[]): IpcInterruptedMessage {
  const checkpoint = (interrupts[0] as any).checkpoint;
  const serialized = interrupts.map((intr) => {
    const { checkpoint: _cp, checkpointId: _cpId, ...rest } = intr as any;
    return rest as SerializedInterrupt;
  });
  return {
    type: "interrupted",
    interrupts: serialized,
    checkpoint,
    subprocessSessionId: "",  // wired in Task 8
  };
}
```

Add `IpcInterruptedMessage` to the `SubprocessToParent` union and give `ipcLog` a case: `else if (type === "interrupted") detail = \`count=${msg.interrupts?.length}\`;`.

- [ ] **Step 4: Remove the Task 1 temporary reject in `interrupts.ts`**

In the IPC branch, replace the temporary block with the normal-mode propagate path (identical to the non-IPC tail):

```typescript
    // merged is propagated/noResponse → the child pauses itself: return the
    // interrupt through the NORMAL propagate path so the existing batching +
    // checkpoint machinery runs; the bootstrap converts the final
    // Interrupt[] into an `interrupted` IPC message.
    const intr = interrupt({ effect, message, data, origin, runId: ctx.getRunId(), interruptId });
    ctx.statelogClient.interruptThrown({ interruptId: intr.interruptId, interruptData: data });
    return [intr];
```

- [ ] **Step 5: Bootstrap — send `interrupted` when the node result is an interrupt batch**

In `lib/runtime/subprocess-bootstrap.ts`, import `hasInterrupts` from `./interrupts.js` and `serializeInterruptsForIpc` from `./ipc.js`. After `const result = await nodeFn(...positionalArgs);` (~line 130), before the `sendResultOrLimitError` call:

```typescript
    if (hasInterrupts(result.data)) {
      // Unresolved interrupts: the child checkpointed itself. Ship the
      // batch + shared checkpoint to the parent and exit; the parent
      // surfaces them to the user and re-forks us on resume.
      await sendResultOrLimitError(serializeInterruptsForIpc(result.data) as any);
      process.exit(0);
    }
```

Widen `sendResultOrLimitError`/`sendOrDie` param types to `IpcResultMessage | IpcErrorMessage | IpcInterruptedMessage` (the size-check logic is shared — the `interrupted` message thereby inherits the `ipcPayload` limit, which is a spec requirement).

- [ ] **Step 6: Run tests + typecheck, commit**

```bash
pnpm vitest run lib/runtime/ipc.test.ts lib/runtime/interrupts.test.ts > /tmp/subprocess-plan/task3-green.log 2>&1
npx tsc --noEmit >> /tmp/subprocess-plan/task3-green.log 2>&1; tail -10 /tmp/subprocess-plan/task3-green.log
git add lib/runtime/ipc.ts lib/runtime/interrupts.ts lib/runtime/subprocess-bootstrap.ts lib/runtime/ipc.test.ts
git commit -m "feat: child pause path sends interrupted terminal message with checkpoint"
```

Note: end-to-end behavior is NOT yet correct after this task alone — the parent treats `interrupted` as an unknown message. Task 4 completes the parent side; do not run subprocess execution tests expecting green between Tasks 3 and 4.

---

### Task 4: Parent `_run` becomes a runBatch adopter and surfaces child interrupts

**Files:**
- Modify: `lib/runtime/ipc.ts` (restructure `_run`; extract `runSubprocessSession`; handle `interrupted`; opaque payload)
- Test: `lib/runtime/ipc.test.ts`
- Test: `tests/agency-js/subprocess-pause-basic/` (new)

**Interfaces:**
- Consumes: `runBatch` (`lib/runtime/runBatch.ts` — `RunBatchOpts`, `BatchChild.invoke: (childStack, abortSignal) => Promise<T | Interrupt[]>`, result union `{kind:"values"|"interrupts"}`); `getRuntimeContext()` from `./asyncContext.js`; `materializeCompiledScript` (Task 2); `IpcInterruptedMessage` (Task 3).
- Produces:

```typescript
// ipc.ts
export type SubprocessResumePayload = {
  childCheckpoint: any;
  interrupts: SerializedInterrupt[];   // order preserved; ids are the resume keys
  node: string;
  subprocessSessionId: string;
};

// The payload lives in a frame local under a private constant key
// ("__subprocess_state_0", NOT exported). A constant is collision-safe:
// run() is an Agency function, so every concurrent call has its own frame
// on its own branch stack — verified in Step 1 and proven E2E by the
// two-subprocesses test in Task 6. Callers go through accessors only
// (frame internals stay encapsulated, per docs/dev/anti-patterns.md):
function saveSubprocessPayload(frame: State, payload: SubprocessResumePayload): void;
function loadSubprocessPayload(frame: State): SubprocessResumePayload | undefined;
function clearSubprocessPayload(frame: State): void;

// Picks run-vs-resume declaratively from the presence of a saved payload:
function resolveInstruction(args: {
  ctx: any;
  saved: SubprocessResumePayload | undefined;
  scriptPath: string;
  node: string;
  nodeArgs: Record<string, any>;
  limits: RunLimits;
  configOverrides?: Partial<AgencyConfig>;
}): RunInstruction | ResumeInstruction;

type SessionOutcome =
  | { type: "result"; value: any }
  | { type: "interrupted"; msg: IpcInterruptedMessage };
// runSubprocessSession: forks, attaches all existing handlers (limits,
// stdout forwarding, locks, interrupt bridge), resolves with SessionOutcome,
// rejects on subprocess error. Owns everything the old _run promise owned.
```

- [ ] **Step 1: Read `lib/runtime/runBatch.ts` fully** (the options JSDoc above line 200 and the body) and `lib/runtime/runner.ts`'s `runForkAll` adapter as the reference pattern. Confirm: (a) how `setInterruptOnBranch` treats an invoke returning multiple interrupts, (b) that a branch with `interruptId` set but `checkpoint` undefined re-invokes cleanly on resume, (c) the exact `checkpointLocation` fields the fork adapter passes, (d) that two concurrent `run()` calls in fork branches get DISTINCT frames from `getRuntimeContext().stack.lastFrame()` (run() is an Agency function with its own frame per call — this is what makes the constant payload key collision-safe; if it does not hold, switch the payload to the runBatch child branch's state before proceeding). Record findings as comments in the ipc.ts code you write in Step 4.

- [ ] **Step 2: Write the failing agency-js test**

Create `tests/agency-js/subprocess-pause-basic/agent.agency`:

```agency
import { compile, run } from "std::agency"

node main() {
  const source = """
import { bash } from "std::shell"
node main() {
  let r = bash("echo resumed-ok")
  return r.stdout
}
"""
  const compileResult = compile(source)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(compiled: compileResult.value, node: "main")
    if (isSuccess(result)) {
      return result.value.data
    }
    return result
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

Create `tests/agency-js/subprocess-pause-basic/test.js`:

```javascript
import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { writeFileSync } from "fs";

const first = await main();

// The child's std::bash interrupt has no handler anywhere → it must
// SURFACE as an interrupt on the parent result (not a rejection).
if (!hasInterrupts(first.data)) {
  writeFileSync("__result.json", JSON.stringify({
    error: "expected surfaced interrupt, got: " + JSON.stringify(first.data),
  }));
  process.exit(0);
}

const surfaced = first.data;
const resumed = await respondToInterrupts(surfaced, surfaced.map(() => approve()));

writeFileSync("__result.json", JSON.stringify({
  surfacedEffects: surfaced.map((i) => i.effect),
  finalData: resumed.data,
}, null, 2));
```

Create `tests/agency-js/subprocess-pause-basic/fixture.json` matching the format of `tests/agency-js/subprocess-no-handler/fixture.json` (copy it and edit the expected `__result.json` to):

```json
{
  "surfacedEffects": ["std::bash"],
  "finalData": "resumed-ok\n"
}
```

(Check the actual fixture format from the existing test dir first; mirror it exactly.)

- [ ] **Step 3: Run to verify failure**

```bash
pnpm run agency test js tests/agency-js/subprocess-pause-basic > /tmp/subprocess-plan/task4-red.log 2>&1; tail -20 /tmp/subprocess-plan/task4-red.log
```
Expected: FAIL — parent doesn't handle `interrupted` (subprocess exits, parent reports abnormal exit or unknown message). This test goes green only after Task 5 (resume); after Task 4 the FIRST half (surfacing) must work — split assertion accordingly if you want a green checkpoint mid-way: acceptable intermediate is `surfacedEffects` correct and resume failing.

- [ ] **Step 4: Restructure `_run` in `ipc.ts`**

Extract everything from the current `fork(...)` call through the `new Promise(...)` body into:

```typescript
async function runSubprocessSession(opts: {
  ctx: any;
  stateStack: any;
  scriptPath: string;
  instruction: RunInstruction;   // widened to ResumeInstruction in Task 5
  limits: RunLimits;
  cwd?: string;
  abortSignal?: AbortSignal;
}): Promise<SessionOutcome> {
  const child = fork(subprocessBootstrapPath, [], buildForkOptions({ limits: opts.limits, cwd: opts.cwd }));
  return new Promise((resolvePromise, rejectPromise) => {
    const session: RunSession = {
      sessionId: nanoid(),
      child,
      limits: opts.limits,
      ctx: opts.ctx,
      stateStack: opts.stateStack,
      compiledPath: opts.scriptPath,
      // result messages settle as {type:"result", value}; interrupted as
      // {type:"interrupted", msg} — see handleChildMessage change below.
      resolvePromise,
      rejectPromise,
      settled: false,
      startedAt: Date.now(),
      wallClockTimer: null,
      stdoutBytes: 0,
      stoppedForwarding: false,
    };
    if (opts.abortSignal) {
      const onAbort = () => {
        // Parent cancellation / race-loss / time-guard: tear the child down.
        try {
          child.kill("SIGKILL");
        } catch (err) {
          ipcLog("send", { type: "kill_failed", detail: err instanceof Error ? err.message : String(err) });
        }
        settle(session, rejectPromise, new AgencyCancelledError());
      };
      if (opts.abortSignal.aborted) onAbort();
      else opts.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    attachSessionHandlers(session, opts.instruction);
  });
}
```

`attachSessionHandlers` changes signature to take the prebuilt instruction (run OR resume) instead of `(node, args)`. In `handleChildMessage`, change the `result` and add the `interrupted` cases:

```typescript
  if (msg.type === "interrupt") {
    await handleInterruptMessage(s, msg);
  } else if (msg.type === "result") {
    settle(s, s.resolvePromise, { type: "result", value: msg.value });
  } else if (msg.type === "interrupted") {
    settle(s, s.resolvePromise, { type: "interrupted", msg });
  } else if ...
```

(`settle` still clears timers, releases session locks, but NO LONGER calls `cleanupTempDir` — temp cleanup moves to `_run`'s invoke `finally`, because the session no longer owns the file lifecycle.) Then rewrite `_run`:

```typescript
export async function _run(
  compiled: { moduleId: string; code: string },
  node: string,
  args: Record<string, any>,
  wallClock: number,
  memory: number,
  ipcPayload: number,
  stdout: number,
  configOverrides?: Partial<AgencyConfig>,
  cwd?: string,
): Promise<any> {
  if (isIpcMode()) {
    throw new Error("Nested subprocess execution is not supported.");  // removed in Task 10
  }
  const store = getRuntimeContext();
  const { ctx, stack: stateStack } = store;
  const limits = clampLimits({ wallClock, memory, ipcPayload, stdout });
  const mergedConfigOverrides = withParentProviderModules(configOverrides, ctx.providerModules);
  const parentFrame = stateStack.lastFrame();

  const batchResult = await runBatch<any>({
    ctx,
    parentStack: stateStack,   // the local slice from ALS — slice rule
    parentFrame,
    // store.callsite is typed on the ALS store (asyncContext.ts:91) and is
    // set by Runner.runInScope; undefined only in bootstrap-frame contexts,
    // where the fallback keeps checkpoint metadata attributable.
    checkpointLocation: store.callsite ?? { moduleId: "", scopeName: "_run", stepPath: "subprocess" },
    mode: "all",
    children: [{
      key: "subprocess_0",
      invoke: (_childStack, abortSignal) =>
        invokeSubprocess({ ctx, stateStack, parentFrame, compiled, node, nodeArgs: args, limits, configOverrides: mergedConfigOverrides, cwd, abortSignal }),
    }],
  });
  if (batchResult.kind === "interrupts") return batchResult.interrupts;
  return batchResult.values[0];
}

/** One subprocess execution segment: materialize code, pick run-vs-resume
 * from the saved payload, run the session, and translate the outcome —
 * `interrupted` saves the payload and returns rehydrated interrupts (which
 * runBatch stamps with the parent-side shared checkpoint); `result` clears
 * the payload and returns the value. */
async function invokeSubprocess(args: {
  ctx: any;
  stateStack: any;
  parentFrame: State;
  compiled: { moduleId: string; code: string };
  node: string;
  nodeArgs: Record<string, any>;
  limits: RunLimits;
  configOverrides?: Partial<AgencyConfig>;
  cwd?: string;
  abortSignal: AbortSignal;
}): Promise<any> {
  const scriptPath = materializeCompiledScript(args.compiled);
  try {
    const saved = loadSubprocessPayload(args.parentFrame);
    const instruction = resolveInstruction({
      ctx: args.ctx,
      saved,
      scriptPath,
      node: args.node,
      nodeArgs: args.nodeArgs,
      limits: args.limits,
      configOverrides: args.configOverrides,
    });
    const outcome = await runSubprocessSession({
      ctx: args.ctx,
      stateStack: args.stateStack,
      scriptPath,
      instruction,
      limits: args.limits,
      cwd: args.cwd,
      abortSignal: args.abortSignal,
    });
    if (outcome.type === "interrupted") {
      // Opaque payload: serialized with the parent frame; NEVER walked by
      // State.toJSON — the child checkpoint belongs to another process and
      // must not be spliced into the parent replay.
      saveSubprocessPayload(args.parentFrame, {
        childCheckpoint: outcome.msg.checkpoint,
        interrupts: outcome.msg.interrupts,
        node: args.node,
        subprocessSessionId: outcome.msg.subprocessSessionId,
      });
      // Rehydrate WITHOUT checkpoints; runBatch stamps the parent-side
      // shared checkpoint and overwrites intr.checkpoint on each.
      return outcome.msg.interrupts.map((intr) => ({ ...intr }));
    }
    clearSubprocessPayload(args.parentFrame);
    return outcome.value;
  } finally {
    cleanupTempDir(scriptPath);
  }
}
```

The payload accessors are three one-liners over a private module constant (see the Interfaces block). In Task 4, `resolveInstruction`'s resume arm does not exist yet — have it throw `new Error("subprocess resume lands in the next commit")` when `saved` is defined, so this compiles standalone; Task 5 replaces the throw with `buildResumeInstruction`.

- [ ] **Step 5: Verify surfacing works end-to-end**

```bash
pnpm vitest run lib/runtime/ipc.test.ts > /tmp/subprocess-plan/task4-green.log 2>&1
pnpm run agency test js tests/agency-js/subprocess-pause-basic >> /tmp/subprocess-plan/task4-green.log 2>&1
pnpm run agency test tests/agency/subprocess/run-basic.agency >> /tmp/subprocess-plan/task4-green.log 2>&1
pnpm run agency test tests/agency/subprocess/handler-approve.agency >> /tmp/subprocess-plan/task4-green.log 2>&1
pnpm run agency test tests/agency/subprocess/run-crash.agency >> /tmp/subprocess-plan/task4-green.log 2>&1
tail -40 /tmp/subprocess-plan/task4-green.log
```
Expected: unit + non-pausing subprocess tests PASS (the runBatch success path must be behavior-identical); `subprocess-pause-basic` surfaces `std::bash` correctly and fails only on the resume half.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/ipc.ts lib/runtime/ipc.test.ts tests/agency-js/subprocess-pause-basic
git commit -m "feat: _run adopts runBatch and surfaces child interrupts to the caller"
```

---

### Task 5: Resume — instruction, bootstrap path, and `_run` dispatch

**Files:**
- Modify: `lib/runtime/ipc.ts` (`ResumeInstruction`, `buildResumeInstruction`, `collectSubprocessResponses`)
- Modify: `lib/runtime/subprocess-bootstrap.ts` (handle `type: "resume"`)
- Test: `tests/agency-js/subprocess-pause-basic/` (from Task 4, now fully green)

**Interfaces:**
- Consumes: compiled modules export a module-bound `respondToInterrupts(interrupts, responses)` (verified: it is in every compiled module's export list). `ctx.getInterruptResponse(interruptId)` returns `{ response: InterruptResponse } | undefined`.
- Produces:

```typescript
export type ResumeInstruction = {
  type: "resume";
  scriptPath: string;
  node: string;
  checkpoint: any;
  interrupts: SerializedInterrupt[];        // same order as responses
  responses: any[];                          // InterruptResponse[]
  ipcPayload?: number;
  configOverrides?: Partial<AgencyConfig>;
};
export function buildResumeInstruction(args: {
  scriptPath: string;
  saved: SubprocessResumePayload;
  responses: any[];
  limits: RunLimits;
  configOverrides?: Partial<AgencyConfig>;
}): ResumeInstruction;
export function collectSubprocessResponses(ctx: any, saved: SubprocessResumePayload): any[];
```

- [ ] **Step 1: Implement the parent side**

```typescript
export function buildResumeInstruction(args: {
  scriptPath: string;
  saved: SubprocessResumePayload;
  responses: any[];
  limits: RunLimits;
  configOverrides?: Partial<AgencyConfig>;
}): ResumeInstruction {
  return {
    type: "resume",
    scriptPath: args.scriptPath,
    node: args.saved.node,
    checkpoint: args.saved.childCheckpoint,
    interrupts: args.saved.interrupts,
    responses: args.responses,
    ipcPayload: args.limits.ipcPayload,
    ...(args.configOverrides ? { configOverrides: args.configOverrides } : {}),
  };
}

/** Pull the user's responses for this subprocess's pending interrupts, in
 * the exact order of the saved interrupts array (respondToInterrupts in
 * the child pairs them positionally). Note: ctx.getInterruptResponse
 * returns the response ALREADY UNWRAPPED (context.ts:128 does
 * `?.response` internally). */
export function collectSubprocessResponses(ctx: any, saved: SubprocessResumePayload): any[] {
  return saved.interrupts.map((intr) => {
    const response = ctx.getInterruptResponse(intr.interruptId);
    if (response === undefined) {
      throw new Error(
        `Missing user response for subprocess interrupt ${intr.interruptId} (${intr.effect}). ` +
        `All surfaced interrupts must be answered via respondToInterrupts before the subprocess can resume.`,
      );
    }
    return response;
  });
}
```

Replace the Task 4 throw in `resolveInstruction`'s `saved` arm with `buildResumeInstruction({ scriptPath, saved, responses: collectSubprocessResponses(ctx, saved), limits, configOverrides })`. Widen `runSubprocessSession`'s `instruction` type and the `RunInstruction` handling in `attachSessionHandlers` to `RunInstruction | ResumeInstruction`. Add a `resume` case to `ipcLog`: `detail = \`node=${msg.node} responses=${msg.responses?.length}\``.

- [ ] **Step 2: Implement the bootstrap resume path**

In `subprocess-bootstrap.ts`, restructure the handler so run and resume share the terminal-reporting code:

```typescript
  if (msg.type !== "run" && msg.type !== "resume") {
    await sendOrDie({ type: "error", error: `Unknown message type: ${(msg as any).type ?? "undefined"}` });
    process.exit(1);
  }
  // ... ipcPayloadLimit + setRuntimeConfigOverrides as today ...
  try {
    const scriptUrl = pathToFileURL(msg.scriptPath).href;
    // eslint-disable-next-line no-restricted-syntax -- dynamic import required: script path is determined at runtime by the parent process
    const mod = await import(scriptUrl);

    let result: any;
    if (msg.type === "resume") {
      // Re-attach the shared checkpoint to each interrupt: the module's own
      // respondToInterrupts export restores state, sets the response map,
      // and replays the node — the exact machinery in-process resumes use.
      const interrupts = msg.interrupts.map((i: any) => ({ ...i, checkpoint: msg.checkpoint }));
      result = await mod.respondToInterrupts(interrupts, msg.responses);
    } else {
      // ... existing node lookup + positional args + call, unchanged ...
      result = await nodeFn(...positionalArgs);
    }

    if (hasInterrupts(result.data)) {
      await sendResultOrLimitError(serializeInterruptsForIpc(result.data) as any);
      process.exit(0);
    }
    await sendResultOrLimitError({
      type: "result",
      value: { data: result.data, tokens: result.tokens, messages: result.messages?.toJSON?.() ?? result.messages },
    });
    process.exit(0);
  } catch (err) { ... unchanged ... }
```

Note the `hasInterrupts` check applies to BOTH paths — a resumed child that interrupts again re-pauses (multi-cycle).

- [ ] **Step 3: Run the end-to-end test**

```bash
pnpm run agency test js tests/agency-js/subprocess-pause-basic > /tmp/subprocess-plan/task5-green.log 2>&1; tail -30 /tmp/subprocess-plan/task5-green.log
```
Expected: PASS — `finalData: "resumed-ok\n"`. Debug with `AGENCY_IPC_DEBUG=1` if the resume hangs; the most likely failure is the child's `respondToInterrupts` needing `registerTopLevelCallbacks`/`moduleDir` — check how the compiled export binds them (`grep -n "respondToInterrupts" tests/agency-js/subprocess-pause-basic/agent.js`) and mirror the run path.

- [ ] **Step 4: Verify the CRITICAL handler-re-registration invariant with a dedicated test**

Create `tests/agency/subprocess/pause-then-child-handler.agency` — after resume, the child hits a SECOND interrupt that a child-local handler must catch:

```agency
import { compile, run } from "std::agency"

node main() {
  const source = """
import { bash } from "std::shell"
node main() {
  let first = bash("echo unhandled-one")
  handle {
    let second = bash("echo handled-two")
    return first.stdout + second.stdout
  } with (e) {
    return approve()
  }
}
"""
  const compileResult = compile(source)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(compiled: compileResult.value, node: "main")
    if (isSuccess(result)) {
      return result.value.data
    }
    return "run failed"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
  }
}
```

`tests/agency/subprocess/pause-then-child-handler.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "After a pause/resume, the child re-registers its own handlers before the next interrupt site",
      "input": "",
      "expectedOutput": "\"unhandled-one\\nhandled-two\\n\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [{ "action": "approve" }]
    }
  ]
}
```

(The first bash pauses → the test runner approves the surfaced interrupt → resume → the second bash MUST be approved by the child-local handler, then still consult the silent parent, merging to approve. If the handler were skipped, the second bash would surface a second interrupt and the single-response test would fail.)

- [ ] **Step 4b: Mirror test for PARENT-side handler re-registration**

Create `tests/agency/subprocess/pause-then-parent-handler.agency` — after resume, the child's second interrupt must be caught by a **parent** handler that replay had to re-register before `_run` re-entered:

```agency
import { compile, run } from "std::agency"

node main() {
  const source = """
import { bash } from "std::shell"
node main() {
  let first = bash("echo phase-one")
  let second = bash("echo phase-two")
  return first.stdout + second.stdout
}
"""
  const compileResult = compile(source)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(compiled: compileResult.value, node: "main")
    if (isSuccess(result)) {
      return result.value.data
    }
    return "run failed"
  } with (e) {
    if (e.effect == "std::run") {
      return approve()
    }
    if (e.effect == "std::bash" && e.data.command == "echo phase-two") {
      return approve()
    }
  }
}
```

`tests/agency/subprocess/pause-then-parent-handler.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "After resume, the replayed parent chain catches the child second interrupt",
      "input": "",
      "expectedOutput": "\"phase-one\\nphase-two\\n\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [{ "action": "approve" }]
    }
  ]
}
```

(phase-one is unmatched by any handler → pauses; the single test-runner approval resumes; phase-two must be approved by the parent handler during the REPLAYED run — if parent re-registration were broken, phase-two would surface a second interrupt and the single-response test would fail. Verify the `std::bash` payload field name for the command — `grep -n "std::bash" stdlib/shell.agency` — and adjust `e.data.command` to match.)

- [ ] **Step 5: Run it**

```bash
pnpm run ast tests/agency/subprocess/pause-then-child-handler.agency > /tmp/subprocess-plan/task5-ast.log 2>&1
pnpm run agency test tests/agency/subprocess/pause-then-child-handler.agency > /tmp/subprocess-plan/task5-exec.log 2>&1
pnpm run agency test tests/agency/subprocess/pause-then-parent-handler.agency >> /tmp/subprocess-plan/task5-exec.log 2>&1
tail -30 /tmp/subprocess-plan/task5-exec.log
```
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/ipc.ts lib/runtime/subprocess-bootstrap.ts tests/agency-js/subprocess-pause-basic tests/agency/subprocess/pause-then-child-handler.* tests/agency/subprocess/pause-then-parent-handler.*
git commit -m "feat: subprocess resume via resume instruction and module respondToInterrupts"
```

---

### Task 6: Concurrency test suite

No production code expected — this task PROVES the concurrent semantics with execution tests. If any test exposes a bug, fix it within this task.

**Files:**
- Test: `tests/agency/subprocess/concurrent-handled.agency` + `.test.json`
- Test: `tests/agency/subprocess/pause-fork-all-unhandled.agency` + `.test.json`
- Test: `tests/agency/subprocess/pause-fork-mixed.agency` + `.test.json`
- Test: `tests/agency/subprocess/pause-multi-cycle.agency` + `.test.json`
- Test: `tests/agency/subprocess/pause-reject-response.agency` + `.test.json`
- Test: `tests/agency/subprocess/pause-two-subprocesses.agency` + `.test.json`

**Interfaces:** consumes everything from Tasks 1-5; produces nothing new.

- [ ] **Step 1: Q1 test — fork in child, all handled by the parent (no pause)**

`tests/agency/subprocess/concurrent-handled.agency`:

```agency
import { compile, run } from "std::agency"

// Three concurrent child branches each interrupt; the parent handler
// approves all three via independent concurrent IPC round-trips.
node main() {
  const source = """
import { bash } from "std::shell"
import { fork } from "std::concurrency"
node main() {
  const results = fork(["a", "b", "c"]) as item {
    let r = bash("echo branch-" + item)
    return r.stdout
  }
  return results
}
"""
  const compileResult = compile(source)
  if (isFailure(compileResult)) {
    return "compile failed"
  }
  handle {
    const result = run(compiled: compileResult.value, node: "main")
    if (isSuccess(result)) {
      return result.value.data
    }
    return "run failed"
  } with (e) {
    return approve()
  }
}
```

`.test.json` expects `"[\"branch-a\\n\",\"branch-b\\n\",\"branch-c\\n\"]"` with `{"type": "exact"}` and no `interruptHandlers`. Before writing the fixture, confirm the fork import path: `grep -rn "fork" tests/agency/fork/*.agency | head -3` — if fork is a builtin needing no import, drop the import line.

- [ ] **Step 2: All-unhandled batch**

`pause-fork-all-unhandled.agency`: same child source, but the parent `with (e)` block approves only `std::run` (returns nothing otherwise). `.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "All three child branches pause into ONE surfaced batch; one respond resumes all",
      "input": "",
      "expectedOutput": "[\"branch-a\\n\",\"branch-b\\n\",\"branch-c\\n\"]",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [
        { "action": "approve" },
        { "action": "approve" },
        { "action": "approve" }
      ]
    }
  ]
}
```

The three approvals answering ONE surfaced batch (not three sequential single-interrupt cycles) is exactly the batching claim. If the runner instead reports three separate cycles, that is a bug in the child-side batching — the merged-propagate branches must return through the child's runBatch, not settle sequentially.

- [ ] **Step 3: Mixed batch — child handler approves one branch, others pause**

Child source's fork body wraps item `"a"` in a child-local handler:

```agency
  const results = fork(["a", "b", "c"]) as item {
    if (item == "a") {
      handle {
        let r = bash("echo branch-" + item)
        return r.stdout
      } with (e) {
        return approve()
      }
    }
    let r2 = bash("echo branch-" + item)
    return r2.stdout
  }
```

`.test.json` has TWO approvals (only b and c surface) and the same expected output. The cache proof must be a HARD assertion, not array equality (a buggy re-run of branch a produces the same array): the item=="a" arm appends to a marker file, and after the fork joins, the child counts the lines and folds the count into its return value:

```agency
  const results = fork(["a", "b", "c"]) as item {
    if (item == "a") {
      handle {
        let m = bash("echo ran-a >> mixed-marker.txt")
        let r = bash("echo branch-" + item)
        return r.stdout
      } with (e) {
        return approve()
      }
    }
    let r2 = bash("echo branch-" + item)
    return r2.stdout
  }
  let count = bash("wc -l < mixed-marker.txt | tr -d \\" \\"")
  let cleanup = bash("rm -f mixed-marker.txt")
  return { results: results, branchARuns: count.stdout }
```

Expected output asserts `branchARuns` is `"1\n"` — if resume re-executed the cached branch, the marker file would have two lines. (The final `bash` calls run inside the child-local handler scope or need their own approvals — wrap the whole child body in the item=="a" handler style, i.e. one top-level `handle` in the child that approves the marker/cleanup bash commands by matching on `e.data`, keeping only the three `branch-*` commands subject to the mixed-handling scenario. Verify the exact bash-payload field name as in Task 5 Step 4b. Escape the quoted `tr` argument per Agency string rules or use `awk` — confirm the string parses with `pnpm run ast`.)

- [ ] **Step 4: Multi-cycle, rejection-response, and two-subprocesses tests**

- `pause-multi-cycle.agency`: child runs `bash("echo one")` then `bash("echo two")` sequentially with no handlers; parent approves only `std::run`. `.test.json`: two cycles → `"interruptHandlers": [{ "action": "approve" }, { "action": "approve" }]`, expected `"one\\ntwo\\n"` (child returns `r1.stdout + r2.stdout`).
- `pause-reject-response.agency`: child does `let r = try bash("echo nope")` and returns `isFailure(r) ? "rejected-as-expected" : "unexpectedly-ran"`. Wait — `try` in Agency captures failures: verify the exact rejected-bash result shape against an existing reject test (`grep -rln "reject" tests/agency/fork/handlers/ | head -3`) and mirror it. `.test.json`: `"interruptHandlers": [{ "action": "reject" }]`, expected `"rejected-as-expected"`. This proves a rejection response resumes the child (not aborts it).
- `pause-two-subprocesses.agency`: parent forks 2 branches, each compiles+runs a child whose single bash is unhandled. Both pause; the surfaced batch has 2 interrupts; 2 approvals; expected output `["sub-a\n","sub-b\n"]` shaped by each branch returning its child's data.

- [ ] **Step 5: Run all six, iterate on failures**

```bash
for t in concurrent-handled pause-fork-all-unhandled pause-fork-mixed pause-multi-cycle pause-reject-response pause-two-subprocesses; do
  pnpm run agency test tests/agency/subprocess/$t.agency > /tmp/subprocess-plan/task6-$t.log 2>&1
  echo "$t: $(tail -1 /tmp/subprocess-plan/task6-$t.log)"
done
```
Expected: all PASS. Likely failure areas and where to look: batching (`interruptWithHandlers` propagate tail must go through the child's fork runBatch — verify with `AGENCY_IPC_DEBUG=1`); response routing (`collectSubprocessResponses` order); two-subprocess payload isolation (each `_run` writes its payload into its OWN call frame — verified in Task 4 Step 1(d); if `pause-two-subprocesses` fails with crossed results anyway, that verification was wrong and the payload must move to the runBatch child branch state before proceeding).

- [ ] **Step 6: Commit**

```bash
git add tests/agency/subprocess/
git commit -m "test: subprocess concurrent pause/resume suite"
```

---

### Task 7: Durability test — self-contained checkpoints

**Files:**
- Test: `tests/agency-js/subprocess-durable-resume/` (new: `agent.agency`, `test.js`, `fixture.json`)

- [ ] **Step 1: Write the test**

`agent.agency`: identical to `tests/agency-js/subprocess-pause-basic/agent.agency`.

The spec's claim is "respond from a **fresh process**" — so the test runs in two stages across two Node processes, with the interrupts persisted to disk between them.

`test.js` (stage 1 — pause, persist, spawn stage 2):

```javascript
import { main, hasInterrupts } from "./agent.js";
import { writeFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";

const first = await main();
if (!hasInterrupts(first.data)) {
  writeFileSync("__result.json", JSON.stringify({ error: "expected interrupt" }));
  process.exit(0);
}

// Persist exactly what a user would persist: the surfaced Interrupt[]
// as JSON. Then destroy every compiled artifact and this process's
// memory by resuming in a FRESH Node process.
writeFileSync("persisted-interrupts.json", JSON.stringify(first.data));
rmSync(".agency-tmp", { recursive: true, force: true });

execFileSync(process.execPath, ["./resume-stage.js"], { stdio: "inherit" });
```

`resume-stage.js` (stage 2 — fresh process, resume from disk):

```javascript
import { approve, respondToInterrupts } from "./agent.js";
import { readFileSync, writeFileSync, rmSync } from "fs";

const persisted = JSON.parse(readFileSync("persisted-interrupts.json", "utf-8"));
const resumed = await respondToInterrupts(persisted, persisted.map(() => approve()));
rmSync("persisted-interrupts.json", { force: true });

writeFileSync("__result.json", JSON.stringify({
  finalData: resumed.data,
}, null, 2));
```

`fixture.json` expects `finalData: "resumed-ok\n"`.

- [ ] **Step 2: Run**

```bash
pnpm run agency test js tests/agency-js/subprocess-durable-resume > /tmp/subprocess-plan/task7.log 2>&1; tail -20 /tmp/subprocess-plan/task7.log
```
Expected: PASS. Two likely failure classes: (a) the JSON round-trip breaks the checkpoint (a class instance somewhere in the tree) — find the non-plain object and fix serialization at the source; do NOT weaken the test to pass live objects; the round-trip IS the requirement. (b) The fresh process needs provider/module re-registration — `respondToInterrupts` already calls `loadProviderModules` for exactly this cross-process case (interrupts.ts:470); if something else is process-global, that is a real durability bug to fix, not to test around. (Check how the agency-js harness treats extra files — `resume-stage.js` must not be picked up as a second test entry; mirror how existing multi-file agency-js tests arrange helpers, `ls tests/agency-js/*/ | head -30`.)

- [ ] **Step 3: Commit**

```bash
git add tests/agency-js/subprocess-durable-resume
git commit -m "test: subprocess checkpoints survive JSON round-trip and artifact wipe"
```

---

### Task 8: Statelog — runId inheritance, subprocessRun span, session id, span isolation

**Files:**
- Modify: `lib/statelogClient.ts` (`SpanType` is a CLOSED union at line 18 — add `"subprocessRun"` to it, with a comment mirroring the existing entries' style; `startSpan("subprocessRun")` does not compile without this)
- Modify: `lib/runtime/ipc.ts` (instructions carry `runId` + `subprocessSessionId`; parent-side span; `runInBranchContext` isolation)
- Modify: `lib/runtime/subprocess-bootstrap.ts` (seed run info)
- Modify: `lib/runtime/node.ts` and/or wherever `runNode` mints the runId
- Test: `lib/runtime/ipc.test.ts`; `tests/agency/subprocess/run-log-file.agency` (existing — extend)

**Interfaces:**
- Produces:

```typescript
// ipc.ts — module-scoped per-PROCESS info (a subprocess is one run per
// process, so this is not per-run mutable state in the banned sense; the
// bootstrap already owns ipcPayloadLimit the same way):
export type SubprocessRunInfo = { runId?: string; subprocessSessionId?: string; depth: number };
export function setSubprocessRunInfo(info: SubprocessRunInfo): void;
export function getSubprocessRunInfo(): SubprocessRunInfo;  // { depth: 0 } outside IPC
```

- [ ] **Step 1: Pin the seams BEFORE editing** (highest-risk edits in this task; do not discover them mid-change):

1. `startSpan(type: SpanType)` takes the closed `SpanType` union (`lib/statelogClient.ts:233` / `:18`) — record where `"subprocessRun"` gets added.
2. `runInBranchContext`'s exact signature from its `runBatch.ts` call site — record it.
3. The runId-minting seam: `grep -rn "runId" lib/runtime/node.ts lib/runtime/state/context.ts | grep -i "nanoid\|createExecution" ` — pin the exact file:line where a fresh run's id is minted, and confirm where a subprocess-inherited id must be injected. Write the finding into the plan-execution notes before making the edit; getting this wrong silently orphans child statelogs.
4. The spec says instructions also carry `spanContext` so child events nest under the parent's current span. Check whether `StatelogClient` can adopt an external parent span id when starting its root span (look at how `SpanContext.parentSpanId` is seeded). If adoption is a one-liner, thread `spanContext: { spanId }` through the instructions and seed it; if it requires reworking the client's span stack, DOCUMENT THE DEVIATION in `docs/dev/subprocess-ipc.md` ("child events share the runId; span nesting via subprocessSessionId correlation instead of parentSpanId") and note it as a follow-up — a conscious decision either way, not an omission.

- [ ] **Step 2: Implement, in this order**

1. `setSubprocessRunInfo`/`getSubprocessRunInfo` in `ipc.ts`; `RunInstruction` and `ResumeInstruction` gain `runId: string` and `subprocessSessionId: string`. `buildRunInstruction`/`buildResumeInstruction` accept and pass them. `serializeInterruptsForIpc` (Task 3) replaces its `subprocessSessionId: ""` stub with `getSubprocessRunInfo().subprocessSessionId ?? ""`.
2. In `_run`: mint `subprocessSessionId: nanoid()` once per `_run` call (store it in the payload on pause; reuse the SAVED one on resume so all segments of one logical child run correlate); pass `runId: ctx.getRunId()`.
3. Bootstrap: `setSubprocessRunInfo({ runId: msg.runId, subprocessSessionId: msg.subprocessSessionId, depth: 0 })` before importing the module.
4. Where the child's runId is minted (follow `runNode` → context creation): if `getSubprocessRunInfo().runId` is set, use it instead of minting. Also in the resume path — the serialized interrupts already carry the inherited runId, and `respondToInterrupts` resumes with `interrupt.runId`, so that path inherits automatically; verify rather than change.
5. Parent-side span: in `_run`, wrap the whole runBatch call with `const spanId = ctx.statelogClient.startSpan("subprocessRun");` / `finally { ctx.statelogClient.endSpan(spanId); }`.
6. Span isolation (the Q1 hardening): in `handleInterruptMessage`, wrap the `gatherChainOutcome` call in the same `runInBranchContext` pattern `runBatch` uses for its children, so two concurrent child interrupts do not interleave `handlerChain` span pushes on the parent's stack.

- [ ] **Step 3: Unit-test the info plumbing**

```typescript
// lib/runtime/ipc.test.ts
import { setSubprocessRunInfo, getSubprocessRunInfo } from "./ipc.js";

describe("subprocess run info", () => {
  // Module-scoped per-PROCESS state (one run per subprocess). Tests share
  // the module instance, so isolate via afterEach instead of relying on
  // in-test reset ordering.
  afterEach(() => setSubprocessRunInfo({ depth: 0 }));

  it("defaults to depth 0 and round-trips", () => {
    expect(getSubprocessRunInfo()).toEqual({ depth: 0 });
    setSubprocessRunInfo({ runId: "r1", subprocessSessionId: "s1", depth: 1 });
    expect(getSubprocessRunInfo()).toEqual({ runId: "r1", subprocessSessionId: "s1", depth: 1 });
  });
});
```

- [ ] **Step 4: Extend the log-file execution test**

`tests/agency/subprocess/run-log-file.agency` already writes a child statelog file. Extend its `.test.json`/assertions (following whatever mechanism that test uses to inspect the log) to assert the child's events carry the parent's runId. If the existing test has no inspection hook, add a small agency-js test `tests/agency-js/subprocess-statelog-runid/` that runs a child with `logFile:`, reads the JSONL, and asserts BOTH: (a) `every(line.runId === parentRunId)` where the parent runId comes from the statelog of the parent run, and (b) every child event carries the same `subprocessSessionId` — and after a pause/resume cycle (make the child's interrupt unhandled, respond, resume), the resumed segment's events still carry that SAME session id, proving cross-segment correlation. Mirror the statelog-reading pattern in `tests/agency-js/` (`grep -rln "statelog" tests/agency-js/ | head -3`).

Span-interleave isolation (Step 2 item 6) is verified at the unit level: follow the existing `runInBranchContext` test pattern (`grep -n "runInBranchContext" lib/statelogClient.test.ts lib/runtime/runBatch.test.ts`) — simulate two concurrent `handleInterruptMessage` calls against one session and assert the emitted spans are well-nested per chain. If no such test pattern exists, assert at minimum that both decisions arrive with their own `handlerChain` span ids and neither span closes the other's.

- [ ] **Step 5: Run + commit**

```bash
pnpm vitest run lib/runtime/ipc.test.ts > /tmp/subprocess-plan/task8.log 2>&1
pnpm run agency test tests/agency/subprocess/run-log-file.agency >> /tmp/subprocess-plan/task8.log 2>&1
pnpm run agency test js tests/agency-js/subprocess-pause-basic >> /tmp/subprocess-plan/task8.log 2>&1
tail -30 /tmp/subprocess-plan/task8.log
git add lib/runtime lib/statelogClient.ts tests/
git commit -m "feat: subprocess statelog runId inheritance and span isolation"
```

---

### Task 9: Limits behavior, existing-test audit, dev docs

**Files:**
- Test: `tests/agency/subprocess/pause-limit-wallclock-resets.agency` + `.test.json`
- Modify: `docs/dev/subprocess-ipc.md`
- Audit: `grep -rn "slow-path" tests/ lib/`

- [ ] **Step 1: Wall-clock-per-segment test**

`pause-limit-wallclock-resets.agency`: child does `bash("sleep 0.4 && echo one")` unhandled → pause → approve → resume → `bash("sleep 0.4 && echo two")` unhandled → pause → approve. Parent passes `wallClock: 600ms` to `run(...)`. Each segment is under 600ms but the total exceeds it — the run must SUCCEED, proving per-segment budgets. Expected output `"one\\ntwo\\n"`, two approvals in `interruptHandlers`. (Generous margins: sleeps of 0.4s with a 600ms cap can flake on slow CI — use `wallClock: 2s` and `sleep 1.2` if the suite tolerates the extra seconds; check how `limit-wall-clock.agency` calibrates and match its margins.)

- [ ] **Step 2: Oversized-interrupted-message E2E**

The `interrupted` path inherits the `ipcPayload` check via `sendResultOrLimitError` (Task 3) — prove it end-to-end, not just at the type level. Create `tests/agency/subprocess/limit-ipc-payload-interrupted.agency`, modeled on the existing `limit-ipc-payload.agency`: the child builds a large local variable (e.g. a loop concatenating a ~100kb string into a `let big`) and THEN hits an unhandled bash interrupt, so the checkpoint carrying `big` inflates the `interrupted` message. The parent calls `run(..., ipcPayload: 16kb)` — small enough that the checkpoint-bearing `interrupted` message exceeds it, but comfortably larger than the ordinary per-interrupt round-trip message (~hundreds of bytes), so the interrupt consult itself still succeeds. Expected: `run()` returns the structured failure — parent asserts `isFailure(result)` and returns a stable string built from `result.error.limit` (verify the failure-value access pattern against `limit-ipc-payload.agency` and mirror it). Expected output: `"ipc_payload"` (or the mirrored equivalent). No `interruptHandlers` — the run fails loudly instead of pausing un-resumably, which is exactly the spec's requirement.

- [ ] **Step 2b: Verify token accounting across segments (spec: "verify during implementation")**

Trace by code-reading (no LLM calls in tests, so this is a source-level verification): confirm the child's token stats live in the per-execution `GlobalStore` (`grep -rn "tokenStats\|__tokenStats" lib/runtime/state/globalStore.ts lib/runtime/ | head`), that `GlobalStore` contents serialize into the checkpoint's `globals`, and that `createReturnObject` reads cumulative stats after a resume (see `runResumeLoop` in `lib/runtime/interrupts.ts`). Record the finding as a sentence in the `docs/dev/subprocess-ipc.md` rewrite (Step 4): either "tokens accumulate across segments via checkpoint globals" (expected) or the actual gap plus a filed follow-up if the stats turn out to live outside the checkpoint.

- [ ] **Step 3: Audit for stale slow-path expectations**

```bash
grep -rn "slow-path" tests/ lib/ docs/dev/ > /tmp/subprocess-plan/task9-audit.log 2>&1; cat /tmp/subprocess-plan/task9-audit.log
```
Fix every hit: the `handleInterruptMessage` message is gone after Task 1; test expectations were updated in their tasks; `docs/dev/subprocess-ipc.md` gets rewritten next step.

- [ ] **Step 4: Rewrite `docs/dev/subprocess-ipc.md`**

Update these sections to match the implementation (source of truth: the spec + the code): the architecture diagram (decision → outcome; add interrupted/resume flows), "How interrupts propagate" (distributed chain, child-side combining, merge table), "Message protocol" (new shapes), "How compiled code gets executed" (`CompiledProgram.code`, materialize-per-fork), and REPLACE the "MVP limitations" list (slow-path, child votes, abort integration are DONE; nested subprocesses moves to "changes in Task 10" or is updated after Task 10). Add a "Pause/resume" section with the end-to-end walkthrough from the spec.

- [ ] **Step 5: Run + commit**

```bash
pnpm run agency test tests/agency/subprocess/pause-limit-wallclock-resets.agency > /tmp/subprocess-plan/task9.log 2>&1; tail -10 /tmp/subprocess-plan/task9.log
git add tests/agency/subprocess docs/dev/subprocess-ipc.md lib/runtime
git commit -m "test+docs: per-segment limits and updated subprocess IPC docs"
```

---

### Task 10: Nested subprocesses — depth tracking, cap, unblock, lock relay

**Files:**
- Modify: `lib/runtime/state/context.ts` (`subprocessDepth` field)
- Modify: `lib/runtime/ipc.ts` (remove nested block; depth in instructions; cap; lock relay)
- Modify: `lib/runtime/subprocess-bootstrap.ts` (seed depth)
- Modify: `lib/stdlib/agency.ts` (`_subprocessDepth`)
- Modify: `stdlib/agency.agency` (`std::run` effect payload + interrupt data gain `depth`)
- Test: `tests/agency/subprocess/nested-basic.agency`, `nested-depth-boundary.agency`, `nested-pause-resume.agency`, `nested-reject-middle.agency`, `nested-lock-relay.agency`, `nested-gate-unapproved.agency` + `.test.json` each; DELETE `nested-blocked.*` (replaced by `nested-gate-unapproved`)

**Interfaces:**
- Produces: `RuntimeContext.subprocessDepth: number` (0 at root); `_subprocessDepth(): number` exported from `lib/stdlib/agency.ts`; `run()`'s `std::run` interrupt data gains `depth` (prospective child depth). `LIMIT_CEILINGS` gains `depth: 10` and `DEFAULT_MAX_SUBPROCESS_DEPTH = 5` is a named exported constant (rationale comment required — see Step 1); `_run` gains a trailing `maxDepth: number = DEFAULT_MAX_SUBPROCESS_DEPTH` param plumbed from a new `maxDepth` param on stdlib `run()`.
- The `_run` param COUNT changes, so the descriptor in `lib/templates/backends/typescriptGenerator/imports.mustache` MUST be updated in the same commit. Explicit sequence: (1) edit the `.mustache` param list; (2) run `pnpm run templates` if that template compiles to a generated `.ts` (check: `grep -rn "imports" lib/templates/backends/typescriptGenerator/*.ts | head -3`); (3) run `make`; (4) run `make fixtures` and inspect the diff — any fixture embedding the `_run` descriptor must be regenerated, and an unexpectedly large fixture diff means the template edit went wrong.

- [ ] **Step 1: Depth plumbing + failing unit test**

```typescript
// lib/runtime/ipc.test.ts
it("depth cap produces a structured limit failure", async () => {
  // _run with ctx.subprocessDepth at the cap must fail before forking.
  // Use the withTestContext/runInTestContext pattern from ipc.test.ts's
  // existing _run tests (mirror their setup), with ctx.subprocessDepth = 5.
  // Expected: result matches makeLimitFailure("depth", 5, 6) shape:
  //   { reason: "limit_exceeded", limit: "depth", threshold: 5, value: 6, ... }
});
```

Implement: `subprocessDepth = 0` field on `RuntimeContext` (initialized from `getSubprocessRunInfo().depth` where the context is constructed in IPC mode — same seam as the Task 8 runId seeding); instructions carry `depth: number` (parent sends `ctx.subprocessDepth + 1`); bootstrap seeds it into `setSubprocessRunInfo`. Name the constants where `LIMIT_CEILINGS` lives, with rationale:

```typescript
// Depth cap on nested subprocess trees. Every run() is already gated by a
// std::run interrupt, so the cap is a backstop against handlers that
// blindly approve — it converts a runaway agent-writes-agent recursion
// into a structured failure. DEFAULT (5) allows realistic tool-building
// pipelines (agent → generated agent → helper) with headroom; the CEILING
// (10) bounds the total process tree even when users raise maxDepth.
export const DEFAULT_MAX_SUBPROCESS_DEPTH = 5;
// in LIMIT_CEILINGS:  depth: 10,
```

In `_run`, DELETE the `isIpcMode()` throw and add:

```typescript
  const childDepth = (ctx.subprocessDepth ?? 0) + 1;
  const cappedMaxDepth = Math.min(maxDepth, LIMIT_CEILINGS.depth);
  if (childDepth > cappedMaxDepth) {
    return makeLimitFailure("depth", cappedMaxDepth, childDepth);
  }
```

- [ ] **Step 2: Surface depth to handlers and TS**

In `stdlib/agency.agency`: add `depth: number` to the `effect std::run { ... }` payload; import `_subprocessDepth` in the import list from `agency-lang/stdlib-lib/agency.js`; in `run()`, add `depth: _subprocessDepth() + 1` to the interrupt data object and a `maxDepth: number = 5` param passed through to `_run`. In `lib/stdlib/agency.ts`:

```typescript
import { getRuntimeContext } from "../runtime/asyncContext.js";

/** The current process's subprocess depth (0 = root). Exposed to Agency
 * via std::agency's run() interrupt data and to TS via agency.ctx(). */
export function _subprocessDepth(): number {
  return getRuntimeContext().ctx.subprocessDepth ?? 0;
}
```

Run `make` (stdlib changed). Check whether `docs/site/appendix/ts-helpers.md` documents ctx fields individually — if it lists them, add one line for `subprocessDepth`.

- [ ] **Step 3: Lock relay for mid-tree processes**

In `handleLockAcquireMessage` (ipc.ts ~line 564): when this process is itself a subprocess, relay upward instead of acquiring locally, so the whole tree shares the root's lock domain:

```typescript
  const release = isIpcMode()
    ? await sendLockAcquireToParent(msg.name, {
        ownerId,
        ...(msg.timeoutMs !== undefined ? { timeoutMs: msg.timeoutMs } : {}),
        ...(msg.warnAfterMs !== undefined ? { warnAfterMs: msg.warnAfterMs } : {}),
      })
    : await acquireLocalLock(s.ctx, msg.name, { ... as today ... });
```

- [ ] **Step 4: Execution tests**

- `nested-basic.agency`: parent → child source that itself compiles+runs a grandchild returning `"grandchild-ok"`. The middle `run()` gate (`std::run`) is approved by a CHILD-level handler; the outer `run()` by the parent. The child's `std::run` handler ALSO asserts the surfaced depth value: `if (e.effect == "std::run" && e.data.depth == 2) { return approve() }` — a wrong depth leaves the gate unapproved and the test fails. Expected `"grandchild-ok"`.
- `nested-depth-boundary.agency`: TWO sub-cases for the exact boundary. (a) allowed-at-cap: parent calls `run(..., maxDepth: 2)`; child nests one `run()` (grandchild depth 2 == cap) → succeeds, expected `"grandchild-ok"`. (b) rejected-above-cap: parent calls `run(..., maxDepth: 1)` — the child's nested `run()` (depth 2 > cap 1) must return the `limit_exceeded`/`depth` failure; child returns a stable string from `isFailure(inner)`. Expected `"depth-capped"`. An off-by-one in `childDepth > cappedMaxDepth` fails exactly one of the two. (Confirm the child sees the parent's maxDepth: maxDepth must ride the instruction like limits do — add it to `RunInstruction`/`ResumeInstruction` and thread bootstrap → `setSubprocessRunInfo` → default for the child's own `_run` calls. If that plumbing is missing, this test catches it.)
- Also unit-test `_subprocessDepth()` via the `agency.withTestContext` pattern (see `docs/site/appendix/ts-helpers.md` "Testing TS helpers") with `ctx.subprocessDepth = 3`, expecting 3 — this is the `agency.ctx().subprocessDepth` exposure check without needing TS imports inside a restricted child.
- `nested-pause-resume.agency`: grandchild's bash is unhandled ANYWHERE → surfaces through both hops to the user; one approval resumes the whole tree. Expected the bash output; `interruptHandlers: [{"action": "approve"}]`. The parent handler approves both `std::run` gates (approve on `e.effect == "std::run"`).
- `nested-reject-middle.agency`: the CHILD has a handler that rejects the grandchild's bash → fail-fast, never surfaces; grandchild gets the rejection as a failure. Prove the parent was NOT consulted: the parent's handler, on seeing any `std::bash` effect, returns `approve()` AND the child folds a probe into its return value — since child reject is final, a buggy implementation that still consults upward would get the parent approval and the grandchild's bash would RUN instead of failing. Child returns `isFailure(grandchildResult) ? "rejected-locally" : "leaked-upward"`. Expected `"rejected-locally"`. No `interruptHandlers` in test.json.
- `nested-lock-relay.agency`: proves the tree shares the ROOT's lock domain (would fail if a mid-tree process acquired locally). Parent acquires a named lock, then runs a child whose grandchild tries to acquire the same lock name with a short `timeoutMs` — the grandchild's acquire must TIME OUT (it contends with the root-held lock; a mid-tree-local lock domain would grant it instantly). Model the lock syntax and timeout failure shape on the existing `lock-cross-process.agency`. Expected: a stable string from the timeout failure.
- DELETE `nested-blocked.agency` + `.test.json` (its premise — the hard error — is gone) and create `nested-gate-unapproved.agency` in its place: the child calls `run()` with NO `std::run` approval anywhere; the gate interrupt surfaces through the distributed chain; the test runner REJECTS it (`interruptHandlers: [{"action": "reject"}]`); the child observes the failure and returns a stable string. This keeps a test proving the gate exists on every nesting hop. No half-flipped test remains.

- [ ] **Step 5: Run everything**

```bash
for t in nested-basic nested-depth-boundary nested-pause-resume nested-reject-middle nested-lock-relay nested-gate-unapproved; do
  pnpm run agency test tests/agency/subprocess/$t.agency > /tmp/subprocess-plan/task10-$t.log 2>&1
  echo "$t: $(tail -1 /tmp/subprocess-plan/task10-$t.log)"
done
pnpm vitest run lib/runtime/ipc.test.ts >> /tmp/subprocess-plan/task10-unit.log 2>&1; tail -5 /tmp/subprocess-plan/task10-unit.log
```
Expected: all PASS.

- [ ] **Step 6: Update `docs/dev/subprocess-ipc.md` nesting section + commit**

```bash
git add -A lib/ stdlib/ tests/ docs/
git commit -m "feat: nested subprocesses with depth tracking, cap, and lock relay"
```

---

### Task 11: Final verification + structural lint

- [ ] **Step 1: Full unit suite + lint + build**

```bash
pnpm test:run > /tmp/subprocess-plan/task11-unit.log 2>&1; tail -20 /tmp/subprocess-plan/task11-unit.log
pnpm run lint:structure > /tmp/subprocess-plan/task11-lint.log 2>&1; tail -10 /tmp/subprocess-plan/task11-lint.log
make > /tmp/subprocess-plan/task11-make.log 2>&1; tail -5 /tmp/subprocess-plan/task11-make.log
```
Expected: clean. Do NOT run the full agency execution suite locally (CI covers it); run only the subprocess directory tests one final time:

```bash
for f in tests/agency/subprocess/*.agency; do
  pnpm run agency test "$f" > "/tmp/subprocess-plan/final-$(basename $f).log" 2>&1
  echo "$(basename $f): $(tail -1 /tmp/subprocess-plan/final-$(basename $f).log)"
done
pnpm run agency test js tests/agency-js/subprocess-pause-basic > /tmp/subprocess-plan/final-js1.log 2>&1; tail -1 /tmp/subprocess-plan/final-js1.log
pnpm run agency test js tests/agency-js/subprocess-durable-resume > /tmp/subprocess-plan/final-js2.log 2>&1; tail -1 /tmp/subprocess-plan/final-js2.log
pnpm run agency test js tests/agency-js/subprocess-no-handler > /tmp/subprocess-plan/final-js3.log 2>&1; tail -1 /tmp/subprocess-plan/final-js3.log
```

- [ ] **Step 2: Spec-invariant sweep** — re-read the spec's "Invariants" section (all 10) and confirm each has a covering test or code assertion; list the mapping in the PR description.

- [ ] **Step 3: PR**

Write the PR description to a file (apostrophe rule), then:

```bash
git push -u origin subprocess-pause-resume
gh pr create --title "Subprocess pause/resume: surface unhandled interrupts and resume from checkpoint" --body-file /tmp/subprocess-plan/pr-body.md
```

PR body must include: link to the spec file path, the invariant→test mapping, the two behavior changes callout (vote combining fixes; nested unblocked behind gate+cap), and end with the standard Claude Code attribution footer.
