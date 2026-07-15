# `saveDraft` (anytime draft-return on guard trip) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `saveDraft(v)` function so that when a `guard(cost:, time:)` trips, it returns the last saved best-so-far value instead of a `failure` — an anytime-algorithm floor for guarded work.

**Architecture:** Drafts live in **branch-local `StateStack.other.drafts`**, a `Record<frameDepth, {value}>` (branch-local because each fork/race/tool branch owns its `StateStack`; serialized because `other` is). `saveDraft` (a thin Agency `def` over a TS helper) writes the *caller* frame's draft. On a trip, the stdlib guard's `_runGuarded` reads the **outermost** (shallowest-depth) draft under the guard and returns it as a success, then **sweeps** its region. A **clearing rule** — clear a frame's draft on *normal* completion (via the def codegen `finally`), keep it on abort — prevents a completed sibling's stale draft from being salvaged.

**Tech Stack:** TypeScript runtime (`lib/runtime`, `lib/stdlib`), Agency stdlib (`stdlib/thread.agency`), the TypeScript-generator backend (`lib/backends/typescriptBuilder.ts` + `lib/templates/**/*.mustache`), the type checker (`lib/typeChecker`), vitest unit tests, and Agency execution tests (`tests/agency/guards`).

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-07-14-save-draft-guards-design.md` — the source of truth. This plan implements it exactly.
- **Storage is `StateStack.other.drafts`, keyed by frame depth. NEVER on `State` (frames pop before the boundary) and NEVER on the guard object (`CostGuard`/`TimeGuard.cloneForBranch` share/clone across branches).**
- **Outermost-set-wins** on read (smallest depth ≥ the guard's entry depth).
- **Additive:** with no `saveDraft` calls, guard behavior is byte-for-byte unchanged.
- **After any change under `stdlib/` or `lib/`, run `make`** (regenerates stdlib `.js` + runtime). **After editing any `.mustache`, run `pnpm run templates` first.** (per CLAUDE.md)
- **Agency execution tests run with `pnpm run agency test <file>`**; lib unit tests with `pnpm test:run <file>`. **Save test output to a file** (tests are slow/expensive — redirect and read the file).
- Banned patterns (per `docs/dev/coding-standards.md`): no dynamic imports; objects not maps; arrays not sets; `type` not `interface`.

---

### Task 1: Draft store runtime module

**Files:**
- Create: `packages/agency-lang/lib/runtime/drafts.ts`
- Create: `packages/agency-lang/lib/runtime/drafts.test.ts`
- Modify: `packages/agency-lang/lib/runtime/index.ts` (add one export line)

**Interfaces:**
- Consumes: `StateStack` from `./state/stateStack.js` (its `stack: State[]` array and `other: Record<string, any>`).
- Produces (used by Tasks 2 & 3):
  - `writeDraft(stack: StateStack, depth: number, value: unknown): void`
  - `readOutermostDraft(stack: StateStack, entryDepth: number): { value: any } | undefined`
  - `sweepDrafts(stack: StateStack, entryDepth: number): void`
  - `__clearTopFrameDraft(stack: StateStack | undefined): void`

- [ ] **Step 1: Write the failing unit test**

Create `packages/agency-lang/lib/runtime/drafts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { StateStack, State } from "./state/stateStack.js";
import {
  writeDraft,
  readOutermostDraft,
  sweepDrafts,
  __clearTopFrameDraft,
} from "./drafts.js";

function stackWithFrames(n: number): StateStack {
  const s = new StateStack();
  for (let i = 0; i < n; i++) s.stack.push(new State());
  return s;
}

