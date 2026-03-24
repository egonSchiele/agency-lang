# Substeps for Block-Level State Serialization

## Overview

Agency's step-counter system (`if (__step <= N) { ... __stack.step++; }`) currently treats entire blocks — if/else, thread, match, loops — as a single step. This means interrupts inside a block cannot resume at the exact statement where execution paused. This design introduces **substeps**: nested step guards inside block bodies that enable precise mid-block resumption.

## Motivation

Consider this Agency code:

```agency
if (x > 5) {
  print("big")
  interrupt("check")
  print("confirmed big")
}
```

Today, the entire if body is one step. After the interrupt resumes, one of two things happens: (a) the whole body re-executes, printing "big" again, or (b) the block is skipped entirely, never printing "confirmed big." Both are wrong.

The same problem affects thread blocks, match blocks, and loops. This design addresses **if/else blocks** first as a proof of concept.

## Scope

**In scope (this design):**
- Substep guards for if/else block bodies
- Branch tracking to remember which branch was taken

**Out of scope (future work):**
- Substep guards for thread blocks, match blocks
- Substep guards for loop bodies
- Compile-time error for interrupts inside loops

## Approach

**Chosen: Nested step guards (substeps in codegen).** Extend the existing `TsStepBlock` IR node with a `subStep` field to support nested step guards. The builder emits substep guards inside block bodies using a substep counter stored in `__stack.locals`. No runtime changes needed.

**Why not replay logs?** Replay logs (as used by Temporal, Azure Durable Functions, Restate) solve the loop problem but introduce strict determinism requirements, linear replay cost, and code versioning constraints. Agency's step-guard approach has none of these problems — it just needs to be extended into blocks.

**Why not flatten blocks into top-level steps?** Flattening if/else is tricky because the true and false branches consume different numbers of steps, requiring padding or jump logic. Substeps keep each block self-contained.

## Design

### 1. TsStepBlock IR Changes

Add a `subStep` field to `TsStepBlock`:

```typescript
export interface TsStepBlock {
  kind: "stepBlock";
  stepIndex: number;
  body: TsNode;
  branchCheck?: boolean;
  subStep?: number[];
}
```

When `subStep` is present, the pretty printer derives the guard variable and counter expression from it instead of using `__step` and `__stack.step`. For example, `subStep: [3]` produces:

- Guard variable: `__sub_3` (a local const initialized from `__stack.locals.__substep_3 ?? 0`)
- Guard: `if (__sub_3 <= 0) {`
- Counter: `__stack.locals.__substep_3 = 1;`

For nested substeps, `subStep: [3, 1]` produces variable names like `__sub_3_1` and `__substep_3_1`. The numbers in the array are joined with underscores.

The builder's `stepBlock` factory function gains the optional `subStep` parameter.

Note: The `__substep_*` and `__condbranch_*` prefixes are reserved for internal use. The compiler should reject user-defined variables with these prefixes.

### 2. Builder Changes

The builder gains a new instance variable `_subStepPath: number[]`, initialized to `[]`. As the builder enters a block body (e.g. an if branch), it pushes the current substep index onto this path. When it exits, it pops. This path is passed as the `subStep` field on `TsStepBlock` nodes created within block bodies.

When processing an if/else block inside a step-counted body, the builder bypasses the normal `TsIf` IR node and instead emits the condbranch tracking + substep structure directly. `TsIf` continues to be used for if/else blocks that appear outside of step-counted bodies (e.g. in non-node helper code).

### 3. If/Else Substep Generation

When the builder processes an if/else block at step index `N`, it emits:

1. **Condition branch tracking:** Evaluate the condition once and store the result as an integer in `__stack.locals.__condbranch_N`. On resume, the stored value is used instead of re-evaluating.
2. **Branch dispatch:** Use the stored condbranch value to select which branch body to enter.
3. **Substep guards:** Each statement within the selected branch body is wrapped in a substep guard using the substep counter `__stack.locals.__substep_N`.

Substep guards are always emitted for if/else block bodies, regardless of whether the body contains interrupts.

#### Example

Agency code:

```agency
if (x > 5) {
  print("big")
  interrupt("check")
  print("confirmed big")
} else {
  print("small")
}
```

Generated TypeScript:

```typescript
if (__step <= 3) {
  if (__stack.locals.__condbranch_3 === undefined) {
    if (__stack.locals.x > 5) {
      __stack.locals.__condbranch_3 = 0;
    } else {
      __stack.locals.__condbranch_3 = 1;
    }
  }
  const __condbranch_3 = __stack.locals.__condbranch_3;
  const __sub_3 = __stack.locals.__substep_3 ?? 0;

  if (__condbranch_3 === 0) {
    if (__sub_3 <= 0) {
      await print("big");
      __stack.locals.__substep_3 = 1;
    }
    if (__sub_3 <= 1) {
      __stack.locals.__substep_3 = 2;
      return interrupt("check");
    }
    if (__sub_3 <= 2) {
      await print("confirmed big");
      __stack.locals.__substep_3 = 3;
    }
  } else if (__condbranch_3 === 1) {
    if (__sub_3 <= 0) {
      await print("small");
      __stack.locals.__substep_3 = 1;
    }
  }

  __stack.step++;
}
```

**Invariant: `__stack.step++` placement.** The `__stack.step++` at the bottom of the outer step block only executes after all substeps complete. When an interrupt fires mid-block, execution returns early via `return interrupt(...)`, so `__stack.step++` is never reached. On resume, the outer guard `__step <= 3` is still true, and the condbranch/substep values in locals guide execution to the correct position within the block.

