# The `?` operator: unwrap a Result or return its failure

## Summary

Agency gets a postfix `?` operator. Written after an expression that holds a
`Result`, it gives the success value, and if the Result is a failure it returns
that failure from the enclosing function:

```
def readMeta(root: string): Result<MetaFile> {
  const parsed = readJsonFile(root, "meta.json")?
  return success(parsed)
}
```

That one line replaces the four-line check the stdlib writes by hand today:

```
const parsed = readJsonFile(root, "meta.json")
if (parsed is failure) {
  return parsed
}
```

The operator is Rust's `?`. It is lowered by the compiler to exactly the
hand-written form above, so the runtime, the checkpoint format, and the
interrupt machinery do not change.

The change removes optional chaining (`a?.b`, `a?.[0]`, `a?.(x)`) from the
language, because `?.` now reads as "unwrap, then access". That is a breaking
change, accepted on purpose; the reasons are in "Why `?.` can be taken".

## Background

### Results and the pattern

Agency has no exceptions. A function that can fail returns a `Result`, which
is either `success(value)` or `failure(message, data)`. Code that calls such a
function has to look inside the Result before using the value. The common
shape is "if it failed, hand the failure to my caller":

```
const parsed = readJsonFile(root, "meta.json")
if (parsed is failure) {
  return parsed
}
const file = parsed.value
```

A count over the stdlib and the built-in agents found this shape 99 times (91
plain `return parsed`, plus 8 `return failure(x.error, x.data)` copies). A
further 31 sites re-wrap the failure with a new message
(`return failure("meta.json has the wrong shape: ${err}")`). The operator
covers the first group. The second group stays hand-written; see "Out of
scope".

### What Agency already has, and why none of it is this

- `catch` gives a fallback value: `read(p) catch ""`. It never leaves the
  function.
- `|>` short-circuits a chain of one-argument functions. It is used twice in
  the stdlib and never by the agents.
- A failure passed to a function whose parameter is not typed to take a
  Result skips that function and comes out the other side. That carries a
  failure forward through calls; it does not stop the current function.

The missing piece is "stop here and give my caller the failure", which is
what `?` does.

### What other languages do

Rust spells it postfix `?`. Zig and Swift spell it prefix `try`. Odin spells
it postfix `or_return`. Gleam uses `use`. Go looked at three proposals and in
June 2025 decided to add nothing. Postfix `?` is the form newer languages keep
copying (Roc, Hare), it chains (`a()?.b()?`), and it has the most training
data behind it, which matters because most Agency code is now written by
models. Agency's `try` keyword already means "turn a thrown exception into a
failure", so the prefix spelling is taken anyway.

## Names

In prose this is "the `?` operator", which is what Rust's documentation calls
it. It is never "the try operator", because Agency's `try` keyword means
something else. In code the access-chain element is `unwrap`, because `?`
cannot be an identifier; `hasUnwrap`, `unwrapChecks.ts`, and the `unwrap...`
diagnostic names follow from that.

## Syntax

### Grammar

`?` is a postfix operator on an expression. It is parsed as an element of an
access chain, the same list that holds `.name`, `[index]`, `[a:b]`,
`.method(args)`, and `(args)`. The new element kind is `unwrap`, and it
carries nothing:

```
{ kind: "unwrap" }
```

So these all parse:

```
foo()?                     // valueAccess(base: foo(), chain: [unwrap])
x?                         // valueAccess(base: x, chain: [unwrap])
foo()?.name                // chain: [unwrap, property name]
a()?.b()?.c()?             // chain: [unwrap, methodCall b, unwrap, methodCall c, unwrap]
foo()?[0]                  // chain: [unwrap, index 0]
(parsed.value as Meta!)?   // a parenthesized expression followed by a chain
```

Because `?` is a chain element, it binds tighter than everything else:
`foo()?.bar` means `(foo()?).bar`, which is Rust's grouping and is what makes
chaining read left to right.

### Adjacency

Chain elements are probed on the raw input with no whitespace skipping, so
after a variable the `?` must be adjacent: `x ?` is not an unwrap. The call
parser consumes the whitespace after `foo()`, so `foo() ?` does parse as an
unwrap and means the same as `foo()?`. The ternary refusal below covers
both spellings.

