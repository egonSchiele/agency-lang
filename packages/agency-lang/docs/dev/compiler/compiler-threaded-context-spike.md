# Spike: compiler-threaded context (removing `node:async_hooks`)

**Status:** spike / sizing. No production behaviour changes in this PR.
**Goal it serves:** letting the runtime run in the browser / embedded targets,
where `node:async_hooks` does not exist.

## The question

Today the runtime reads its per-run frame (`ctx`, `stack`, `threads`,
`globals`, and a few optional slots) from a `node:async_hooks`
`AsyncLocalStorage` called `agencyStore` (`lib/runtime/asyncContext.ts`). That
ambient store is what lets a stdlib helper deep in the call graph call
`getRuntimeContext()` without every caller passing the frame down by hand.

`async_hooks` is Node-only, so it blocks a browser / embedded build.
"Compiler-threaded context" removes the ambient store entirely: the compiler
passes the frame in as an explicit parameter, every generated call site
forwards it, and the accessors read it from that parameter. No ambient
mechanism means no `async_hooks` and no polyfill.

This spike answers: **what would that take, how big is it, and how much
complexity does it add?**

## TL;DR

- **Feasible** — the mechanism works; the proof-of-concept in
  `lib/runtime/experimental/threadedContext.ts` (+ test) demonstrates threading
  a frame through async calls, deriving child scopes, and the one hard case,
  all with `async_hooks` switched off.
- **Large** — roughly **~205 ambient read sites** across ~30 runtime files and
  ~19 stdlib files, **~41 codegen emission points**, **~7 seeding points**, and
  **12 templates**, plus **5 `AsyncLocalStorage` instances** in **6 files**.
- **It reverts a deliberate migration.** The codebase moved *to* ALS on purpose
  across the initial migration (`d39103cc`) and PRs #198–#201, to escape exactly
  the explicit-threading pattern this would reintroduce. See "What this reverts."
- **There is a much cheaper route to the same goal** (browser support): put the
  ambient store behind a small seam and back it with the TC39 `AsyncContext`
  polyfill in the browser build. That changes ~6 files and **zero** call sites.
  Full compiler threading buys robustness (no polyfill) at a large cost; it is
  probably a later step, not the first one.

## What "compiler-threaded context" means, concretely

Generated code today (from a real compile, `bar.js`):

```ts
const __ctx = getRuntimeContext().ctx;
// ...
messages: __threads().getOrCreateActive();
```

Threaded:

```ts
async function main(__store, /* ...user params */) {
  const __ctx = ctxOf(__store);
  // ...
  messages: threadsOf(__store).getOrCreateActive();
  await someOtherNode(__store, /* ... */); // forward the frame to every callee
}
```

And a stdlib helper today:

```ts
export async function _recall(query: string) {
  const { ctx, stack } = getRuntimeContext(); // ambient
  // ...
}
```

Threaded:

```ts
export async function _recall(__store: AgencyStore, query: string) {
  const { ctx, stack } = __store; // explicit
  // ...
}
// every caller must now pass __store
```

## Size (measured against the current tree)

| Surface | Count | Notes |
| --- | --- | --- |
| `getRuntimeContext()` reads | ~151 | non-test `lib/` |
| `agencyStore.getStore()` reads | ~54 | includes the accessor internals |
| Codegen sites emitting accessors | ~41 | generator `.ts` + templates |
| Templates referencing accessors | 12 | `lib/templates/backends/typescriptGenerator/` |
| Seeding points (`agencyStore.run`) | ~7 | see async-context.md |
| `AsyncLocalStorage` instances | 5 | `agencyStore`, `callDepth`, `executingHandlers`, `hooks._activeCallbacksALS`, `statelogClient.spanStorage` |
| Files importing `node:async_hooks` | 6 | `asyncContext`, `interrupts`, `callDepth`, `executingHandlers`, `hooks`, `statelogClient` |
| Stdlib helper files reading the frame | 19 | `lib/stdlib/*` |

