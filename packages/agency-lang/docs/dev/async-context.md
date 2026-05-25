# Async context: `agencyStore` and `getRuntimeContext()`

Stdlib TS helpers that need `RuntimeContext`, `StateStack`, or `ThreadStore` read them from a Node `AsyncLocalStorage` frame that the runtime installs at well-defined points. This replaces an older "context-injected builtin" mechanism that prepended three magic params to specific function calls at codegen time.

## API

```ts
import {
  agencyStore,
  getRuntimeContext,
  runInTestContext,
} from "agency-lang/runtime";

// In stdlib code that runs inside an Agency execution scope:
const { ctx, stack, threads } = getRuntimeContext();

// In tests that exercise stdlib helpers directly:
await runInTestContext(ctx, stack, threads, () => _someStdlibHelper(args));
```

`getRuntimeContext()` throws if called outside an `agencyStore.run(...)` frame, with an error pointing to the most likely cause (a stdlib helper called from non-Agency code).

## Where frames are installed

There are three seeding points. Everything else inherits them through normal `await` propagation.

1. **`runNode`** ([lib/runtime/node.ts](../../lib/runtime/node.ts)) — wraps every fresh agent run in the outermost `agencyStore.run(...)` frame with `{ctx, stack, threads}` for that run. This is the frame any user-written `node main()` sees.
2. **`Runner.runInScope`** ([lib/runtime/runner.ts](../../lib/runtime/runner.ts)) — every callback-taking method on `Runner` (`step`, `hook`, `pipe`, `fork`) re-enters `agencyStore.run(...)` so the scope-local `stack` (and per-fork branch stack) is visible to stdlib helpers running inside that step.
3. **`runBatch`'s branch wrapper** ([lib/runtime/runBatch.ts](../../lib/runtime/runBatch.ts)) — each fork/race branch body runs inside its own frame seeded with the branch's `StateStack`, so `getRuntimeContext().stack.abortSignal` returns the branch signal (not the parent's). This is what makes race-loser branches actually tear down in-flight work.

Subprocess bootstrap deliberately does NOT install its own frame. Each child re-enters `runNode` (which installs the frame) on its own, so threading a frame across the IPC boundary would be redundant.

## What was wrong with the previous mechanism

Before this, stdlib helpers that needed `ctx`/`stack`/`threads` were named with an `__internal_` prefix and registered in a `CONTEXT_INJECTED_BUILTINS` table. The TypeScript codegen rewrote every call site to prepend the three locals as positional arguments:

```ts
// agency
__internal_recall(query)
// generated TS
await __internal_recall(__ctx, __stateStack, __threads, query)
```

Drawbacks that motivated the migration:

- **Every new abortable function** needed a registry entry plus a special TS signature (`(ctx, stack, _threads, ...userParams)`). Easy to forget either piece. The registry/impl-arity drift was guarded by a test, which itself was per-entry maintenance.
- **Bare references** to `__internal_*` names had to be rejected by the typechecker — `let f = __internal_recall` would otherwise produce code that didn't carry the context, silently breaking.
- **Cross-stdlib calls** to abortable helpers were verbose: callers had to pass `(ctx, stack, threads, ...args)` themselves, which polluted the call site.

With ALS, none of these are concerns. A stdlib export is just an ordinary function from the codegen's perspective; the `ctx`/`stack`/`threads` it reads come from the active frame.

## Conventions

- Name stdlib JS exports that read the ALS frame with a single underscore: `_recall`, `_fetch`, `_authorize`. This is just a naming convention to signal "this is the JS implementation of an Agency-facing function, not a public API"; the codegen doesn't treat the prefix specially.
- Tests that exercise a `_foo` helper directly (without going through compiled Agency code) MUST wrap the call in `runInTestContext`.
- A stdlib helper that calls another `_foo` helper does NOT need to re-establish a frame — frames propagate through `await` automatically.

## See also

- [docs/superpowers/plans/2026-05-25-als-migration.md](../superpowers/plans/2026-05-25-als-migration.md) — the migration plan.
- [docs/dev/adding-a-module-to-the-agency-stdlib.md](./adding-a-module-to-the-agency-stdlib.md) — step-by-step recipe for adding a new module.
