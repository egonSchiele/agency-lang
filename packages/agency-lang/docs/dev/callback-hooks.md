# Callback hooks and interrupts

Agency lets user code register callbacks for runtime events
(`onFunctionStart`, `onNodeStart`, `onLLMCallStart`, `onToolCallStart`,
etc.) via the stdlib `callback()` function. A callback body can call
`interrupt(...)` like any other agency code. This doc explains what
happens to that interrupt and where it ends up.

## Two paths through `callHook`

`callHook(...)` in `lib/runtime/hooks.ts` is the single dispatcher that
fires every callback for a given hook name. It now returns
`Interrupt[] | undefined`:

- **`undefined`** — no callback raised an interrupt; the hook fired and
  every callback completed normally.
- **`Interrupt[]`** — at least one callback halted with an `interrupt`
  statement that wasn't caught by a `handle` block on the live call
  stack. *All* callbacks still ran (interrupts from callback A do not
  short-circuit callback B); the returned array contains every
  interrupt that bubbled out.

There are two kinds of call site:

### Codegen-emitted (`ts.runnerHook(...)` → `runner.hook(...)`)

These fire from inside compiled agency code (function entry/exit, node
entry/exit, `emit`). The runner, `__stack`, and `__stateStack` are in
scope at the firing point. Codegen emits `ts.runnerHook(...)`, which
compiles to a single line per hook site:

```ts
await runner.hook(<id>, "onFunctionStart", { ... });
```

`Runner.hook` (in `lib/runtime/runner.ts`) is a specialized Runner
step type that owns the substep / halt machinery for callback
interrupts. When any callback halts with `Interrupt[]`, `Runner.hook`
halts its runner without advancing the substep counter so the
surrounding generated function returns the interrupts up the stack
via `runner.haltResult`. The user can respond via
`respondToInterrupts` and resume the program.

`Runner.hook` deliberately does NOT stamp its own checkpoint: the
callback's interrupt step already stamps one (via the
`interruptReturn` template) that captures the full stack including
the callback frame with its substep counters and saved
`__interruptId_N`. `respondToInterrupts` reads `intr.checkpoint`
first, so the callback-stamped checkpoint is what gets used on
resume.

**Callback fires exactly once total across resume.** Because the
callback frame's substep counters survive in its own checkpoint, on
resume the callback's body skips already-completed substeps (the
`__substep_*` locals are restored) and re-enters straight at the
interrupt step — which finds the user's response via the saved
`__interruptId_N` and completes without re-running earlier side
effects.

The five codegen-emitted hooks today are: `onFunctionStart`,
`onNodeStart`, `onNodeEnd`, `onEmit`, and `onFunctionEnd`. Of these,
the first four migrated to `runner.hook` in Phase 1. **`onFunctionEnd`
is still a raw `callHook` in a `finally` block** — interrupts thrown
from `finally` cannot propagate cleanly, so its callback-raised
interrupts are dropped today. Migrating it requires moving function
returns away from immediately-halt semantics; tracked as a follow-up.

**`onNodeEnd` has the same gap in practice for nodes with a `return`
statement.** The body's `return` compiles to `runner.halt({data: ...})`,
which sets `runner.halted = true`; the subsequent `runner.hook` call
short-circuits via `shouldSkip()`. Only nodes whose body completes
without a halting return statement reach the onNodeEnd hook. This
matches the pre-Phase-1 behavior of the raw `callHook` site, which
was also gated by the same `if (runner.halted) return runner.haltResult;`
check.

### TS-side runtime (`callHookAndDrop(...)`)

These fire from `lib/runtime/node.ts` and `lib/runtime/prompt.ts`,
outside any agency frame. They cannot pause/resume cleanly because
either there's no agency state to checkpoint (`onAgentStart` /
`onAgentEnd`) or the surrounding TS code (`runPrompt`'s internal state
machine) has no substep machinery to skip already-fired hooks on
resume. These sites use `callHookAndDrop` which fires the hook, logs
any returned interrupts to `console.error`, and continues. Phase 2
will migrate the LLM/tool hooks to a proper propagation path by
splitting `runPrompt` into agency-callable pieces.

`onAgentStart` and `onAgentEnd` are a stricter case: `callHook`
itself throws if a callback for either of these hooks raises an
interrupt, because there is no frame to checkpoint and nowhere for
the user to respond from. This catches a misuse pattern (registering
an interrupt-raising callback on a hook that fundamentally can't
support it) loudly instead of silently dropping it.

## Errors vs. interrupts in callback bodies

`fireWithGuard` distinguishes the two:

- A real JS `throw` inside a callback body is caught and
  `console.error`-logged. It never propagates further.
- An `interrupt(...)` statement in a callback body returns
  `Interrupt[]` from `AgencyFunction.invoke`. `invokeCallback` returns
  the array; `fireWithGuard` returns the array; `callHook` collects it
  into its batch. The interrupt does NOT go through the `catch` block.

`RestoreSignal` and `AgencyCancelledError` are special — they always
re-throw, since they're internal control-flow signals the runtime
relies on.

## Multiple callbacks on the same hook

`gatherCallbacks` returns callbacks in this order:
1. Innermost stack-frame scoped callbacks
2. Outer stack-frame scoped callbacks (walking up)
3. Top-level callbacks (registered at module init), in registration order
4. The TS-passed `ctx.callbacks[name]` callback, if any

`callHook` invokes them in that order and collects interrupts as it
goes. The returned `Interrupt[]` preserves the firing order.

**Resume limitation when multiple callbacks raise interrupts.** When
two callbacks on the same hook both raise an interrupt, the user
receives a batch of two interrupts. Each interrupt's `checkpoint`
property captures the stack at *its own* interrupt step — including
its own callback frame, but not its siblings'. `respondToInterrupts`
uses `interrupts[0].checkpoint` to drive the resume, so only the first
callback's frame is restored. On resume the hook re-fires, the first
callback's frame is reused from the deserialize queue and it completes
with the user's response, but the second callback is invoked fresh
(no saved frame, no saved `__interruptId`) — its body re-runs from the
top and re-raises a new interrupt, producing an unexpected extra
interrupt cycle.

A correct fix mirrors the fork pattern (`docs/dev/concurrent-interrupts.md`):
fire each callback on its own branch, stamp a single shared
hook-level checkpoint capturing all branches, store each branch's
interruptId in `setInterruptOnBranch`, and on resume re-enter only the
branches that haven't completed. That refactor is out of scope for
Phase 1. Today, prefer at most one interrupt-raising callback per
hook; if you must have multiple, expect to handle extra resume cycles
manually.

## Why the batch-and-return shape

This mirrors `runForkAll` / `runRace` from
`docs/dev/concurrent-interrupts.md`. Callbacks are sequential rather
than parallel, but the invariant is the same: each callback runs to
completion regardless of what its siblings did, and the caller gets
every halt batched together so the user can respond to all of them in
one cycle of `respondToInterrupts`.