After `try`, the `?` applies to the try's Result: `try f()?` is `(try f())?`,
with the `try` covering the chain up to the first `?`. The reading precedence
would give, `try (f()?)`, puts the `?` in a refused position, so nothing is
lost. Added after the first stdlib conversion found one site in six was a
`try` call.

### What follows the `?`

- `?` followed by `?` is still nullish coalescing: `a ?? b` is unchanged.
- `?` followed by `.`, `[`, or `(` continues the chain after the unwrap.
- `?` followed by anything else ends the chain.

### The ternary refusal

Agency has no ternary and refuses `cond ? a : b` with a message pointing at
`if ... then ... else`. That refusal looks, after an expression, for `?`
followed by an expression and a `:`. With the adjacency rule, `cond ? a : b`
never reaches the unwrap parser, so the existing refusal still fires. For
`cond? a : b` the unwrap parser consumes the `?`; the refusal therefore also
checks the case where the expression just parsed ends in an `unwrap` element
and the remaining text is `expr :`. Both spellings keep today's message.

### Why `?.` can be taken

Optional chaining was JavaScript syntax Agency inherited. A search of every
`.agency` file in the stdlib and the built-in agents finds zero uses. The
test corpus has eight files that use it, all written to test the feature
itself. Nothing an agent has written has reached for it. Agency has no users
outside this repository, so the change is a safe one to make now. The cost is
that Agency can no longer claim to be a superset of JavaScript expression
syntax, which it already was not.

A Rust-trained model's most likely spelling is `readJsonFile(...)?.value`.
Under the old grammar that parsed as optional chaining on a Result object and
quietly gave null on a failure. Under the new grammar it does what the model
meant.

Old code that used `?.` on a plain object is caught by the type checker, not
the parser: `obj?.name` now parses as an unwrap of `obj`, and unwrapping a
non-Result is a compile error (AG2023). Nothing old parses to something
quietly different.

The `optional` flag on access-chain elements, the `?.` and `?.(` branches of
the chain parser, the generator's `?.` printing, and the builder's
optional-chain code paths are all removed. The AST never carries an
`optional` element again.

## Semantics

`expr?` evaluates `expr` once. If the value is a success, the expression's
value is `value.value`. If it is a failure, the enclosing function returns
that failure object, unchanged. Unchanged matters: a failure produced by a
rejected interrupt carries `rejected`, `functionName`, and the other fields
the tool loop reads to tell the model its call was refused. `?` passes them
through exactly as `return parsed` does today.

"The enclosing function" is whatever a `return` statement at that spot would
return from. Inside a `def` or `node` body, that is the def or node. Inside a
block argument, a comprehension body, or a `parallel` branch, a `return`
returns from the block, so `?` returns the failure as that block's value. This
is the same rule Rust applies to `?` inside a closure. From there the failure
self-propagates as any failure does.

A `?` at the top level of a `parallel` arm is refused (AG1024). An arm may not
`return` either, because the compiler reads each arm's bindings back after the
fork, and a guard that returned a failure from the arm would hand back a
failure where the bindings object is expected. Do the unwrap inside a `def`
the arm calls. A `?` inside a block argument nested in an arm is fine, since
its `return` belongs to the block.

A `?` in an assignment target, `obj?.field = 1`, is refused (AG1025). There is
no sensible lowering for a `?` in a write target; unwrap into a variable
first.

`foo()? with approve` does not parse, because the `with` shorthand accepts
only an assignment, a `return`, or a plain call before `with`. Write
`const v = foo()? with approve` or use a `handle` block.

`?` on a value that is not a Result is a compile error. Unlike `catch`, which
is a no-op on a non-Result, `?` on a non-Result almost always means the writer
misread the function's return type, or wrote old optional chaining.

## Typing

### The operand

Walking an access chain, an `unwrap` element takes the type so far and:

- if it is `any`, yields `any`;
- if it is `Result<T, D>` (after alias resolution), yields `T`;
- otherwise reports **AG2023** `unwrapNonResult`: "`{expr}?` needs a
  `Result`, and `{expr}` is a `{type}`. Only a `Result` can be unwrapped with
  `?`." and yields `any` so the chain can continue.

