# The `?` operator

`expr?` reads a `Result`. If it is a success, the expression is the success
value. If it is a failure, the enclosing function returns that failure,
unchanged:

```
def readMeta(root: string): Result<MetaFile> {
  const parsed = readJsonFile(root, "meta.json")?
  return success(parsed)
}
```

This is Rust's `?`. In prose it is called the `?` operator. In code the
access-chain element is `unwrap`, because `?` cannot be an identifier, and
`hasUnwrap`, `unwrapChecks.ts`, and the `unwrap...` diagnostic names follow
from that. It is not called the try operator, because `try` is a keyword
that means something else.

## Grammar

`?` is an element of an access chain, parsed by `unwrapChainParser` beside
`.name`, `[index]`, `[a:b]`, `.method(args)`, and `(args)` in
`chainElementParser` (`lib/parsers/parsers.ts`). The element is
`{ kind: "unwrap" }` (`lib/types/access.ts`). Because it is a chain element it
binds tighter than everything else, so `foo()?.name` means `(foo()?).name`
and `a()?.b()?.c()?` reads left to right.

A `?` followed by another `?` is nullish coalescing and is left for the
binary-operator table. A `?` followed by `.`, `[`, or `(` continues the
chain. Chain elements are probed on the raw input with no whitespace
skipping, so after a variable the `?` must be adjacent: `x ?` is not an
unwrap. The call parser consumes the whitespace after `foo()`, so `foo() ?`
does parse as an unwrap; it means the same as `foo()?`.

Agency has no ternary. The refusal in `exprParser` looks for `? expr :` after
an expression. When the expression already ends in an unwrap, the `?` of a
ternary written without a space (`cond? a : b`) has been consumed, so
`ternaryRefusal` also tries the ` a : b` tail directly. Both spellings give
the "Agency has no ternary" message.

Optional chaining (`a?.b`, `a?.[0]`, `a?.(x)`) was removed when `?` was
added. Old code that used it on a plain object is caught by AG2023 below.

## What it does

The hoist pass lowers every `?` to the statements a hand-written check
produces (`lowerUnwraps` in `lib/preprocessors/hoistCalls.ts`). The chain is
split at each `?` by `chainPieces` (`lib/types/access.ts`). Each piece before
a `?` becomes a temp, followed by an `isFailure` temp and a guard that
returns the first temp, and the chain continues from the temp's `.value` as
one flat chain:

```
const x = a()?.b()?

const __hoist_0 = a()
const __hoist_1 = isFailure(__hoist_0)
if (__hoist_1) {
  return __hoist_0
}
const __hoist_2 = __hoist_0.value.b()
const __hoist_3 = isFailure(__hoist_2)
if (__hoist_3) {
  return __hoist_2
}
const x = __hoist_2.value
```

The `isFailure` call comes from `resultCheckCall` in
`lib/lowering/patternLowering.ts`, the function the `is failure` pattern
lowers through, so both paths build the same node. The temps come from the
frame's `__hoist_N` counter. Every emitted statement carries the chain's
`loc`, so the debugger and the source map point at the line that wrote the
`?`.

Rules of the lowering:

- The split happens whether or not the chain is a statement tail, so
  `return foo()?` hoists `foo()`. A bare `foo()?` statement has its own case
  in the statement dispatcher, because a bare access chain is otherwise left
  alone.
- Arguments inside each piece hoist first, in evaluation order.
- The piece after the last `?` follows the ordinary chain rule: it stays
  inline unless it contains a method call and the chain is not a statement
  tail, in which case it hoists as a unit.
- The returned failure is the original object. A rejected interrupt's
  `rejected` and `functionName` fields reach the caller as they do from a
  hand-written `return parsed`.

`const x = expr?`, `let x = expr?`, `x = expr?`, and `const { a } = expr?`
all hold `expr?` in an assignment's value slot, so one rule covers them.
Destructuring lowers at parse time to `__tmp_N = expr?` plus one assignment
per field, and the `?` lowers on the `__tmp_N` statement. A compound
assignment, `n += expr?`, parses as a bare expression statement, which the
pass never extracts from, so AG1021 refuses the `?` there.

### Under `with approve`

`const text = read(path)? with approve` is rewritten inside its handler
region. The `withModifier` case of `rewriteStatement` lowers the inner
statement as it would anywhere else and wraps the result in a `handleBlock`
whose handler is the same builtin, so every temp and the guard stay covered
by the approval the author wrote. A `with` statement with no `?` is left as
it was. `foo()? with approve` with no assignment does not parse, because the
shorthand accepts only an assignment, a `return`, or a plain call before
`with`.

### In a block

A `return` inside a block argument, a comprehension body, or a `parallel`
arm's block returns from the block, and so does the return a `?` lowers to.
The failure then self-propagates from the block's value as any failure does.

## Where it is refused

The type checker refuses a `?` wherever the lowering cannot run or cannot
mean what it says (`lib/typeChecker/unwrapChecks.ts`, run beside
`checkCastPositions`).

