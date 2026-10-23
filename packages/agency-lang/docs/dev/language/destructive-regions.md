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

Every function and node activation carries one boolean, `__destructiveRan`, on its locals. It starts false and only ever flips to true. The generated code refers to it as `__activation.__destructiveRan`, and `DestructiveTracking` (`lib/backends/typescriptBuilder/destructiveTracking.ts`) is the one place that emits every read and write:

- **Init**, in step 0 of every function: `?? false` for an ordinary def, `true` for a `destructive def`. It runs after the `!` parameter checks so a refused argument leaves the flag false.
- **Region entry**: a `destructive { }` region is a `seqBlock` the parallel desugar inlines into the surrounding statements, leaving a `markDestructiveRan` node at its start (`lib/types/markDestructiveRan.ts`). Codegen turns that node into the flip.
- **Rule 2, calls to a destructive def**: when the call's result binds a plain local, a post-flip trusts the result (`isFailure(r) ? r.destructiveRan : true`), so a clean refusal from the callee does not poison the caller. Any other statement containing a destructive call gets a conservative pre-flip.
- **Decision 8, a destructive tool inside `llm()`**: the `llm()` codegen hands `runPrompt` the activation as `destructiveSink`, and the tool loop writes the flag through it (`markDestructiveWork` in `lib/runtime/result.ts`).
- **Exit stamp**: when the function halts with a failure, `stampFailureBoundary` ORs the flag into it. The catch path that turns a thrown error into a failure reads the same slot.

The flag lives on the frame's locals so a checkpoint carries it: a function that resumes after an interrupt inside its region still knows the region was entered.

## Why `__activation`, not `__self`

Each function body declares `__self` for its own frame. So does every block argument and every fork branch, which run as arrow functions inside the body and shadow it. Until ADI-56 the tracking codegen wrote `__self.__destructiveRan`, so a region inside a block argument flipped the block frame's flag. The block frame is dropped when the block returns, and the function's exit stamp read its own untouched flag: `false`. The protection failed open for any function whose destructive work sat inside a block. Decorators (`docs/dev/language/decorators.md`) made that common, because a decorated body is a block.

`ts.setupEnv` now declares `const __activation = __self` once per function and node, right after `__self`, and the tracking codegen writes only `__activation`. A block or fork branch never redeclares it, so a flip anywhere in the body reaches the function lexically. The alias is the same object as the function's `__self`, which keeps the checkpoint story unchanged.

What this fixes, each pinned by `tests/agency/destructive-in-blocks.agency`:

- a region inside a block argument, whether the failure escapes through the block or the function fails after the block returned;
- a destructive call bound to a local inside a block;
- regions two blocks deep, and a block run more than once;
- a destructive call inside a `parallel` arm.

The decorator case is `tests/agency/decorators/destructive-region-in-body.agency`.

## What is still refused

A `destructive { }` region inside a `parallel` block is refused by `validateParallelBlock` (`lib/preprocessors/parallelDesugar.ts`). The original reason, that the flip would land on the fork frame, no longer holds. The rule stays because nobody has decided what a failure from one arm should say about destructive work in the arms running beside it. A destructive *call* in an arm is allowed and marks the function, as the test above shows.

## Files

- `lib/backends/typescriptBuilder/destructiveTracking.ts` and its test: every emitted read and write.
- `lib/ir/builders.ts`: `ts.runtime.activation` and the declaration in `setupEnv`.
- `lib/backends/functionContainsDestructiveBlock.ts`: the metadata question, "does this def declare destructive work", used for the tool marker and the `destructiveFunctions` registry, never for the flip.
- `lib/templates/backends/typescriptGenerator/functionCatchFailure.mustache`: the thrown-error path.
- `lib/runtime/result.ts`: `stampFailureBoundary`, `markDestructiveWork`.
- `lib/runtime/prompt.ts`: `destructiveSink` and the decision 8 write.
- Tests: `tests/agency/destructive-block.agency`, `destructive-tracking.agency`, `destructive-extern-throw.agency`, `stdlib-destructive.agency`, `destructive-in-blocks.agency`.
