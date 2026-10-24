# Review: Decorator Shape and Arguments plan

Plan: `docs/superpowers/plans/2026-10-24-decorator-shape-and-arguments.md`
Spec: `docs/superpowers/specs/2026-10-23-decorator-shape-and-arguments.md`
Reviewed 2026-10-24 against `main` at `cf8c27b82`.

I checked the plan's file and line references against the code. Most are right: `paramStore` at `typescriptBuilder.ts:2240`, `processBlockArgument` at `:1915`, the `markDestructiveRan` case at `:685`, the parser ordering loop at `parsers.ts:7524`, `hiddenDecoratorArguments` and `writableParameterNames` at `checker.ts:729-743`, the comment at `parsers.ts:249`, and 17 agent files with one `@guard(` each. The findings below are where the plan and the code disagree, or where the plan does what the spec says but the result will not behave the way the spec describes.

I could not run anything locally (a hook blocks local test and `pnpm run ast` runs), so findings 1 and 2 are reasoned from the generated code. Each one says what to run to confirm it.

## Must fix before executing

### 1. A resume throws away the rebind

The plan stores rebound values on the decorated function's frame (`__stack.args["n"] = ...`) and relies on the frame being saved in the checkpoint. That part is true. The problem is what happens when the function is entered again on resume.

On resume, the program replays from the top. `main`'s step that calls `f(1)` is still in progress, so it calls `f(1)` again, with `1`. The function entry then runs the store for every plain parameter:

```ts
// tests/typescriptGenerator/decorators.mjs:919, the entry of a decorated def
__stack.args["task"] = task;
```

The builder says this runs on every entry (`typescriptBuilder.ts:2399-2402`: "A plain parameter is stored on every entry"). So the saved `n = 2` is overwritten with the caller's `1`. The block's rebind step already finished before the interrupt, so the resume skips it. The body reads `n` and gets `1`.

Example: `withTwo` calls `block({ ...call.args, n: 2 })`. The body is `interrupt("go?")` then `return n`. The caller runs `f(1)`. If the interrupt is answered by a real pause and resume, `f` returns `1`. The spec says `2`.

The same thing happens to `!` parameters through a different path. `checkedParamStore` skips the store when the slot exists, so the checked value survives. But that only works for `!` parameters.

The plan's test does not catch this. `rebind-resumes` wraps the call in `handle { } with approve`. A handler that approves answers the interrupt in the same process. Nothing is saved and nothing resumes. The existing `interrupt-resumes.test.json` shows how to make a real resume: `"interruptHandlers": [{ "action": "approve" }]` in the test file and no handler in the program.

Ways to fix it, for the plan to choose:

- Run the rebind on every block entry, outside a step, the way `blockSetup.mustache` stores the block's own parameters. The record is in `__bstack.args.__args`, which is restored on resume, so the result is the same each time. A `!` check would then have to skip on resume the way `checkedParamStore` does, because a validator claims a frame and must not run twice.
- Store the rebound values somewhere the function entry does not write, for example on the block's frame, and read them from there. This changes how the body reads its parameters, which is a bigger change.

Whichever is chosen, `rebind-resumes` must use `interruptHandlers`. Add a stacked case too: after a resume, the inner decorator's `call.args` is rebuilt from `__stack.args`, so it changes from what the inner decorator saw before the pause.

To confirm: write `rebind-resumes` with `interruptHandlers` and run it once against the plan's design.

### 2. Rebind failures come back in two different ways

The spec says a failing rebind "is the value `block()` returns", and that "a decorator such as `retry` sees it as a failed attempt." The plan produces two behaviours:

- A `!` check that fails goes through `__checkParams`, which calls `runner.halt(failure)` on the block's runner (`paramChecks.ts:93`). The block returns `runner.haltResult`, so `block()` returns a failure value. This matches the spec.
- A missing required key or an unknown key goes through `__reboundArgument` and `__checkReboundKeys`, which throw an `Error`. The block's `catch` rethrows anything that is not an abort (`blockSetup.mustache`). The error passes through the decorator, which does not see a value at all. It turns into a failure only when some enclosing function returns `Result`.

So a `retry` decorator that returns `any` would not "see a failed attempt" on a missing key. It would be cut off, and so would the decorated function if it does not return `Result`.

The plan's fixtures hide this. `rebind-missing-required` and `rebind-unknown-key` both decorate a function that returns `Result<number>`. The function's own catch turns the exception into a failure, so the test passes either way.

Pick one behaviour and test it. The simplest choice is to have the generated code call `runner.halt(failure(message))` for all three, the way `__checkParams` does. Then `block()` returns a failure every time. Add a fixture where the decorator inspects the value: `const r = block()` followed by `if (isFailure(r)) { ... }`, on a decorated function that does not return `Result`.

If the spec meant the exception behaviour (the same thing a real call does today: `agencyFunction.ts:594` throws), the spec's `retry` sentence is wrong and should change. Either way the spec and the plan should say the same thing.

### 3. Tasks 4 to 6 leave `main` unbuildable