describe("draft store", () => {
  it("writes and reads a single draft (outermost = shallowest >= entryDepth)", () => {
    const s = stackWithFrames(4);
    writeDraft(s, 2, "code");
    writeDraft(s, 3, "verify");
    // entryDepth 1: both are under the guard; outermost is depth 2.
    expect(readOutermostDraft(s, 1)?.value).toBe("code");
  });

  it("last-wins per frame", () => {
    const s = stackWithFrames(3);
    writeDraft(s, 2, "first");
    writeDraft(s, 2, "second");
    expect(readOutermostDraft(s, 0)?.value).toBe("second");
  });

  it("returns undefined when nothing is at or above entryDepth", () => {
    const s = stackWithFrames(3);
    writeDraft(s, 1, "shallow");
    expect(readOutermostDraft(s, 2)).toBeUndefined();
  });

  it("sweep deletes every draft at depth >= entryDepth", () => {
    const s = stackWithFrames(4);
    writeDraft(s, 1, "keep");
    writeDraft(s, 2, "drop");
    writeDraft(s, 3, "drop2");
    sweepDrafts(s, 2);
    expect(readOutermostDraft(s, 0)?.value).toBe("keep");
    expect(readOutermostDraft(s, 2)).toBeUndefined();
  });

  it("clearTopFrameDraft clears the top frame's draft only", () => {
    const s = stackWithFrames(3); // top index = 2
    writeDraft(s, 1, "caller");
    writeDraft(s, 2, "top");
    __clearTopFrameDraft(s);
    expect(readOutermostDraft(s, 0)?.value).toBe("caller");
    expect(readOutermostDraft(s, 2)).toBeUndefined();
  });

  it("survives StateStack serialization round-trip", () => {
    const s = stackWithFrames(3);
    writeDraft(s, 2, { report: "partial" });
    const restored = StateStack.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(readOutermostDraft(restored, 0)?.value).toEqual({ report: "partial" });
  });

  it("tolerates a stack with no drafts", () => {
    const s = stackWithFrames(2);
    expect(readOutermostDraft(s, 0)).toBeUndefined();
    sweepDrafts(s, 0); // no throw
    __clearTopFrameDraft(s); // no throw
    __clearTopFrameDraft(undefined); // no throw
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/agency-lang && pnpm test:run lib/runtime/drafts.test.ts > /tmp/drafts-test-1.txt 2>&1; tail -30 /tmp/drafts-test-1.txt`
Expected: FAIL — `Cannot find module './drafts.js'` / exports undefined.

- [ ] **Step 3: Implement the draft store**

Create `packages/agency-lang/lib/runtime/drafts.ts`:

```ts
import type { StateStack } from "./state/stateStack.js";

/** A saved best-so-far value. Wrapped so a stored `null`/`undefined` value is
 *  distinct from "no draft for this frame". */
type DraftRecord = { value: any };

/** Branch-local, serialized store: frame depth -> its latest draft. Lives in
 *  `StateStack.other` (NOT on `State`) because frames are popped by the unwind
 *  before a guard boundary reads them — `other` outlives frame pops. See
 *  docs/superpowers/specs/2026-07-14-save-draft-guards-design.md. */
function draftsOf(stack: StateStack): Record<number, DraftRecord> {
  const other = stack.other as Record<string, any>;
  if (!other.drafts) other.drafts = {};
  return other.drafts as Record<number, DraftRecord>;
}

/** Record `value` as the draft for the frame at `depth` (last call wins). */
export function writeDraft(stack: StateStack, depth: number, value: unknown): void {
  draftsOf(stack)[depth] = { value };
}

/** The outermost draft under a guard: the smallest depth >= `entryDepth` that
 *  has a draft. Undefined if none. Outermost (not deepest) is the type-closest
 *  choice to the guarded block's type — see the spec. */
export function readOutermostDraft(
  stack: StateStack,
  entryDepth: number,
): DraftRecord | undefined {
  const drafts = (stack.other as Record<string, any>).drafts as
    | Record<number, DraftRecord>
    | undefined;
  if (!drafts) return undefined;
  let best = Infinity;
  for (const key of Object.keys(drafts)) {
    const d = Number(key);
    if (d >= entryDepth && d < best) best = d;
  }
  return best === Infinity ? undefined : drafts[best];
}

/** Delete every draft at depth >= `entryDepth`. Run on BOTH guard outcomes so a
 *  draft never leaks into a later sibling guard or an outer guard. */
export function sweepDrafts(stack: StateStack, entryDepth: number): void {
  const drafts = (stack.other as Record<string, any>).drafts as
    | Record<number, DraftRecord>
    | undefined;
  if (!drafts) return;
  for (const key of Object.keys(drafts)) {
    if (Number(key) >= entryDepth) delete drafts[Number(key)];
  }
}

/** Clear the CURRENT top frame's draft. Called from generated code in the def
 *  `finally` ONLY on normal completion (`__functionCompleted`), so a frame that
 *  is unwinding on an abort keeps its draft for the guard boundary to read. */
export function __clearTopFrameDraft(stack: StateStack | undefined): void {
  if (!stack) return;
  const drafts = (stack.other as Record<string, any>).drafts as
    | Record<number, DraftRecord>
    | undefined;
  if (!drafts) return;
  delete drafts[stack.stack.length - 1];
}
```

- [ ] **Step 4: Export from the runtime index**

In `packages/agency-lang/lib/runtime/index.ts`, add after the `export { StateStack, State } ...` line (around line 30):

```ts
export {
  writeDraft,
  readOutermostDraft,
  sweepDrafts,
  __clearTopFrameDraft,
} from "./drafts.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/agency-lang && pnpm test:run lib/runtime/drafts.test.ts > /tmp/drafts-test-2.txt 2>&1; tail -30 /tmp/drafts-test-2.txt`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/save-draft-guards
git add packages/agency-lang/lib/runtime/drafts.ts packages/agency-lang/lib/runtime/drafts.test.ts packages/agency-lang/lib/runtime/index.ts
git commit -m "feat(saveDraft): branch-local draft store (StateStack.other)"
```

---

### Task 2: `saveDraft` surface + `_runGuarded` read & sweep

**Files:**
- Modify: `packages/agency-lang/lib/stdlib/thread.ts` (add `_saveDraft`; modify `_runGuarded`)
- Modify: `packages/agency-lang/stdlib/thread.agency` (import `_saveDraft`; add `def saveDraft`)
- Create: `packages/agency-lang/tests/agency/guards/save-draft-basic.agency` (+ `.test.json`)
- Create: `packages/agency-lang/tests/agency/guards/save-draft-no-draft.agency` (+ `.test.json`)
- Create: `packages/agency-lang/tests/agency/guards/save-draft-last-wins.agency` (+ `.test.json`)
- Create: `packages/agency-lang/tests/agency/guards/save-draft-outermost.agency` (+ `.test.json`)
- Create: `packages/agency-lang/tests/agency/guards/save-draft-sequential-guards.agency` (+ `.test.json`)
- Create: `packages/agency-lang/tests/agency/guards/save-draft-nested-guards.agency` (+ `.test.json`)

**Interfaces:**
- Consumes: `writeDraft`, `readOutermostDraft`, `sweepDrafts` (Task 1); existing `getRuntimeContext`, `__call`, `__tryCall` in `thread.ts`; `success`, `isFailure`, `ResultValue`, `ResultFailure` from `../runtime/result.js`.
- Produces: the Agency builtin `saveDraft(value)` and the salvage behavior on trip.

- [ ] **Step 1: Write the first failing execution test**

Create `packages/agency-lang/tests/agency/guards/save-draft-basic.agency`:

```
import { guard, saveDraft } from "std::thread"

// SYNTHETIC_COST = 0.000002 per llm call; limit 0.000001 trips on the first
// call. saveDraft runs first, so the guard salvages "partial" instead of failing.
node main() {
  const result = guard(cost: 0.000001) as {
    saveDraft("partial")
    const reply = llm("Reply with: pong")
    return reply
  }
  if (isFailure(result)) {
    return "unexpected failure"
  }
  return result.value
}
```

Create `packages/agency-lang/tests/agency/guards/save-draft-basic.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"partial\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [{ "return": "pong" }],
      "description": "A guard trip after saveDraft returns the saved draft instead of a failure."
    }
  ]
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/agency-lang && pnpm run agency test tests/agency/guards/save-draft-basic.agency > /tmp/sd-basic-1.txt 2>&1; tail -30 /tmp/sd-basic-1.txt`
Expected: FAIL — `saveDraft` is not defined / unknown import from `std::thread` (and even if it compiled, the guard returns a failure, not `"partial"`).

- [ ] **Step 3: Add the `_saveDraft` TS helper**

In `packages/agency-lang/lib/stdlib/thread.ts`, add near the guard helpers (after `_popGuard`). First ensure the imports at the top of the file include:

```ts
import { writeDraft, readOutermostDraft, sweepDrafts } from "../runtime/drafts.js";
import { success, isFailure } from "../runtime/result.js";
import type { ResultValue, ResultFailure } from "../runtime/result.js";
```

Then add:

```ts
/**
 * Impl of the Agency `saveDraft(value)` builtin. Records a best-so-far value
 * keyed to the CALLER's frame (the Agency function/block that called saveDraft),
 * so a tripping enclosing `guard` can salvage it. `saveDraft` is a thin one-frame
 * `def` wrapper, so the caller is exactly one frame below saveDraft's own frame.
 * With no caller (module-init/global scope) it is a harmless no-op.
 */
export function _saveDraft(value: unknown): void {
  const { stack } = getRuntimeContext();
  const callerDepth = stack.stack.length - 2; // saveDraft's frame is on top
  if (callerDepth < 0) return;
  writeDraft(stack, callerDepth, value);
}
```

- [ ] **Step 4: Modify `_runGuarded` to salvage on trip and sweep on exit**

In `packages/agency-lang/lib/stdlib/thread.ts`, replace the body of `_runGuarded` (currently just `return __tryCall(...)`) with:

```ts
export async function _runGuarded(
  ids: string[],
  block: unknown,
): Promise<ResultValue> {
  const { ctx, stack } = getRuntimeContext();
  // Frames of the block + everything it calls live at indices >= entryDepth.
  const entryDepth = stack.stack.length;
  const result = await __tryCall(
    () => __call(block, { type: "positional", args: [] }),
    {
      ownedGuardIds: ids,
      checkpoint: ctx.getResultCheckpoint(),
      functionName: "guard",
      args: stack.lastFrame()?.args,
    },
  );

  // Salvage: a guardFailureData-shaped failure is produced ONLY by __tryCall's
  // owned-guard branch, so its presence here means THIS guard tripped. If a
  // draft was saved under it, return the outermost draft instead of the failure.
  let out: ResultValue = result;
  if (isFailure(result) && isGuardTripFailure(result)) {
    const draft = readOutermostDraft(stack, entryDepth);
    if (draft !== undefined) out = success(draft.value);
  }

  // Clean this guard's region on BOTH outcomes so drafts never leak into a
  // later sibling guard or an outer guard.
  sweepDrafts(stack, entryDepth);
  return out;
}

/** A failure whose error carries GuardFailureData — produced only by the
 *  owned-guard conversion in __tryCall, i.e. this guard's own trip. */
function isGuardTripFailure(f: ResultFailure): boolean {
  const t = (f.error as { type?: string } | null | undefined)?.type;
  return t === "guardFailure" || t === "timeoutFailure";
}
```

- [ ] **Step 5: Wire `saveDraft` into the Agency stdlib**

In `packages/agency-lang/stdlib/thread.agency`, add `_saveDraft` to the existing import from `agency-lang/stdlib-lib/thread.js` (the block that already imports `_pushGuard, _popGuard, _runGuarded`):

```
  _pushGuard,
  _popGuard,
  _runGuarded,
  _saveDraft,
```

Then add the exported `def` (place it right after the `guard` def):

```
export def saveDraft(value: any) {
  """
  Record a best-so-far value for the current function or guarded block. If an
  enclosing `guard(...)` trips before this scope returns, the guard yields the
  last saved draft instead of a failure — an "anytime" result you can always
  fall back to. Call it repeatedly as your result improves; the last value
  wins. With no enclosing guard it is a harmless no-op.

  @param value - The best-so-far value. Should match the enclosing scope's return type.
  """
  _saveDraft(value)
}
```

- [ ] **Step 6: Rebuild the stdlib**

Run: `cd packages/agency-lang && make > /tmp/sd-make-1.txt 2>&1; tail -15 /tmp/sd-make-1.txt`
Expected: build completes without errors.

- [ ] **Step 7: Run the basic test to verify it passes**

Run: `cd packages/agency-lang && pnpm run agency test tests/agency/guards/save-draft-basic.agency > /tmp/sd-basic-2.txt 2>&1; tail -20 /tmp/sd-basic-2.txt`
Expected: PASS — output `"partial"`.

- [ ] **Step 8: Add the remaining behavior tests**

Create these six files (`.agency` + `.test.json` each). All use `useTestLLMProvider: true`.

`save-draft-no-draft.agency` (additivity — trip with no draft still fails):

```
import { guard } from "std::thread"

node main() {
  const result = guard(cost: 0.000001) as {
    const reply = llm("Reply with: pong")
    return reply
  }
  if (isFailure(result)) { return "failed:${result.error.type}" }
  return "no trip"
}
```

`save-draft-no-draft.test.json`:

```json
{
  "tests": [
    { "nodeName": "main", "input": "", "expectedOutput": "\"failed:guardFailure\"",
      "evaluationCriteria": [{ "type": "exact" }], "useTestLLMProvider": true,
      "llmMocks": [{ "return": "pong" }],
      "description": "Additivity: a trip with no saveDraft still returns a failure." }
  ]
}
```

`save-draft-last-wins.agency`:

```
import { guard, saveDraft } from "std::thread"

node main() {
  const result = guard(cost: 0.000001) as {
    saveDraft("first")
    saveDraft("second")
    const reply = llm("Reply with: pong")
    return reply
  }
  if (isFailure(result)) { return "unexpected" }
  return result.value
}
```

`save-draft-last-wins.test.json`: same shape, `"expectedOutput": "\"second\""`.

`save-draft-outermost.agency` (outermost across frames → returns the shallow one):

```
import { guard, saveDraft } from "std::thread"

def verify(): string {
  saveDraft("verify-draft")
  const reply = llm("Reply with: pong")
  return reply
}

def code(): string {
  saveDraft("code-draft")
  const x = verify()
  return x
}

node main() {
  const result = guard(cost: 0.000001) as {
    return code()
  }
  if (isFailure(result)) { return "unexpected" }
  return result.value
}
```

`save-draft-outermost.test.json`: same shape, `"expectedOutput": "\"code-draft\""`, `"llmMocks": [{ "return": "pong" }]`.

`save-draft-sequential-guards.agency` (the sweep prevents guard B from reading guard A's draft):

```
import { guard, saveDraft } from "std::thread"

node main() {
  const r1 = guard(cost: 0.000001) as {
    saveDraft("g1-draft")
    const a = llm("Reply with: pong")
    return a
  }
  const r2 = guard(cost: 0.000001) as {
    const b = llm("Reply with: pong")
    return b
  }
  let first = "?"
  if (isSuccess(r1)) { first = r1.value }
  return "${first}|${isFailure(r2)}"
}
```

`save-draft-sequential-guards.test.json`: `"expectedOutput": "\"g1-draft|true\""`, `"llmMocks": [{ "return": "pong" }, { "return": "pong" }]`.

`save-draft-nested-guards.agency` (inner guard's swept draft must NOT be salvaged by the outer trip):

```
import { guard, saveDraft } from "std::thread"

node main() {
  const outer = guard(cost: 0.000003) as {
    const inner = guard(cost: 0.000001) as {
      saveDraft("inner-draft")
      const a = llm("Reply with: pong")
      return a
    }
    // outer saves NO draft of its own; then it trips.
    const b = llm("Reply with: pong")
    return b
  }
  return "${isFailure(outer)}"
}
```

`save-draft-nested-guards.test.json`: `"expectedOutput": "\"true\""`, `"llmMocks": [{ "return": "pong" }, { "return": "pong" }]`. (Inner trips on the first call and salvages `inner-draft`, sweeping its region; the second call pushes the outer over 0.000003 and it trips with no draft of its own — the swept inner draft must not be read, so `outer` is a failure.)

- [ ] **Step 9: Run all six new tests**

Run each and save output, e.g.:

```
cd packages/agency-lang
for t in no-draft last-wins outermost sequential-guards nested-guards; do
  pnpm run agency test tests/agency/guards/save-draft-$t.agency > /tmp/sd-$t.txt 2>&1
  echo "== $t =="; tail -5 /tmp/sd-$t.txt
done
```
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/save-draft-guards
git add packages/agency-lang/lib/stdlib/thread.ts packages/agency-lang/stdlib/thread.agency packages/agency-lang/tests/agency/guards/save-draft-*.agency packages/agency-lang/tests/agency/guards/save-draft-*.test.json packages/agency-lang/stdlib/
git commit -m "feat(saveDraft): salvage outermost draft on guard trip; sweep region"
```

---

### Task 3: Clear a frame's draft on normal completion (def codegen)

**Files:**
- Modify: `packages/agency-lang/lib/templates/backends/typescriptGenerator/imports.mustache` (add `__clearTopFrameDraft` to the runtime import)
- Modify: `packages/agency-lang/lib/backends/typescriptBuilder.ts` (def `finally`: clear before pop)
- Create: `packages/agency-lang/tests/agency/guards/save-draft-stale-sibling.agency` (+ `.test.json`)

**Interfaces:**
- Consumes: `__clearTopFrameDraft` (Task 1), exported from `agency-lang/runtime`; the generated `__functionCompleted` local and `__stateStack()` accessor (already in the def `finally`).
- Produces: every def frame clears its own draft on normal return.

- [ ] **Step 1: Write the failing execution test (stale-sibling)**

Create `packages/agency-lang/tests/agency/guards/save-draft-stale-sibling.agency`:

```
import { guard, saveDraft } from "std::thread"

// `saver` saves a draft and returns NORMALLY (no llm, no cost). `tripper` then
// trips before saving anything. Without normal-completion clearing, the guard
// would wrongly salvage "stale" from `saver`; with it, the guard fails.
def saver(): string {
  saveDraft("stale")
  return "ok"
}

def tripper(): string {
  const reply = llm("Reply with: pong")
  return reply
}

node main() {
  const result = guard(cost: 0.000001) as {
    const a = saver()
    const b = tripper()
    return b
  }
  if (isSuccess(result)) { return "leaked:${result.value}" }
  return "failed"
}
```

Create `save-draft-stale-sibling.test.json`: `"expectedOutput": "\"failed\""`, `"useTestLLMProvider": true`, `"llmMocks": [{ "return": "pong" }]`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/agency-lang && pnpm run agency test tests/agency/guards/save-draft-stale-sibling.agency > /tmp/sd-stale-1.txt 2>&1; tail -20 /tmp/sd-stale-1.txt`
Expected: FAIL — output is `"leaked:stale"` (saver's draft is stale-read because it is never cleared).

- [ ] **Step 3: Add `__clearTopFrameDraft` to the generated runtime import**

In `packages/agency-lang/lib/templates/backends/typescriptGenerator/imports.mustache`, add `__clearTopFrameDraft` to the value-import list (the block ending in `} from "agency-lang/runtime";` around line 28-33). For example change:

```
  __call, __callMethod, __threads, __stateStack, __globals, getRuntimeContext, agencyStore,
```
to include it:
```
  __call, __callMethod, __threads, __stateStack, __globals, getRuntimeContext, agencyStore,
  __clearTopFrameDraft,
```

- [ ] **Step 4: Recompile templates**

Run: `cd packages/agency-lang && pnpm run templates > /tmp/sd-templates.txt 2>&1; tail -5 /tmp/sd-templates.txt`
Expected: templates recompiled (no error).

- [ ] **Step 5: Emit the clearing call in the def `finally`**

In `packages/agency-lang/lib/backends/typescriptBuilder.ts`, in the def `finally` statements (around line 2246, the `ts.statements([...])` that begins with `ts.raw("__stateStack()?.pop()")`), insert a clearing statement BEFORE the pop so it runs while the completing frame is still on top:

```ts
ts.statements([
  ts.raw("if (__functionCompleted) __clearTopFrameDraft(__stateStack())"),
  ts.raw("__stateStack()?.pop()"),
  ...(skipHooks
    ? []
    : [
        ts.if(
          ts.id("__functionCompleted"),
          ts.callHook("onFunctionEnd", {
            // ...unchanged...
          }),
        ),
      ]),
]),
```

(Only the first `ts.raw(...)` line is new; leave the rest of the block exactly as it is.)

- [ ] **Step 6: Rebuild**

Run: `cd packages/agency-lang && make > /tmp/sd-make-2.txt 2>&1; tail -15 /tmp/sd-make-2.txt`
Expected: build completes.

- [ ] **Step 7: Run the stale-sibling test + re-run Task 2 tests (regression)**

```
cd packages/agency-lang
pnpm run agency test tests/agency/guards/save-draft-stale-sibling.agency > /tmp/sd-stale-2.txt 2>&1; tail -8 /tmp/sd-stale-2.txt
for t in basic no-draft last-wins outermost sequential-guards nested-guards; do
  pnpm run agency test tests/agency/guards/save-draft-$t.agency > /tmp/sd-re-$t.txt 2>&1
  echo "== $t =="; tail -3 /tmp/sd-re-$t.txt
done
```
Expected: stale-sibling PASSes (`"failed"`); all six earlier tests still PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/save-draft-guards
git add packages/agency-lang/lib/templates/backends/typescriptGenerator/imports.mustache packages/agency-lang/lib/templates/backends/typescriptGenerator/imports.ts packages/agency-lang/lib/backends/typescriptBuilder.ts packages/agency-lang/tests/agency/guards/save-draft-stale-sibling.*
git commit -m "feat(saveDraft): clear a frame's draft on normal completion (no stale salvage)"
```

---

### Task 4: Branch-locality execution test

**Files:**
- Create: `packages/agency-lang/tests/agency/guards/save-draft-fork-isolation.agency` (+ `.test.json`)

**Interfaces:**
- Consumes: everything from Tasks 1-3 (no new code — this proves the branch-local property already holds because each branch owns its `StateStack`, hence its own `other.drafts`).

- [ ] **Step 1: Write the test**

Create `packages/agency-lang/tests/agency/guards/save-draft-fork-isolation.agency`. Each fork branch has its OWN guard and saves its OWN draft; the trip in each branch must salvage that branch's value, with no cross-branch clobber:

```
import { guard, saveDraft } from "std::thread"

def branch(tag: string): string {
  const r = guard(cost: 0.000001) as {
    saveDraft(tag)
    const reply = llm("Reply with: pong")
    return reply
  }
  if (isFailure(r)) { return "fail" }
  return r.value
}

node main() {
  const results = fork(["a", "b", "c"]) as tag {
    return branch(tag)
  }
  return "${results[0]}|${results[1]}|${results[2]}"
}
```

Create `save-draft-fork-isolation.test.json`: `"expectedOutput": "\"a|b|c\""`, `"useTestLLMProvider": true`, `"llmMocks": [{ "return": "pong" }, { "return": "pong" }, { "return": "pong" }]`.

- [ ] **Step 2: Run it**

Run: `cd packages/agency-lang && pnpm run agency test tests/agency/guards/save-draft-fork-isolation.agency > /tmp/sd-fork.txt 2>&1; tail -12 /tmp/sd-fork.txt`
Expected: PASS — `"a|b|c"` (each branch salvages its own draft; no clobber). If it fails with a mixed/duplicated value, drafts are leaking across branches — stop and revisit storage (must be `stack.other`, per-branch).

- [ ] **Step 3: Commit**

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/save-draft-guards
git add packages/agency-lang/tests/agency/guards/save-draft-fork-isolation.*
git commit -m "test(saveDraft): fork branches salvage their own drafts (branch-local)"
```

---

### Task 5: Type-check the `saveDraft` argument

**Files:**
- Modify: `packages/agency-lang/lib/typeChecker/checker.ts` (name-keyed check against the enclosing return type)
- Create: `packages/agency-lang/lib/typeChecker/saveDraft.test.ts`

**Interfaces:**
- Consumes: `scope.returnType` and `checkType(expr, expectedType, scope, contextLabel, ctx)` (both used by `checkReturnTypesInScope`); the per-scope call-checking pass `checkFunctionCallsInScope(info, ctx)` where `info` is the `ScopeInfo` carrying `returnType` and `scope`.
- Produces: a diagnostic when `saveDraft`'s argument is not assignable to the enclosing scope's return type.

- [ ] **Step 1: Write the failing type-checker test**

Create `packages/agency-lang/lib/typeChecker/saveDraft.test.ts`. Mirror an existing checker test's harness (see the sibling `*.test.ts` files in this directory for the exact `typeCheck`/diagnostics import). The two cases:

```ts
import { describe, it, expect } from "vitest";
import { typeCheckSource } from "./testHarness.js"; // use whatever the sibling tests import

describe("saveDraft argument type-check", () => {
  it("accepts a draft assignable to the enclosing return type", () => {
    const diags = typeCheckSource(`
      import { guard, saveDraft } from "std::thread"
      def f(): string {
        saveDraft("ok")
        return "x"
      }
    `);
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("rejects a draft not assignable to the enclosing return type", () => {
    const diags = typeCheckSource(`
      import { guard, saveDraft } from "std::thread"
      def f(): string {
        saveDraft(42)
        return "x"
      }
    `);
    expect(diags.some((d) => d.severity === "error")).toBe(true);
  });
});
```

> Note: if the sibling checker tests use a different harness entry point than `typeCheckSource`/`testHarness.js`, use theirs — grep `lib/typeChecker/*.test.ts` for the import and match it. Do not invent a harness.

- [ ] **Step 2: Run it to verify the reject case fails**

Run: `cd packages/agency-lang && pnpm test:run lib/typeChecker/saveDraft.test.ts > /tmp/sd-tc-1.txt 2>&1; tail -30 /tmp/sd-tc-1.txt`
Expected: the "rejects" test FAILS (no diagnostic yet); the "accepts" test passes.

- [ ] **Step 3: Add the name-keyed check**

In `packages/agency-lang/lib/typeChecker/checker.ts`, find `checkFunctionCallsInScope(info, ctx)` (the per-scope pass that walks calls and invokes `checkSingleFunctionCall`). For each `saveDraft` call with exactly one positional argument and a defined `info.returnType`, reuse the return-assignability helper. Add, at the point where each `FunctionCall` `call` is visited in that pass:

```ts
if (
  call.functionName === "saveDraft" &&
  info.returnType !== undefined &&
  call.arguments.length === 1 &&
  call.arguments[0].type !== "splat" &&
  call.arguments[0].type !== "named"
) {
  // The draft must be assignable to the enclosing scope's return type — the
  // same contract a `return` obeys. Name-keyed: aliasing `saveDraft` escapes
  // this (documented v1 limitation).
  const arg = call.arguments[0];
  checkType(
    arg.value ?? arg,
    info.returnType,
    info.scope,
    "the saveDraft() draft value",
    ctx,
  );
  // fall through to normal call checking (arity etc.) as well
}
```

> Adjust `arg.value ?? arg` to however the AST exposes a positional argument's expression in this codebase (grep how `checkArgsAgainstParams` reads positional arg expressions — match that exactly). The `checkType(expr, expectedType, scope, label, ctx)` signature is the one used in `checkReturnTypesInScope`.

- [ ] **Step 4: Run the type-checker test to verify it passes**

Run: `cd packages/agency-lang && pnpm test:run lib/typeChecker/saveDraft.test.ts > /tmp/sd-tc-2.txt 2>&1; tail -20 /tmp/sd-tc-2.txt`
Expected: both tests PASS.

- [ ] **Step 5: Confirm no regression in the checker suite**

Run: `cd packages/agency-lang && pnpm test:run lib/typeChecker > /tmp/sd-tc-suite.txt 2>&1; tail -15 /tmp/sd-tc-suite.txt`
Expected: the type-checker unit suite is green.

- [ ] **Step 6: Commit**

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/save-draft-guards
git add packages/agency-lang/lib/typeChecker/checker.ts packages/agency-lang/lib/typeChecker/saveDraft.test.ts
git commit -m "feat(saveDraft): type-check the draft against the enclosing return type"
```

---

### Task 6: Docs, stdlib regen, and full verification

**Files:**
- Modify: `packages/agency-lang/docs/site/stdlib/thread.md` (regenerated — do not hand-edit; comes from `agency doc`)
- Verify: whole build + the guard test suite subset.

**Interfaces:**
- Consumes: the `saveDraft` docstring added in Task 2 (Step 5).

- [ ] **Step 1: Regenerate stdlib docs**

The `saveDraft` docstring in `stdlib/thread.agency` becomes the generated reference page and the tool description. Regenerate:

Run: `cd packages/agency-lang && make > /tmp/sd-make-final.txt 2>&1; tail -15 /tmp/sd-make-final.txt`
Expected: build + docs regen succeed. Confirm `saveDraft` now appears in `docs/site/stdlib/thread.md`:

Run: `grep -n "saveDraft" packages/agency-lang/docs/site/stdlib/thread.md | head`
Expected: at least one hit with the docstring text.

- [ ] **Step 2: Run the full saveDraft + guards execution subset**

Run:
```
cd packages/agency-lang
for f in tests/agency/guards/save-draft-*.agency; do
  pnpm run agency test "$f" > "/tmp/sd-final-$(basename $f).txt" 2>&1
  echo "== $(basename $f) =="; tail -3 "/tmp/sd-final-$(basename $f).txt"
done
pnpm run agency test tests/agency/guards/guard-cost-trip.agency > /tmp/sd-guard-regression.txt 2>&1; echo "== guard-cost-trip (regression) =="; tail -3 /tmp/sd-guard-regression.txt
```
Expected: every `save-draft-*` PASSes AND the pre-existing `guard-cost-trip` still PASSes (additivity — unchanged guard behavior when no draft is saved).

- [ ] **Step 3: Run the runtime + typechecker unit suites**

Run: `cd packages/agency-lang && pnpm test:run lib/runtime/drafts.test.ts lib/typeChecker/saveDraft.test.ts > /tmp/sd-unit-final.txt 2>&1; tail -15 /tmp/sd-unit-final.txt`
Expected: green.

- [ ] **Step 4: Commit any regenerated artifacts**

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/save-draft-guards
git add packages/agency-lang/docs/site/stdlib/thread.md packages/agency-lang/stdlib/
git commit -m "docs(saveDraft): regenerate stdlib reference"
```

- [ ] **Step 5: Push and open a PR (only when the user asks)**

Do not push or open a PR unless the user requests it. When they do:

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/save-draft-guards
git push -u origin worktree-save-draft-guards
```
Then open a PR whose body summarizes: the anytime-algorithm motivation, `StateStack.other` storage + clearing rule, outermost-wins/type-safety, and the deferred follow-ups (`finalize`, deep/fork salvage, `sigint`/`sigkill`, LLM-tool exposure, `Both`).

---

## Self-Review

**Spec coverage:**
- `saveDraft(v)` statement-form builtin → Task 2 (Steps 3, 5).
- Branch-local `StateStack.other` storage keyed by frame depth → Task 1; branch-locality proven in Task 4.
- Trip read (outermost-set-wins) + sweep → Task 2 (Step 4).
- Clearing rule (normal completion clears; abort keeps) → Task 3.
- Additivity (no draft ⇒ failure unchanged) → Task 2 (no-draft test) + Task 6 (guard-cost-trip regression).
- Type-check against enclosing return type + name-keyed aliasing caveat → Task 5.
- Interrupt/resume survival → Task 1 serialization round-trip unit test.
- Deferred items (`finalize`, deep/fork salvage, `sigint`/`sigkill`, tool exposure, `Both`, root budgets) → out of scope, unchanged; noted in PR body (Task 6).

**Placeholder scan:** every code step shows the code; every test step shows the command and expected output. Two spots say "match the sibling test harness / positional-arg accessor" (Task 5) — these are deliberate: they instruct the engineer to mirror verified existing code rather than invent an API, because the exact harness entry point and AST arg-accessor must match this codebase's conventions.

**Type consistency:** `writeDraft` / `readOutermostDraft` / `sweepDrafts` / `__clearTopFrameDraft` names and signatures are identical across Tasks 1, 2, 3. `_saveDraft` (TS) ↔ `saveDraft` (Agency def) wiring is consistent. `_runGuarded`'s new `isGuardTripFailure` reads `f.error.type` matching `guardFailureData`'s shape from `result.ts`. `entryDepth = stack.stack.length` (captured before `__call`) aligns with `writeDraft` keying at `stack.stack.length - 2` (caller frame) and `__clearTopFrameDraft` at `stack.stack.length - 1` (completing frame) — verified consistent in the spec's depth walk-through.
