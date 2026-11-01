# Destructive regions and the `destructiveRan` flag

A `destructive def` says the whole function does work that cannot be undone. A `destructive { }` region inside an ordinary def says only the statements inside it do. Either way, a failure that leaves the function carries `destructiveRan: true` when execution entered that work, and `false` when it did not. The tool loop reads that one bit: a tool that failed after destructive work is removed from the conversation, while a tool that failed before touching anything may be retried. See `docs/dev/agents/tool-loop-guards.md` for the removal rule and `docs/dev/language/result-failures.md` for the failure record.

```
def wipe(path: string): Result {
  const ok = interrupt("Delete ${path}?")
  destructive {
    rm(path)
    return failure("the second step failed")
  }
}
```

A rejected interrupt here fails before the region, so the failure is clean and retryable. A failure from inside the region says `destructiveRan: true`.

## Where the flag lives

Every function and node activation carries one boolean, `__destructiveRan`, on its locals. It starts false and only ever flips to true. The generated code refers to it as `__activation.__destructiveRan`. `DestructiveTracking` (`lib/backends/typescriptBuilder/destructiveTracking.ts`) spells the slot for the compile-time flips, but it is not the only code that touches it: the `llm()` codegen, the catch template, and the runtime do too. The five places, with the file for each:

- **Init**, in step 0 of every function: `?? false` for an ordinary def, `true` for a `destructive def`. It runs after the `!` parameter checks so a refused argument leaves the flag false.
- **Region entry**: a `destructive { }` region is a `seqBlock` the parallel desugar inlines into the surrounding statements, leaving a `markDestructiveRan` node at its start (`lib/types/markDestructiveRan.ts`). Codegen turns that node into the flip.
- **Rule 2, calls to a destructive def**: each statement gets the flips for the destructive calls it owns. A call it owns is one in its own expressions, not in a nested statement body. `DestructiveTracking` decides. The two places that compile a list of statements emit the flips, both in `lib/backends/typescriptBuilder.ts`: `processBodyAsParts` for stepped code and `withPlainFlip` for plain code.
  - **Post-flip.** When the call's result binds a plain local, `const r = rm(x)` or `const r = try rm(x)`, a post-flip after the call trusts the result (`isFailure(r) ? r.destructiveRan : true`), so a clean refusal from the callee does not poison the caller. The statement is also wrapped in a catch that sets the flag and rethrows (`markOnThrow`), because a throw skips the post-flip: a destructive JS extern called without `try` throws, and so does an abort such as a guard trip. Run-control signals (pause, restore) pass through without setting it.
  - **Pre-flip.** Every other destructive call the statement owns gets a conservative pre-flip before the statement: a bare call, a call nested in another expression, the right side of `&&` or `||`, a `catch` expression, and a call in a `try` operand of a tracked call (`const r = try rm(name())` gets both flips). A pipe chain is never a tracked assignment, so it gets only the pre-flip, in a step before the chain's own runner nodes.
  - **Nested bodies.** A call inside a nested body belongs to the statement in that body, because every body flips its own statements. That covers an `if` branch, a loop body, a `match` arm, a `handle` body, an inline handler body, a `thread` body, the statement under `with`, a `finalize`, and a block argument. So `for (x in xs) { const r = rm(x) }` puts no pre-flip on the loop, and a clean refusal from `rm` leaves the caller clean (#1278).
  - **`else if` is not a body.** Codegen folds `if (a) { } else if (b && rm()) { }` into one chain and compiles the inner condition as part of the outer `if`, so the outer `if` owns `rm()`. `flattenedElseIf` (`lib/backends/typescriptBuilder/elseIfChain.ts`) is the one test that both codegen and the tracking rule use to spot this shape.
  - **Plain code.** An inline handler body compiles to plain JS with no steps, and so does an `if`, loop, or `match` inside one. `withPlainFlip` puts a pre-flip in front of each statement there that owns a destructive call. A tracked call gets one too, because plain code has no post-flip, so a clean refusal inside a handler body still reports `true`. Any new code that compiles a list of statements must go through `processBodyAsParts` or `withPlainFlip`, or the calls in that list get no flip at all.
  - **Hoisting.** The hoisting pass (`docs/dev/compiler/hoist-calls.md`) turns a call in a loop's iterable, an `if` condition, or a pipe chain's input into a `const __hoist_N = ...` statement before it, so those calls get the post-flip.
  - **Where the pre-flip goes.** For a plain statement such as `rm(path)` the flip shares the statement's step. For a compound statement (`handle`, `with`, `if`, a loop, `match`, `thread`) it gets a step of its own, closed before the statement's: a compound statement is emitted as its own runner node, past the open part, so a flip left in that part would run after it, and a destructive call on the right side of `&&` in an `if` condition would be covered by nothing if the statement returned first. `processBodyAsParts` decides which case applies from `COMPOUND_STATEMENT_TYPES` before processing the statement, and throws if a statement type turns out to be compound without being listed there.
- **Decision 8, a destructive tool inside `llm()`**: the `llm()` codegen in `lib/backends/typescriptBuilder.ts` hands `runPrompt` the activation as `destructiveSink`, and the tool loop writes the flag through it at runtime (`markDestructiveWork` in `lib/runtime/result.ts`).
- **Exit stamp**: when the function halts with a failure, `stampFailureBoundary` ORs the flag into it. The catch path that turns a thrown error into a failure (`functionCatchFailure.mustache`) reads the same slot.

The flag lives on the frame's locals so a checkpoint carries it: a function that resumes after an interrupt inside its region still knows the region was entered.

## Why `__activation`, not `__self`

Each function body declares `__self` for its own frame. So does every block argument and every fork branch, which run as arrow functions inside the body and shadow it. Until ADI-56 the tracking codegen wrote `__self.__destructiveRan`, so a region inside a block argument flipped the block frame's flag. The block frame is dropped when the block returns, and the function's exit stamp read its own untouched flag: `false`. The protection failed open for any function whose destructive work sat inside a block. Decorators (`docs/dev/language/decorators.md`) made that common, because a decorated body is a block.

`ts.setupEnv` now declares `const __activation = __self` once per function and node, right after `__self`, and the tracking codegen writes only `__activation`. A block or fork branch never redeclares it, so a flip anywhere in the body reaches the function lexically. The alias is the same object as the function's `__self`, which keeps the checkpoint story unchanged.

What this fixes, each pinned by `tests/agency/destructive-in-blocks.agency`:

- a region inside a block argument, whether the failure escapes through the block or the function fails after the block returned;
- a destructive call bound to a local inside a block;
- regions two blocks deep, and a block run more than once;
- a destructive call in a handler body (the plain-code flip above), and one in an `if` condition (covered by the hoisted temp's post-flip);
- a region inside a `parallel` arm, directly or nested in a `seq` arm, and a destructive call bound to a local inside an arm. The region cases are the ones that pin the fork-branch path: nothing else in those functions is destructive, so no function-level pre-flip runs before the fork, and only the write inside the branch can mark the function.

The decorator case is `tests/agency/decorators/destructive-region-in-body.agency`.

## The removed-tools list moved too

The tool loop keeps the names of tools it has removed from the conversation in `__removedTools`, a list the `llm()` codegen hands to `runPrompt` by reference. It used to live on `__self`, which inside a block argument is the block frame. A decorated body or a retry block that calls `llm()` more than once got a fresh, empty list each time, so a tool removed for failing destructively on one run of the block was offered to the model again on the next. The list now lives on `__activation` as well, so every run of the block sees the same list.

## A tool marks only the work it does

A function enters a region around work it does itself and can see. A
tool that hands work to a program it cannot see into does not guess.
safeBash is the example: its in-process write enters a region, and a
line it runs through bash enters none, because a bash failure is any
non-zero exit and a failure flagged `destructiveRan` removes the tool
from the conversation. The decision and the alternatives set aside are
in `docs/dev/stdlib/safe-bash.md`, "Why a bash call is never
destructive".

## Regions inside `parallel`

A `destructive { }` region is allowed inside a `parallel` block, directly as an arm or nested in a `seq` arm. The parallel desugar (`lib/preprocessors/parallelDesugar.ts`) keeps the region's flip when it inlines the region, and when the region is itself an arm, it puts the flip at the start of the arm's statements. The flip is written to `__activation`, so it marks the calling function, exactly as a destructive call in an arm does. Both are conservative: a failure that leaves the function after the `parallel` block says `destructiveRan: true` whichever arm did the work. The refusal that used to guard this case existed because the flip landed on the fork frame, and went away with that bug.

## Files

- `lib/backends/typescriptBuilder/destructiveTracking.ts` and its test: the compile-time flips, the init, and the exit stamp.
- `lib/backends/typescriptBuilder.ts`: `processBodyAsParts` (where a pre-flip goes), `withPlainFlip` (plain code), and the `llm()` codegen that passes `removedTools` and `destructiveSink`.
- `lib/backends/typescriptBuilder/elseIfChain.ts`: the else-if test that codegen and the tracking rule share.
- `lib/backends/destructiveFlips.codegen.test.ts`: whole-pipeline compiles of a destructive call in a block's `finalize`, in an `if` inside a handler body, and in an else-if condition.
- `lib/ir/builders.ts`: `ts.runtime.activation` and the declaration in `setupEnv`.
- `lib/preprocessors/parallelDesugar.ts`: the `markDestructiveRan` node a region leaves behind, inline and as an arm.
- `lib/backends/functionContainsDestructiveBlock.ts`: the metadata question, "does this def declare destructive work", used for the tool marker and the `destructiveFunctions` registry, never for the flip.
- `lib/templates/backends/typescriptGenerator/functionCatchFailure.mustache`: the thrown-error path.
- `lib/runtime/result.ts`: `stampFailureBoundary`, `markDestructiveWork`.
- `lib/runtime/prompt.ts`: `destructiveSink` and the decision 8 write.
- Tests: `tests/agency/destructive-block.agency`, `destructive-tracking.agency`, `destructive-extern-throw.agency`, `stdlib-destructive.agency`, `destructive-in-blocks.agency`, `destructive-tracked-in-compound.agency`.