### The enclosing function's return type

A function that uses `?` must be able to return a failure. **AG2024**
`unwrapReturnTypeNotResult` fires when the nearest enclosing def or node has a
declared return type and `Result<any, any>` is not assignable to it: "`{expr}?`
returns a failure from `{name}` when the Result fails, but `{name}` is declared
to return `{type}`. Declare it as `Result<{type}>`, or unwrap with `match` or
`catch` instead." A def with no declared return type is not checked; its type
is inferred from its returns, and the lowered `return` is one of them. A `?`
inside a block is not checked against the enclosing def, because its `return`
belongs to the block.

### Narrowing

Flow-sensitive narrowing tracks stable access paths such as `obj.inner.name`.
An `unwrap` element ends a path: `foo()?.name` is not a stable path and no
narrowing applies across it. This is the same treatment a method call gets.

## Lowering

### The invariant this must keep

Agency resumes a paused program with step counters. Every statement in a body
is a runner step; a pause serializes the counters and the frame locals, and a
resume skips completed steps and reads their values back from the frame. The
`hoistCalls` preprocessor pass (`docs/dev/compiler/hoist-calls.md`) exists to
keep that sound: it moves every helper call into its own `const __hoist_N`
statement so a resume never re-runs a completed call.

`?` has to become statements, because "return from the function" is a
statement-level action. The lowering is a new rule in that pass, in the
branch that already handles access chains.

### The rewrite

The common case is an assignment: `const x = expr?`, and equally
`let x = expr?`, `x = expr?`, and `const { a } = expr?`. All of them hold
`expr?` in the assignment's value slot, which the pass already walks, so one
rule covers them. A compound assignment, `n += expr?`, parses as a bare
expression statement the pass never extracts from, so AG1021 refuses it. For a chain that contains `unwrap` elements,
the pass splits the chain at each one. Each piece before an `unwrap` becomes a hoisted temp, followed by a guard
that returns the temp if it is a failure, and the chain continues from the
temp's `.value`:

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

The `isFailure` call is emitted already hoisted into its own temp, because
that is what the pass produces for a hand-written `if (parsed is failure)`:
the `is failure` pattern lowers to an `isFailure(...)` call at parse time, and
the pass lifts `if` conditions before the statement. The output of `?` is
therefore byte-for-byte the output of the hand-written form, and the step
structure a checkpoint sees is one the resume code has handled for months.

Details of the rule:

- The split happens whether or not the chain is in statement-tail position.
  `return foo()?` hoists `foo()` like any other piece, because the guard needs
  the value in a local. A bare `foo()?` statement has its own case in the
  pass's statement dispatcher (a bare access chain is otherwise left alone),
  and that case splits it the same way.
- Argument expressions inside each piece hoist first, in evaluation order, as
  they do today.
- A trailing piece after the last `unwrap` (the `.name` in `foo()?.name`)
  follows the existing chain rule: it stays inline unless it contains a method
  call, in which case the whole trailing chain hoists as a unit.
- Temps come from the frame's `__hoist_N` counter, which already seeds itself
  above any existing `__hoist_N` names and which the parser guarantees no
  user can collide with (`lib/reservedNames.ts`).
- `loc` on every emitted statement is the `loc` of the operand, so the
  debugger and source map keep pointing at the line that wrote `?`.

Each `?` is a hard step boundary. Today `a().b().c()` hoists `a()` and keeps
`.b().c()` as one step, so a pause inside `.c()` re-runs `.b()` on resume (a
documented residual). `a()?.b()?.c()?` puts each call in its own step, so it
is resume-safe in a way the plain chain is not.

### The `with approve` shorthand

`const text = read(path)? with approve` is the line the agent tutorial's
readers will write most, since the tutorial teaches
`read(path) catch "" with approve`. The pass treats a `with`-wrapped
statement as opaque: it never rewrites inside one, because moving work out of
the statement would move it outside the approval region.

For `?` the expansion goes inside the region instead. When the statement under
`with` contains an `unwrap`, the pass rewrites that statement as it would any
other, and wraps the resulting statements in a `handleBlock` whose handler is
the same builtin (`approve`, `reject`, or `propagate`):