Task 4 makes every decorator need `call` second-to-last. The stdlib `guard` decorator has `call` first (`strategy.agency:201`), and 17 agent files tag a def with it. From the Task 4 commit until Task 6, `make` fails on the stdlib, and every test that imports a stdlib agent fails to compile.

Task 4 Step 8 has the same problem on a smaller scale. It runs `make fixtures` before updating `tests/typescriptGenerator/decorators.agency`. That fixture's `retry(times: number, block: () -> any)` has no `call`, so it now fails to compile and the regenerated output is an error.

Fix: move the `strategy.agency` signature change (not the rename) into Task 4, and update `decorators.agency` before running `make fixtures`. Or merge Task 6 into Task 4. Each commit should build.

### 4. Every codegen fixture changes, not just `decorators.mjs`

Task 4 Step 8 says "Only `decorators.mjs` should change." The generated import list is in `lib/templates/backends/typescriptGenerator/imports.mustache:32`, and every compiled fixture prints it (`decorators.mjs:33` is one). Adding `__reboundArgument` and `__checkReboundKeys` to it changes every `.mjs` under `tests/typescriptGenerator/`.

Also, Task 3 Step 6 says to add the names "to the generated import list". That list is a template. Per the package `CLAUDE.md`, edit the `.mustache` file and run `pnpm run templates`. Do not edit `imports.ts`.

## Should fix

### 5. `block()` on a function with a variadic parameter fails

`__reboundArgument(R, "rest", false, "f")` treats `rest` as required, because a variadic parameter has no default. So `block()` on `def f(first: string = "a", ...rest: string[])` throws "Missing required argument 'rest'". A real call `f()` gets `rest = []` (`agencyFunction.ts:600-605` only fills the variadic when it is named).

Add a case to `rebind.test.ts` and a `block()` line to `rebind-variadic`.

This is a sign of the larger point in finding 9: the helpers redo work `AgencyFunction.resolveNamed` already does.

### 6. The parser test expects the wrong message

Task 2's second test expects `/Required parameter 'label' cannot follow optional parameter/`. The neighbouring test in the same file expects `/expected/` for the same mistake (`paramDefaultOrder.test.ts:15-20`). That suggests the parser's `label(...)` wrapper replaces the specific message with an "expected a function definition" message. Step 2's "Expected: a thrown parse error containing `Required parameter 'call'`" probably has the same problem. Run it once and copy what it prints into the test.

### 7. Old decorator wording the plan does not list

- `stdlib/index.agency:72`, the doc comment on `type Call`: "a decorator whose first parameter is named `call` receives one of these". The spec says `type Call` is unchanged, but this comment is now wrong. It generates `docs/site/stdlib/index.md`.
- `lib/typeChecker/diagnosticExplanations.ts:816`: the AG explanation for `decoratorBodyReturn` uses `def budgeted(cost: number, block: () -> string)` as its example, which no longer compiles. Task 4 finds sentences by the phrase "a def whose last parameter is a block", which this one does not contain. These explanations also generate pages through `make diagnostics-docs`.
- `docs/dev/language/decorators.md:168` describes `DecoratorOrigin.passesCallRecord` and the arity count. Task 7 rewrites the doc, but this paragraph is in the arity section, not the ones Task 7 names.

### 8. The `docs/site` edits need the owner's say

Task 7 edits `docs/site/guide/decorators.md` and `guards.md`. The spec lists them in its Docs section, so they may be wanted. The standing rule is to leave `docs/site/**` alone in a feature PR unless asked. Ask before Task 7 Step 3, or move it to its own commit that is easy to drop.

## Design: reuse `resolveNamed`

The plan writes two new runtime helpers that redo four things the runtime already does when a call passes named arguments (`AgencyFunction.resolveNamed`, `agencyFunction.ts:503`):

| Rule | `resolveNamed` | Plan's helpers |
|---|---|---|
| Unknown key | message lists the valid names, leaving out function-typed parameters (`:524`) | takes its own `names` list from codegen |
| Missing required | throws (`:594`) | throws, same text |
| Defaulted and absent | `UNSET`, padded only when a later name is given | `UNSET` always |
| Variadic absent | left empty, so the parameter is `[]` | treated as missing (finding 5) |

Finding 5 is what happens when the same rule is written twice. A third copy also exists at compile time (`namedArgsResolver.ts`), and `resolveNamed` has a comment saying the two must be kept in step.

A smaller design would add one public method to `AgencyFunction`, something like `bindRecord(record)`. It would call `resolveNamed([], record)`, then gather the variadic the way `resolvePositional` does, and return one value per parameter with `UNSET` where none was given. The decorated function's own `AgencyFunction` is a module-level constant in the generated file, so the block can reach it by name. Codegen then emits the existing `paramStore` per parameter, reading from that array. One rule set for calls and rebinds, and the error text is the same because it comes from the same code.

Two things to settle if this route is taken. First, `resolveNamed` wants the block argument when the function takes one, so pass the current value from `__stack.args`. Second, `resolveNamed` reads `_unboundParams`, which leaves out parameters bound by `.partial()`. A decorated function's own constant is never partially applied, so that should not matter, but the plan should say so.

If the two-helper design stays, at least make the unknown-key list come from the same filter `resolveNamed` uses, and fix the variadic case.

