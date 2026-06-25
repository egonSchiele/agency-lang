# Nested block scope resolution — design

**Date:** 2026-06-16
**Status:** Design approved, pending spec review

## Problem

Agency resolves every variable reference to a scope so codegen can emit the
correct runtime frame access. The scope kinds are global, function, node,
imported, static, local, and **block**. Of these, only **block** can nest:
functions and nodes cannot be nested, and there is exactly one global scope, so
their scope identity is unambiguous. Block scope carries no identity, so nested
blocks that reuse a variable name resolve incorrectly.

Minimal repro:

```agency
node main() {
  foo() as {
    let y = 1
    foo() as {
      y = 2
    }
    print("case2 y=${y}")   // prints 1 — should print 2
  }
}
```

The inner `y = 2` should write the outer block's `y`. Instead it prints `1`.

### Root cause — two independent defects

**Defect 1 — the preprocessor flattens nested blocks and mis-resolves.**
In `lib/preprocessors/typescriptPreprocessor.ts`, the Phase-1 block pass
(~line 1346) processes each `functionCall`-with-block, calling
`getAllVariablesInBodyArray(block.body)`. That helper recurses through nested
`block.body` (`lib/utils/node.ts:178-182`), so outer and inner block variables
are seen as one flat pool with no nesting distinction. Worse, ownership is
decided with `lookupScope`, which only knows node-locals and globals — never
*outer-block* locals. So the inner `y = 2` falls through to `blockLocalNames`
and is invented as a brand-new inner-block local. `walkNodes` only tracks block
nesting via the `ancestors` list (count of `blockArgument` ancestors); the
`scopes` array never carries block depth.

**Defect 2 — codegen cannot address an ancestor block's frame.**
At runtime each block gets its own `State` frame (`setupFunction()` →
`StateStack.getNewState()`), with block locals in `frame.locals`. Block vars are
emitted as `__bstack.locals.NAME` (`lib/ir/prettyPrint.ts:24`). The raw
generated TS re-declares `const __bstack = __bsetup.stack` inside *every* block
setup (`lib/templates/backends/typescriptGenerator/blockSetup.mustache:2`).
esbuild (`lib/cli/commands.ts:17`) alpha-renames the shadowed inner declaration
to `__bstack2` and rewrites references scope-aware. The net effect: an inner
block's `__bstack.locals.y` binds to the *nearest* `__bstack` (the inner
frame), so the write lands in the inner frame while the outer `print(y)` reads
the outer frame — different objects.

The two frames already exist and are both reachable (esbuild gives them
distinct names). The bug is purely that an inner reference to an outer-owned
variable is emitted against the nearest frame instead of the owning one.

## Design — lexical frame addressing

Agency block scope is lexical, and generated nested blocks are already
lexically-nested JS arrow functions, so an ancestor block's frame binding is
always in closure scope. We exploit this: resolve which block owns each
reference at compile time, then address that block's frame directly. No runtime
walk, no prototype tricks, no serialization changes.

### 1. Scope representation

Keep `scope = "block"` and add an optional `blockDepth?: number` on the AST
nodes that already carry `scope` (`Assignment`, `VariableName`, and any other
reference node set by the preprocessor). Semantics:

- `blockDepth` absent or `0` → the **current** (innermost) block. This is
  today's behavior, so all existing single-block code is unchanged.
- `blockDepth = 1` → the immediately enclosing block, `2` → its parent, etc.
  (relative lexical distance, counted in block scopes only — node/function
  boundaries are not crossed because a block-owned variable can never live
  outside the enclosing function/node).

`blockDepth` is threaded onto the IR `TsScopedVar` so the printer/builder can
emit the right accessor (see §3).

### 2. Preprocessor — nesting-aware lexical resolution

Replace the flat Phase-1 block pass with a resolver that maintains an explicit
**stack of block scopes** while walking a function/node body. Each entry holds
the block's declared names: its params (→ `blockArgs`) and its `let`/`const`
declarations (→ block-local). Resolution for any reference proceeds
innermost-first:

```
block_n (params + locals) → … → block_0 → node-locals → globals/imported/static
```

- A reference resolved to block `k` (counting from innermost) records
  `scope = "block"` (or `blockArgs` for a param) and `blockDepth = k`.
- A `let`/`const` always declares in the current block (`blockDepth = 0`).
- A bare assignment resolves up the chain; if no owner is found it declares in
  the current block, matching current "assignment creates a local" behavior.

This single change fixes Defect 1: `y = 2` now resolves to the outer block
(`blockDepth = 1`) instead of being invented as a new inner-block local. Outer
references and node/global fallthrough keep working because the chain ends in
the existing node-local/global lookup.

The block-nesting depth at any point is already available from the `ancestors`
list (count of `blockArgument` ancestors), so the walker does not need new
plumbing to know how deep it is — only a parallel stack of declared-name sets.

