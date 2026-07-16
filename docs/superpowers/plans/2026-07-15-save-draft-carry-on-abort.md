# saveDraft Carry-On-Abort + finalize Implementation Plan

> **SUPERSEDED IN PART (2026-07-15, PR #553 review round):** the owner's review moved the abort transport from exceptions to RETURN VALUES (`AbortedResult`; see the revision-3 spec). Tasks A0-A2 and A5-A6 shipped as written. Tasks A3/A4's mechanism (carried draft on the exception, `returnCarry` marking, rung stamping) was replaced by the value transport in the same PR. PR B's tasks need re-planning against revision 3 before execution — the finalize surface design is unchanged, but the codegen anchors moved.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the main session (owner preference: no subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `saveDraft` on the carry-on-abort architecture (a `carriedDraft` on the abort object, updated by each frame's catch rung under the level rule), then add the `finalize` keyword — as two sequenced PRs from this one plan.

**Architecture:** `saveDraft(v)` sets a serialized `savedDraft` slot on the caller's frame. Every generated catch rung (defs AND blocks) applies the LEVEL RULE to any passing `AgencyAbort`: carried draft = finalize result, else this frame's draft, else erased. The guard's owned-trip conversion in `__tryCall` reads the carried draft and returns success. `runBatch` clears the carried draft when rethrowing a branch's error so branch drafts never cross the fork boundary. No side map, no regions, no sweep, no clearing codegen, no resume memo — PR #551's `drafts.ts` machinery is never ported.

**Tech Stack:** TypeScript runtime (`lib/runtime`, `lib/stdlib`), the TypeScript-generator backend (`lib/backends/typescriptBuilder.ts` + `lib/templates`), parser (`lib/parsers`, PR B), type checker (`lib/typeChecker`), vitest, Agency execution tests (`tests/agency/guards`).

## Global Constraints

- **Design spec (source of truth):** `docs/superpowers/specs/2026-07-15-save-draft-carry-on-abort-redesign.md` (revision 2). Before writing any code, run the DRIFT CHECK in Task A0.
- **Branch mechanics:** work in the existing `save-draft-guards` worktree. Create a NEW branch `save-draft-carry` from `origin/main`. Port surviving #551 files from the old `save-draft-guards` branch with `git checkout save-draft-guards -- <path>` (Task A1 lists them). PR #551 is CLOSED; do not reuse its branch.
- **The level rule, verbatim from the spec (four rungs):** each frame REPLACES the carried draft — finalize result, else own draft, else PASS-THROUGH when the trip escaped through a return-position call (`returnCarry` flag, consume-once), else ERASED. No deep fallback. Stamping applies to EVERY `AgencyAbort` regardless of cause (the mechanism is universal; the guard is just the first reader).
- **Deliberate behavior change vs #551:** a draft saved only in a deep callee, with nothing at the levels between it and the guard, is NOT salvaged. Task A5 pins this.
- **`docs/site/guide/guards.md` is owner-owned. Do not edit it.** Docstrings and generated stdlib reference pages only.
- **After any `stdlib/` or `lib/` change, run `make`. After editing any `.mustache`, run `pnpm run templates` first.** Commit regenerated template `.ts` files with their `.mustache` sources. Generated `stdlib/*.js` and `tests/**/*.js` are gitignored — never commit them.
- **Execution tests:** `pnpm run agency test <file>`; unit tests: `pnpm test:run <file>`. Save all test output to files and read the file. Do not run the full agency suite locally; CI does. DO run the full `tests/agency/guards/` sweep before each PR (the loop in Task A5/B4) — these changes touch every guard.
- Banned patterns (`docs/dev/coding-standards.md` + `docs/dev/anti-patterns.md`): no dynamic imports; objects not maps; arrays not sets; `type` not `interface`; no conditional object-spread; no one-line `if`; block-form braces in generated code.
- **Commits:** message in a temp file, `git commit -F` (apostrophes break `-m`); plain imperative subject, no `feat:`/`fix:` prefixes; end with the EXECUTING model's Co-Authored-By line. Re-check `git branch --show-current` before every commit.
- PR A lands first and must be green standalone. PR B follows immediately on a branch cut from PR A's.

---

## Task A0: Drift check (do this before any code)

Reproduce the spec's two walked examples by hand and check every carried-draft value below against the spec's. If ANY value differs, STOP — the spec and plan have diverged; do not reconcile silently.

Program: `guard { return code() }`; `code` saves `10` then calls `verify`; `verify` saves `1` then trips.

| Step | Both levels save | Only `verify` saves |
| --- | --- | --- |
| error leaves `verify` | carried draft = `1` | carried draft = `1` |
| error leaves `code` | carried draft = `10` (replaced) | carried draft = EMPTY (erased — `const x = verify()` is not return position) |
| error leaves the guard block | carried draft = `10` (PASSED THROUGH — `return code()` is return position) | carried draft = EMPTY |
| guard reads | `success(10)` | `failure` (unchanged from today) |

The block row is load-bearing: the block level saves no draft of its own, so WITHOUT return-position pass-through the block's catch would erase `code`'s draft and the flagship example would fail. If your implementation makes the left column fail at the block hop, the missing piece is the pass-through rung, not the fixture.

Also confirm these spec decisions are still what the doc says: stamping is cause-agnostic; the level rule has FOUR rungs (finalize, own draft, return-position pass-through, erase); `runBatch` clears the carried draft on branch rethrow; blocks get a NEW catch; `finalize` is a keyword; partials bind per call expression, consume-once innermost.

---

# PR A — the carried-draft mechanism

### Task A1: Branch + port the surviving #551 pieces

**Files:**
- Port (from the old `save-draft-guards` branch): all `packages/agency-lang/tests/agency/guards/save-draft-*.agency` and `*.test.json` (13 fixtures); `packages/agency-lang/lib/typeChecker/saveDraft.test.ts`; the `checkSaveDraftCall` hunk in `packages/agency-lang/lib/typeChecker/checker.ts`; the `saveDraft` def in `packages/agency-lang/stdlib/thread.agency` and the `_saveDraft` import line.
- Do NOT port: `lib/runtime/drafts.ts` + its test, the `_runGuarded` body changes, the `guardFailureData` guardId change in `result.ts`, the clearing codegen in `typescriptBuilder.ts`/`blockSetup.mustache`, the `imports.mustache` `__clearTopFrameDraft` line.

**Interfaces:**
- Produces: a red baseline — the fixtures compile (once Task A2's `_saveDraft` exists) but fail, because no salvage mechanism exists yet.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/save-draft-guards
git fetch origin main
git checkout -b save-draft-carry origin/main
cd packages/agency-lang && pnpm install > /tmp/ca-install.txt 2>&1; tail -3 /tmp/ca-install.txt
make > /tmp/ca-make0.txt 2>&1; tail -3 /tmp/ca-make0.txt
```

- [ ] **Step 2: Port the fixtures and checker files**

```bash
cd /Users/adityabhargava/agency-lang/.claude/worktrees/save-draft-guards
git checkout save-draft-guards -- 'packages/agency-lang/tests/agency/guards/save-draft-*' packages/agency-lang/lib/typeChecker/saveDraft.test.ts
```

Then port BY HAND (the files also contain #551 changes you must not take):
- From the old branch's `packages/agency-lang/lib/typeChecker/checker.ts`, copy ONLY the `checkSaveDraftCall` function and its one call site inside `checkFunctionCallsInScope` (`git show save-draft-guards:packages/agency-lang/lib/typeChecker/checker.ts | grep -n "checkSaveDraftCall" -A 20`).
- From the old branch's `packages/agency-lang/stdlib/thread.agency`, copy the `export def saveDraft(value: any)` block and add `_saveDraft` to the import list from `agency-lang/stdlib-lib/thread.js`.

- [ ] **Step 3: Delete the deep-fallback expectation**

The ported `save-draft-outermost` fixture still matches the level rule (both levels save; `code-draft` wins). No fixture pins the removed deep fallback — verify: `grep -L "saveDraft" packages/agency-lang/tests/agency/guards/save-draft-*.agency` should list only `save-draft-no-draft.agency`. If any other fixture expects a salvage where an intermediate level saved nothing, adjust it to the level rule and note the change in the commit message.

- [ ] **Step 4: Commit the port (red state is expected and stated)**

```bash
git add packages/agency-lang/tests/agency/guards/ packages/agency-lang/lib/typeChecker/ packages/agency-lang/stdlib/thread.agency
printf '%s\n' "Port saveDraft fixtures, checker, and stdlib surface from #551" "" "The salvage mechanism is not implemented yet; the fixtures are the red baseline for the carry-on-abort rebuild." "" "Co-Authored-By: <executing model> <noreply@anthropic.com>" > /tmp/ca-commit.txt
git commit -F /tmp/ca-commit.txt
```

### Task A2: `State.savedDraft` + `_saveDraft`

Naming (owner review rounds): both fields hold a draft — a function's best-so-far return value. The names mark the stage: `savedDraft` is filed on a frame; `carriedDraft` is in transit on the abort. A finalize's return is a draft too (the frame's freshest one) and rides `carriedDraft` directly, never touching `savedDraft`. `savedDraft` mirrors the API name and avoids the `draftValue.value` stutter.

**Files:**
- Modify: `packages/agency-lang/lib/runtime/state/stateStack.ts` (State class ~L77 fields, `toJSON` ~L202, `fromJSON` ~L251, `StateJSON` type ~L290)
- Modify: `packages/agency-lang/lib/stdlib/thread.ts` (add `_saveDraft` after `_popGuard`, ~L336)
- Test: `packages/agency-lang/lib/runtime/state/stateStack.test.ts`

**Interfaces:**
- Consumes: `StateStack.callerFrame()` (`stateStack.ts` — "the caller's frame is what owns scoped registrations"; precedent call site `lib/stdlib/agency.ts:68`); `deepClone` from `lib/runtime/utils.js`; `getRuntimeContext` (already imported in `thread.ts`).
- Produces: `State.savedDraft?: { value: any }` (serialized); `_saveDraft(value: unknown): void` exported from `lib/stdlib/thread.ts`. Task A3's stamp helper reads `frame.savedDraft`; nothing else touches it.

- [ ] **Step 1: Write the failing unit tests**

In `packages/agency-lang/lib/runtime/state/stateStack.test.ts`, add:

```ts
describe("State.savedDraft (saveDraft slot)", () => {
  it("survives a State serialization round-trip", () => {
    const s = new State();
    s.savedDraft = { value: { report: "partial" } };
    const restored = State.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(restored.savedDraft).toEqual({ value: { report: "partial" } });
  });

  it("is absent by default and absent from JSON when unset", () => {
    const s = new State();
    expect(s.savedDraft).toBeUndefined();
    expect("savedDraft" in s.toJSON()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/agency-lang && pnpm test:run lib/runtime/state/stateStack.test.ts > /tmp/ca-a2.txt 2>&1; tail -20 /tmp/ca-a2.txt`
Expected: FAIL — `draft` does not exist / JSON round-trip loses it.

- [ ] **Step 3: Implement the field**

In the `State` class (near `scopedCallbacks?`, ~L77):

```ts
  /** saveDraft's best-so-far value for THIS scope. Wrapped so a saved
   *  null is distinct from "no draft". Serialized: a draft must survive
   *  interrupt/resume. Read only by this frame's own catch rung (the
   *  carry-on-abort level rule); no other code walks it. */
  savedDraft?: { value: any };
```

In `toJSON()` (after the object literal is built — match the existing `scopedCallbacks` conditional-assign pattern, NOT a conditional spread):

```ts
    if (this.savedDraft !== undefined) {
      json.savedDraft = deepClone(this.savedDraft);
    }
```

(If `toJSON` currently returns the literal directly, convert it to `const json: StateJSON = {...}; ...; return json;` — the same shape `StateStack.toJSON` already uses.)

In `fromJSON()`:

```ts
    if (json.savedDraft !== undefined) {
      state.savedDraft = json.savedDraft;
    }
```

In `StateJSON` (~L290): `savedDraft?: { value: any };`

- [ ] **Step 4: Implement `_saveDraft`**

In `packages/agency-lang/lib/stdlib/thread.ts`, after `_popGuard`:

```ts
/**
 * Impl of the Agency `saveDraft(value)` builtin. Sets the CALLER frame's
 * draft slot — the Agency scope that called saveDraft. The value is
 * deep-cloned so later mutation cannot change the salvage, and so a
 * live-trip salvage matches a post-resume one.
 *
 * The global-context check: saveDraft is itself an Agency def, so when it
 * runs, the top frame is saveDraft's own frame and callerFrame() is the
 * user's scope. During module-level init there is no user scope below it
 * — callerFrame() would return saveDraft's OWN frame (or throw on an
 * empty stack), and a draft written there dies unread when the frame
 * pops. So with no caller scope, saveDraft is a deliberate no-op.
 */
export function _saveDraft(value: unknown): void {
  const { stack } = getRuntimeContext();
  if (stack.isGlobalContext()) {
    return;
  }
  stack.callerFrame().savedDraft = { value: deepClone(value) };
}
```

(`isGlobalContext()` is the existing `stateStack.ts` predicate for "the only frame on the stack is the running call's own frame" — use it instead of a raw `stack.stack.length < 2` so the intent is named.)

Add `deepClone` to `thread.ts`'s imports from `../runtime/utils.js` if not present.

- [ ] **Step 5: Verify green + commit**

Run: `pnpm test:run lib/runtime/state/stateStack.test.ts > /tmp/ca-a2b.txt 2>&1; tail -10 /tmp/ca-a2b.txt` — expected PASS.
Commit (message file + `-F`): subject `Add the per-frame draft slot and the saveDraft writer`.

### Task A3: The carried draft, the stamp helper, and the level rule in generated code

The rungs do NOT assign the carried draft inline. They call one runtime helper, `__stampCarriedDraft`, which applies the level rule AND emits the statelog trail (owner review round: every partial that moves must be observable). Centralizing in a helper keeps the generated code one line per rung and gives statelog a single chokepoint.

**Files:**
- Modify: `packages/agency-lang/lib/runtime/errors.ts` (`AgencyAbort` class, ~L144)
- Modify: `packages/agency-lang/lib/statelogClient.ts` (`SpanType` union ~L21; new event method near `warn()` ~L1259)
- Create: `packages/agency-lang/lib/runtime/carriedDraft.ts` (+ `carriedDraft.test.ts`)
- Modify: `packages/agency-lang/lib/templates/backends/typescriptGenerator/functionCatchFailure.mustache` (the `AgencyAbort` rung)
- Modify: `packages/agency-lang/lib/templates/backends/typescriptGenerator/blockSetup.mustache` (ADD a catch — the template is try/finally today, with NO catch)
- Modify: `packages/agency-lang/lib/templates/backends/typescriptGenerator/imports.mustache` (import `__stampCarriedDraft`)
- Modify: `packages/agency-lang/lib/backends/typescriptBuilder.ts` (pass scope name + param names into the two templates)
- Regenerate: the matching `.ts` template files (`pnpm run templates`)

**Interfaces:**
- Consumes: `State.savedDraft` (Task A2); `AgencyAbort` already imported in generated code (`imports.mustache` line ~19); `ctx.statelogClient`.
- Produces: `AgencyAbort.carriedDraft?: { value: unknown }` and `AgencyAbort.unwindSpanId?: string`; `__stampCarriedDraft(error, frame, scopeName, paramNames, ctx, finalizeResult?)` — the ONLY writer of `carriedDraft` in generated code; statelog span type `"abortUnwind"` + event `abortSalvage`. Task A4 reads the carried draft at the guard boundary; Task B3 passes `finalizeResult`.

- [ ] **Step 1: Add the abort fields**

In `packages/agency-lang/lib/runtime/errors.ts`, inside `class AgencyAbort`:

```ts
  /** saveDraft partial carried up the unwind (carry-on-abort spec). Every
   *  generated catch rung REPLACES this with the unwinding frame's own
   *  partial — its draft, or (future) its finalize's return — or erases it
   *  when the frame has neither. Deliberately mutable: every rung rethrows
   *  the SAME object, which is what makes the level rule's replace-and-erase
   *  work. Same idiom as agencyCause.delivered. */
  carriedDraft?: { value: unknown };
  /** Level-rule rung 3 (return-position pass-through): set by the
   *  __markReturnCarry wrapper around a return-position call the abort
   *  just escaped, consumed (read then cleared) by the very next rung.
   *  Consume-once, so the flag can never skip a level. */
  returnCarry?: boolean;
  /** Statelog span for this abort's unwind. Opened lazily by the first
   *  __stampCarriedDraft call that has a partial to report; closed at delivery
   *  (the guard boundary). Undefined for the common case of an unwind
   *  that never touches a partial. */
  unwindSpanId?: string;
```

- [ ] **Step 2: The statelog surface**

In `lib/statelogClient.ts`: add `"abortUnwind"` to the `SpanType` union (~L21), then add an event method next to `warn()` (~L1259), following its shape — variable payloads nested under `data` so the redaction replacer covers them:

```ts
  /** One event per level-rule transition while an abort unwinds (saveDraft
   *  carry-on-abort). Emitted only when a partial exists on either side of
   *  the transition, so a trip through undrafted code logs nothing.
   *  `partial` and `functionArgs` are pre-truncated string previews. */
  async abortSalvage({
    action,
    scopeName,
    functionArgs,
    partial,
  }: {
    action: "carried" | "passedThrough" | "erased" | "delivered" | "clearedAtFork";
    scopeName?: string;
    functionArgs?: string;
    partial?: string;
  }): Promise<void> {
    await this.post({
      type: "abortSalvage",
      action,
      scopeName,
      data: { functionArgs, partial },
    });
  }
```

VERIFY before finalizing the payload: read `post()` to confirm events pick up the current span automatically. The unwind runs synchronously up one async chain, so span attribution should hold from the lazy `startSpan` to the guard's `endSpan` — but a branch-originated abort crosses into the parent's span context at the fork boundary. If `post()` attribution alone cannot keep parent-side events in the span, add an explicit `spanId` field to the event (from `error.unwindSpanId`) so the viewer can group by it regardless.

- [ ] **Step 3: The stamp helper (unit-tested first)**

`packages/agency-lang/lib/runtime/carriedDraft.ts`:

```ts
import { AgencyAbort } from "./errors.js";
import { State } from "./state/stateStack.js";
import { RuntimeContext } from "./state/context.js";

const TRUNCATE_AT = 500;

/** Stringify a value for a statelog payload, capped so a large partial
 *  cannot bloat an event. */
export function previewForLog(value: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length > TRUNCATE_AT ? s.slice(0, TRUNCATE_AT) + "…(truncated)" : s;
}

/** The level rule (FOUR rungs), applied by every generated catch rung:
 *  replace the unwinding abort's carried draft with THIS frame's partial —
 *  the finalize result when one is passed (PR B), else the frame's
 *  savedDraft, else the callee's partial passed through unchanged when the
 *  trip escaped a return-position call (returnCarry, consume-once), else
 *  nothing (erase). Also the single statelog point for salvage tracking:
 *  the first call that touches a partial opens the abortUnwind span
 *  (stored on the abort), and every transition involving a partial emits
 *  one abortSalvage event. Empty-to-empty transitions are silent. */
export function __stampCarriedDraft(
  error: unknown,
  frame: State,
  scopeName: string,
  paramNames: string[],
  ctx: RuntimeContext,
  finalizeResult?: { value: unknown },
): void {
  if (!(error instanceof AgencyAbort)) return;
  const prev = error.carriedDraft;
  const passThrough = error.returnCarry === true ? prev : undefined;
  error.returnCarry = false;
  const next = finalizeResult ?? frame.savedDraft ?? passThrough;
  error.carriedDraft = next;
  if (prev === undefined && next === undefined) return;
  const client = ctx.statelogClient;
  if (client === undefined) return;
  if (error.unwindSpanId === undefined) {
    error.unwindSpanId = client.startSpan("abortUnwind");
  }
  const args: Record<string, unknown> = {};
  for (const name of paramNames) {
    args[name] = frame.locals[name];
  }
  const action =
    next === undefined
      ? "erased"
      : next === passThrough && finalizeResult === undefined && frame.savedDraft === undefined
        ? "passedThrough"
        : "carried";
  client.abortSalvage({
    action,
    scopeName,
    functionArgs: previewForLog(args),
    partial: previewForLog(next !== undefined ? next.value : prev?.value),
  });
}

/** Return-position marker (level-rule rung 3). The compiler wraps the
 *  OUTERMOST call of every `return <call>(...)` statement (and the block
 *  equivalent that lowers to runner.halt) in try/catch and calls this
 *  before rethrowing. Argument subexpressions are evaluated BEFORE the
 *  wrapped call, so `return f(g())` with g tripping stays unmarked —
 *  only f's own trip (f-return-typed = this scope's return type) may
 *  pass through. */
export function __markReturnCarry(error: unknown): void {
  if (error instanceof AgencyAbort) {
    error.returnCarry = true;
  }
}
```

(An "erased" event reports the partial that just died — that is the observable trace of the level rule declining to pass a value on. VERIFY the exact shape of `frame.locals` and how params land in it before wiring `paramNames`; params are assigned into frame locals by the generated prologue.)

Unit tests in `carriedDraft.test.ts` (stub client recording calls): stamps the draft and emits "carried"; erases a prior carried draft and emits "erased" with the dead value; `finalizeResult` wins over a saved draft; a marked abort with no draft/finalize keeps its carried draft and emits "passedThrough"; own draft BEATS pass-through (mark set, draft saved → "carried" with the draft); the flag is cleared even when unused (stamp twice: second call with no re-mark erases); non-abort errors are untouched and silent; empty→empty emits nothing and opens no span; a >500-char value is truncated in the payload but the carried draft itself carries the FULL value.

- [ ] **Step 3b: Return-position marking in codegen**

In `typescriptBuilder.ts`, every `return <expr>` whose expression is (or whose outermost node is) an Agency function call compiles with the marker, and the same for block `return`s that lower to `runner.halt(...)`:

```ts
// return f(<args>)  — args are evaluated into temporaries FIRST, so a trip
// inside an argument never gets marked (its type is unrelated to this
// scope's return type).
const __arg0 = /* compiled g() etc. */;
try {
  return await __call(f, __arg0);
} catch (__returnError) {
  __markReturnCarry(__returnError);
  throw __returnError;
}
```

VERIFY first: check how return-expression calls compile today — if argument subexpressions already evaluate through awaited temporaries (likely, given async call sequencing), the wrapper only needs to enclose the outermost call. If arguments compile inline inside the call expression, hoist them; do NOT wrap the whole expression, or a tripping argument would be wrongly marked (type-unsound). Add `__markReturnCarry` to `imports.mustache`. Non-call return expressions (`return x`, `return "s"`) compile exactly as today.

- [ ] **Step 4: The def rung**

In `functionCatchFailure.mustache`, the current rung is:

```
if (__error instanceof AgencyAbort) {
  throw __error;
}
```

Replace with:

```
if (__error instanceof AgencyAbort) {
  // Level rule (saveDraft): this frame REPLACES the carried draft with its own
  // partial — its savedDraft if it saved one, else nothing. A partial
  // crosses one level at a time; a frame with nothing to say ERASES the
  // carried draft. See lib/runtime/carriedDraft.ts.
  __stampCarriedDraft(__error, __stack, {{{scopeNameLiteral}}}, {{{paramNamesLiteral}}}, __ctx);
  throw __error;
}
```

In `typescriptBuilder.ts`, pass `scopeNameLiteral` (the function's name as a JS string literal) and `paramNamesLiteral` (`JSON.stringify(params.map(p => p.name))`) where this template is rendered. The `RestoreSignal` rung above stays first and untouched — restores must not be stamped.

- [ ] **Step 5: The block rung (new catch)**

In `blockSetup.mustache`, between the try body's final `return` and the `finally`, insert a catch:

```
} catch (__error) {
  // Level rule for the block frame — see functionCatchFailure.mustache.
  // This is where a saveDraft placed directly inside a guard block gets
  // its partial onto the abort. Blocks have no params: empty name list.
  __stampCarriedDraft(__error, __bstack, {{{scopeNameLiteral}}}, [], __ctx);
  throw __error;
} finally {
```

(`__stampCarriedDraft` no-ops on non-abort errors, so the catch needs no instanceof check of its own. The finally still pops; the catch changes nothing about unwind order. For `scopeNameLiteral` use whatever block identifier the template context already has — check the template's existing variables; `"<enclosing>#block"` shape is fine.)

Add `__stampCarriedDraft` to `imports.mustache`.

- [ ] **Step 6: Regenerate, rebuild, expect fixtures still red**

```bash
pnpm run templates > /tmp/ca-templates.txt 2>&1; tail -3 /tmp/ca-templates.txt
make > /tmp/ca-make3.txt 2>&1; tail -3 /tmp/ca-make3.txt
pnpm run agency test tests/agency/guards/save-draft-basic.agency > /tmp/ca-a3.txt 2>&1; tail -6 /tmp/ca-a3.txt
```

Expected: still FAIL — the carried draft is stamped but nothing reads it yet. That is correct at this point. Also run `pnpm test:run lib/runtime/carriedDraft.test.ts` — green.

- [ ] **Step 7: Commit** — subject `Stamp the carried draft on every unwinding frame (level rule)`.

### Task A4: The guard-boundary reader + the fork-boundary clear

**Files:**
- Modify: `packages/agency-lang/lib/runtime/result.ts` (`__tryCall` owned-guard branch, ~L205-214 on main)
- Modify: `packages/agency-lang/lib/runtime/runBatch.ts` (every site that rethrows a BRANCH's error)
- Test: `packages/agency-lang/lib/runtime/result.test.ts`

**Interfaces:**
- Consumes: `AgencyAbort.carriedDraft` (Task A3); `success` (already in `result.ts`).
- Produces: an owned guard trip with a carried draft returns `success(carriedDraft.value)`; without a carried draft, today's failure exactly. Branch rethrows carry NO carried draft.

- [ ] **Step 1: Write the failing unit test**

In `packages/agency-lang/lib/runtime/result.test.ts`, add (mirror the file's existing `__tryCall` test setup — grep how it constructs a guardTrip cause; reuse its helpers):

```ts
describe("__tryCall salvages the carried draft on an OWNED trip", () => {
  it("returns success(carriedDraft.value) when the abort carries a draft", async () => {
    const abort = new AgencyCancelledError(
      "sleep cancelled",
      makeAbortCause({ kind: "guardTrip", dimension: "time", limit: 100, spent: 140, guardId: "g1" }),
    );
    abort.carriedDraft = { value: "partial-report" };
    const result = await __tryCall(() => { throw abort; }, { ownedGuardIds: ["g1"] });
    expect(isSuccess(result)).toBe(true);
    expect((result as any).value).toBe("partial-report");
  });

  it("returns the failure when the abort carries no carried draft (additive)", async () => {
    const abort = new AgencyCancelledError(
      "sleep cancelled",
      makeAbortCause({ kind: "guardTrip", dimension: "time", limit: 100, spent: 140, guardId: "g1" }),
    );
    const result = await __tryCall(() => { throw abort; }, { ownedGuardIds: ["g1"] });
    expect(isFailure(result)).toBe(true);
  });

  it("an UNOWNED trip propagates with its carried draft intact", async () => {
    const abort = new AgencyCancelledError(
      "x",
      makeAbortCause({ kind: "guardTrip", dimension: "time", limit: 1, spent: 2, guardId: "outer" }),
    );
    abort.carriedDraft = { value: "keep-me" };
    await expect(__tryCall(() => { throw abort; }, { ownedGuardIds: ["inner"] })).rejects.toBe(abort);
    expect(abort.carriedDraft).toEqual({ value: "keep-me" });
  });
});
```

Run: `pnpm test:run lib/runtime/result.test.ts > /tmp/ca-a4.txt 2>&1; tail -20 /tmp/ca-a4.txt` — expected: first test FAILS (returns failure), others pass.

- [ ] **Step 2: Implement the guard-boundary read**

In `result.ts`, the owned branch currently:

```ts
      if (opts?.ownedGuardIds?.includes(guardCause.guardId)) {
        guardCause.delivered = true;
        return failure(
          guardFailureData(guardCause.dimension, guardCause.limit, guardCause.spent),
          opts,
        );
      }
```

becomes:

```ts
      if (opts?.ownedGuardIds?.includes(guardCause.guardId)) {
        guardCause.delivered = true;
        // saveDraft salvage: the unwind carried the guarded block's own
        // partial on the abort (level rule — the carried draft always holds the
        // partial of the frame the error most recently left, which at this
        // boundary is the guarded block). Present -> the guard yields it.
        // Absent -> exactly today's failure. Additive by construction.
        const abort = error as AgencyAbort;
        closeUnwindSpan(abort);
        if (abort.carriedDraft !== undefined) {
          return success(abort.carriedDraft.value);
        }
        return failure(
          guardFailureData(guardCause.dimension, guardCause.limit, guardCause.spent),
          opts,
        );
      }
```

`closeUnwindSpan` goes in `carriedDraft.ts` — delivery is the end of the salvage story, so the span closes here and the final event says what the guard actually returned:

```ts
/** Delivery point: the guard (or any owned-trip consumer) is about to
 *  turn this abort into a value. Emit the closing event and end the
 *  unwind span. No-op when the unwind never touched a partial. */
export function closeUnwindSpan(abort: AgencyAbort): void {
  if (abort.unwindSpanId === undefined) return;
  const client = getRuntimeContext()?.statelogClient;
  client?.abortSalvage({
    action: "delivered",
    partial: abort.carriedDraft !== undefined ? previewForLog(abort.carriedDraft.value) : undefined,
  });
  client?.endSpan(abort.unwindSpanId);
  abort.unwindSpanId = undefined;
}
```

(VERIFY the context-access pattern: `result.ts` has no `ctx` parameter, so use the `getRuntimeContext()` AsyncLocalStorage accessor per `docs/dev/async-context.md`, null-safe — a trip surfacing outside any runtime frame must not crash on telemetry. `AgencyAbort` and `success` are already imported in `result.ts`; verify and add if not.)

- [ ] **Step 3: Clear the carried draft at every branch rethrow in runBatch**

A branch's error object crosses the fork boundary carrying branch-frame stamps. Branch drafts must stay inside their branch: which branch rejects first is nondeterministic in `all` mode, and a single branch's value is the wrong type for the fork's shape. Find every site that rethrows a branch's error — on main these are: the fork-all settle loop (`throw s.reason;`), `runRaceFirstTime`'s catch (`throw err;`), and `runRaceResume`'s catch (`throw err;`). Grep to confirm none were missed: `grep -n "throw s.reason\|throw err" lib/runtime/runBatch.ts`. At each, before the throw:

```ts
      if (s.reason instanceof AgencyAbort) {
        // Branch drafts stay inside their branch: the carried draft must not
        // cross the fork boundary (nondeterministic in "all" mode; wrong
        // type for the fork's shape). Carry-on-abort spec, fork section.
        if (s.reason.carriedDraft !== undefined) {
          ctx.statelogClient?.abortSalvage({
            action: "clearedAtFork",
            partial: previewForLog(s.reason.carriedDraft.value),
          });
        }
        s.reason.carriedDraft = undefined;
      }
```

(adjusting the variable name per site; import `AgencyAbort` and `previewForLog` into `runBatch.ts` if absent). The span is NOT ended here — the abort keeps unwinding in the parent, where parent frames may stamp their own drafts; delivery ends it. The clear event makes the drop visible in the trace.

- [ ] **Step 4: Rebuild and flip the ported fixtures green**

```bash
make > /tmp/ca-make4.txt 2>&1; tail -3 /tmp/ca-make4.txt
for f in packages/agency-lang/tests/agency/guards/save-draft-*.agency; do
  pnpm run agency test "$f" > "/tmp/ca-$(basename $f).txt" 2>&1
  echo "== $(basename $f) =="; tail -3 "/tmp/ca-$(basename $f).txt"
done
```

Expected: ALL 13 ported fixtures PASS. If a fixture whose saveDraft sits in a DEF (not directly in the guard block) fails with a failure-instead-of-salvage, the missing piece is almost certainly the return-position pass-through at the block hop (Task A0's block row) — re-read the table before touching code.

- [ ] **Step 5: Commit** — subject `Guard boundary reads the carried draft; fork boundary clears it`.

### Task A5: New fixtures + unit coverage + sweeps

**Files:**
- Create: `packages/agency-lang/tests/agency/guards/save-draft-deep-only.agency` (+ `.test.json`)
- Create: `packages/agency-lang/tests/agency/guards/save-draft-return-chain.agency` (+ `.test.json`)
- Create: `packages/agency-lang/tests/agency/guards/save-draft-branch-trip.agency` (+ `.test.json`)
- Create: `packages/agency-lang/tests/agency-js/save-draft-plain-error/` (Step 2b)

**Interfaces:** consumes everything above; produces the level-rule, pass-through, fork-isolation, and plain-error pins.

- [ ] **Step 1: The level-rule pin (deliberate behavior change vs #551)**

`save-draft-deep-only.agency`:

```
import { guard, saveDraft } from "std::thread"

// Only the DEEP level saves, and code() consumes verify() via an
// ASSIGNMENT (`const x = ...` — not return position), so the level rule
// erases the carried draft at code's boundary and the guard FAILS. Under
// #551's deep-fallback this salvaged "verify-draft"; that fallback is
// removed on purpose: salvage is opt-in per level. This fixture also pins
// that pass-through does NOT apply to assignments — contrast with
// save-draft-return-chain, where `return verify()` DOES pass through.
def verify(): string {
  saveDraft("verify-draft")
  const reply = llm("Reply with: pong")
  return reply
}

def code(): string {
  const x = verify()
  return x
}

node main() {
  const result = guard(cost: 0.000001) as {
    return code()
  }
  if (isFailure(result)) { return "failed-as-designed" }
  return "leaked:${result.value}"
}
```

`.test.json`: `"expectedOutput": "\"failed-as-designed\""`, `"useTestLLMProvider": true`, `"llmMocks": [{ "return": "pong" }]`.

- [ ] **Step 2: The branch-originated-trip pin**

`save-draft-branch-trip.agency`:

```
import { guard, saveDraft } from "std::thread"

// The trip fires INSIDE a fork branch. The branch's frames stamp their
// drafts onto the branch's abort, but runBatch clears the carried draft at the
// fork boundary, so the outer guard fails rather than salvaging one
// branch's value (nondeterministic and wrong-typed for the fork). The
// existing guard-outside-fork fixture covers only a parent-side trip.
def branchWork(tag: string): string {
  saveDraft("branch-${tag}")
  sleep(2s)
  return tag
}

node main() {
  const result = guard(time: 600ms) as {
    fork(["a"]) as tag {
      return branchWork(tag)
    }
    return "joined"
  }
  if (isFailure(result)) { return "failed-no-branch-salvage" }
  return "leaked:${result.value}"
}
```

`.test.json`: `"expectedOutput": "\"failed-no-branch-salvage\""`, exact. (Time budget ≥500ms per the CI-jitter rule; the branch's clone trips during its 2s sleep, per the #549 per-branch semantics.)

- [ ] **Step 2a: The return-position pass-through pin**

`save-draft-return-chain.agency`:

```
import { guard, saveDraft } from "std::thread"

// Only the DEEP level saves, but every hop up is a return-position call:
// verify's draft is verify's forced return, `return verify()` makes it
// code's forced return, and `return code()` carries it to the guard.
// Contrast with save-draft-deep-only, where an assignment breaks the chain.
def verify(): string {
  saveDraft("verify-draft")
  const reply = llm("Reply with: pong")
  return reply
}

def code(): string {
  return verify()
}

node main() {
  const result = guard(cost: 0.000001) as {
    return code()
  }
  if (isFailure(result)) { return "no-salvage" }
  return result.value
}
```

`.test.json`: `"expectedOutput": "\"verify-draft\""`, `"useTestLLMProvider": true`, `"llmMocks": [{ "return": "pong" }]`.

- [ ] **Step 2b: Pin that a plain thrown error never salvages (owner review round)**

The rung stamps ONLY `AgencyAbort`. A regular exception takes the existing convert-to-failure path and the draft is never consulted — an unexpected failure must surface as a failure, not be papered over with a stale draft. Pin it with an agency-js test (mirror an existing `tests/agency-js/` test that imports a JS module — grep for one and copy its layout): the JS module exports `function boom() { throw new Error("boom"); }`; the Agency side is

```
def work(): string {
  saveDraft("draft-must-not-leak")
  boom()
  return "unreachable"
}

node main() {
  const result = guard(cost: 1.0) as {
    return work()
  }
  if (isFailure(result)) { return "failed-as-expected" }
  return "leaked:${result.value}"
}
```

Expected output: `"failed-as-expected"`.

- [ ] **Step 3: Run both new fixtures + the full guards sweep + subprocess sample**

```bash
for f in tests/agency/guards/*.agency; do
  r=$(pnpm run agency test "$f" 2>&1 | grep -cE "✗"); n=$(basename "$f" .agency)
  if [ "$r" != "0" ]; then echo "FAIL: $n"; else echo "ok: $n"; fi
done | tee /tmp/ca-guards-sweep.txt | grep -c "^ok"
grep FAIL /tmp/ca-guards-sweep.txt
for f in nested-pause-resume run-max-cost nested-pause-maxcost pause-fork-mixed; do
  echo "== $f"; pnpm run agency test "tests/agency/subprocess/$f.agency" 2>&1 | grep -cE "✗"
done
```

Expected: zero FAILs in guards; zero `✗` in the subprocess sample (the rungs changed for every compiled function — the subprocess suite is the #513 alarm).

- [ ] **Step 4: Checker + runtime unit suites**

`pnpm test:run lib/typeChecker lib/runtime > /tmp/ca-units.txt 2>&1; tail -5 /tmp/ca-units.txt` — expected green. Then `pnpm run lint:structure`.

- [ ] **Step 5: Commit** — subject `Pin the level rule and fork-boundary isolation with fixtures`.

### Task A6: Docs + PR A

- [ ] **Step 1:** `make` regenerates `docs/site/stdlib/thread.md` from the `saveDraft` docstring; verify with `grep -n saveDraft docs/site/stdlib/thread.md | head`. Commit regenerated docs. Do NOT touch `docs/site/guide/guards.md`.
- [ ] **Step 2:** Commit this plan + the rev-2 spec if not already on the branch (`git add docs/superpowers/`).
- [ ] **Step 3:** Push `save-draft-carry`; open PR A titled `saveDraft: carry the draft on the abort (level rule)`. Body: the carried-draft mechanism, the four-rung level rule (erase + return-position pass-through), the behavior change vs #551 (deep fallback removed, with the walked example), fork-boundary clearing, what got deleted relative to #551 and why, and the finalize slot this is shaped for. Reference the closed #551, the rev-2 spec, and the resumable-guards follow-up spec (`2026-07-15-resumable-guards-design.md` — reject in that design reuses this PR's machinery unchanged). Wait for review/merge before starting PR B tasks.

---

# PR B — the `finalize` keyword

Cut `save-draft-finalize` from `save-draft-carry` (or from main after PR A merges). Read `docs/dev/adding-features.md` (AST-node checklist) before B1.

### Task B1: Parser + AST + formatter for `finalize { }`

**Files:**
- Modify: `packages/agency-lang/lib/parsers/parsers.ts` (statement parser)
- Modify: the AST node type definitions (find via `grep -rn "handleBlock" lib/types* lib/parsers/parsers.ts` — mirror `handleBlock`'s type + registration exactly)
- Modify: the formatter/AgencyGenerator (find via `grep -rln "handleBlock" lib/` outside parsers — every file that switches on `handleBlock` needs a `finalizeBlock` arm)
- Test: co-located parser test next to the existing block-parser tests

**Interfaces:**
- Produces: AST node `{ type: "finalizeBlock", body: <statement list>, loc }`, parseable at statement position inside def/node/guard-block bodies. B2 and B3 consume it.

- [ ] **Step 1:** Read how `handle { } with (e) { }` is parsed (`grep -n "handle" lib/parsers/parsers.ts`) and copy its structure for a simpler no-suffix form: keyword `finalize`, then a braced statement list. Write the parser test FIRST (mirror the sibling handle-block parser test's harness — do not invent one): `finalize { return 1 }` inside a def parses to a `finalizeBlock` node; `finalize` as a variable name still parses as an identifier if the grammar allows (check how `handle` handles this and match).
- [ ] **Step 2:** Implement, then verify end-to-end with a probe: write `tmp/finalize-probe.agency` containing the spec's walked example and run `pnpm run ast tmp/finalize-probe.agency > /tmp/cb-ast.txt 2>&1` — the finalizeBlock node appears with the right body.
- [ ] **Step 3:** Formatter arm: `pnpm run fmt tmp/finalize-probe.agency` round-trips the block (prints `finalize {` + indented body + `}`).
- [ ] **Step 4:** Commit — subject `Parse and format finalize blocks`.

### Task B2: Checker rules for finalize

**Files:**
- Modify: `packages/agency-lang/lib/typeChecker/checker.ts` (+ the interrupt-analysis pass — `grep -rn "checkCallbackBodyInterrupts" lib/typeChecker/`)
- Test: `packages/agency-lang/lib/typeChecker/finalize.test.ts` (same harness as `saveDraft.test.ts`, ported in A1)

**Interfaces:**
- Consumes: `finalizeBlock` AST (B1); `checkSaveDraftCall`'s harness patterns; `info.returnType` per scope.
- Produces: four checks — return-type, structural, no-interrupts, no-saveDraft — plus the nullable-locals rule (see the decision gate).

- [ ] **Step 1: Write the failing checker tests** (one `it` per rule, both accept and reject where meaningful):

```ts
// finalize returns check against the enclosing return type
def f(): string { finalize { return "ok" } return "x" }      // no error
def f(): string { finalize { return 42 } return "x" }        // error
// at most one, top-level only
def f(): string { finalize { return "a" } finalize { return "b" } return "x" }   // error
def f(): string { if (true) { finalize { return "a" } } return "x" }             // error
// no interrupts, no saveDraft inside
def f(): string { finalize { interrupt("no") return "a" } return "x" }           // error
def f(): string { finalize { saveDraft("no") return "a" } return "x" }           // error
// no interrupts INDIRECTLY either: the finalize calls a def that interrupts
def asker(): string { interrupt("ask") return "a" }
def f(): string { finalize { return asker() } return "x" }                       // error
```

The indirect case is load-bearing (owner review round): a finalize runs in a catch rung with no step counters, so an interrupt reaching it at runtime is unresumable no matter where it originated. Check what `checkCallbackBodyInterrupts` does for transitive calls (it may lean on `raises` tracking). If it catches them, the finalize check inherits that for free. If it does NOT, do two things: flag the shared callback gap to the owner (do not silently accept it), and add a runtime backstop in B3 — if an interrupt signal escapes `__finalize`, treat it exactly like a finalize error (statelog + fall back to draft/erase) rather than letting an unresumable interrupt propagate.

(Write these as real `check(...)` calls in the harness, one test per case; run to confirm all reject-cases currently pass with zero diagnostics — that is the red state.)

- [ ] **Step 2: Implement.** Return-type: feed the finalize body's `return` statements through the same machinery `checkReturnTypesInScope` uses for the enclosing scope's returns, against the enclosing `info.returnType`. Structural: while walking a scope body, count `finalizeBlock` nodes at the top level (error on the second) and error on any `finalizeBlock` found nested below the top level. No-interrupts: apply the same analysis `checkCallbackBodyInterrupts` applies to callback bodies. No-saveDraft: walk the finalize body for `saveDraft` calls (reuse the name-keyed detection from `checkSaveDraftCall`).
- [ ] **Step 3 — DECISION GATE (nullable locals).** The spec's rule: inside a finalize body, every local reads as `T | null`. Investigate whether the flow-narrowing machinery (see `docs/dev/typechecker/narrowing/`) supports a scope-level "all locals nullable here" context cheaply. If yes, implement it and add two tests (unguarded use of a local errors; a `!= null` guard narrows). If it requires invasive changes, STOP and present the owner two options with the cost of each: (a) invasive-but-sound now, (b) document-and-defer with a tracking issue. Do not silently pick (b).
- [ ] **Step 4:** Run `pnpm test:run lib/typeChecker > /tmp/cb-tc.txt 2>&1` — green, no regressions. Commit — subject `Type-check finalize blocks`.

### Task B3: Codegen — run the finalize in the rung, bind partials into locals

**Files:**
- Modify: `packages/agency-lang/lib/backends/typescriptBuilder.ts` (def compilation: emit `__finalize`, pass `hasFinalize` to the catch template; call-expression wrappers in finalize-bearing scopes)
- Modify: `packages/agency-lang/lib/templates/backends/typescriptGenerator/functionCatchFailure.mustache` (the finalize branch of the level rule)
- Modify: `packages/agency-lang/lib/templates/backends/typescriptGenerator/blockSetup.mustache` (same, for guard blocks with a finalize)
- Modify: `packages/agency-lang/lib/runtime/carriedDraft.ts` (created in A3 — add the two binding helpers + tests)

**Interfaces:**
- Consumes: `finalizeBlock` AST (B1); `AgencyAbort.carriedDraft` (A3).
- Produces: `__finalize` — a generated inner `async` function executing in the SAME frame; `__bindCarriedDraft(e, assign)` and `__dropCarriedDraft(thunk)` runtime helpers.

- [ ] **Step 1: The runtime helpers first (unit-tested):**

```ts
// lib/runtime/carriedDraft.ts (appended below __stampCarriedDraft)
import { AgencyAbort } from "./errors.js";

/** Statement-level call binding for finalize-bearing scopes: when the call's
 *  abort carries a carried draft, deliver the partial into the local the call's result
 *  was headed for, then let the abort continue. Consume-once: the carried draft is
 *  cleared so an enclosing binder cannot double-deliver it. */
export function __bindCarriedDraft(e: unknown, assign: (v: unknown) => void): void {
  if (e instanceof AgencyAbort) {
    assign(e.carriedDraft !== undefined ? e.carriedDraft.value : null);
    e.carriedDraft = undefined;
  }
}

/** Nested (non-statement-level) call expressions: their partial has no
 *  variable to land in. Drop the carried draft so it cannot bind to the WRONG local
 *  (in `x = f(g())`, g's partial must not land in the f-typed x). */
export async function __dropCarriedDraft<T>(thunk: () => Promise<T>): Promise<T> {
  try {
    return await thunk();
  } catch (e) {
    if (e instanceof AgencyAbort) {
      e.carriedDraft = undefined;
    }
    throw e;
  }
}
```

Unit tests in `carriedDraft.test.ts`: bind delivers value + clears; bind delivers null when no carried draft; drop clears and rethrows the same object; non-abort errors pass both untouched.

- [ ] **Step 2: Compile the finalize body.** In `processFunctionDefinition`, when the body contains a `finalizeBlock`: remove it from the normal statement stream and compile its statements via `processBodyAsParts` under a FRESH `Runner` over the same `__stack`, with `scopeName` = `<functionName>#finalize` so its `__substep_*` keys cannot collide with the body's. Emit into `setupStmts`:

```ts
const __finalize = async (): Promise<any> => {
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: ..., scopeName: "<fn>#finalize" });
  /* compiled finalize statements */
  return runner.halted ? runner.haltResult : undefined;
};
```

(`return x` inside the compiled body lowers to `runner.halt(x)` — the same lowering blocks use — so the halt result IS the finalize's return value. Interrupts are statically impossible here per B2, so a halt can only be a value.) Verify this compilation shape against how `handle` bodies compile in-frame before writing it; if handle bodies use a different closure shape, mirror that instead.

- [ ] **Step 3: The rung branch.** Pass `hasFinalize` into `renderFunctionCatchFailure`; the rung becomes:

```
if (__error instanceof AgencyAbort) {
{{#hasFinalize}}
  try {
    __stampCarriedDraft(__error, __stack, {{{scopeNameLiteral}}}, {{{paramNamesLiteral}}}, __ctx, { value: await __finalize() });
  } catch (__finalizeError) {
    // A finalize error never masks the trip: statelog it, fall back as if
    // the finalize did not exist (own draft or erase), keep unwinding.
    __ctx.statelogClient?.error?.({ errorType: "finalizeError", message: String(__finalizeError), functionName: {{{scopeNameLiteral}}} });
    __stampCarriedDraft(__error, __stack, {{{scopeNameLiteral}}}, {{{paramNamesLiteral}}}, __ctx);
  }
{{/hasFinalize}}
{{^hasFinalize}}
  __stampCarriedDraft(__error, __stack, {{{scopeNameLiteral}}}, {{{paramNamesLiteral}}}, __ctx);
{{/hasFinalize}}
  throw __error;
}
```

(The finalize result rides through `__stampCarriedDraft`'s `finalizeResult` parameter, so a finalize's return shows up in the statelog trail as a "carried" event exactly like a draft would.)

Same branch structure in `blockSetup.mustache`'s catch for guard blocks that declare a finalize. `pnpm run templates` after.

- [ ] **Step 4: The binding wrappers.** In finalize-bearing scopes ONLY: statement-level assignments whose right-hand side is a single call (`__stack.locals.x = await __call(...)`) compile to:

```ts
try {
  __stack.locals.x = await __call(...);
} catch (__e) {
  __bindCarriedDraft(__e, (__v) => { __stack.locals.x = __v; });
  throw __e;
}
```

Non-statement-level call expressions in those scopes compile through `__dropCarriedDraft(() => __call(...))`. Add both helpers to `imports.mustache`. Scopes with no finalize compile exactly as today (zero cost).

- [ ] **Step 5:** `pnpm run templates && make`; run the whole `save-draft-*` fixture set from PR A — all still green (finalize absent means byte-identical rung behavior). Commit — subject `Compile finalize blocks into the catch rung with partial binding`.

### Task B4: Execution fixtures for finalize

**Files:** create in `packages/agency-lang/tests/agency/guards/`:

- [ ] `finalize-consumes-partial.agency` — the spec's walked example, made concrete:

```
import { guard, saveDraft } from "std::thread"

def verify(): string {
  saveDraft("v-partial")
  const reply = llm("Reply with: pong")
  return reply
}

def code(): string {
  const x = verify()
  return x

  finalize {
    if (x != null) { return "combined:${x}" }
    return "no-inner"
  }
}

node main() {
  const result = guard(cost: 0.000001) as {
    return code()
  }
  if (isFailure(result)) { return "unexpected" }
  return result.value
}
```

Expected output: `"combined:v-partial"` — verify's partial reached `code`'s finalize through the local `x`, and the finalize's return reached the guard. This is the load-bearing fixture; its expected value comes straight from the spec's walked example.

- [ ] `finalize-nested-call-binding.agency` — the `f(g())` rule, both directions: g trips → the finalize sees `x == null`; restructure so f trips → the finalize sees f's partial. Expected outputs `"g-tripped:x-null"` and `"f-tripped:f-partial"` (two nodes in one fixture).
- [ ] `finalize-error-falls-back.agency` — the finalize throws (e.g. calls a def that throws); the frame saved a draft first; expect the guard to salvage the DRAFT, and the run not to crash.
- [ ] `finalize-in-guard-block.agency` — a finalize directly inside `guard(...) as { ... }`; expect its return to be the salvage.
- [ ] Run all four + the full guards sweep + the subprocess sample (same loops as A5). Commit — subject `Pin finalize semantics with execution fixtures`.

### Task B5: Docs + PR B

- [ ] Docstring for finalize goes in the language guide's source of truth for keywords — find where `handle` is documented under `docs/site/guide/` EXCEPT `guards.md` (owner-owned; if finalize belongs there, leave a carried draft in the PR body offering the text instead of editing). Regenerate stdlib docs (`make`).
- [ ] Push; open PR B titled `Add finalize blocks: convert a callee's partial on a guard trip`. Body: the fold model with the walked example and its carried-draft values, the four body rules, the binding rules with the `f(g())` case, the nullable-locals decision from B2's gate, and the deferred items (shielding + grace budget, fork-array salvage).

---

## Self-Review

**Spec coverage:** carriedDraft field → A3; level rule incl. erase → A3 (four rungs in `__stampCarriedDraft`); return-position pass-through → A3 Step 3b (`__markReturnCarry` + codegen) + A5 return-chain/deep-only pins; guard read → A4; fork clear → A4 (all three rethrow sites + grep guard); behavior change + pin → A1 Step 3 + A5 deep-only; branch-trip fixture → A5; plain-error no-salvage pin → A5 Step 2b; block catch → A3; `State.savedDraft` serialization → A2; statelog span + salvage events → A3 (`__stampCarriedDraft`/`abortSalvage`) + A4 (`closeUnwindSpan`, fork-clear event); universal stamping (cause-agnostic) → A3 stamps every `AgencyAbort`; finalize keyword/one-per-scope/top-level → B1+B2; finalize body rules (no-mask, no-interrupt, no-saveDraft, computational-v1) → B2+B3 (computational-v1 needs no code — the aborted signal already cancels leaf ops; documented in B5); locals binding + consume-once + `f(g())` → B3 helpers + B4 fixture; nullable locals → B2 decision gate (explicitly not silent); root-budget hook, shielding, grace budget, fork-array → deferred, named in PR bodies.

**Placeholder scan:** B1/B2 contain "mirror handle / mirror the sibling harness" instructions — deliberate: the parser and checker harness APIs must match the codebase, and the steps name the exact grep to find the precedent. B2 Step 3 and B3 Step 2 are explicit DECISION/VERIFY gates, not placeholders — each states the options and forbids silent fallback.

**Type consistency:** `carriedDraft?: { value: unknown }` (A3) matches the A4 read and B3 write; `State.savedDraft?: { value: any }` (A2) matches `__stampCarriedDraft`'s read; `__stampCarriedDraft(error, frame, scopeName, paramNames, ctx, finalizeResult?)` matches all four call sites (def rung, block rung, B3 finalize branch, B3 fallback); `_saveDraft(value: unknown)` matches the ported `saveDraft(value: any)` def; `__bindCarriedDraft`/`__dropCarriedDraft` names match between B3 Step 1, Step 4, and `imports.mustache`.

**The two riskiest steps are flagged as verify-first:** B3 Step 2 (finalize body compilation shape — verify against how handle bodies compile before writing) and B2 Step 3 (nullable locals). Everything in PR A is written against code read from `origin/main` this session.
