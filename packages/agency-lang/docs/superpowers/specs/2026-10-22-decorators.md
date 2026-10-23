# User-defined decorators — Spec

Status: settled 2026-10-22 in discussion with the maintainer, recorded in the Linear project P-ADI-3 ("Agency agent cleanup"). Tickets ADI-39 (part 1) and ADI-40 (part 2). Plan: `docs/superpowers/plans/2026-10-22-decorators.md`.

## Why

The stdlib agents and the coordinator wrappers repeat the same guard-and-salvage boilerplate in every function: take `maxCost` and `maxTime`, wrap the body in `guard(...)`, carry a `finalize` for the draft, turn a trip into a failure that names the budget. The trace that motivated this project (wX5GvrUq) failed inside exactly that boilerplate, in a copy that differed slightly from the others. Writing it once, as a decorator, is the fix. The language has no decorators today, and the maintainer wants user-definable ones, not a fixed set.

## What a decorator is

A decorator is an ordinary `def` whose last parameter is a block. Writing `@name(args)` above a function means "run my body as the block passed to `name`". Nothing else about the function changes.

```
type Call = { name: string, args: object }

def budgeted(call: Call, cost: number, time: number, block: () -> string): Result<string> {
  return guard(cost: cost, time: time, label: call.name) {
    return block()
  }
}

@budgeted(cost: maxCost, time: maxTime)
export handoff def researcherAgent(task: string, maxCost: number = $50.00, maxTime: number = 30m): Result<string> {
  ...
}
```

The compiler rewrites the decorated body to:

```
return budgeted(
  { name: "researcherAgent", args: { task: task, maxCost: maxCost, maxTime: maxTime } },
  cost: maxCost,
  time: maxTime,
) { ...original body... }
```

The tag's arguments are written by the author and evaluated on every call, in the decorated function's scope, so they can name its parameters.

## Rules

1. **The `call` record.** A decorator whose first parameter is named `call` receives `{ name, args }`: the decorated function's name and its parameters by name. One that does not declare it does not receive it. The record is passed as the first positional argument (see Decisions, 1). `args` leaves out block-typed parameters (Decisions, 4).
2. **Stacking is nesting.** `@a @b def f` becomes `a(...) { b(...) { body } }`, outermost first.
3. **Resolution.** The decorator name resolves like a call, including imports. The reserved tag names (`capabilities`, `validate`, `jsonSchema`, `hidden`, `always`, `alwaysUnder`, `optimize`) are never decorators. An unknown decorator is a compile error that names it.
4. **The formatter prints the tag back**, never the lowered body. The rewrite lives in the compiler's lowering passes, not the parser. (The `on`-clause handler desugar in the parser is the precedent for the other choice and the reason to avoid it: `agency fmt` normalizes it away.)
5. **The rewrite runs before the type checker and before the effect walk reads it.** The checker then sees an ordinary call with a block and already checks the tag's arguments against the decorator's signature, the body's `return` statements against the block parameter type, and the lowered `return decorator(...)` against the declared return type. Part 2 adds diagnostics that point at the tag and name the decorator.
6. **Effects.** A decorated function's effect set is the decorator's effects plus the body's. A `raises` clause that omits `std::guard` on a `@budgeted` function is a compile error, as it is today for a `guard` block in the body. The same holds for unanswered effects and for host capabilities.
7. **A decorator cannot replace the function or change its tool metadata.** Name, docstring, schema, `handoff`, `destructive`, and `idempotent` stay on the `def`. The LLM never sees a decorator: the tool schema comes from the `def`'s own parameters.
8. **The block rules apply.** A decorator calls `block()` directly, never stores or returns it. It may call it more than once (a `@retry` decorator).
9. **`def` only.** A node body can `goto` and a block cannot. A decorator tag on anything but a top-level `def` is an error (Decisions, 3).

## Why interrupts are inherited, not invented

`guard { }` already lowers to `_guard` with the body as a block argument, and interrupts inside a block argument resume through step counters today. `revise(...)` already calls its block more than once. A decorator that installs a handler around `block()` cannot widen approvals, because every handler in the chain votes. So the runtime does not change for this feature; the design rests on blocks already working.

## Decisions made while planning

These go beyond the sketch above or differ from it. Each is also flagged in the plan's Review Focus.

1. **The `call` record is positional, first.** The sketch wrote `budgeted(call: {...}, cost: maxCost)`. If the author's tag arguments are positional, as in `@retry(3)`, a named `call:` followed by a positional `3` is refused by the checker and the runtime alike. First-positional works with both shapes and keeps the rule "the decorator's first parameter is named `call`".
2. **Decorators lower before guards.** The guard desugar stamps a return-position `guard` with the def's declared `Result<T>` success type. Inside the decorator's block, a `return guard(...) {}` yields to the block, not the def, so that stamp would be wrong. Lowering decorators first means the guard desugar meets the body inside a block argument and stamps nothing, as for any other block today.
3. **A decorator tag in the wrong place is an error.** Today an unknown tag anywhere is ignored. Keeping that would mean `@budgeted` on a `node` silently does nothing. The reserved names keep their current behavior everywhere.
4. **The `args` record leaves out block-typed parameters.** A decorated function that itself takes a block would otherwise store a block in a record, which the block rules forbid. The parameter stays in scope inside the body.
5. **`type Call` is in the prelude** (`stdlib/index.agency`), so `def budgeted(call: Call, ...)` needs no import, like `Result`.
6. **An unresolved decorator still lowers.** The desugar does not throw; it wraps the body in a call to the unknown name and the checker reports it at the tag. This keeps the pass as simple as the guard desugar and keeps the editor usable on a half-typed tag.

## Where it lands in the code

- **Parser.** The tag grammar already accepts a tag above `export handoff def`. The change is to the argument list: a reserved name keeps today's static-only arguments; any other name takes the ordinary call argument list, with named arguments.
- **Lowering.** A new pass beside the guard desugar, run in both places the guard desugar runs (the type checker's constructor and the preprocessor), mutating in place and idempotent, since the compiler type-checks and then preprocesses the same program object.
- **Effect propagation.** The symbol table's walk runs over raw parse trees before any lowering and builds call edges from the body. A decorated body never calls its decorator, so the walk must count each decorator tag on a def as a callee, the way it counts a `guard` block as a call to `_guard`. Without this, `agency doc`, `agency policy gen`, and the `raises` check would miss the decorator's effects.
- **Runtime.** Unchanged.

## Known block bugs the tests must cover

From `docs/dev/agents/agent-brains.md`: a `match` expression inside a block body once kept its value on the enclosing frame, and `record.field(args) with approve` compiles wrong. The test set includes a `match` in a decorated body and a decorated function called through a record field.

## Verify before committing

That `destructive { }` regions and `finalize` behave inside a block argument; that effect propagation through block arguments is complete rather than special-cased for `guard`; and that `handBack` inside a decorated `handoff def` still counts. Each is a "stop and report" in the plan, not something to patch in passing.

## Out of scope

Nodes. Decorators that replace the function. Changing tool metadata from a decorator. The `@budgeted` decorator itself and the wrapper cleanup are milestone 4 (ADI-50, ADI-51).
