# Memory Configuration in Agency Code — Implementation Plan

## Goal

Let Agency code enable, configure, and disable memory directly, without
requiring a `memory` block in `agency.json`. Support per-thread / per-fork
memory by moving memory configuration onto the stateStack. All new
surface lives in the `std::memory` module.

## User-visible API (final)

Three new exports added to
[`stdlib/memory.agency`](../../../stdlib/memory.agency):

```agency
// Function form — push a new memory frame onto the current stateStack.
// Process-wide stores are cached by absolute dir, so multiple calls
// with the same dir share storage. Repeating the same dir as the
// current top frame is a no-op (so `static const _ = enableMemory(...)`
// + an `enableMemory(...)` in `main` is safe). Pushing a different
// dir stacks the new frame on top — pop it with `disableMemory()`.
// Auto-creates the dir if missing.
enableMemory({
  dir: string,                 // required
  model?: string,
  autoExtract?: { interval: number },
  compaction?: { trigger: string, threshold: number },
  embeddings?: { model: string }
})

// Function form — turn memory off for the current stateStack frame.
// Frame-scoped: a `disableMemory()` inside a fork branch only affects
// that branch.
disableMemory()

// Block form — push a memory frame, run the body, pop the frame on
// exit (including interrupt resume and exceptions). Implemented as a
// plain function taking a block, per docs/site/guide/blocks.md — no
// parser changes needed.
memory({...}) as {
  // code in here uses the new memory config
  remember("...")
}
```

All three are also valid tools an LLM can be passed.

### Precedence

Code wins over `agency.json`. The JSON config seeds the bottom of the
config stack on every execCtx; any `enableMemory` / `memory` block
pushes a new frame on top. The active config is always "top of stack."

### Relative dir resolution

Mirrors `agency.json`: `dir` resolves against `process.cwd()`. This
deliberately differs from `read`/`write`/`ls`/`glob`/`grep` (which use
the module dir) so the same string in `agency.json` and in code points
at the same place. Documented explicitly in the `enableMemory` doc
comment. `~` expansion lands separately in
[`2026-05-29-tilde-expansion-in-stdlib.md`](./2026-05-29-tilde-expansion-in-stdlib.md);
once that ships, `~/.agency/memory` works for free.

## Architectural change (the "refactor" half)

### Current shape

[`lib/runtime/state/context.ts#L214-L301`](../../../lib/runtime/state/context.ts):
- `Context.memoryConfig` and `Context.memoryStore` are set once from
  `args.memory` (JSON-derived).
- `createExecutionContext()` builds a `MemoryManager` per execCtx,
  closing over `execCtx.stateStack` for the memoryId ref.
- `execCtx.memoryManager` is the single live manager for the whole run.

[`lib/runtime/state/stateStack.ts`](../../../lib/runtime/state/stateStack.ts)
already carries `other: Record<string, any>` which is forked correctly
and stores the active `memoryId`.

### New shape

**Memory frames on the stateStack, hidden behind methods.** The
stateStack carries a stack of memory frames; callers never touch the
array directly.

```ts
// lib/runtime/state/stateStack.ts
interface MemoryFrame {
  configKey: string;     // absolute, realpath'd dir
  config: MemoryConfig;
}

class StateStack {
  // Existing fields unchanged. `memoryFrames` lives in `other` so it
  // serializes for free with the rest of stateStack.other and forks
  // correctly via the existing deepClone path.

  pushMemoryFrame(frame: MemoryFrame): void
  popMemoryFrame(): MemoryFrame | undefined
  topMemoryFrame(): MemoryFrame | undefined
}
```

Every other site reads / mutates frames only through these three
methods. The underlying array shape is an implementation detail.

**Single source of truth: JSON config is just the bottom frame.** No
separate "fallback" path. At `createExecutionContext`, if
`args.memory` is set, push it onto the new execCtx's stateStack as
the bottom frame. After that, the stack is the only thing anyone
consults. The "code wins over JSON" rule is structural, not coded.

