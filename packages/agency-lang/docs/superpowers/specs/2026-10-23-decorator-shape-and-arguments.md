# Decorator shape and argument passing — Spec

Status: settled 2026-10-23 in discussion with the maintainer. Follows `2026-10-22-decorators.md`, which shipped the feature this spec changes. No plan yet.

## Why

Today a decorator is any def whose last parameter is a block. If its *first* parameter happens to be named `call`, the compiler also passes a `{ name, args }` record there. Nothing else about the def says it is a decorator.

That rule is easy to break without noticing. The maintainer wrote this:

```
def logged(tag: string, call: Call, block: () -> any): any { ... }

@logged("adit")
def add(a: number, b: number): number { ... }
```

The first parameter is `tag`, so the compiler decided `logged` takes no record. `"adit"` went into `tag`, nothing filled `call`, and the failure surfaced at runtime as "Missing required argument 'call'". The opposite mistake makes no noise at all. A decorator whose ordinary first parameter happens to be called `call` receives the record, and every tag argument lands one slot to the right.

Two smaller problems came up alongside it:

- The stdlib's `@guard` decorator shares its name with the `guard { }` block. `guard(...) {` always parses as the block, so the decorator cannot be called as a function, and seven stdlib agents split themselves into an inner def to work around it (`docs/dev/agents/subagent-budgets.md`).
- A decorator cannot change the arguments the body runs with. `call.args` is a copy made for reading. In Python, TypeScript, and Lisp advice, a wrapper owns the call and can pass different arguments through; that is how argument coercion, defaults from context, and dependency injection decorators work. Agency's `block()` always runs the body with whatever the caller passed.

## What changes

### 1. One shape for every decorator

A decorator's last two parameters are always `call: Call` and the block, in that order, both required. The decorator's own parameters come before them.

```
def logged(tag: string, call: Call, block: (args: object) -> any): any {
  print("-> ${call.name} ${JSON.stringify(call.args)} -- ${tag}")
  const result = block(call.args)
  print("<- ${call.name}")
  return result
}

@logged("adit")
def add(a: number, b: number): number {
  return a + b
}
```

The compiler rewrites `add` to:

```
def add(a: number, b: number): number {
  return logged("adit", call: { name: "add", args: { a: a, b: b } }) {
    return a + b
  }
}
```

The tag's arguments go first, by position or by name as the author wrote them. The record goes after them **by name**, so it never competes with a positional tag argument for a slot. The block goes last, as every block does.

A decorator that does not use the record still declares `call`. That is the cost of having one shape. There is no second form to remember, and no parameter is treated specially because of where it sits.

### 2. The block takes the arguments

The body block takes one parameter, a record of arguments keyed by the decorated function's parameter names. The decorator chooses what the body sees:

```
block(call.args)                          // run with the arguments as passed
block({ ...call.args, name: "default" })  // run with one argument changed
block()                                   // run with no arguments at all
```

`block()` with no record means every parameter is unset, the same as a call that passes nothing. A parameter with a default takes its default. A parameter with no default is missing, and the body does not run: `block()` returns the failure a call gets today, "Missing required argument 'name' in call to 'f'". The same holds for a record that leaves such a parameter out.

A failing rebind (a missing parameter, an unknown key, a `!` check that fails) is raised inside the block, so it is the value `block()` returns. A decorator that returns the block's result passes the failure on; a decorator such as `retry` sees it as a failed attempt. This is the same place a failure from the body itself lands.

With stacked decorators, each block rebinds in turn. `@outer @inner def f` lowers to `outer(call: ...) { rebind; return inner(call: ...) { rebind; body } }`, and `inner`'s record is built after `outer`'s rebind has run, so `inner` sees the arguments `outer` passed.

The record is applied the way a call's arguments are:

- A key that matches a parameter sets it. A parameter the record leaves out is unset, as above: its default if it has one, a "Missing required argument" failure if not.
- A `!` parameter is checked again against the new value. A decorator cannot slip an unchecked value past a validator by rebinding it.
- Block-typed parameters of the decorated function are not in `call.args` (a block cannot be stored in a record) and are not touched by a rebind; they keep the value the caller passed.
- A key that names no parameter is a runtime failure that names the key, the same failure a call with an unknown named argument gets today ("Unknown named argument 'x' in call to 'f'", `lib/runtime/agencyFunction.ts:529`).

`call.args` is built when the decorator is called, from the parameters as they are at that moment. It does not change when that decorator rebinds, so `block(call.args)` always means the arguments the decorator was handed, even after an earlier `block({ ... })` on the same call.

A rebind survives a pause. When a decorated function is paused inside its body and resumed later, the body still sees the rebound values. Today a function stores every parameter on the frame on every entry, and a resume re-enters the function with the caller's original arguments; that store would overwrite the rebound slots. A decorated function therefore stores its parameters on first entry only, the way a `!` parameter already does (`checkedParamStore`, `docs/dev/language/validation-annotations.md`), so a restored frame keeps what the rebind wrote.

### 3. The stdlib decorator is renamed `@guarded`

`std::strategy` exports `guarded` in place of `guard`. The `guard { }` block, the `std::guard` effect, and the `guard` keyword in the parser are unchanged. The name clash goes away, and with it the rule that the decorator cannot be called with a block.

The inner-def split in the stdlib agents stays. It exists because a decorator wraps a whole def and post-processing wants to sit outside the wrap. The name clash only made the split mandatory. Simplifying the agents is a separate change.

## Rules

1. **Shape.** A decorator is a def whose second-to-last parameter is named `call` and whose last parameter takes a block (the existing `lastParameterTakesBlock` test: block-typed, untyped, or `any`). Neither may have a default. A tag naming a def of any other shape is a compile error (see Diagnostics).
2. **AG6039 does not apply to those two parameters.** The rule "no required parameter after a defaulted one" exists because a call can omit trailing arguments. The compiler supplies `call` and the block on every decorator call, so they can never be omitted, and a decorator's own parameters may have defaults in front of them. `checkParamDefaultOrder` skips the last two parameters of a def with the decorator shape and nothing else.
3. **The record is passed by name.** The lowered call is `name(<tag arguments>, call: { name, args }) { body }`.
4. **The body block takes one parameter**, the arguments record, and the compiler inserts a rebind of the decorated function's parameters from it as the block's first step. The rebind resolves the record with the same code a named-argument call uses (`AgencyFunction.resolveNamed`, through a new `bindRecord` method), so unknown keys, missing arguments, variadic parameters, and aliases follow the call's rules and produce the call's messages, and then runs the `!` checks a call runs.
5. **A decorated function stores its parameters on first entry only**, so a resume does not overwrite a rebind (see "The block takes the arguments").
6. **The block's type.** The guide writes it `(args: object) -> T`. A decorator that never passes arguments may still write `() -> T`; see Verify, 1.
7. **Everything else from the 2026-10-22 spec holds.** Stacking is nesting. Tag arguments are evaluated on every call in the decorated function's scope. The decorator's effects are the function's effects. The tool schema comes from the def. The formatter prints the tag back.

## Diagnostics

The decorator checks in `decoratorProblems` (`lib/preprocessors/decoratorDesugar.ts`) gain the shape rules. Each message names the decorator and the function it is written on, like the existing ones:

- The second-to-last parameter is not `call`: "'logged' cannot decorate 'add': a decorator's last two parameters are `call: Call` and a block, so `call` must come right before the block. Found 'tag' there."
- The def has fewer than two parameters, or its last cannot take a block: the existing message, reworded to state the two-parameter shape.
- `call` or the block has a default: "'logged' gives 'block' a default, but a decorator always receives 'call' and the block. Remove the default."