| Code | Name | When |
|---|---|---|
| AG2023 | `unwrapNonResult` | The operand is not a `Result`. Reported in the chain walk of `synthValueAccess`; the chain continues as `any`. |
| AG2024 | `unwrapReturnTypeNotResult` | The nearest def or node has a declared return type that `Result<any, any>` is not assignable to. A `?` inside a block argument is not checked against the def. |
| AG1021 | `unwrapInOpaquePosition` | A position the hoist pass never lifts from: the right side of `&&`, `\|\|`, or `??`, either side of `catch`, a `\|>` stage, a `try` operand, or a bare expression statement such as a compound assignment. |
| AG1022 | `unwrapOutsideBody` | A module-level initializer or a parameter default. |
| AG1023 | `unwrapInHandlerBody` | A handler body (`with (intr) { ... }`), which compiles to plain code with no steps. |
| AG1024 | `unwrapInParallelArm` | The top level of a `parallel` arm. An arm hands its bindings back when it finishes and cannot return early. Checked on the pre-desugar tree, where the `parallelBlock` ancestor is still visible. |
| AG1025 | `unwrapInAssignmentTarget` | A write target, `obj?.field = 1`. An assignment's target chain is not an expression slot, so `hoistPositions` never lists it; the check walks every assignment's `accessChain`. |

AG1021 to AG1023 come from `positionRefusals`
(`lib/typeChecker/positionRefusals.ts`), the one loop that turns
`hoistPositions` statuses into diagnostics. The checked cast uses the same
loop with its own table. `hoistPositions` has two rules for `?`: a bare
access-chain statement that holds one extracts from its own expressions, and
a `with` statement that holds one keeps its positions liftable. The agreement
test in `hoistPositions.test.ts` runs the real pass over both programs.

AG1021 to AG1025 are fatal in every mode, like the platform diagnostic
(`isUnwrapRefusal`, read by `buildSession.ts`). Type errors are warnings
unless `typechecker.strict` is set, and a warning here would let compilation
run on into the throw below.

`async f()?` is AG2023: the value is a pending handle, and the lowering would
drop the `async`.

After the pass no `unwrap` element remains. `processValueAccess` in the
TypeScript builder and `accessChain` in `assignmentEmitter.ts` throw
`UNWRAP_REACHED_CODEGEN` (`lib/types/access.ts`) on one. A user cannot reach
that throw; it marks a toolchain bug.

## Interrupts, case by case

- **A pause inside the operand.** The operand is its own step. The pause
  serializes that step's counter and the frame. On resume the call completes
  once, its value lands in the temp, and the guard and the `.value` read run
  as fresh steps against the restored local.
  `tests/agency-js/unwrap-resume` round-trips the checkpoint through JSON
  and counts the operand's runs.
- **A rejected interrupt.** The operand returns a failure with `rejected`
  set. The guard returns it unchanged, so a tool call that was refused still
  reports the refusal to the model.
- **Handlers.** The temps and the guard land immediately before the original
  statement, in the same block, so they are inside every `handle` block that
  enclosed the line. The `with approve` expansion keeps them inside the
  handler region by construction. `tests/agency/unwrap/handlers.agency`
  covers approve, reject, a data-driven handler, and both one-line forms.
- **`checkpoint()` and `restore()`.** The temps are frame locals and the
  guard's `if` records its branch like any other. Nothing new is serialized.
- **Forks and `parallel`.** A `?` at the top level of an arm is refused
  (AG1024). Inside a block argument, which owns its frame and its `__hoist_N`
  counter, `?` returns the failure from the block.
- **Handler bodies.** Refused (AG1023). `?` never adds a pausing site to a
  handler.
- **Code fingerprints.** Adding `?` to a file changes its compiled step
  numbering, and a checkpoint from before the edit is already refused by the
  fingerprint check.

## Files

- `lib/types/access.ts`: the `unwrap` element, `isUnwrapElement`,
  `hasUnwrap`, `chainPieces`, `UNWRAP_REACHED_CODEGEN`.
- `lib/parsers/parsers.ts`: `unwrapChainParser`, `chainElementParser`,
  `ternaryRefusal`.
- `lib/parsers/unwrap.test.ts`, `lib/parsers/access.test.ts`.
- `lib/backends/agencyGenerator.ts`, `lib/utils/node.ts`,
  `lib/backends/typescriptGenerator/typeToString.ts`: print `?`.
- `lib/utils/node.ts`: `containsUnwrap`.
- `lib/utils/expressionSlots.ts`: an unwrap has no slots.
- `lib/typeChecker/pathSegments.ts`: an unwrap ends a narrowing path.
- `lib/typeChecker/synthesizer.ts`: `unwrapOperandType`, AG2023.
- `lib/typeChecker/positionRefusals.ts`, `lib/typeChecker/unwrapChecks.ts`:
  AG2024 and AG1021 to AG1025.
- `lib/typeChecker/diagnostics.ts`, `lib/typeChecker/diagnosticExplanations.ts`.
- `lib/preprocessors/hoistCalls.ts`: `lowerUnwraps`, the bare-statement case,
  the `with` expansion.
- `lib/preprocessors/hoistPositions.ts`: the two `?` rules.
- `lib/lowering/patternLowering.ts`: `resultCheckCall` is exported.
- `lib/backends/typescriptBuilder.ts`,
  `lib/backends/typescriptBuilder/assignmentEmitter.ts`: the tripwire.
- `tests/typescriptGenerator/unwrap.agency`, `tests/agency/unwrap/`,
  `tests/agency-js/unwrap-resume/`.