```
handle {
  const __hoist_0 = read(path)
  const __hoist_1 = isFailure(__hoist_0)
  if (__hoist_1) {
    return __hoist_0
  }
  const text = __hoist_0.value
} with approve
```

In a node or def body, `with approve` on a statement already compiles to the
same `runner.handle(...)` a `handle` block does
(`docs/dev/language/with-approve.md`), so this changes nothing about which
handler covers the call. A `with` statement with no `unwrap` is left exactly
as it is today.

### Positions where the lowering cannot happen

Some expression positions are never rewritten by the pass: the right side of
`&&`, `||`, and `??`; both sides of a `catch` (the whole `catch` expression is
a boundary, so `parseName(x)? catch ""` is refused and must be two lines);
the stages of a `|>` chain; the operand of a `try`; a
`static` statement; a module-level initializer; a parameter default; and a
handler body (`with (intr) { ... }`), which compiles to plain JavaScript with
no steps and can never pause. The checked cast `x as T!` has the same problem
and the same answer: `hoistPositions` (`lib/preprocessors/hoistPositions.ts`)
models where the pass can lift from, and the type checker refuses a pausing
cast anywhere it cannot. `?` reuses that model with three diagnostics that
mirror the cast ones:

- **AG1021** `unwrapInOpaquePosition` (status `stuck`): "`{expr}?` cannot be
  lowered in this position. Move it to its own line: `const value = {expr}?`."
- **AG1022** `unwrapOutsideBody` (status `outsideBodies`): "`{expr}?` returns
  from a function, and a module-level initializer or a parameter default is
  not inside one. Use it inside a node or a def."
- **AG1023** `unwrapInHandlerBody` (status `handlerBody`): "`{expr}?` cannot
  be used inside a handler body. Unwrap the Result before the `handle` block,
  or match on it here."

Two more refusals are not about hoisting but belong with these:

- **AG1024** `unwrapInParallelArm`: "`{expr}?` would return from a `parallel`
  arm, and an arm cannot return early. Do the unwrap inside a def the arm
  calls." Checked on the pre-desugar tree, where the `parallelBlock` ancestor
  is still visible.
- **AG1025** `unwrapInAssignmentTarget`: "`{expr}?` cannot be a write target.
  Unwrap into a variable first, then assign to its field." Checked by walking
  every assignment's access chain, which is not an expression slot and so is
  never listed by `hoistPositions`.

`hoistPositions` gains one rule for the `with` expansion: a `with` statement
whose inner statement contains an `unwrap` is modeled as a body the pass
rewrites, so its positions are `liftable`, not `stuck`. The agreement test
that runs the real pass over the model's programs pins this.

### The codegen tripwire

After the pass, no `unwrap` element should remain. The TypeScript builder
throws on one, naming it as a toolchain bug, the same way an unregistered
expression kind makes the hoist pass throw. Nothing a user writes can reach
that throw, because every position the pass skips is refused by AG1021 to
AG1023 first.

## Interrupts, checked case by case

- **A pause inside the operand.** The operand is its own step. The pause
  serializes that step's counter and the frame. On resume the call completes
  once, its value lands in the temp, and the guard and the `.value` read run
  as fresh steps against the restored local.
- **A rejected interrupt.** The operand returns a failure with `rejected`
  set. The guard returns it unchanged, so a tool call that was refused still
  reports the refusal to the model.
- **Handlers.** The temps and the guard land immediately before the original
  statement, in the same block, so they are inside every `handle` block that
  enclosed the original line. The handler that would have answered the
  operand's interrupt still does. The `with approve` expansion keeps the
  statements inside the handler region by construction.
- **`checkpoint()` and `restore()`.** The temps are plain frame locals and the
  guard's `if` records its branch like any other; nothing new is serialized.
- **Forks and `parallel`.** A `?` at the top level of a `parallel` arm is
  refused (AG1024). Inside a block argument, which is a lifted block with its
  own frame and its own `__hoist_N` counter, `?` returns the failure from the
  block, and the failure self-propagates from there.
- **Handler bodies.** Refused (AG1023); `?` never adds a pausing site to a
  handler.
