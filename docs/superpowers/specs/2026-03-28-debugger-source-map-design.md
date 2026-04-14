# Debugger Source Map

## Summary

Add a statement-level source map to compiled Agency files, mapping each step and substep in the generated TypeScript back to the corresponding Agency source location. This enables the Agency debugger to show the user which Agency line they're on when execution is paused.

## Data Structure

The source map is a plain object exported from each generated `.ts` file as `export const __sourceMap`:

```ts
type SourceMap = Record<string, Record<string, SourceLocation>>;
```

- **Outer key**: `"<moduleId>:<functionOrNodeName>"` (e.g., `"recipe.agency:main"`)
- **Inner key**: Step/substep path as a dot-separated string (e.g., `"0"`, `"2.0.1"`)
- **Value**: `SourceLocation` from `lib/types/base.ts` (`{ line, col, start, end }`)

Example:

```ts
export const __sourceMap = {
  "recipe.agency:main": {
    "0": { line: 5, col: 2, start: 45, end: 78 },
    "1": { line: 6, col: 2, start: 79, end: 112 },
    "2": { line: 8, col: 2, start: 120, end: 195 },
    "2.0.0": { line: 9, col: 4, start: 140, end: 160 },
    "2.0.1": { line: 10, col: 4, start: 161, end: 180 },
    "2.1.0": { line: 12, col: 4, start: 182, end: 194 },
    "3": { line: 14, col: 2, start: 197, end: 230 },
  },
  "recipe.agency:greet": {
    "0": { line: 18, col: 2, start: 260, end: 290 },
  },
};
```

The inner key format is the builder's `_subStepPath` array joined with `"."`. For top-level steps, this is just the step index (`"0"`, `"1"`, `"2"`). For substeps inside blocks, the path encodes the full nesting: `"2.0.1"` means step 2, branch 0, substep 1.

Note: the builder uses `"_"` as separator for generated variable names (e.g., `__condbranch_2_0`), but the source map uses `"."` for readability. These are independent conventions.

All block types that produce substeps are covered: if/else, match, for loop, while loop, message thread, and handle block.

## SourceMapBuilder Class

New file: `lib/backends/sourceMap.ts`

A simple class with three methods:

- `enterScope(moduleId: string, scopeName: string)`: Called when the builder begins processing a function or node body. Sets the current outer key.
- `record(subStepPath: number[], loc: SourceLocation | undefined)`: Records a source map entry for the current step/substep. If `loc` is undefined (parser hasn't populated it), silently skips. This makes the source map gracefully degrade before position tracking is fully wired in.
- `build(): SourceMap`: Returns the accumulated source map.

## Builder Integration

Minimal changes to `typescriptBuilder.ts`:

1. Add a `_sourceMapBuilder: SourceMapBuilder` instance property.
2. In `processFunctionDefinition`, call `enterScope(this.moduleId, node.functionName)`. In `processGraphNode`, call `enterScope(this.moduleId, node.nodeName)`.
3. In `processBodyAsParts`, for each statement that triggers a new step, call `record(this._subStepPath, stmt.loc)` after pushing the step index onto `_subStepPath` but before popping it (i.e., at the same point as `processStatement`).
4. In branch body processing methods (`processBranchBody` inside `processIfElseWithSteps`, and equivalent methods for while/for/match/thread/handle steps), for each statement call `record(this._subStepPath, stmt.loc)`.
5. After building, the source map is available via `_sourceMapBuilder.build()`.

**Debugger mode and step indices**: When `agencyConfig.debugger` is true, the builder inserts synthetic `debuggerStatement` nodes before each step. These synthetic nodes have no `loc`, so they are silently skipped by `record()`. The source map only contains entries for real Agency statements. The step index keys will differ between debugger-mode and non-debugger-mode compilations (because the synthetic steps shift indices), but this is correct — the source map always matches the generated code it accompanies.

**Global-scope statements**: Assignments and other statements at the module level (outside any function or node) are not processed via `processBodyAsParts` and are excluded from the source map. The debugger operates within function/node execution, so this is expected.

## Output

The source map is injected into the generated output as a `TsRaw` IR node appended to the builder's `sections` array:

```ts
ts.raw(`export const __sourceMap = ${JSON.stringify(sourceMapBuilder.build())};`)
```

This keeps the output assembly inside the existing IR/print pipeline — no changes needed to `generateTypeScript`'s return type or `printTs`. The source map appears at the end of the generated file, after all other exports.

Each compiled `.agency` file produces its own `__sourceMap` export. In multi-file programs, the debugger reads the source map from whichever compiled module is currently executing. Aggregating source maps across files is out of scope — each file's map is self-contained.

## Debugger Usage

When the debugger pauses execution (via an interrupt), it knows:
- The current node/function name
- The current step number (`__stack.step`) and substep values (`__substep_*`, `__condbranch_*`)

It can reconstruct the substep path and look up the source location:

```ts
const loc = __sourceMap[`${moduleId}:${scopeName}`][subStepPath.join(".")];
// loc.line, loc.col tell the debugger which Agency source line to highlight
```

## Testing

### Unit tests (`lib/backends/sourceMap.test.ts`)

- `enterScope` + `record` + `build` produces expected structure
- Multiple scopes accumulate correctly
- `record` with `undefined` loc silently skips
- Substep paths format correctly (`[2, 0, 1]` -> `"2.0.1"`)

### Integration test

Add a fixture in `tests/typescriptGenerator/` with an Agency file containing if/else, loops, and functions. Verify the generated `.ts` file includes `__sourceMap` with the correct step/substep keys and scope keys. Exact `loc` values depend on the parser populating `BaseNode.loc` (separate work), so initially the test verifies structural correctness.

## Dependencies

- `BaseNode.loc` (already added to types, not yet populated by parser)
- The builder's `_subStepPath` tracking (already exists)
- The builder's knowledge of current module ID and function/node name (already exists)

The source map works without `loc` being populated — entries with undefined `loc` are simply omitted. Once `withSpan` is wired into the parser (per the parser improvements plan), the source map will automatically start containing full location data.
