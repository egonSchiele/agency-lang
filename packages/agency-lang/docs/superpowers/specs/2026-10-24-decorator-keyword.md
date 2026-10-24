# The `decorator` keyword — Spec

Status: settled 2026-10-24 in discussion with the maintainer; revised after the plan review. Follows `2026-10-23-decorator-shape-and-arguments.md`, which shipped in PR #1269. Plan: `docs/superpowers/plans/2026-10-24-decorator-keyword.md`.

## Why

Today the compiler recognizes a decorator by the shape of its parameter list: the second-to-last parameter is named `call` and the last one can take a block. Nothing in the def says "this is a decorator". That has three costs.

- **The name is load-bearing.** A plain def with a parameter that happens to be named `call` right before a block parameter is treated as a decorator. It gets the exemptions a decorator gets from the required-after-optional check and from the call arity check, and a normal call to it fails at runtime instead of compile time. A reviewer found this in #1269.
- **The user has no choice of names or types.** The second-to-last parameter must be spelled `call`, and the guide tells the user to write `call: Call` and `block: (args: object) -> any` on every decorator. Both are boilerplate the compiler could supply.
- **Errors land away from the mistake.** A decorator in the wrong shape is reported at every tag that uses it. A library decorator with no tag in its own file is reported nowhere until someone imports it. Renaming `call` to `ctx` silently turns a decorator into a plain function, and the failure appears at the use site as "Found 'ctx' there".

A keyword fixes all three. Agency already has `destructive def`, `idempotent def`, and `handoff def`, and `handoff` in particular changes how the function is called, which is what a decorator does too. So this is one more modifier in a family the user knows, not a new concept.

## What changes

### 1. `decorator def` marks a decorator

```
decorator def logged(tag: string, call, block) {
  print("${tag}: entering ${call.name}")
  return block(call.args)
}

@logged("adit")
def add(a: number, b: number): number {
  return a + b
}
```

`decorator` is a function marker, like `handoff`. It may combine with `export` in any order; `agency fmt` prints `export decorator def`. The parser accepts the modifiers in any order and the formatter prints markers in the order `destructive idempotent handoff decorator`, so `decorator` sits right before `def`.

### 2. The two slots are found by position, with any names

A `decorator def` has at least two parameters. The last two are the call record and the block, in that order, whatever they are called. The decorator's own parameters come before them. The lowering passes the record by the name the user chose, so `decorator def logged(tag: string, ctx, body)` works the same as one with `call` and `block`.

The guide keeps `call` and `block` as the names in every example, so examples, the stdlib, and code the agent writes share a vocabulary. The compiler does not require them.

### 3. The two slots are typed by the compiler when left untyped

If the second-to-last parameter has no type, it is `Call`. If the last has no type, it is `(args: object) -> any`. A user who writes a type keeps it: `block: () -> string` still makes the checker check the body's returns against `string` (the `@budgeted` case in the guide).

The fill is applied to the def when the decorator lowering runs, and to an imported decorator's signature when the compilation unit is built, so the checker, the preprocessor's block-type propagation, and code generation all see typed parameters. The parse tree `agency fmt` prints is not touched: the user's text round-trips without the types.

### 4. Only a `decorator def` can be a tag

A tag naming a def that is not marked `decorator` is an error at the tag, whatever its shape:

```
'logged' is not a decorator, so '@logged' cannot go on 'add'. Declare it as `decorator def logged(...)`.
```

This replaces shape detection. `hasDecoratorShape` is deleted. The required-after-optional exemption, AG6039, and the checker's hidden-argument count all key on the marker.

### 5. The shape of a `decorator def` is checked at the def

A `decorator def` whose parameters are wrong is an error at the def, in the def's own file, whether or not a tag uses it. The message starts `'logged' is declared as a decorator, but ` and ends with one of:

- `a decorator takes at least two parameters: the call record and the body as a block.`
- `its last parameter must take the body as a block, such as \`block: (args: object) -> any\`. Found 'x: number'.`
- `'tag' receives the call record, so its type must be \`Call\` or left off.` (the second-to-last parameter has a type that is neither `Call` nor `any`)
- `'block' has a default, and a decorator always receives the call record and the block. Remove the default.`
- `'rest' is variadic, but the call record and the block are one argument each.`

The third rule exists because the checker is off by default. Without it, `decorator def d(call: Call, tag: string, block)` would pass the record into `tag` and fail at runtime, which is the trap the previous spec was written to close.

An imported decorator with a bad shape is also reported at the tag in the importing file, with the same message, so a stale compiled library still fails at compile time. AG6043 has one message wherever it appears.

