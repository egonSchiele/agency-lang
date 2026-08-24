# Async context: `agencyStore` and `getRuntimeContext()`

> **User docs.** If you're writing a TS helper and want to read context,
> push thread messages, install handlers, take checkpoints, or call the
> LLM, read [docs/site/guide/ts-helpers.md](../../site/guide/ts-helpers.md)
> instead. The `agency.*` namespace is the supported public surface;
> `getRuntimeContext()` is no longer exported from the package entry
> point. This page documents the underlying ALS mechanism for codegen
> and runtime maintainers.

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

## What a frame holds

```ts
export type AgencyStore = {
  ctx: RuntimeContext<any>;
  stack: StateStack;
  threads: ThreadStore;
  globals: GlobalStore;
  callsite?: CallsiteLocation;
  runner?: Runner;
};
```

`globals` normally points at the same `GlobalStore` as `ctx.globals`. It is a separate slot so a fork branch can hold a clone and write to a branch-local view without disturbing the parent.

`callsite` is `{moduleId, scopeName, stepPath}` for the step currently executing. `Runner.runInScope` seeds it, and `checkpoint()` reads it instead of taking the location as a trailing argument from generated code. Frames that are not inside a step, such as the top-level `runNode` frame and any bootstrap frame, omit it.

`runner` is the `Runner` driving the current step. TS helpers like `agency.interrupt` read it to call `runner.halt(...)` without being handed the runner.

## Where frames are installed

These are the seeding points. Everything else inherits them through normal `await` propagation.

1. **`runNode`** ([lib/runtime/node.ts](../../../lib/runtime/node.ts)) — wraps every fresh agent run in the outermost `agencyStore.run(...)` frame for that run. This is the frame any user-written `node main()` sees.
2. **`Runner.runInScope`** ([lib/runtime/runner.ts](../../../lib/runtime/runner.ts)) — every callback-taking method on `Runner` (`step`, `hook`, `pipe`, `fork`) re-enters `agencyStore.run(...)` so the scope-local `stack` is visible to stdlib helpers running inside that step. This is also the only place that seeds `callsite` and `runner`.
3. **`runBatch`'s branch wrapper** ([lib/runtime/runBatch.ts](../../../lib/runtime/runBatch.ts)) — each fork/race branch body runs inside its own frame seeded with the branch's `StateStack`, so `getRuntimeContext().stack.abortSignal` returns the branch signal, not the parent's. This is what makes race-loser branches actually tear down in-flight work. The same frame carries the branch's `ThreadStore` and `GlobalStore` view.
4. **`withResumableScope`** ([lib/runtime/resumableScope.ts](../../../lib/runtime/resumableScope.ts)) — the scope body runs in its own frame with the scope's stack and a `callsite` naming the scope.
5. **Tool invocation in `runPrompt`** ([lib/runtime/prompt.ts](../../../lib/runtime/prompt.ts)) — a function invoked as a tool re-enters the parent frame with a FRESH `ThreadStore`, so the tool's conversation does not land in the caller's thread.
6. **Scoped callback dispatch** ([lib/runtime/hooks.ts](../../../lib/runtime/hooks.ts)) — re-enters the parent frame with the callback's own `stateStack`.
7. **`withCallsite(loc, fn)`** ([lib/runtime/asyncContext.ts](../../../lib/runtime/asyncContext.ts)) — copies the current frame and overrides only `callsite`. For TS helpers that attach per-substep checkpoints. It throws outside any frame, since there is no base to inherit.

Subprocess bootstrap deliberately does NOT install its own frame. Each child re-enters `runNode`, which installs the frame, so threading a frame across the IPC boundary would be redundant.

## Frame kinds: node frames vs bootstrap frames

Not every frame the runtime installs has a real `ThreadStore`. There are two kinds:

- **Node frames** are seeded inside a Runner step, a runBatch branch, or the outer wrap around `graph.run` in `runNode`. The `threads` slot is the actual per-run `ThreadStore` (or, for fork branches, the branch's own store). User code running inside a node frame can freely use `systemMessage`/`userMessage`/`thread { ... }`/etc.

- **Bootstrap frames** are seeded by `runInBootstrapFrame(ctx, fn)` for code that runs *outside* any agent node. The runtime uses them in four places:
  1. `runNode` — around `initializeGlobals` and `registerTopLevelCallbacks`.
  2. `runNode` — around the `onAgentStart` callback (no node has executed yet).
  3. `respondToInterrupts` and `rewindFrom` — around the corresponding `registerTopLevelCallbacks` re-run.
  4. `respondToInterrupts` and `rewindFrom` — around the resume/replay `graph.run` loop. Generated node bodies re-enter ALS with a real per-node ThreadStore on every step via `Runner.runInScope`, so the bootstrap frame only covers the slice between entering `graph.run` and the first step.

The `threads` slot in a bootstrap frame is a `BootstrapThreadStore` (lib/runtime/state/bootstrapThreadStore.ts). Every user-facing method on it throws with an actionable error. The contract: **message threads do not work in bootstrap scope**. If you reach for them at module top-level, inside `callback(...)` registration, or inside `onAgentStart`, you get a loud error instead of a silent write into a placeholder that the runtime is about to discard.

`runInBootstrapFrame` is declared `async` on purpose. A synchronous throw inside `fn`, which is exactly what the `BootstrapThreadStore` sentinel does, then surfaces as a rejected promise for `.catch(...)` callers rather than an uncaught sync exception.

`onAgentEnd` is different: it fires after the run finished, so it runs inside an `agencyStore.run(...)` frame seeded with the *real* per-run ThreadStore. User callbacks can inspect the final conversation through stdlib helpers there.

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

## Codegen contract: call sites do not pass `ctx`/`stack`/`threads`

After the "drop per-call-site context plumbing" pass (see plan), runtime helpers invoked from generated code read `ctx`/`stack`/`threads` from the active ALS frame instead of accepting them as positional arguments or config-bag keys:

- `__call(target, descriptor)` / `__callMethod(obj, prop, descriptor)` build the `__state` bag from ALS internally. Call sites only pass the location-info bag when invoking `checkpoint`/`getCheckpoint`/`restore`, and pass `{ctx}` when invoked from inside `__initializeGlobals`, which runs before any ALS frame exists.
- `runPrompt({prompt, messages, clientConfig, ...})` no longer accepts `ctx` / `stateStack` — both come from ALS.
- `callHook({name, data})` no longer requires `ctx`; it falls back to `getRuntimeContext().ctx` when omitted. Generated code stops emitting `ctx: __ctx`.
- `new Runner(__ctx, __stack, {moduleId, scopeName, threads})` — `stack` defaults from ALS when omitted. `threads` is passed explicitly because every Runner needs to install its own per-scope ALS frame inside `Runner.runInScope`, and that frame must carry the per-node/per-function `ThreadStore` (which the outer ALS frame doesn't have, especially when a function is called as a tool). See PR [#200](https://github.com/egonSchiele/agency-lang/pull/200).

The two external entry points called from host TS code, `respondToInterrupts` and `rewindFrom`, install their own outer bootstrap frame around the resume/replay loop so that callbacks and stdlib helpers triggered during resume see the right context.

## See also

- [docs/dev/compiler/codegen-als-accessors.md](../compiler/codegen-als-accessors.md) — how generated code reads from the ALS frame via `__threads()` / `__ctx()` / `__stateStack()` accessors, plus the recipe for adding a new accessor or pruning an existing setup-block local.
- The initial ALS migration that introduced `agencyStore` / `getRuntimeContext()` (commit `d39103cc` on `main`).
- The follow-up PR [#198](https://github.com/egonSchiele/agency-lang/pull/198) that dropped per-call-site `{ctx, threads, stateStack}` bag emission from generated code.
- PR [#199](https://github.com/egonSchiele/agency-lang/pull/199) — BootstrapThreadStore sentinel + onAgentEnd real ThreadStore wrap.
- PR [#200](https://github.com/egonSchiele/agency-lang/pull/200) — explicit `threads:` on the Runner constructor so per-scope ALS frames carry the right `ThreadStore`.
- PR [#201](https://github.com/egonSchiele/agency-lang/pull/201) — first accessor migration (`__threads()`), template for the rest of Phase 4 cleanup.
- [docs/dev/runtime/runBatch.md](./runBatch.md) — the fork/race primitive that owns branch frames.
- [docs/dev/stdlib/adding-a-module-to-the-agency-stdlib.md](../stdlib/adding-a-module-to-the-agency-stdlib.md) — step-by-step recipe for adding a new module.

## Paid-usage accounting reads the frame

`addCost(amount)` and `addTokens(amount)` ([lib/runtime/cost.ts](../../../lib/runtime/cost.ts))
are the two stdlib helpers that charge the active branch. Both read
`{ ctx, stack }` from the active `agencyStore` frame via `getRuntimeContext()`,
then hand the explicit pair to the accounting sink.

The sink itself never touches ALS. Every export in
[lib/runtime/recordPaidUsage.ts](../../../lib/runtime/recordPaidUsage.ts)
(`recordUsage`, `recordCompletionUsage`, `recordNormalizedUsageDelta`,
`meteredDispatch`, `markInvocationUsageIncompleteAt`) takes its target
explicitly. That is what lets out-of-frame callers account correctly. The IPC
telemetry handler is the one that bites: it runs from an event-loop message
callback, outside any frame, and passes `RunSession.ctx/stateStack` directly.
See the serve cost seam section of
[hosted-agent-execution.md](../hosting/hosted-agent-execution.md).
