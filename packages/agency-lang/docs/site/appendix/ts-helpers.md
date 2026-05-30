---
title: TypeScript helpers — the `agency.*` namespace
description: Reference for the `agency` namespace exported from `agency-lang/runtime`, which lets TypeScript code participate in an Agency run — reading context, manipulating threads, installing handlers, taking checkpoints, and issuing LLM calls.
---

# TypeScript helpers — the `agency.*` namespace

Agency's runtime exposes a single namespace, `agency`, that lets TypeScript code participate fully in an agent run: read execution context, push thread messages, install handlers and guards, take checkpoints, issue LLM calls, and write resumable workflows. Everything you need for first-class TS interop is reachable from one import.

```ts
import { agency } from "agency-lang/runtime";
```

There are no individual named exports for the helpers — `agency.<method>` is the canonical surface. Types (`ResumableScope`, `ResumableScopeOpts`, `LlmOpts`, `CallsiteLocation`) and a small set of low-level primitives (the `Interrupt` shape, the `RuntimeContext` class) remain accessible as named exports for cases where you need to write a type annotation.

## When a TS helper "participates" in a run

Every method on `agency.*` reads its dependencies from an [AsyncLocalStorage](https://nodejs.org/api/async_context.html) frame the runtime installs around each Agency execution step. When you call a TS function from Agency code, that frame is already in place — your helper sees the same `ctx`, `stack`, and `ThreadStore` the surrounding Agency function saw.

The corollary: most `agency.*` methods **throw if called outside an Agency frame**. Calling `agency.thread.current()` from a script's top level, or from a setTimeout callback that escaped the run, raises a clear error pointing at the cause. For the lax-read methods (`agency.ctxMaybe()`, `agency.thread.storeMaybe()`), the throw is replaced with `undefined`.

The one place this contract is relaxed is `agency.withTestContext({ctx, stack, threads}, fn)` — covered in [Testing TS helpers](#testing-ts-helpers).

## Setup

There is no setup. Import the namespace and call its methods from a TS function that's reachable from Agency code.

```ts
// helpers.ts
import { agency } from "agency-lang/runtime";

export function greetingPrompt(name: string): string {
  // Inspect the active thread without modifying it.
  const turnCount = agency.thread.current().getMessages().length;
  return `Turn ${turnCount}: hello, ${name}`;
}
```

```agency
import { greetingPrompt } from "./helpers.js"

node main(name: string) {
  const p = greetingPrompt(name)
  print(p)
}
```

The compiled `main.js` calls `greetingPrompt(name)` from inside an active Runner step; the ALS frame is already installed, so `agency.thread.current()` resolves.

---

## Context

| Method | Returns | Throws? |
| --- | --- | --- |
| `agency.ctx()` | active `RuntimeContext` | yes, outside a frame |
| `agency.ctxMaybe()` | `RuntimeContext \| undefined` | no |
| `agency.callsite()` | `CallsiteLocation \| undefined` | no |
| `agency.global<T>(name, moduleId?)` | the named module global | yes |

### `agency.ctx()` / `agency.ctxMaybe()`

The active runtime context — same object the codegen used to receive as a `__ctx` positional argument. Useful for advanced uses (custom statelog events, looking up checkpoint metadata, inspecting cost). Most user code never needs to touch it.

```ts
const ctx = agency.ctx();
console.log(`run id: ${ctx.runId}, cost so far: ${ctx.stateStack.localCost}`);
```

### `agency.callsite()`

The source location attached to the current step by `Runner.runInScope`. Format: `{ moduleId: string, scopeName: string, stepPath: string }`. Returns `undefined` in bootstrap-frame contexts (module init, `onAgentStart`, etc.). The runtime uses this to attribute every checkpoint to its source location; you can read it for custom telemetry.

### `agency.global<T>(name, moduleId?)`

Read a module-scoped global. `moduleId` defaults to `""` (the anonymous module). Equivalent to the Agency-level `globals.get(...)`. Use this when a TS helper needs to consult a global declared in an Agency module.

```ts
const apiKey = agency.global<string>("API_KEY", "config");
```

---

## Threads

The active thread is the `MessageThread` instance the surrounding LLM call (or builtin) is writing into. Most agent code only ever interacts with one thread; switching is for advanced patterns like auxiliary threads or per-tool subthreads.

| Method | Description |
| --- | --- |
| `agency.thread.current()` | active `MessageThread`, creating one if none exists |
| `agency.thread.user(content)` | push a user-role message |
| `agency.thread.system(content)` | push a system-role message |
| `agency.thread.assistant(content)` | push an assistant-role message |
| `agency.thread.store()` / `storeMaybe()` | the full `ThreadStore` |
| `agency.thread.with(threadId, fn)` | run `fn` with `threadId` as the active thread |

### Pushing messages

```ts
export async function setupConversation(systemPrompt: string): Promise<void> {
  agency.thread.system(systemPrompt);
  agency.thread.user("Begin.");
}
```

### Switching threads

`agency.thread.with(threadId, fn)` runs `fn` with `threadId` pushed as the active thread, then pops it on the way out (including on throw). Accepts sync or async callbacks. Use it to run an LLM call against an auxiliary thread without disturbing the main conversation.

```ts
const store = agency.thread.store();
const auxId = store.create();

const auxResponse = await agency.thread.with(auxId, () =>
  agency.llm("Summarize the last user message"),
);
```

---

## LLM

`agency.llm(prompt, opts?)` issues an LLM call through the same `runPrompt` pipeline the codegen `llm(...)` emission uses. Cost, threads, trace events, and checkpoint integration all flow through automatically.

```ts
const text  = await agency.llm("Suggest a name for a SaaS product");
const obj   = await agency.llm("Extract first/last", { schema: NameSchema });
const aux   = await agency.llm("...", { thread: someThread });
const fast  = await agency.llm("...", { model: "gpt-4o-mini" });
```

### Return type

Generic + overload pair:

```ts
agency.llm(prompt)                  // Promise<string>
agency.llm(prompt, { schema: S })   // Promise<z.infer<S>>
agency.llm(prompt, { model })       // Promise<string>
```

The schema overload wins when `schema` is set; otherwise you get the raw string response. TypeScript narrows the result type automatically.

### `LlmOpts`

```ts
import type { LlmOpts } from "agency-lang/runtime";

type LlmOpts<S extends z.ZodSchema = z.ZodSchema> = {
  /** Per-call model override. Does NOT mutate the active client. */
  model?: string;
  /** Zod schema for structured output. */
  schema?: S;
  /** Override the thread (default: active thread). */
  thread?: MessageThread;
};
```

### Tools — not in v1

`agency.llm` intentionally does **not** accept a `tools` field. Agency's tool registry is per-module and codegen-managed; exposing it to TS callers would leak codegen internals into the public surface.

If you need LLM-driven tool dispatch from a TS helper, write the call as an Agency `def` (which inherits the tool registry automatically) and invoke that `def` from TS:

```agency
def runWithTools(prompt: string): string {
  return llm(prompt, { tools: [getWeather, lookupOrder] })
}
```

```ts
import { runWithTools } from "./agent.js";
const r = await runWithTools("What's the weather in NYC?");
```

### Model override is per-call

`opts.model` applies to a single prompt. It does **not** rebind the active LLM client. Subsequent `agency.llm` calls without `opts.model` fall back to the default model. If you need to switch the default across a whole run, configure the client up front.

### Cost tracking and threads

Every `agency.llm` call increments the active branch's `localCost` and `localTokens` accumulators the same way the codegen path does. Inside a `withCostGuard(...)`, the guard sees the spend in real time and trips if exceeded. The prompt and assistant response are appended to the active (or overridden) thread, so subsequent `agency.llm` / Agency `llm()` calls in the same flow see them.

---

## Checkpoints

| Method | Description |
| --- | --- |
| `agency.checkpoint()` | capture a checkpoint at the current step |
| `agency.getCheckpoint(id)` | retrieve a previously-created checkpoint |
| `agency.restore(idOrCp, opts?)` | restore execution to a prior checkpoint |
| `agency.withCallsite(loc, fn)` | run `fn` with a custom callsite installed |

Checkpoints flow through the same machinery as the codegen `checkpoint(...)` builtin — the recorded location comes from `agency.callsite()` automatically. `agency.withCallsite(...)` lets a TS helper attribute substep checkpoints to a custom location for debugger/trace clarity:

```ts
await agency.withCallsite(
  { moduleId: "my.helper", scopeName: "retry", stepPath: "2.1" },
  async () => {
    const cpId = await agency.checkpoint();
    /* ... */
  },
);
```

Most TS helpers will never need `withCallsite` — the runtime-seeded callsite from the surrounding step is the right value. Reach for it when you're subdividing a TS-side helper into substeps that each deserve a distinct trace location.

---

## Handlers, guards, and cost

### `agency.withHandler(handler, fn)`

Push a handler onto `ctx.handlers` for the duration of `fn`; pop on return (including on throw). Handlers respond to interrupts the same way `handle { ... }` blocks in Agency code do.

```ts
await agency.withHandler(
  (intr) => {
    if (intr.kind === "std::read") return approve("auto-y");
    return undefined; // let it propagate
  },
  () => doWorkThatMightInterrupt(),
);
```

### `agency.withCostGuard(maxCost, fn)` / `agency.withTimeGuard(maxMs, fn)`

Install a `CostGuard` / `TimeGuard` on the active branch's stack for the duration of `fn`. The guards are charged automatically by every `agency.llm` and `llm(...)` call in scope and throw `GuardExceededError` on trip.

```ts
await agency.withCostGuard(0.05, async () => {
  await agency.llm("Be brief: " + question);
  await agency.llm("Now elaborate slightly: " + question);
});
```

### `agency.addCost(amount)`

Add USD spend to the active branch and bill all guards. Use this when a TS helper wraps its own paid call site (a custom LLM client, a third-party API) and wants the cost to participate in `agency.withCostGuard` / cost reporting the same way `agency.llm` does.

```ts
const { tokens, cost } = await myCustomLLM(prompt);
agency.addCost(cost);
```

---

## Memory

TS helpers reach Agency's memory layer through `agency.memory.*`. Every method mirrors a function in `std::memory`, so a TS helper can do the same push/configure/recall/forget operations Agency code can.

```ts
import { agency, type MemoryConfig } from "agency-lang/runtime";

export async function withUserMemory<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await agency.memory.enable({ dir: `./mem/${userId}` });
  await agency.memory.setId(userId);
  try {
    return await fn();
  } finally {
    agency.memory.disable();
  }
}
```

### Methods

| Method | What it does |
| --- | --- |
| `agency.memory.enable(config)` | Push a memory frame; `config.dir` resolves against `process.cwd()`. Same dir as top is a no-op. |
| `agency.memory.disable()` | Pop the top frame. Includes the JSON-seeded bottom frame — use the block form in Agency for lexical scoping. |
| `agency.memory.setId(id)` | Update the scope id. Orthogonal to frames — persists across push/pop. |
| `agency.memory.enabled()` | `true` iff a frame is currently active. |
| `agency.memory.remember(content)` | Extract + store facts. No-op when no frame is active. |
| `agency.memory.recall(query)` | Retrieve facts as a formatted string. Empty when no frame or no match. |
| `agency.memory.forget(query)` | Soft-delete matching facts. |

The `MemoryConfig` type is re-exported from `agency-lang/runtime` so TS helpers can accept it as a parameter without reaching into the internals.

---

## Resumable scopes

A resumable scope wraps a TS body in the same substep-counter + serialized-frame machinery generated Agency function bodies use. Interrupts that happen inside a step body re-enter exactly where they left off on resume: already-completed steps are skipped, and the deepest in-flight step re-runs from scratch.

If you've used Temporal, this is the same model: each `s.step(...)` is a journaled point that survives crash/interrupt/resume.

### Basic shape

```ts
import { agency } from "agency-lang/runtime";

export async function processOrder(orderId: string) {
  return agency.withResumableScope({ name: "processOrder" }, async (s) => {
    const order     = await s.step(() => loadOrder(orderId));
    const validated = await s.step(() => validate(order));
    const stored    = await s.step(() => persist(validated));
    return stored;
  });
}
```

### The `ResumableScope` API

```ts
type ResumableScope = {
  step<T>(fn: () => T | Promise<T>): Promise<T>;
  getLocal<T>(key: string): T | undefined;
  setLocal<T>(key: string, value: T): void;
  halt(result: unknown): void;
};
```

- **`s.step(fn)`** — each call gets an auto-incrementing id (0, 1, 2, ...) tied to call order. On resume, the body re-runs only if not already completed; cached return values are returned without re-executing.
- **`s.getLocal` / `s.setLocal`** — frame-local storage that survives resume. Use these for state you want available across step boundaries (counters, retry accumulators).
- **`s.halt(result)`** — sets the underlying runner's halt flag and makes the scope return `result`. Subsequent `s.step(...)` calls short-circuit. Useful for bubbling out an interrupt response that a step body has already handled. **Does not throw** and **is not an interrupt** — for that, use Agency-level `interrupt(...)`.

### `ResumableScopeOpts`

```ts
type ResumableScopeOpts = {
  name: string;                      // shown in traces / debugger
  moduleId?: string;                 // default: "<ts-helper>"
  pinResultCheckpoint?: boolean;     // default: true
};
```

`pinResultCheckpoint: true` pins a `result-entry` checkpoint at scope entry so the calling Agency function's `result.retry()` rewinds back to scope start, exactly as it would for a generated function body. Set false for helpers whose results should not participate in retry.

### ⚠️ Determinism contract

**This is load-bearing.** Resumable scopes work because the runtime can replay step calls in a stable order to find the in-flight step on resume. Break the order and resume picks the wrong step body.

The rules:

1. **Step bodies must be pure with respect to inputs.** On resume, the in-flight step's body re-runs from scratch — any non-pure work (`Date.now`, `Math.random`, cumulative I/O) will diverge from the pre-interrupt run.
2. **All I/O that should run exactly once must live inside a `s.step(...)` body.**
3. **Step calls MUST be issued in a stable order across the original run and every resume.** Don't put `s.step(...)` behind a condition whose outcome could change between runs (random branching, wall-clock, external state). Straight-line code, loops with deterministic bounds, and conditions over stable inputs are all fine.

```ts
// ❌ Wrong: condition over wall-clock — outcome may differ on resume
await agency.withResumableScope({ name: "bad" }, async (s) => {
  if (Date.now() % 2 === 0) {
    await s.step(() => sideEffectA());
  }
  await s.step(() => sideEffectB());
});

// ✓ Right: I/O lives inside steps; ordering is stable
await agency.withResumableScope({ name: "good" }, async (s) => {
  const now = await s.step(() => Date.now());
  if (now % 2 === 0) {
    await s.step(() => sideEffectA());
  }
  await s.step(() => sideEffectB());
});
```

### Pairing with `agency.llm` and interrupts

`agency.llm` calls inside a `s.step(...)` body inherit the scope's resumability. If the LLM call interrupts (cost-guard trip, future cancellation, etc.), the scope serializes its frame and on resume picks up at the same step:

```ts
return agency.withResumableScope({ name: "analyze" }, async (s) => {
  const claims = await s.step(() =>
    agency.llm("Extract claims from: " + doc, { schema: ClaimList }),
  );
  const verified = await s.step(() =>
    Promise.all(claims.map((c) => verifyClaim(c))),
  );
  return verified;
});
```

If `verifyClaim` itself issues `agency.llm` calls and the third one trips a cost guard, only that one re-runs on resume — the extracted claims are cached, the first two verifications are cached, and the resume picks up at the third.

### Side-by-side: Agency vs TS

The same workflow expressed two ways. Both are resumable.

**Agency:**

```agency
def analyzeDocument(doc: string): Verified {
  const claims = llm("Extract claims from: " + doc, { schema: ClaimList })
  const verified = parallel { for (c in claims) { verifyClaim(c) } }
  return verified
}
```

**TypeScript:**

```ts
export async function analyzeDocument(doc: string): Promise<Verified> {
  return agency.withResumableScope({ name: "analyzeDocument" }, async (s) => {
    const claims = await s.step(() =>
      agency.llm("Extract claims from: " + doc, { schema: ClaimList }),
    );
    const verified = await s.step(() =>
      Promise.all(claims.map((c) => verifyClaim(c))),
    );
    return verified;
  });
}
```

Pick whichever reads better for the task. Agency wins when the workflow uses named args, blocks, `match`, or first-class function semantics. TS wins when you need complex data wrangling, TS-only libraries, or gradual migration of an existing TS codebase.

---

## Testing TS helpers

`agency.withTestContext({ctx, stack, threads}, fn)` installs an ALS frame from explicit dependencies so unit tests can exercise TS helpers directly:

```ts
import { describe, it, expect } from "vitest";
import { agency, RuntimeContext, ThreadStore } from "agency-lang/runtime";

describe("greetingPrompt", () => {
  it("counts existing turns", async () => {
    const ctx = new RuntimeContext({
      statelogConfig: { host: "https://x", apiKey: "k", projectId: "p", debugMode: false },
      smoltalkDefaults: {},
      dirname: "/tmp",
    });
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    threads.active()!.push(agency.thread.user("hello"));

    const result = await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      () => Promise.resolve(greetingPrompt("alice")),
    );
    expect(result).toMatch(/Turn 1/);
  });
});
```

`withTestContext` is marked `@internal` — it's intended for testing, not production code paths. Anything you'd reach for it from in production should use the regular Agency entry points (`runNode`, `respondToInterrupts`) instead.

---

## Anti-patterns

- **Calling thread builtins from module-init scope.** Module top-level code runs inside a bootstrap frame whose `ThreadStore` is a sentinel — every method throws. If you have setup work that needs the thread, defer it into the first node body.
- **Non-determinism inside `s.step` bodies.** `Math.random`, `Date.now`, reading mutable module-level state — all break the resume contract. Capture those values into a `s.step(() => Date.now())` so the captured value is cached and re-used on resume.
- **Mutating module-level state from inside steps without `s.setLocal`.** Frame-locals are serialized into the checkpoint and restored on resume. Module-level mutations are not. Use `s.setLocal` for anything that needs to survive resume.
- **Passing `tools` to `agency.llm`.** The option doesn't exist. If you need tool dispatch from a TS helper, define a small Agency `def` that issues the `llm(...)` call (with `tools`) and invoke that `def` from TS.
- **Wrapping every TS helper in `withResumableScope`.** The scope adds bookkeeping; only use it when you have meaningful "I/O that should run exactly once on resume" sub-steps. A pure-function helper doesn't need a scope.
- **Forgetting that `s.halt(value)` does not throw.** Code after `s.halt(...)` runs to the next `s.step(...)` boundary; only `s.step` short-circuits. If your step body needs to exit immediately, `return;` after `s.halt(...)`.

---

## Reference: namespace at a glance

```ts
agency.ctx()                              // active RuntimeContext
agency.ctxMaybe()                         // RuntimeContext | undefined
agency.callsite()                         // CallsiteLocation | undefined
agency.global<T>(name, moduleId?)         // module global

agency.thread.current()                   // active MessageThread
agency.thread.user(content)               // push user message
agency.thread.system(content)             // push system message
agency.thread.assistant(content)          // push assistant message
agency.thread.store() / storeMaybe()      // active ThreadStore
agency.thread.with(threadId, fn)          // scoped thread switch

agency.llm(prompt, opts?)                 // typed LLM call

agency.checkpoint()                       // capture checkpoint
agency.getCheckpoint(id)                  // retrieve by id
agency.restore(idOrCp, opts?)             // restore
agency.withCallsite(loc, fn)              // scoped callsite

agency.withHandler(handler, fn)           // scoped interrupt handler
agency.withCostGuard(maxCost, fn)         // scoped CostGuard
agency.withTimeGuard(maxMs, fn)           // scoped TimeGuard
agency.addCost(amount)                    // custom cost contribution

agency.withResumableScope(opts, body)     // Temporal-style resumable scope

agency.withTestContext({ctx,stack,threads}, fn)  // (test only)
```

For the broader interop story (cancelling agents, importing Agency code from TS, gotchas around serializability), see [TypeScript Interoperability](/guide/ts-interop).