The messages that describe a decorator ("A decorator is a def whose last parameter is a block") change to the new shape wherever they appear: `decoratorDesugar.ts`, the explanations in `diagnosticExplanations.ts`, the guide page, and the dev doc.

## Decisions

1. **Your arguments first, then `call`, then the block.** Three layouts were weighed. `call` first (today's slot, made required) keeps the rewrite as it is but puts tag arguments one slot off from the parameter list, so `@logged("adit")` fills the *second* parameter. `call` and block first, then your arguments, would make defaults trivial but breaks the rule that a block binds to the last parameter, which every block-taking function follows. The chosen layout reads like a call, costs one AG6039 exemption, and needs the record passed by name instead of by position.
2. **Both required, no name-by-position magic.** The 2026-10-22 spec made `call` optional so short decorators stayed short. The bug in Why is the price of that. One shape is checked once, at the tag, with a message that says what was expected.
3. **`block()` means no arguments, not the original ones.** The maintainer's call. "Run with the original arguments" is spelled `block(call.args)`, which is explicit about what it does. A missing parameter fails the way it fails on a call, so a decorator cannot run a body with a required parameter unset. See Open questions, 1, for the compile-time side.
4. **The rebind goes through the call path.** Defaults and `!` checks are applied by the same code a call uses. A decorator is often imported from a package the author of the decorated function did not write; it must not be a way around that function's validators.
5. **`guard` the decorator is removed, with no alias.** Keeping it as a second name would keep the parse quirk alive for anyone who used it.
6. **A decorated function's `!` parameters are checked twice on a rebind**: once at entry, as today, and once more when the block rebinds them. The second check runs on different values.

## Where it lands in the code

- **`lib/preprocessors/decoratorDesugar.ts`.** `decoratorCall` emits the record as a named argument after the tag's arguments and drops the `takesCallRecord` test. The body block gets one parameter, named `__args`, and a new first statement that rebinds the parameters. The `__` check sits in the parser and sees only what the user typed (`docs/dev/language/reserved-names.md`), so a name the lowering adds is allowed, as `__matchval_1` is. `decoratorProblems` gains the shape checks. `DecoratorOrigin.passesCallRecord` goes away, since every decorator receives it.
- **A rebind statement.** A new AST node the lowering inserts and the TypeScript builder compiles. For each non-block parameter of the decorated function, the builder emits the store `paramStore` emits today, reading from the record instead of the impl's parameter, with the key's absence standing in for `__UNSET`, and then the `!` checks for the checked parameters. Where it lives in the builder and how it shares code with `paramStore` is the plan's job. The rule is that there is one store and one check.
- **`lib/typeChecker/paramDefaultOrder.ts`.** Skip the last two parameters of a def with the decorator shape. The shape test is one function in `lib/types/function.ts` beside `lastParameterTakesBlock`, used by the checker, the desugar, and AG6039 alike.
- **`stdlib/strategy.agency`.** `guard` becomes `guarded`, its `block` parameter loses `= null`, and its body calls `block(call.args)`. The 18 `@guard(` tags across `stdlib/agents/` become `@guarded(`. The parser comment at `lib/parsers/parsers.ts:249` is updated.
- **`stdlib/index.agency`.** `type Call` is unchanged.
- **Runtime.** `AgencyFunction.bindRecord(record, blockArg)` in `lib/runtime/agencyFunction.ts`, a public method over the private `resolveNamed` and `resolvePositional`, returning one value per parameter by name. `lib/runtime/rebind.ts`: the one function the rebind statement calls, which binds the record, applies defaults, writes the frame, runs `__checkParams`, and turns any failure into a halt of the block's runner so `block()` returns a failure. Blocks with a parameter, assignment to a parameter from inside a block, and resuming inside a block all exist today.
- **Docs.** `docs/dev/language/decorators.md` (the shape, the rebind, the renamed decorator, and the removed "cannot be called with a block" section), `docs/dev/agents/subagent-budgets.md` (the name), `docs/site/guide/decorators.md` and `guards.md`. The generated stdlib pages pick up the rename from `make`.

## Tests

Existing fixtures that change shape: `retry-calls-block-twice`, `stacked-order`, `handler-in-decorator`, `interrupt-resumes`, `log-around`, `match-in-body`, `guard-in-decorated-body`, `destructive-region-in-body`, `finalize-in-body`, `decorated-block-taker`, `through-record-field`, `tests/agency-js/decorator-handoff`, `tests/typescriptGenerator/decorators.agency`, and `tests/agency/guards/guard-decorator.agency`. Each decorator in them gains `call: Call` before its block if it lacks one, and `block()` becomes `block(call.args)` where the body reads a parameter.

New fixtures under `tests/agency/decorators/`:

- `rebind-changes-argument`: `block({ ...call.args, name: "default" })`; the body sees the new value.
- `rebind-no-arguments`: `block()` on a function whose parameters all have defaults; the body sees the defaults.
- `rebind-missing-required`: `block()` on a function with a parameter that has no default; the function returns the "Missing required argument" failure and the body does not run.
- `rebind-restores-original`: `block({ ... })` then `block(call.args)`; the second run sees the original.
- `rebind-rechecks-validated`: a `!` parameter rebound to a value that fails its check; the function returns the validation failure.
- `rebind-unknown-key`: a key that is not a parameter; a failure naming it.
- `rebind-keeps-block-parameter`: the decorated function takes a block; a rebind leaves it callable.
- `rebind-resumes`: an interrupt after the rebind; the resumed body still sees the rebound value.
- `defaults-before-call`: a decorator with defaulted parameters before `call`, used with and without those arguments. This is the AG6039 exemption at work.
- `compile-errors/call-not-second-to-last`, `compile-errors/default-on-call-or-block`: through `agency compile` with the checker off, like the existing compile-error fixtures.

`lib/typeChecker/paramDefaultOrder` gets a unit test that a required parameter after a defaulted one is still refused on a def that is *not* decorator-shaped, so the exemption is no wider than the two slots.

## Verify before committing

Checked 2026-10-24, before the plan was written:

1. The checker accepts `block(record)` against a block typed `() -> any`, and `block()` against `(args: object) -> any`. Block call arity is not checked in either direction. A `() -> T` decorator keeps working; the guide recommends `(args: object) -> T` for clarity. The plan pins this in `decoratorChecks.test.ts`.
2. Statements inside a block have their own step counter and a resume skips completed ones (`docs/dev/runtime/interrupts.md:16-20`); parameters live on the serialized frame. The plan pins the rebind case in `rebind-resumes.agency`.
3. The draft path relies on the guard block being `return block()` (`subagent-budgets.md:113`), which `return block(call.args)` keeps. `tests/agency/guards/guard-decorator.agency` pins it after the rename.
4. `__activation` is declared once per function and never redeclared in a block (`destructive-regions.md:33`); a block parameter does not touch it. `destructive-region-in-body.agency` pins it after migration.

## Open questions

0. Three questions from the plan review, answered by the maintainer 2026-10-24: the guide pages `docs/site/guide/decorators.md` and `guards.md` are updated in this change; the decorator shape keeps accepting an untyped or `any` last parameter as the block (no block-typed-only rule); there is no checker warning on a positional argument reaching `call`, and the guide says `call` is passed by name.
1. A call that leaves out a required argument is a compile error when the checker is on (AG6016). Should `block()` get the same check? The compiler knows the decorator's `block()` call sites and, at each tag, the decorated function's parameters, but a decorator is checked once and used on many functions, so the check would have to run per tag. Deferred. The runtime failure above is the floor.
2. Whether to fold the inner-def split out of the seven stdlib agents now that `@guarded` can be called as a function. Not part of this change.

## Out of scope

Decorators on nodes. Decorators that replace the function or change its tool metadata. Typed block parameters. Generic decorators.