- **Code fingerprints.** Adding `?` to a file changes its compiled step
  numbering, and a checkpoint from before the edit is already refused by the
  fingerprint check.

## Formatting

`agency fmt` prints an `unwrap` element as `?` with nothing around it. The
round-trip test over the corpus must stay clean once the test files that
used `?.` are rewritten.

## Documentation

- A new dev doc `docs/dev/language/unwrap-operator.md`: the grammar, the chain
  element, the lowering with the example above, the `with` expansion, the
  three position diagnostics, the two type diagnostics, and the list of files.
  An index line in `CLAUDE.md` and in
  `.claude/skills/agency-language-docs/SKILL.md`.
- `docs/dev/compiler/hoist-calls.md` gains a row for the `unwrap` element and
  loses the sentence that calls the `with` slot fully opaque.
- `docs/site/guide/error-handling.md` gains a section "The `?` operator"
  between `catch` and the pipe operator, and the pipe section's example is
  no longer the recommended way to avoid repeated unwrapping.
- `stdlib/agents/prompts/agency-tutorial.md` gains the operator in its Result
  section and its `with approve` example, following the editing rules in
  `docs/dev/agents/agency-writer-prompt.md`. The tutorial is the agent's only
  exposure to the language, so without this the agents never use `?`.

## Out of scope

- **Re-wrapping with a message.** `return failure("context: ${err}")` after a
  check stays hand-written. One propagation in four adds context; the
  operator is for the other three.
- **`?` directly after a checked cast.** `raw as Meta!?` does not parse; write
  `(raw as Meta!)?`. Adding the suffix to the cast parser is a small follow-up
  if the parenthesized form proves annoying.
- **Converting the stdlib.** The 99 existing sites keep working. Converting
  them is a separate change once the operator has landed, and a good test of
  it.
- **Policy or runtime changes.** None. Nothing in `lib/runtime/` changes.

## Files

- `lib/types/access.ts`: the `unwrap` element kind, `hasUnwrap`, and
  `chainPieces`, the pure split of a chain at its unwraps; the `optional` flag
  is removed.
- `lib/parsers/parsers.ts`: `chainElementParser` gains the unwrap element;
  `dotParser` and `callChainParser` lose `?.`; the ternary refusal learns the
  adjacent form.
- `lib/parsers/access.test.ts`, `lib/parsers/unwrap.test.ts`: parser tests.
- `lib/backends/agencyGenerator.ts`: prints `?`, no longer prints `?.`.
- `lib/backends/typescriptBuilder.ts`: the tripwire; optional-chain codegen
  removed.
- `lib/backends/typescriptBuilder/assignmentEmitter.ts`: the same tripwire in
  the write-target chain switch.
- `lib/backends/typescriptGenerator/typeToString.ts`: prints `?` in its chain
  switch.
- `lib/utils/node.ts`: `expressionToString` prints `?`.
- `lib/utils/expressionSlots.ts`: an `unwrap` element has no slots.
- `lib/typeChecker/synthesizer.ts`: the chain walk's `unwrap` case, AG2023.
- `lib/typeChecker/positionRefusals.ts`: the one status-to-diagnostic loop,
  shared by the cast checks and the unwrap checks.
- `lib/typeChecker/unwrapChecks.ts`: AG2024 and AG1021 to AG1025, run beside
  `checkCastPositions`.
- `lib/lowering/patternLowering.ts`: `resultCheckCall` is exported so the
  lowering emits the same `isFailure` call the `is failure` pattern does.
- `lib/typeChecker/diagnostics.ts`: the seven entries.
- `lib/typeChecker/pathSegments.ts`: an `unwrap` ends a path.
- `lib/preprocessors/hoistCalls.ts`: the split-and-guard rule and the `with`
  expansion.
- `lib/preprocessors/hoistPositions.ts`: the `with` rule and the bare-statement
  rule.
- `tests/typescriptGenerator/unwrap.agency`, `tests/agency/unwrap/`,
  `tests/agency-js/unwrap-resume/`: fixtures.
- The eight test files that used `?.`, and
  `docs/dev/language/null-and-undefined.md`, which described optional chaining
  as a deferred feature.