**Interrupt substep advancement.** The substep counter must be incremented *before* `return interrupt(...)`. Without this, the substep counter would still point to the interrupt statement on resume, causing an infinite loop.

#### Else-if chains

Else-if chains mirror the original if/else-if structure:

```typescript
if (__stack.locals.__condbranch_3 === undefined) {
  if (__stack.locals.x > 10) {
    __stack.locals.__condbranch_3 = 0;
  } else if (__stack.locals.x > 5) {
    __stack.locals.__condbranch_3 = 1;
  } else {
    __stack.locals.__condbranch_3 = 2;
  }
}
const __condbranch = __stack.locals.__condbranch_3;
```

#### No else clause

When there is no else clause and no condition matches, `__condbranch` is set to -1 and the body is skipped:

```typescript
if (__stack.locals.__condbranch_3 === undefined) {
  if (__stack.locals.x > 5) {
    __stack.locals.__condbranch_3 = 0;
  } else {
    __stack.locals.__condbranch_3 = -1;
  }
}
```

### 4. Nested Blocks

Substeps nest recursively. Each level of nesting appends to the `subStep` array. For example, an if inside another if at step 2, substep 1:

- Outer if uses `__substep_2` and `__condbranch_2`
- Inner if uses `__substep_2_1` and `__condbranch_2_1`

The builder's `_subStepPath` tracks the nesting: `[2]` at the outer level, `[2, 1]` at the inner level.

```typescript
if (__step <= 2) {
  if (__stack.locals.__condbranch_2 === undefined) {
    if (condition1) {
      __stack.locals.__condbranch_2 = 0;
    } else {
      __stack.locals.__condbranch_2 = -1;
    }
  }
  const __condbranch_2 = __stack.locals.__condbranch_2;
  const __sub_2 = __stack.locals.__substep_2 ?? 0;

  if (__condbranch_2 === 0) {
    if (__sub_2 <= 0) {
      await print("setup");
      __stack.locals.__substep_2 = 1;
    }
    if (__sub_2 <= 1) {
      // Nested if block
      if (__stack.locals.__condbranch_2_1 === undefined) {
        if (condition2) {
          __stack.locals.__condbranch_2_1 = 0;
        } else {
          __stack.locals.__condbranch_2_1 = -1;
        }
      }
      const __condbranch_2_1 = __stack.locals.__condbranch_2_1;
      const __sub_2_1 = __stack.locals.__substep_2_1 ?? 0;

      if (__condbranch_2_1 === 0) {
        if (__sub_2_1 <= 0) {
          __stack.locals.__substep_2_1 = 1;
          return interrupt("check");
        }
        if (__sub_2_1 <= 1) {
          await print("done");
          __stack.locals.__substep_2_1 = 2;
        }
      }

      __stack.locals.__substep_2 = 2;
    }
  }

  __stack.step++;
}
```

### 5. State Serialization

No runtime changes are needed. The substep counters (`__substep_N`) and condbranch values (`__condbranch_N`) are regular entries in `__stack.locals`, which is already serialized as part of the state stack during interrupts and checkpoints. On resume, the deserialized locals contain the substep and condbranch values, allowing execution to skip to the correct position.

### 6. Interaction with Async Branches

The existing `TsStepBlock` has a `branchCheck` field used for async function calls that fork the state stack. The interaction between `branchCheck` and `subStep` on the same node is out of scope for this design — async calls inside if/else blocks are not addressed here.

### 7. Condbranch Immutability

Once a `__condbranch_N` value is stored in locals, it is not re-evaluated on resume. This means `modifyInterrupt` (which replaces `__stack.args`) does not cause branch conditions to be re-evaluated. The execution always resumes in the branch that was originally taken. This is the intended behavior — modifying arguments mid-execution should not change which branch of an already-entered if/else block is active.

## Testing

New integration test fixtures needed:

- **Interrupt inside if body:** Verify that statements before the interrupt don't re-execute and statements after do execute on resume.
- **Interrupt inside else body:** Same verification for the else branch.
- **Interrupt inside else-if chain:** Verify correct branch is re-entered on resume.
- **If with no else, no match:** Verify condbranch -1 skips the body entirely.
- **Nested if blocks:** Verify substeps nest correctly (if inside if).
- **If inside a function:** Verify substeps interact correctly with function-level steps.
- **Two consecutive if/else blocks:** Verify that substep/condbranch naming (keyed by step index) correctly isolates two sequential if/else blocks, each with interrupts.
- **modifyInterrupt does not re-evaluate branch:** Verify that modifying interrupt arguments does not change which branch executes on resume.

## Alternatives Considered

### Flatten blocks into top-level steps

Instead of nesting, lift statements out of blocks into top-level steps. Rejected because if/else branches consume different numbers of steps, requiring padding or jump logic that complicates the builder.

### Replay logs

Used by Temporal, Azure Durable Functions, Restate. Re-execute the function from the beginning and match side effects against a log. Rejected because it introduces strict determinism requirements (the function must produce the same side-effect sequence on replay), linear replay cost, and code versioning constraints. Agency's step-guard approach avoids all of these.

### Substeps only when needed

Only emit substep guards for blocks whose body contains an interrupt. Rejected in favor of always emitting substeps for uniform behavior and simpler builder logic.
