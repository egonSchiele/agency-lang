# Builtin Cost Guards

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `guard(cost: $2.0) as { ... }` stdlib function that aborts its block when the cost of LLM calls inside it exceeds the limit, and returns a `Result<T, GuardFailureData>` so the user can decide what to do.

**Reference spec:** [`docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md`](../specs/2026-05-20-cost-and-guard-tracking-design.md) — the canonical design. This plan is the V1 implementation of that spec with the open questions resolved as below.

**Reference prior work:** Per-branch cost accumulation already exists from commit c695d411 (`StateStack.localCost`, `seedCost`, `propagateBranchCost`). This plan piggybacks on the cost-accumulation site at [`prompt.ts:177`](../../lib/runtime/prompt.ts#L177).

**Reference for the runtime mechanism:** Guards throw a JS `GuardExceededError` (not an interrupt). The thrown error propagates up through normal error propagation until the `guard` stdlib function's `try` keyword catches it and returns a `Failure`. This deliberately does NOT use the callback-interrupt mechanism — see the sister plan `2026-05-23-remove-callback-interrupts.md`.

---

## Open questions resolved (V1)

| Question | V1 answer |
| --- | --- |
| Surface syntax | `guard(cost: $2.0) as { ... }` — agency's standard trailing-block convention + named params + the existing `$` unit literal that compiles to a plain number. |
| Cost vs timeout | Cost only. `maxTime`/`actualTime` fields absent in V1; the failure shape's `type` field reserves space for `"timeoutFailure"` in V2 without breaking V1 consumers. |
| Fork cost merging | Documented limitation. Costs propagate to the outer guard only after the fork completes (existing `propagateBranchCost` semantics). An in-progress outer guard does NOT see in-flight branch spend. |
| Memory layer costs | Excluded from V1. Memory `text`/`embed` calls bypass the guard. Documented; tracked as a follow-up. |
| Unit literals | Use the existing `$` literal in examples; `guard(cost: $2.0)` is exactly equivalent to `guard(cost: 2.0)` because `$` is a no-op compile-time scale factor. |
| Block scoping | Falls out for free: `guard` takes a block, the block has its own scope, only the block's `return` value escapes into `result`. No new scoping rules needed. |

---

## Files to create / modify

### New files
- `lib/runtime/guard.ts` — `GuardEntry` type, `GuardExceededError` class, type guard helpers.
- `lib/runtime/guard.test.ts` — unit tests for the error class + entry shape.
- `tests/agency/guards/guard-cost-trip.agency` + `.test.json`
- `tests/agency/guards/guard-cost-no-trip.agency` + `.test.json`
- `tests/agency/guards/guard-nested.agency` + `.test.json`
- `tests/agency/guards/guard-cost-fork.agency` + `.test.json` (documents the fork-merge limitation)
- `docs/site/stdlib/guard.md` — stdlib reference page.

### Modified files
- `lib/runtime/state/stateStack.ts` — add `guards: GuardEntry[]` field + `pushGuard` / `popGuard` methods; serialize in `toJSON`/`fromJSON`.
- `lib/runtime/prompt.ts` — after `targetStack.localCost += ...` (line 177-ish), walk active guards and throw `GuardExceededError` if any tripped.
- `lib/codegenBuiltins/contextInjected.ts` — register `__internal_pushGuard` and `__internal_popGuard`.
- `lib/stdlib/thread.ts` — TS implementations for the two builtins.
- `stdlib/thread.agency` — agency-side `guard` function + `GuardFailureData` type alias.
- `lib/typechecker/` — recognize the `guard` symbol with its generic signature, if stdlib pickup is insufficient (Task 7).

---

## Task 1: Add `GuardEntry`, `GuardExceededError`, and `GuardFailureData`

**Files:**
- Create: `lib/runtime/guard.ts`
- Create: `lib/runtime/guard.test.ts`

- [ ] **Step 1: `lib/runtime/guard.ts`**

```ts
/**
 * Per-guard scope state. Held on `StateStack.guards` as an array;
 * `pushGuard` appends, `popGuard` removes the last entry. Serialized
 * with the rest of the stack via `toJSON`/`fromJSON` so guards
 * survive interrupt + resume cycles.
 *
 * V1 only supports cost guards. The shape leaves room for additional
 * limit types (e.g. `timeoutMs`) without forcing a breaking change to
 * GuardFailureData consumers.
 */
export type GuardEntry = {
  /** The limit, in dollars. */
  costLimit: number;
  /** Stack cost at the moment this guard scope opened. The guard trips
   *  when `(currentLocalCost - costAtPush) > costLimit`. Storing the
   *  baseline keeps the check independent of any siblings' cost that
   *  was already on the stack before the guard scope began. */
  costAtPush: number;
};

/**
 * Thrown by `prompt.ts` immediately after an LLM call's cost is
 * accumulated into `targetStack.localCost`, when any active guard's
 * spend has exceeded its limit. Propagates as a normal JS error
 * through the call stack; the `guard` stdlib function's `try` catches
 * it and returns a Failure.
 *
 * Deliberately not an interrupt — see
 * `docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md`
 * sections "Mechanism" and "Layer 2: stdlib function".
 */
export class GuardExceededError extends Error {
  constructor(
    public readonly type: "cost",
    public readonly limit: number,
    public readonly spent: number,
  ) {
    super(`guard exceeded: ${type} limit ${limit}, spent ${spent}`);
    this.name = "GuardExceededError";
  }
}

export function isGuardExceededError(e: unknown): e is GuardExceededError {
  return e instanceof GuardExceededError;
}
```

- [ ] **Step 2: Tests**

`lib/runtime/guard.test.ts` — minimal:
- Constructs a `GuardEntry` with the expected shape.
- Constructs a `GuardExceededError`; checks `instanceof`, `name`, `type`, `limit`, `spent`.
- `isGuardExceededError` returns true for the error and false for a plain `Error`.

- [ ] **Step 3: Run**

```bash
pnpm test:run -- guard > /tmp/guard.log 2>&1
```

- [ ] **Step 4: Commit**

---

## Task 2: Add `guards` to `StateStack` with serialization

**Files:**
- Modify: `lib/runtime/state/stateStack.ts`
- Modify: `lib/runtime/state/stateStack.test.ts`

- [ ] **Step 1: Add the field**

```ts
import type { GuardEntry } from "../guard.js";

export class StateStack {
  // ...existing fields (localCost, localTokens, seedCost, etc.) ...

  /** Active guard scopes on this stack, innermost last. Walked after
   *  every LLM cost accumulation in prompt.ts to enforce limits.
   *  See lib/runtime/guard.ts. */
  guards: GuardEntry[] = [];

  pushGuard(entry: GuardEntry): void {
    this.guards.push(entry);
  }

  popGuard(): GuardEntry | undefined {
    return this.guards.pop();
  }
}
```

- [ ] **Step 2: Serialize**

In `toJSON`:
```ts
return {
  // ...existing fields...
  guards: this.guards,  // GuardEntry is plain JSON-safe data
};
```

In `fromJSON`:
```ts
stateStack.guards = json.guards ?? [];
```

(The nullish coalesce handles checkpoints written before this field existed.)

- [ ] **Step 3: Update `StateStackJSON` type**

Add `guards?: GuardEntry[]` to the JSON shape declaration.

- [ ] **Step 4: Branch seeding**

When `Runner.seedBranchCost` clones cost state onto a child branch, also clone the guard list — branches inherit their parent's active guards so cost within the branch counts toward an outer guard:

```ts
private seedBranchCost(branchStack: StateStack, parentStack: StateStack): void {
  if (branchStack.localCost === 0 && branchStack.localTokens === 0) {
    branchStack.localCost = parentStack.localCost;
    branchStack.localTokens = parentStack.localTokens;
    branchStack.seedCost = parentStack.localCost;
    branchStack.seedTokens = parentStack.localTokens;
  }
  // NEW: clone parent guards so the child's LLM calls are checked
  // against ancestor limits. Per-entry deep-copy keeps the parent's
  // entries safe from mutation if the child later pushes its own.
  branchStack.guards = parentStack.guards.map(g => ({ ...g }));
}
```

NOTE: this means a child branch can have guard entries with `costAtPush` that reference the PARENT's baseline at branch-creation time. That's correct: the parent's guard checks "delta from when the guard opened" — including delta produced inside the branch — once costs propagate back via `propagateBranchCost`. **But** because that propagation only fires at branch completion, the outer guard cannot trip mid-fork from a child's spend. Document this limitation in Task 9.

- [ ] **Step 5: Tests**

Extend `stateStack.test.ts`:
- Push two guards, pop one; verify the array.
- `toJSON` round-trip preserves `guards`.
- `seedBranchCost` clones parent guards onto child stack.

- [ ] **Step 6: Run**

```bash
make
pnpm test:run -- stateStack guard > /tmp/stack.log 2>&1
```

- [ ] **Step 7: Commit**

---

## Task 3: Register `__internal_pushGuard` and `__internal_popGuard` as context-injected builtins

**Files:**
- Modify: `lib/codegenBuiltins/contextInjected.ts`

Follow the existing pattern for `__internal_getCost` / `__internal_getTokens` (lines 148–154 of that file).

- [ ] **Step 1: Add registry entries**

```ts
__internal_pushGuard: {
  name: "__internal_pushGuard",
  // ... follow the shape of __internal_getCost / __internal_getTokens ...
  // Both functions take a (stack-bearing) prefix and one positional arg.
},
__internal_popGuard: {
  name: "__internal_popGuard",
  // ... no positional args; just the prefix ...
},
```

Match whatever the per-entry shape is in the existing registry — both signature info and the import target (`lib/stdlib/thread.ts`).

- [ ] **Step 2: Tests**

Extend `contextInjected.test.ts` if it tests the registry shape — confirm the two new entries are present and have the right argument arities.

- [ ] **Step 3: Run**

```bash
pnpm test:run -- contextInjected > /tmp/ctxinj.log 2>&1
```

- [ ] **Step 4: Commit**

---

## Task 4: TS implementations in `lib/stdlib/thread.ts`

**Files:**
- Modify: `lib/stdlib/thread.ts`

Follow the existing pattern (`__internal_getCost`, `__internal_getTokens`).

- [ ] **Step 1: Add the two functions**

```ts
import type { GuardEntry } from "../runtime/guard.js";

export async function __internal_pushGuard(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  costLimit: number,
): Promise<void> {
  stack.pushGuard({ costLimit, costAtPush: stack.localCost });
}

export async function __internal_popGuard(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
): Promise<void> {
  stack.popGuard();
}
```

`costAtPush` captures the baseline at push time so the guard's "spent" reading is `stack.localCost - guard.costAtPush`, not the absolute `localCost` (which would include cost spent before the guard scope opened).

- [ ] **Step 2: Type test**

`make` should compile the new TS without error.

- [ ] **Step 3: Commit**

---

## Task 5: Wire the cost check into `prompt.ts`

**Files:**
- Modify: `lib/runtime/prompt.ts`

The existing cost-accumulation site is around line 177:
```ts
targetStack.localCost += completion.cost?.totalCost ?? 0;
targetStack.localTokens += completion.usage?.totalTokens ?? 0;
```

Immediately after these two lines, walk the active guards and throw if any tripped.

- [ ] **Step 1: Add the check**

```ts
import { GuardExceededError } from "./guard.js";

// ... after the existing localCost/localTokens increments ...
for (const guard of targetStack.guards) {
  const spent = targetStack.localCost - guard.costAtPush;
  if (spent > guard.costLimit) {
    throw new GuardExceededError("cost", guard.costLimit, spent);
  }
}
```

Walk in declaration order (innermost last) — when multiple guards have tripped on the same call, the OUTER guard's entry comes first in the array, so the loop reports the outermost-tripped first. That matches user intuition: "your $10 outer guard tripped" is a stronger signal than "your $1 inner guard tripped" when both fire simultaneously, because the outer trip means the user blew an even bigger budget.

Actually reconsider: innermost-first is the more common intuition (tightest limit fires first). Re-read the spec — it says "all active guards are updated, not just the innermost" but doesn't say which trip is reported. Pick innermost-first (loop in reverse):

```ts
for (let i = targetStack.guards.length - 1; i >= 0; i--) {
  const guard = targetStack.guards[i];
  const spent = targetStack.localCost - guard.costAtPush;
  if (spent > guard.costLimit) {
    throw new GuardExceededError("cost", guard.costLimit, spent);
  }
}
```

Document the choice in the loop's comment.

- [ ] **Step 2: Verify the throw is caught only by `guard`'s `try`**

Inspect the surrounding code in `_runPrompt`. The throw should propagate up through:
- `_runPrompt` (no surrounding try/catch that would swallow it — the `AgencyCancelledError` / `PromptBailout` catches are class-specific).
- `runPrompt`'s outer try (same — class-specific).
- The user's `llm()` call site.
- The user's function body (auto-wrapped in try/catch by codegen — this is the boundary to verify).

Critical: the function-body auto-wrap MUST re-throw `GuardExceededError`. If it converts the error to a Failure return value (the auto-wrap's normal behavior for unexpected JS errors), the guard mechanism breaks.

Two options:
- (a) Make the auto-wrap class-aware: re-throw `GuardExceededError` (and `AgencyCancelledError`, `RestoreSignal` — already special-cased).
- (b) Catch in the runner one level out — but the runner is the wrong layer; we want the error to propagate THROUGH the runner up to the `guard` function's body.

Pick (a). Find the codegen template or runtime helper that emits the auto-wrap; add `GuardExceededError` to its class allow-list.

- [ ] **Step 3: Run prompt-related tests**

```bash
pnpm test:run -- prompt > /tmp/prompt-guard.log 2>&1
```

Nothing should regress (no guards in flight yet means the loop is a no-op).

- [ ] **Step 4: Commit**

---

## Task 6: Agency-side `guard` function

**Files:**
- Modify: `stdlib/thread.agency`

- [ ] **Step 1: Add the type alias**

```
export type GuardFailureData = {
  type: "guardFailure"
  maxCost: number
  actualCost: number
}
```

(`maxTime` / `actualTime` are intentionally absent in V1. When timeout lands, add them as optional fields — `maxTime?: number` etc. — and existing V1 consumers continue working.)

- [ ] **Step 2: Add the `guard` function**

```
/**
 * Run a block with a cost limit. If LLM calls inside the block
 * cause the cumulative cost to exceed the limit, the block halts
 * and `guard` returns a failure carrying the limit and actual spend.
 *
 * On success, returns `success(blockReturnValue)`. The block's local
 * variables are scoped to the block — only the block's return value
 * is observable from the caller.
 *
 * @param cost - Maximum cost in dollars (e.g. $2.00 or 2.00)
 * @param block - The work to run under the guard
 *
 * Example:
 *   const result = guard(cost: $2.0) as {
 *     const a = llm("step 1")
 *     const b = llm("step 2")
 *     return process(a, b)
 *   }
 *   if (isFailure(result)) {
 *     print("Budget exceeded: spent " + result.data.actualCost)
 *   } else {
 *     print(result.value)
 *   }
 */
export def guard<T>(cost: number, block: () => T): Result<T, GuardFailureData> {
  __internal_pushGuard(cost)
  const result = try block()
  __internal_popGuard()
  return result
}
```

Notes:
- `try block()` converts any thrown error (including `GuardExceededError`) to a `Failure` value. The `data` field will be the error's data — make sure the `try` machinery maps `GuardExceededError` to `failure({ type: "guardFailure", maxCost, actualCost })`. If the existing `try` keyword doesn't apply that mapping by default (i.e. it just wraps the raw error), wrap manually:
  ```
  const result = try block()
  __internal_popGuard()
  if (isFailure(result)) {
    // Re-shape if the failure came from a GuardExceededError
    // (try keyword's default failure shape is {error, retryable, ...})
    if (result.data.name == "GuardExceededError") {
      return failure({
        type: "guardFailure",
        maxCost: result.data.limit,
        actualCost: result.data.spent,
      })
    }
    return result  // some other error — propagate as-is
  }
  return result
  ```
  Verify which behavior `try` has by reading `docs/site/guide/error-handling.md` or grep the codebase.
- Use the block param directly (`block()`), do NOT copy to a local — see [Blocks guide → limitation](https://agency-lang.com/guide/blocks.html). Resume safety depends on this.

- [ ] **Step 3: Verify the agency code parses and typechecks**

```bash
pnpm run ast stdlib/thread.agency > /tmp/thread-ast.log
make
```

If the typechecker complains about the generic `<T>` or the `() => T` block param type, jump to Task 7 (typechecker registration).

- [ ] **Step 4: Commit**

---

## Task 7: Typechecker support for `guard`

**Files:**
- Modify: `lib/typechecker/` (whichever file holds the stdlib-function signature registry, if one exists)

Two scenarios:

**Scenario A: stdlib pickup just works.** The typechecker reads `stdlib/thread.agency`, infers `guard`'s signature from the `def`, and propagates the block's return type T through to `Result<T, GuardFailureData>`. The user calls `guard(cost: 2.0) as { return "hello" }` and the typechecker correctly types `result` as `Result<string, GuardFailureData>`. **Do nothing in this task.**

**Scenario B: stdlib pickup fails** (generic inference doesn't propagate, or the typechecker has a special-case registry for builtins that need entries for new ones).

- [ ] **Step 1: Locate the registry**

```bash
rg "getCost|getTokens" lib/typechecker/
```

Find where `getCost`/`getTokens` (or the other thread-stdlib functions) are recognized. Either there's a registry, or the typechecker walks `stdlib/*.agency` and inhales signatures.

- [ ] **Step 2: Register `guard` if needed**

If a registry exists, add an entry mapping `guard` to the signature:
```
guard: <T>(cost: number, block: () => T) => Result<T, GuardFailureData>
```

- [ ] **Step 3: Test with a contrived agency snippet**

```bash
cat > /tmp/guard-test.agency <<EOF
import { guard } from "std::thread"
node main() {
  const r = guard(cost: 2.0) as {
    return "hello"
  }
  return r
}
EOF
pnpm run agency /tmp/guard-test.agency
```

- [ ] **Step 4: Commit**

---

## Task 8: Integration fixtures

**Files:**
- Create: `tests/agency/guards/guard-cost-trip.agency` + `.test.json`
- Create: `tests/agency/guards/guard-cost-no-trip.agency` + `.test.json`
- Create: `tests/agency/guards/guard-nested.agency` + `.test.json`
- Create: `tests/agency/guards/guard-cost-fork.agency` + `.test.json`

These use real LLM calls (cheap). Per the testing guide they're acceptable when they're testing something that genuinely needs the LLM path.

- [ ] **Step 1: Trip case**

```
// tests/agency/guards/guard-cost-trip.agency
import { guard } from "std::thread"

node main() {
  const result = guard(cost: 0.00000001) as {  // tiny budget
    const reply = llm("Reply with the single word: pong")
    return reply
  }
  if (isFailure(result)) {
    return "tripped: " + result.data.actualCost
  }
  return "did not trip"
}
```

`.test.json` asserts the output starts with `"tripped: "` and the actual cost is positive.

- [ ] **Step 2: No-trip case**

```
const result = guard(cost: 10.00) as {
  const reply = llm("Reply with the single word: pong")
  return reply
}
return result.value  // "pong"
```

- [ ] **Step 3: Nested guards**

Inner guard tripping doesn't trip outer:
```
const outer = guard(cost: 1.00) as {
  const inner = guard(cost: 0.00000001) as {
    return llm("Reply with: pong")
  }
  // inner is a Failure; outer still has budget
  if (isFailure(inner)) {
    return "inner tripped"
  }
  return "neither tripped"
}
return outer.value  // "inner tripped"
```

- [ ] **Step 4: Fork case (documents the limitation)**

```
const result = guard(cost: 0.00000001) as {
  fork([1, 2, 3]) as n {
    llm("Reply with: pong")
  }
  return "all branches finished"
}
```

This SHOULD trip the outer guard after the fork completes (when `propagateBranchCost` rolls up the branch deltas). The fixture confirms that path works. The limitation — that the outer guard doesn't trip MID-fork — is documented in the docs (Task 9), not in this fixture.

- [ ] **Step 5: Build fixtures**

```bash
make fixtures
```

- [ ] **Step 6: Run**

```bash
pnpm test:run -- guards > /tmp/guards-int.log 2>&1
```

- [ ] **Step 7: Commit**

---

## Task 9: Documentation

**Files:**
- Create: `docs/site/stdlib/guard.md` — user-facing guide.
- Modify: `docs/site/stdlib/thread.md` — link to the new guard page.

- [ ] **Step 1: User guide**

`docs/site/stdlib/guard.md` covers:
- The `guard(cost: $X) as { ... }` syntax (with the unit literal).
- Return shape: `Result<T, GuardFailureData>`.
- `GuardFailureData` field-by-field.
- Nested guards example (each scope independent; inner trip doesn't trip outer).
- The fork limitation explicitly: "An outer guard wrapping a `fork` block only sees branch costs after the fork completes — it cannot pre-empt branches mid-flight."
- The memory limitation: "Memory layer LLM calls (memory.text, memory.embed) currently bypass the guard."
- V2 footnote: "Timeout guards are planned; the `GuardFailureData.type` field will gain a `"timeoutFailure"` variant alongside the current `"guardFailure"`."

- [ ] **Step 2: Cross-link from `docs/site/stdlib/thread.md`**

Add a section pointing at the new page. The existing thread.md already covers `getCost` / `getTokens`; guard is a natural follow-on.

- [ ] **Step 3: CHANGELOG entry**

```
### Added
- `guard(cost: $X) as { ... }` in `std::thread` — automatic cost limit enforcement for blocks of LLM-using code. Returns a `Result` so callers can branch on success vs over-budget. See docs/site/stdlib/guard.md.
```

- [ ] **Step 4: Commit**

---

## Validation checklist

- [ ] `guard(cost: $2.00) as { return llm("...") }` returns a `Success` when under budget, `Failure({ type: "guardFailure", maxCost, actualCost })` when over.
- [ ] Nested guards work: inner trip doesn't trip outer.
- [ ] Fork inside a guard: outer trip fires after fork completes (rollup case).
- [ ] `GuardExceededError` propagates through `_runPrompt` / `runPrompt` / the function-body auto-wrap, caught only by the `try` inside `guard`.
- [ ] `StateStack` round-trips guards through `toJSON`/`fromJSON`.
- [ ] Branch seeding clones parent guards onto child stacks.
- [ ] No regressions in `tests/agency/thread/cost-*` (the existing per-branch-cost fixtures from c695d411).
- [ ] No regressions in `tests/agency/fork/*`, `tests/agency/handlers/*`, or `tests/agency/substeps/*`.
- [ ] `make` succeeds. `pnpm run lint:structure` clean.

---

## Risks and known limitations

- **Fork cost is invisible to outer guards mid-flight.** This is documented in the guard.md page and in the test fixture's comment. A user wanting per-iteration enforcement should place the guard INSIDE the fork body (`fork(items) as item { guard(cost: $0.50) as { ... } }`).

- **Memory layer LLM calls bypass the guard.** Same documented limitation. Tracked as a future enhancement — wiring `memory.text` / `memory.embed` through `prompt.ts` (or adding a separate accumulator path) is mechanical but non-trivial.

- **Function-body auto-wrap must re-throw `GuardExceededError`.** Task 5 Step 2 covers this — verify before committing. If the auto-wrap swallows the error, every guard call returns success even when the budget was blown.

- **`__popGuard` cleanup on JS error escape.** If a non-guard JS error escapes both `try block()` and the auto-wrap (i.e., the runtime itself crashes), `__popGuard` is skipped and the guard list is polluted on resume. **Mitigation: guard list is serialized as part of `StateStack`** (Task 2 Step 2), so the deserialized stack on resume carries the right list — the missed pop is a no-op because the snapshot already reflected the right state. Verify this in a test that intentionally throws inside the block.

- **Multiple guards tripping on the same call.** The loop reports the innermost-tripped first (Task 5 Step 1). If multiple guards trip simultaneously, the user sees one failure and the other guards' state still on the stack — but the surrounding `guard` function's body returns immediately, so the outer guard's `try` catches its own failure on the next walk. Test this with the `guard-nested` fixture by setting BOTH limits low enough that both trip.

- **Typechecker generic inference.** Task 7 has a fork: stdlib pickup may or may not handle `<T>`. Be prepared to add a registry entry.

- **Unit literal interactions.** `$2.0` and `2.0` are exactly equivalent at the type level (both `number`). The unit checker doesn't distinguish dollars from arbitrary numbers — so a user could pass a non-dollar number and the typechecker wouldn't catch it. Documented as a known limitation; revisit when dimensioned types land.

---

## Follow-ups (not in V1)

- Timeout guards (`guard(time: 30s) as { ... }`).
- Depth guards (number of LLM calls, tool-call rounds, etc.).
- Memory layer integration.
- Pipe operator interaction.
- Mid-fork cost propagation (require a shared atomic accumulator OR a checkpoint hook in `runBatch` that rolls deltas to the parent at every cost-emitting site).
- Richer partial-result return (per the conversation: returning bound locals + message thread at trip time). Deliberately out of scope for V1 in favor of the minimal `{ type, maxCost, actualCost }` shape.