### 6. A decorator can be called directly

A `decorator def` is still a function. Calling it directly means passing a record for the call slot and a block for the block slot:

```
logged("t", call: { name: "add", args: { a: 1, b: 2 } }) {
  return 3
}
```

`Call` is `{ name: string, args: object }`, a type in the prelude, so an object literal is the whole answer. There is no helper to build one and the slot is not nullable: a nullable slot would make every decorator body null-check `call.name` to serve a rare direct call.

## Rules

1. `decorator` is a marker keyword on `def`, carried in `markers.decorator` from the parser through the symbol table, imports, and re-exports, like `handoff`.
2. A tag may name only a def with `markers.decorator`. Local or imported.
3. A `decorator def`'s last two parameters are the call record and the block, by position. Names are free. Neither has a default or is variadic. The record slot's type, if written, is `Call` or `any`; the block slot's type, if written, is a block type or `any`.
4. Untyped slots are filled: `Call` and `(args: object) -> any`.
5. The lowering passes the record by the record slot's own name, after the tag's arguments, and the body as the block.
6. The required-after-optional check (parser and AG6039) skips the last two parameters of a `decorator def` only.
7. In the checker, a call that carries `decorator` has two hidden arguments; any other call to a `decorator def` has none, so a direct call is checked like any call.
8. The checker reports a non-decorator tag and a bad decorator shape on its own (AG6044, AG6043), so a program checked without the decorator stage is not accepted; the editor drops those copies when the stage already reported.

## Diagnostics

| Code | Name | Where | Message |
| --- | --- | --- | --- |
| AG6043 | `decoratorShape` | the def; the tag for an import | `'{name}' is declared as a decorator, but {problem}` |
| AG6044 | `notADecorator` | the tag | `'{name}' is not a decorator, so '@{name}' cannot go on '{target}'. Declare it as \`decorator def {name}(...)\`.` |

The decorator stage (`decoratorProblems`) reports the same two mistakes, rendered from the same registry entries so the text lives once, plus the existing ones (unknown name, JavaScript import, loop, misplaced tag), and the CLI build stops on them with the checker off.

## Decisions

- **Keyword over a tightened convention.** Requiring `call: Call` would have closed the hole with no new syntax, but it asks the user for more (the name and the type) where the keyword asks for less (neither). The maintainer wants untyped slots and free names.
- **A direct call passes a record literal.** No `Call` constructor, no nullable slot.
- **A plain def with the right shape is not a decorator.** One way to say it.
- **The record slot may be typed `any`.** A reusable decorator that reads nothing from the record can say so.
- **No new marker conflicts.** `handoff decorator def` is accepted and meaningless, like `idempotent` on a def nothing retries. Out of scope.

## Where it lands in the code

- `lib/types/function.ts`: `FUNCTION_MARKER_KEYWORDS` gains `"decorator"`; `FunctionMarkers.decorator`; one section that owns `isDecoratorDef`, `DECORATOR_SLOT_COUNT`, `recordSlotName`, `withDecoratorTypes`, `decoratorShapeProblem`, and `callerSuppliedParameters`; nothing else reads `markers.decorator`; `hasDecoratorShape` deleted.
- `lib/parsers/parsers.ts`: the ordering check keys on the marker. The keyword list already drives the modifier parser.
- `lib/backends/agencyGenerator.ts`: nothing; `markerKeywordsOf` prints the new word.
- `lib/compilationUnit.ts`: `ImportedFunctionSignature.markers`, so the one predicate works on a def and on an import alike; the fill on import.
- `lib/preprocessors/decoratorDesugar.ts`: the fill on lowering; the lookup carries `decorator` and the record slot's name; `decoratorProblems` checks every local `decorator def` and refuses a tag on a non-decorator.
- `lib/typeChecker/checker.ts`, `paramDefaultOrder.ts`, `diagnostics.ts`, `diagnosticExplanations.ts`, a new `decoratorDefs.ts` pass; `lib/lsp/diagnostics.ts` drops both copies.
- `stdlib/strategy.agency`: `export decorator def guarded(...)`.
- Every decorator in `tests/`, `lib/**/*.test.ts`, and the docs gains the keyword.

## Out of scope

- Marker conflicts (`handoff decorator`).
- Whether a `decorator def` should be left out of the tools a model sees. Today it is treated like any def with a block parameter.
- Implicit parameters (`decorator def logged(tag: string)` with `call` and `block` supplied by name). The keyword makes it possible later; it is not built.