### 3. Codegen — address the owning frame by unique name

Give each block's frame a **unique, lexically-visible binding** derived from its
already-unique `blockName` (the builder mints these via `steps.nextBlockName()`,
e.g. `__block_0`, `__block_1`). In the block setup template, bind:

```ts
const __bframe_<blockName> = __bsetup.stack;
```

*in addition to* the existing `const __bstack` / `const __self`. The existing
bindings are left untouched so all internal machinery (`__prompt`,
`__retryable`, llm wiring, the runner construction) keeps working exactly as
today — only **user variable** references change to use the per-block frame.

When emitting a block-scoped user variable, the builder uses `blockDepth` to
walk up its `ScopeManager` block-stack (`this.scopes`, which already pushes
`{ type: "block", blockName }` per block) to the owning block and emits:

```ts
__bframe_<owningBlockName>.locals.NAME
```

Because `__bframe_<blockName>` names are globally unique within the function,
esbuild does not rename them and there is no shadowing — an inner block's arrow
closes over the outer block's `__bframe_*` const directly. `blockArgs` is
handled the same way against `.args` instead of `.locals`.

Mechanically:

- `TsScopedVar` gains an optional `blockDepth`.
- For `scope === "block" | "blockArgs"`, the builder resolves the concrete
  frame variable name from its block-stack and emits the member access (the
  depth → frame-name resolution must happen in the builder, which owns the
  scope stack; `prettyPrint.scopeToPrefix` has no scope context and so cannot
  do it alone). Options: pass the resolved frame-var name through on the IR
  node, or have the builder construct the access node directly.

### Data flow summary

```
parse
  → SymbolTable.build
  → buildCompilationUnit
  → TypescriptPreprocessor   ← §2: lexical resolution sets scope + blockDepth
  → TypeScriptBuilder.build  ← §3: emits __bframe_<blockName>.locals.NAME
  → printTs
  → esbuild (unchanged)
```

## Why this is guaranteed

- Block scope in Agency is lexical, and the generated structure is already
  lexically nested, so the owning frame's binding is always in closure scope.
- Reads *and* writes target the owning frame, so shadowing and arbitrary
  nesting depth are correct by construction.
- No runtime, frame-chain, prototype, or serialization changes — block frames
  are created and torn down exactly as today; only the *name* used to reference
  an ancestor block's frame changes.

## Risks to validate during implementation

1. **Interrupt/resume rebinding.** On resume a node replays top-down,
   re-running each block's setup via `getNewState()` (deserialize mode returns
   the restored frame), so `__bframe_<blockName>` is rebound to the restored
   frame before any inner reference runs. Confirm with an interrupt test that
   crosses a nested-block boundary.
2. **Deferred-invocation block contexts.** Tool blocks, `fork`/`parallel`/race
   branches, and `with`/`handle` handler bodies are still emitted inline as
   nested arrows, so closure capture holds — but confirm each path: the
   captured `__bframe_*` const must point at the correct frame at invocation
   time (lexical semantics), including across fork/parallel branch stacks.
3. **Preprocessor/builder depth agreement.** The preprocessor counts block
   nesting (via `blockArgument` ancestors) and the builder counts block scopes
   on `ScopeManager`. These must enumerate the same set of blocks in the same
   order. Verify they agree for blocks in loops, `if`/`match` arms, and
   handler bodies.

## Alternatives considered (rejected)

- **Dynamic runtime frame walk** (keep `scope = "block"`, walk ancestor frames
  at runtime to find the owner): still requires the preprocessor fix, adds an
  explicit ancestor link not present today, and entangles with fork/parallel
  branch stacks and serialization. More fragile against the "guaranteed" bar.
- **Flatten block-locals into the function/node frame via name-mangling**:
  blocks still need their own frames for params/substeps/resumability, and a
  block running inside a fork/parallel branch must keep locals branch-isolated;
  flattening risks breaking that isolation.
- **Depth-suffixed frame names** (`__bstack_<depth>` instead of
  `__bframe_<blockName>`): simpler numbering but requires preprocessor and
  builder to stay in lockstep on depth and reuses numbers across sibling
  blocks; unique per-block names avoid both issues and sidestep esbuild
  renaming entirely.

## Testing

Agency execution tests (`tests/agency/`) cover this without LLM calls:

- The repro above: nested same-name write is visible to the outer block.
- Three-level nesting with writes at each level.
- Shadowing: inner `let y` declares a new local; outer `y` is untouched after
  the block exits.
- Mixed: outer block local read+written from a nested block that also has its
  own distinct locals.
- An interrupt that crosses a nested-block boundary (risk #1).
- A nested block inside `fork`/`parallel` and inside a `with`/`handle` body
  (risk #2).
- Regenerate fixtures (`make fixtures`) and confirm only block-var accesses
  change (to `__bframe_*`), with no semantic diffs elsewhere.