The reads are the bulk of it: every one becomes "take/forward `__store`" in
generated code, or "accept `__store` as a parameter" in a stdlib helper, and
every caller of those helpers has to pass it.

## The hard part: escaping async boundaries

Threading is mechanical for the parts the compiler controls (function bodies,
their direct calls, the seeding points). The complexity lives where control
**re-enters** the runtime from an event-loop callback that no caller threaded a
frame into:

- `.then`/`await` on a promise that escaped the generated call graph,
- `setTimeout` / emitter / message handlers,
- scoped callback dispatch (`hooks.ts`),
- fork / race branch bodies (`runBatch.ts`),
- the IPC telemetry handler — `async-context.md` already calls this one out as
  running "outside any frame."

ALS carries the frame across all of these for free. Explicit threading has to
**capture** the frame at each such boundary and re-bind it (the `bindStore`
primitive in the PoC). Miss one and the callback runs with the wrong context or
none — a silent failure, and precisely the class of bug ALS was adopted to
prevent. Auditing every boundary is the real work and the real risk.

## What this reverts

`docs/dev/runtime/async-context.md` documents the pre-ALS mechanism this would
bring back — "context-injected builtins" that prepended `__ctx, __stateStack,
__threads` to specific calls at codegen time — and why it was dropped:

1. **Every new abortable helper** needed a registry entry plus a special TS
   signature `(ctx, stack, threads, ...userParams)`; easy to forget either, and
   a test existed just to guard the drift.
2. **Bare references** to those names (`let f = __internal_recall`) had to be
   rejected by the typechecker or they silently produced context-less code.
3. **Cross-stdlib calls** were verbose: callers passed `(ctx, stack, threads,
   ...args)` by hand.

A full threading migration reintroduces all three. It also reverts the initial
ALS migration (`d39103cc`) and PRs #198 (dropped per-call-site context bags),
#199 (`BootstrapThreadStore`), #200 (explicit `threads:` on `Runner`), and #201
(first accessor migration).

## Cheaper alternative for the browser goal

The end goal is "runs without `async_hooks`," not "no ambient store." Those come
apart:

- **Seam + polyfill.** All ~205 reads already funnel through one object
  (`agencyStore`) plus four satellite ALS instances. Wrap the `{ getStore, run }`
  surface behind a seam, keep Node `AsyncLocalStorage` for the Node build, and
  select the TC39 `AsyncContext` polyfill for the browser build via the package
  `exports` `"browser"` condition. **~6 files change, zero call sites**, and the
  hard escaping-boundary cases keep working because the polyfill preserves ALS
  semantics.
- **Compiler threading.** Everything above. Buys independence from a polyfill
  and removes a class of ambient-context bugs by construction, at ~205 call
  sites + codegen + reverting merged work.

## Recommendation

For unblocking a browser / embedded build, do the **seam + `AsyncContext`
polyfill** first — it is days, not weeks, and low regression risk. Keep
**compiler-threaded context** on the table as a later robustness play if the
polyfill proves flaky or if removing all ambient context becomes worth the
churn. If we do pursue full threading, land it in the same staged shape the ALS
migration used (accessors first, then seeding points, then stdlib helpers), one
mechanism per PR, each behind CI.

## What is in this spike PR

- `lib/runtime/experimental/threadedContext.ts` — the threaded frame carrier,
  the accessors (`ctxOf` / `threadsOf` / `stackOf` / `globalsOf`), `deriveStore`
  for child scopes, and `bindStore` for the escaping-callback case.
- `lib/runtime/experimental/threadedContext.test.ts` — proves reads survive
  awaits with `async_hooks` off, child scopes don't disturb the parent, and the
  escaping-callback case (with the ALS contrast that shows the cost of dropping
  it).
- This doc.

Nothing here is wired into the compiler or runtime; it is additive so the change
is safe to land while the decision above is made.