## Smaller points

- **Defaults before `call` and direct calls.** With the AG6039 exemption, `def d(cost: number = 1, call: Call, block: ...)` is legal. A user who calls it directly as `d(myCall) { ... }` puts `myCall` into `cost`. The `paramDefaultOrder.ts` comment says this shape lets "required `b`" be "silently left undefined". The decorator lowering always passes `call` by name, so tags are fine. Consider whether the checker should warn on a direct positional call to a decorator-shaped def, or at least say in the guide that `call` is passed by name.
- **`hasDecoratorShape` in the parser covers more than decorators.** It treats an untyped or `any` last parameter as a block, so `def f(a: number = 1, call: string, cb)` is exempt from the ordering rule even if it is never used as a decorator. Requiring the last parameter to be block-typed for the exemption (not for the decorator check) would close this. The spec allows an untyped block, so this is a choice for the owner.
- **One error for a wrong shape.** When a decorator lacks `call`, the lowered call passes `call:` by name to a def with no such parameter. Check that the type checker does not also report "Unknown named argument 'call'" next to the shape error. One test in `decoratorChecks.test.ts` would pin it.
- **`rebindParameters` reports no identifiers.** Registering it with `identifierSlots: none` means every walker thinks it reads and writes nothing, even though it writes the decorated function's parameters and reads `__args`. Nothing I found needs that information today. Say in the type's doc comment that the omission is deliberate, so the next walker that cares knows to look.
- **Spec wording on `call.args`.** The spec says `call.args` "is built once, when the decorated function is entered." With stacking, the inner decorator's record is built inside the outer block, after the outer rebind, which is what `stacked-rebind-order` expects. Reword the spec sentence to "built when the decorator is called".
- **Parameter aliases.** `block({ url: "x" })` where `url` is an alias of `baseUrl` will be an unknown key. That matches "Agency code that writes one gets an error" (`parameter-aliases.md`). Add one line to `rebind.test.ts` or a fixture so it stays that way.
- **`rebind-missing-required`** does not say what `main` calls. Write `const r = f(1)` in the plan so the fixture is not guessed.
- **Task 3 test location** is left open ("or the nearest existing builder unit test"). If codegen is only tested through Task 4's fixture, say so, and move the codegen check there.

## Tests to add

1. `rebind-resumes` with `interruptHandlers`, no `handle` block (finding 1).
2. A stacked version of it, checking the inner decorator's `call.args` after the resume (finding 1).
3. A decorator that does `const r = block()` and checks `isFailure(r)`, on a decorated function that does not return `Result`, for a missing key, an unknown key, and a failed `!` check (finding 2).
4. `block()` on a function with a variadic parameter (finding 5).
5. A wrong-shape decorator gives exactly one error (smaller points).

## Response, 2026-10-24

Each finding was checked against the code before the plan changed.

1. **Confirmed and fixed.** `__stack.args["task"] = task` runs on every entry (`decorators.mjs:919`), and a resume re-enters with the caller's arguments. Fix chosen: a decorated def stores every parameter the way a `!` parameter already does, skipping the store when the slot exists (`checkedParamStore`, renamed `firstEntryParamStore`). The rebind stays a plain step 0; on resume it is skipped and the restored slots keep its values. Smaller than a block-setup preamble, no template change, and the `!` check keeps running once. `rebind-resumes` now uses `interruptHandlers` with no handler in the program; `stacked-rebind-resumes` covers the inner record after resume.
2. **Confirmed and fixed.** All failures go through `runner.halt(failure(message))` inside the one runtime function, so `block()` always returns a failure value. `rebind-failure-is-block-result` tests the three causes on functions that do not return `Result`.
3. **Fixed.** The stdlib signature change and the fixture edit moved into Task 4; Task 6 is only the rename. Every commit builds.
4. **Fixed.** `imports.mustache` plus `pnpm run templates`; Task 4 expects every `.mjs` to change by one line.
5. **Fixed by taking the design suggestion.** `AgencyFunction.bindRecord(record, blockArg)` wraps `resolveNamed([], record, blockArg)` and `resolvePositional`, so unknown keys, missing arguments, defaults, variadics, and the messages all come from the one existing rule set. The two hand-written helpers are gone. `_unboundParams` is all parameters for a def's module constant, which is never partially applied; the plan says so.
6. **Accepted.** The test asserts what the parser prints after one run.
7. **Accepted.** All three sites are in Tasks 4 and 7.
8. **Deferred to the owner.** The guide edits are a separate commit in Task 7, made only on a yes. The spec's Open question 0 lists it with the two shape questions below.

Smaller points: block-typed-only exemption and a warning on a positional `call` are owner decisions, recorded in the spec's Open question 0 with a recommendation (block-typed only: yes; warning: no, the guide says `call` is by name). One-error-for-wrong-shape: the checker skips argument checks on a decorator call whose target lacks the shape, with a test. `identifierSlots` omission documented on the node type. Spec wording changed to "built when the decorator is called". Alias key: `rebind-alias-key`. `rebind-missing-required` names its `main`. Codegen is tested through the Task 4 fixture, stated in Task 3.