```ts
// lib/runtime/state/context.ts — in createExecutionContext
if (this.jsonMemoryConfig) {
  execCtx.stateStack.pushMemoryFrame(
    await normalizeMemoryFrame(this.jsonMemoryConfig)
  );
}
```

`Context.memoryConfig` becomes the immutable JSON seed
(`jsonMemoryConfig`), used only at execCtx creation. `Context.memoryStore`
goes away — stores are looked up via the registry below when needed.

**Process-wide store registry**, `lib/runtime/memory/registry.ts`:

```ts
const stores = new Map<string, FileMemoryStore>();
export function getOrCreateStore(absDir: string, logLevel): FileMemoryStore
```

Keyed by absolute, realpath'd dir. First lookup creates the store and
the dir (`mkdir -p`).

> **Verification step before writing this file:** grep `lib/runtime/`
> and `lib/stdlib/` for any existing keyed-singleton / cached-factory
> pattern (`new Map<string,`, `getOrCreate`, registry / cache files)
> to make sure we're not duplicating an idiom already in use.
> Also check the `agency` namespace surface
> ([lib/runtime/agency.ts](../../../lib/runtime/agency.ts)) for any
> existing memory helpers — current grep shows none, but confirm
> nothing has been added since.

**Active-manager resolution.** Single method on `RuntimeContext`:

```ts
getActiveMemoryManager(): MemoryManager | undefined {
  const frame = this.stateStack?.topMemoryFrame();
  if (!frame) return undefined;
  return this.getOrCreateManager(frame);   // cached per execCtx by configKey
}
```

No fallback branch. No "if frame else default" special case. Top of
stack or undefined. The per-execCtx manager cache prevents reconstruction
on every call — needs its own statelog client / log level per execCtx,
which is why it can't be process-wide.

### Replacing direct `ctx.memoryManager` reads

All call sites enumerated below switch from
`ctx.memoryManager` → `ctx.getActiveMemoryManager()`:

- [`lib/runtime/node.ts:356-358`](../../../lib/runtime/node.ts#L356-L358) (save on shutdown)
- [`lib/runtime/prompt.ts:214-218`](../../../lib/runtime/prompt.ts#L214-L218) (onTurn / compactIfNeeded)
- [`lib/runtime/prompt.ts:401-403`](../../../lib/runtime/prompt.ts#L401-L403) (recallForInjection)
- All `_*` and `__internal_*` exports in
  [`lib/stdlib/memory.ts`](../../../lib/stdlib/memory.ts) (~14 sites)

For the save-on-shutdown path, iterate every cached manager and call
`save()` — otherwise a fork that enabled a side store would lose its
writes.

## TypeScript helpers in `lib/stdlib/memory.ts`

Once `StateStack.{push,pop,top}MemoryFrame` exist and
`normalizeMemoryFrame(config)` owns "resolve + mkdir + return frame,"
the helpers collapse to a handful of lines each. Imperative work is
encapsulated in the StateStack methods and the normalization helper;
these wrappers stay declarative.

```ts
// "What" lives here. "How" lives in normalizeMemoryFrame +
// StateStack.{push,pop,top}MemoryFrame.

export async function _enableMemory(config: MemoryConfig): Promise<void> {
  const { stack } = getRuntimeContext();
  if (!stack) return;
  stack.pushMemoryFrame(await normalizeMemoryFrame(config));
}

export function _disableMemory(): void {
  const { stack } = getRuntimeContext();
  stack?.popMemoryFrame();
}
```

`normalizeMemoryFrame(config)` lives in
`lib/runtime/memory/frame.ts` and is the single owner of the
"resolve dir, mkdir, build frame" policy. `StateStack.pushMemoryFrame`
owns the idempotency policy:

```ts
// lib/runtime/state/stateStack.ts
pushMemoryFrame(frame: MemoryFrame): void {
  const top = this.topMemoryFrame();
  // Same dir as top: no-op, so static-const + main double-call is safe.
  // Different dir: stack on top. Callers pop with popMemoryFrame() or
  // use the memory(){} block for lexical scoping.
  if (top?.configKey === frame.configKey) return;
  this.other.memoryFrames = [...(this.other.memoryFrames ?? []), frame];
}
```

The block form is plain Agency `try/finally` — no TS helper needed
(see `stdlib/memory.agency` below).

## `agency.memory.*` TS-facing namespace

[Per ts-helpers.md](../../site/guide/ts-helpers.md), TS code that
participates in an Agency run reaches everything via the single
`agency` namespace exported from
[`lib/runtime/agency.ts`](../../../lib/runtime/agency.ts). Today that
namespace has **no memory methods** (confirmed by grep). Adding them
gives TS helpers symmetric access to what Agency code can do.

Add a `memory` sub-namespace to the `agency` const:

```ts
// lib/runtime/agency.ts — additions only
import {
  _enableMemory, _disableMemory,
  _setMemoryId, _shouldRunMemory,
  _remember, _recall, _forget,
} from "../stdlib/memory.js";

const memoryEnable   = (config: MemoryConfig) => _enableMemory(config);
const memoryDisable  = ()                     => _disableMemory();
const memorySetId    = (id: string)           => _setMemoryId(id);
const memoryEnabled  = ()                     => _shouldRunMemory();
const memoryRemember = (content: string)      => _remember(content);
const memoryRecall   = (query: string)        => _recall(query);
const memoryForget   = (query: string)        => _forget(query);

export const agency = {
  // ... existing fields unchanged ...
  memory: {
    enable:   memoryEnable,
    disable:  memoryDisable,
    setId:    memorySetId,
    enabled:  memoryEnabled,
    remember: memoryRemember,
    recall:   memoryRecall,
    forget:   memoryForget,
  },
};
```

Naming: matches the namespace's pattern of action verbs without the
"memory" prefix (compare `agency.thread.current()`, not
`agency.thread.currentThread()`). `setId` because `agency.memory.set`
would be ambiguous. `enabled` is a query, not a setter.

TS helpers can now do:

```ts
import { agency } from "agency-lang/runtime";

export async function rememberPreference(pref: string): Promise<void> {
  await agency.memory.enable({ dir: "~/.agency/memory" });
  agency.memory.setId(`user-${getUserId()}`);
  await agency.memory.remember(pref);
}
```

Each method just re-exports the underlying `_*` ALS-reading helper —
no second code path. Behavior changes happen in one place.

## Agency-side wrappers in `stdlib/memory.agency`

```agency
import {
  _enableMemory,
  _disableMemory,
  _setMemoryId,
  // ... existing imports
} from "agency-lang/stdlib-lib/memory.js"

export type MemoryConfig = {
  dir: string;
  model?: string;
  autoExtract?: { interval: number };
  compaction?: { trigger: string; threshold: number };
  embeddings?: { model: string };
}

export def enableMemory(config: MemoryConfig) {
  """
  Push a memory frame onto the current execution stack. Auto-creates
  `dir` if missing. `dir` resolves against the process cwd (matching
  `agency.json` precisely, not the calling module directory).

  Repeating the same dir as the current top frame is a no-op (so
  `static const _ = enableMemory(...)` plus an `enableMemory(...)` at
  the top of `main` is safe). Pushing a different dir stacks on top —
  use `disableMemory()` to pop back, or the `memory(){}` block for
  lexical scoping. `setMemoryId(...)` is NOT affected by push or pop;
  storage (where) and scope (who) are orthogonal.

  Settings here override `agency.json` for this frame and below.

  @param config - Memory configuration (dir required)
  """
  _enableMemory(config)
}

export def disableMemory() {
  """
  Pop the top memory frame. Frame-scoped: a call inside a fork
  branch only affects that branch.

  Library authors: this pops whatever is on top, including the
  bottom frame seeded from `agency.json`. Don't call this casually
  in shared helpers — you can shadow the user's project-level memory
  config.
  """
  _disableMemory()
}

export def memory(config: MemoryConfig, block: () => any): any {
  """
  Push a memory frame for the body, then pop it. Implemented in pure
  Agency so the new frame survives interrupt/resume and exception
  unwinding correctly.

  Usage:

      memory({ dir: ".project-memory" }) as {
        remember("user prefers tabs")
      }

  @param config - Memory configuration (dir required)
  @param block - Code to run with this memory active
  """
  enableMemory(config)
  try {
    return block()
  } finally {
    disableMemory()
  }
}
```

Note: Agency's `try/finally` already exists (used elsewhere in stdlib);
if not, the block can use a `with`-style handler. Confirm during
implementation.

## JSON config seeding

After the refactor:

- `Context.jsonMemoryConfig` holds the JSON-derived config — immutable
  after construction, used only by `createExecutionContext` to seed
  the bottom frame.
- `Context.memoryConfig` and `Context.memoryStore` are deleted. They
  were "the active config" / "the active store" — concepts that no
  longer exist; everything goes through the stateStack frame plus the
  process-wide registry.
- "Code overrides JSON" is structural: code's frames are above the
  JSON-seeded bottom frame, so `topMemoryFrame()` returns the right
  thing without a special case anywhere.

## Serialization & resume

Memory state moves cleanly through Agency's existing serialize/restore
pipeline because frames are POJOs and stores live on disk.

**What's serialized:**

- `MemoryFrame` objects (`{configKey: string, config: MemoryConfig}`)
  ride through the existing
  [`StateStack.serialize()` / `deserialize()`](../../../lib/runtime/state/stateStack.ts#L535)
  path as part of `stateStack.other`. The existing code does
  `other: deepClone(this.other)` on save and
  `stateStack.other = json.other || {}` on restore. No new code
  needed.
- `memoryId` continues to ride on `stateStack.other.memoryId` exactly
  as today.

**What's NOT serialized:**

- `MemoryManager` instances. They're rebuilt lazily on first call
  after resume: `getActiveMemoryManager()` looks at the top frame,
  asks the registry for the store, constructs the manager, caches it
  on the execCtx.
- `FileMemoryStore` instances. The registry is process-local and
  re-populated on first call after a new process starts. The actual
  facts live on disk under the configured `dir`, so they survive
  process death.

**Three corner cases this plan must handle:**

1. **Old checkpoints without `memoryFrames`.** Checkpoints saved
   before this PR have no `memoryFrames` in `other`. On restore,
   `topMemoryFrame()` would return undefined and memory would silently
   go dark even if `agency.json` enables it. **Mitigation:** in
   `Context.createExecutionContext` (and any explicit restore path
   that swaps the stateStack), after the swap, if
   `stateStack.topMemoryFrame()` is undefined AND `this.jsonMemoryConfig`
   is set, re-seed the bottom frame. Backward-compatible without
   re-introducing the fallback special case (the seed lands as a real
   frame).

2. **Config change between save and resume.** If `agency.json`
   changes between checkpoint save and resume, the saved frames win —
   the stale JSON change is ignored until the user explicitly calls
   `enableMemory(...)` again. This is the correct "faithful resume"
   behavior; documented in the user-facing memory guide.

3. **Fork branches.** Each fork's stateStack is independently deep-
   cloned, so frame pushes in one branch don't bleed into siblings.
   Two branches pushing the same `configKey` share one
   `MemoryManager` from the execCtx cache — correct, because the
   manager's only per-branch state (`memoryId`) is read live from the
   active branch's stateStack on every call, not captured at
   construction.

## Wins, automatically

After the refactor, this works:

```agency
fork {
  branch {
    memory({ dir: "./mem-a" }) as {
      remember("alice fact")
    }
  }
  branch {
    memory({ dir: "./mem-b" }) as {
      remember("bob fact")
    }
  }
}
```

Because `stateStack.other` deep-clones on fork, each branch has its
own `memoryFrames` stack. The registry caches both stores once per
process.

## Testing

### Unit (TS) — `lib/runtime/memory/registry.test.ts` (new)

- `getOrCreateStore` returns same instance for same absDir
- creates dir if missing
- different abs dirs → different stores

### Unit (TS) — `lib/runtime/state/context.test.ts` (extend)

- `getActiveMemoryManager()` returns undefined when nothing configured
- returns JSON-derived manager when only JSON is set
- returns frame manager when frame is pushed, ignoring JSON
- pops back to JSON manager when frame is popped

### Unit (TS) — `lib/stdlib/memory.test.ts` (extend)

- `_enableMemory` no-op when pushing the same dir as the current top
- `_enableMemory` stacks a different dir on top of the current frame
- `_disableMemory` pops one frame
- frames survive a roundtrip through stateStack serialize/deserialize
  (important: the `memoryFrames` array must serialize cleanly)

### Agency execution test — `tests/agency/memory-enable.agency` (new)

```agency
import { enableMemory, remember, recall, setMemoryId } from "std::memory"

node main() {
  enableMemory({ dir: ".test-mem" })
  setMemoryId("test-1")
  remember("the sky is blue")
  const r = recall("sky")
  assert(r != "")
  return "ok"
}
```

Add `.gitignore` entry for `.test-mem/` if needed; teardown in a
`finally` block or test harness afterEach.

### Agency execution test — `tests/agency/memory-block.agency` (new)

Test the block form: memory is active inside, no-op outside.

### Agency execution test — `tests/agency/memory-fork.agency` (new)

Two fork branches, each pushing a different memory dir, each writing
a distinct fact. Assert each store ends up with only its own fact.

### Agency-js integration test — `tests/agency-js/memory-precedence/`

agency.json with `memory: { dir: ".json-mem" }`, agency code that
calls `enableMemory({ dir: ".code-mem" })`, assert writes land in
`.code-mem` not `.json-mem`. Confirms code-wins-over-JSON.

### Existing tests

Run `lib/runtime/memory/*.test.ts` and `lib/stdlib/memory.test.ts`
unchanged; the refactor must not regress them.

### Test gaps — what could break that the tests above wouldn't catch

The initial list focuses on the happy path. The audit below names
the specific failures that the listed tests would silently miss, and
the additional tests that close each gap. **Every bullet is a real
correctness or regression risk, not paranoia.**

**Gap 1: `agency.memory.*` namespace wiring.** If one of the seven
sub-namespace methods is dropped, mistyped, or wired to the wrong
underlying `_*` function, nothing in the listed tests would catch
it — they all go through the Agency-side wrappers, not the TS
namespace.
**Add:** `lib/runtime/agency.test.ts` — call each of `agency.memory.{enable,disable,setId,enabled,remember,recall,forget}` inside `agency.withTestContext({...}, async () => {...})` and assert observable behavior. Mirrors how `agency.thread.*` is tested today.

**Gap 2: Interrupt-resume across an `enableMemory`.** The whole point
of frames-on-stateStack is that they survive interrupts. A serialize
unit test verifies the shape; only an end-to-end test verifies that
resumed code still sees the same memory frame.
**Add:** `tests/agency/memory-interrupt.agency` — `enableMemory`, raise an interrupt, host resolves it, control resumes; `remember`/`recall` continue against the right dir. Confirms checkpoint/restore through the real Runner.

**Gap 3: Manager cache invalidation on pop.** Two frames pushed
(A, then B), then B popped. Listed tests check that B's manager is
returned while B is on top, but don't check that popping back returns
A's manager (not a stale B, not undefined, not a fresh A that drops
state).
**Add:** test in `lib/runtime/state/context.test.ts` — push A, get manager, push B, get manager, pop B, get manager again; assert third manager is the same instance as the first.

**Gap 4: Old-checkpoint re-seeding.** The corner-case mitigation
(re-seed JSON bottom frame when restoring a stateStack that lacks
`memoryFrames`) is untested.
**Add:** test in `lib/runtime/state/context.test.ts` — construct a `Context` with `jsonMemoryConfig` set, restore from a fake serialized stateStack that has `other.memoryId` but no `other.memoryFrames`, assert `topMemoryFrame()` returns the JSON-derived frame.

**Gap 5: `_disableMemory` against the JSON-seeded bottom frame.**
**Resolved:** `disableMemory()` pops whatever is on top, including
the JSON-seeded bottom frame. Memory then goes off until the next
`enableMemory()`. Keeps "stack is the single source of truth" as an
invariant; no special case for the bottom frame.
**Add:** test in `lib/stdlib/memory.test.ts` — JSON config seeded,
no user frames pushed, `_disableMemory` called, assert
`getActiveMemoryManager()` returns undefined and a follow-up
`remember` is a no-op. Also document in the user-facing memory guide
that library authors should not call `disableMemory()` casually —
they will shadow user JSON config.

**Gap 6: `memoryId` semantics across a frame push.** **Resolved:**
`enableMemory()` does **not** touch `memoryId`. Storage (which dir)
and scope (which id) are orthogonal — `memoryId` lives on
`stateStack.other.memoryId` and persists across frame pushes and
pops. A library helper that opens a side store cannot accidentally
clobber the caller's `setMemoryId`. If a caller wants a fresh scope
when switching stores, they call `setMemoryId("default")` (or
whatever) explicitly.
**Add:** test in `tests/agency/memory-id-across-frames.agency` —
`setMemoryId("alice")`, `enableMemory({dir: A})`, write fact,
`enableMemory({dir: B})` (different dir), write fact;
assert both stores contain a fact under scope `alice`. Pop back to
A and assert id is still `alice`.

**Gap 7: `StateStack` push/pop/top semantics in isolation.** The
Agency-side tests exercise the wrappers; the StateStack methods
themselves should also be tested unit-level so the stack invariants
survive refactoring.
**Add:** test in `lib/runtime/state/stateStack.test.ts` — direct
push/pop/top calls covering: same-dir push is a no-op, different-dir
push stacks, pop returns to previous top, pop on empty returns
undefined, the frames array survives deep-clone across forks.

**Gap 8: `MemoryConfig` round-trips intact through serialize.** The
"frames survive serialize/deserialize" test exists but probably
only checks the array shape. Confirm nested fields (`autoExtract`,
`compaction`, `embeddings`) survive.
**Add:** to the existing roundtrip test, assert deep equality of the
full config object after deserialize.

**Gap 9: Cross-execCtx store sharing.** Plan claims the registry is
process-wide. If two execCtxs in the same process push the same dir,
they should share the underlying `FileMemoryStore` (otherwise writes
from one are invisible to the other until disk reload).
**Add:** `lib/runtime/memory/registry.test.ts` — create two stores via
the registry with the same dir, assert reference equality.

**Gap 10: Absolute vs relative dir input.** `enableMemory({dir: "/abs/path"})`
should not be re-resolved against cwd. `enableMemory({dir: "./mem"})`
should be. `enableMemory({dir: "~/.agency/mem"})` (after the tilde
PR lands) should expand.
**Add:** `lib/runtime/memory/frame.test.ts` — three cases for
`normalizeMemoryFrame`, asserting the resulting `configKey` for each.

**Gap 11: agency-js test for `agency.memory.*`.** TS helper that
calls `agency.memory.remember(...)` should be reachable from Agency
code under a real Runner.
**Add:** `tests/agency-js/memory-ts-namespace/` — agency.json with
memory enabled; TS helper exported from `helpers.ts` that
`agency.memory.remember`s a fact; Agency code calls the helper then
`recall`s the fact.

The two existing "agency-js memory-precedence" and "agency
memory-fork" tests stay; the gaps above are additive, not
replacements.

## Migration & rollout

- **Backward compatible.** Existing agents that rely on `agency.json`
  memory config keep working — the JSON config becomes the bottom-of-
  stack default with identical behavior.
- **No deprecations.** The existing `setMemoryId` API is unchanged.
- **Single PR.** Combining the refactor and the new API into one PR
  is fine because the block form is just `try/finally` around the
  two new functions — no parser changes (confirmed via
  [`docs/site/guide/blocks.md`](../../site/guide/blocks.md)).
- **Build.** Touches stdlib → run `make` after editing
  `stdlib/memory.agency`.

## File checklist

Runtime — new:
- [`lib/runtime/memory/registry.ts`](../../../lib/runtime/memory/registry.ts) — process-wide `getOrCreateStore`
- [`lib/runtime/memory/registry.test.ts`](../../../lib/runtime/memory/registry.test.ts)
- [`lib/runtime/memory/frame.ts`](../../../lib/runtime/memory/frame.ts) — `normalizeMemoryFrame(config)`: resolve dir, mkdir, return `MemoryFrame`
- [`lib/runtime/memory/frame.test.ts`](../../../lib/runtime/memory/frame.test.ts)

Runtime — modified:
- [`lib/runtime/state/stateStack.ts`](../../../lib/runtime/state/stateStack.ts) — add `pushMemoryFrame` / `popMemoryFrame` / `topMemoryFrame` (own the same-dir idempotency rule), `MemoryFrame` type
- [`lib/runtime/state/context.ts`](../../../lib/runtime/state/context.ts) — rename `memoryConfig` → `jsonMemoryConfig`; drop `memoryStore` and `memoryManager`; add `getActiveMemoryManager` with per-execCtx cache keyed by `configKey`; seed JSON config as bottom frame in `createExecutionContext`
- [`lib/runtime/agency.ts`](../../../lib/runtime/agency.ts) — add `agency.memory.{enable,disable,setId,enabled,remember,recall,forget}` sub-namespace
- [`lib/runtime/index.ts`](../../../lib/runtime/index.ts) — re-export `MemoryConfig` type alongside existing type exports
- [`lib/runtime/node.ts`](../../../lib/runtime/node.ts) — save-all-cached-managers on shutdown (iterate the per-execCtx cache)
- [`lib/runtime/prompt.ts`](../../../lib/runtime/prompt.ts) — read via `ctx.getActiveMemoryManager()` (3 sites)
- [`lib/stdlib/memory.ts`](../../../lib/stdlib/memory.ts) — all `_*` and `__internal_*` exports switch to `ctx.getActiveMemoryManager()`; add `_enableMemory`, `_disableMemory`

Stdlib (Agency):
- [`stdlib/memory.agency`](../../../stdlib/memory.agency) — add `enableMemory`, `disableMemory`, `memory(config, block)`, `MemoryConfig` type

Docs:
- [`docs/site/guide/memory.md`](../../site/guide/memory.md) — new section "Configuring memory in code" covering the three Agency functions, the precedence rule, and the per-fork pattern
- [`docs/site/guide/ts-helpers.md`](../../site/guide/ts-helpers.md) — new section "Memory" covering `agency.memory.*`

Tests: as listed above.

## Out of scope

- Generic `configure(...)` block. Deferred per user decision.
- Client (model, headers, baseUrl) config in code. Same pattern when
  needed.
- `~` expansion in path resolution — separate PR.
- Cross-process memory store coordination (locking, etc.) — not a new
  problem introduced here.
