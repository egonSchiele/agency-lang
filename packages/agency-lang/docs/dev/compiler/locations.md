# Source locations

How Agency tracks positions through the parser, why the template wrapper exists, and what to check when location-related bugs show up.

## The shape

Every AST node carries an optional `loc: SourceLocation`:

```ts
type SourceLocation = {
  line: number;    // 0-indexed in the user's source file
  col: number;     // 0-indexed column
  start: number;   // byte offset into the parser input
  end: number;     // byte offset into the parser input
};
```

**Invariant:** `loc.line` is always 0-indexed in the user's source, regardless of which parse mode was used. `start` and `end` are byte offsets into whatever the parser actually saw — see "About `start` / `end`" below.

`parseAgency` also returns `errorData.line` for parse failures. Same convention: 0-indexed in the user's source.

## The template

Every Agency program is conceptually wrapped in a 2-line prelude that auto-imports stdlib symbols (`print`, `read`, `range`, …). The prelude lives at `lib/templates/backends/agency/template.mustache`:

```
import { print, ... } from "std::index";

{{{body:string}}}
```

`AGENCY_TEMPLATE_OFFSET = 2` in `lib/parsers/parsers.ts` is the count of prelude lines.

The prelude is what makes `print(x)` work in a user file with no explicit import. Without the wrapper, the parser would still parse the source — it just wouldn't know about the stdlib names that the typechecker / codegen later assume to exist.

## The two parse modes

`parseAgency(source, config, applyTemplate=true)` is the entrypoint. The third argument gates whether the prelude wrapper is prepended.

**`applyTemplate=true` (default, used by the CLI compile path):** the parser sees `prelude + source`. Spans returned by tarsec are based on this combined input — line numbers shifted by `+AGENCY_TEMPLATE_OFFSET` relative to the user's source.

**`applyTemplate=false`:** the parser sees just the user's source.

Three callers genuinely need `applyTemplate=false`:

1. **Stdlib index** (`stdlib/index.agency`) — declares the very symbols the prelude imports. Wrapping it would be circular.
2. **Formatter** (`lib/formatter.ts`) — round-trips source through `generateAgency`. The wrapper would inject phantom imports into output.
3. **Fixture regeneration** (`scripts/regenerate-fixtures.ts`) — same as formatter.

LSP also uses `applyTemplate=false`, but that's historical, not load-bearing. It could switch.

## How `loc.line` is computed

Inside the parser, `withLoc` wraps tarsec parsers to attach `loc` to each AST node. It reads a module-level `currentTemplateOffset` and subtracts it from `span.line`:

```ts
// lib/parsers/parsers.ts
let currentTemplateOffset = 0;
export function setTemplateOffset(n: number): void { currentTemplateOffset = n; }

export function withLoc<T>(parser: Parser<T>) {
  return (input: string) => {
    // ...
    const loc: SourceLocation = {
      line: span.start.line - currentTemplateOffset,
      col: span.start.column,
      start: span.start.offset,
      end: span.end.offset,
    };
    // ...
  };
}
```

`parseAgency` sets the offset before invoking `_parseAgency` and resets in `finally`:

```ts
// lib/parser.ts
const offset = applyTemplate ? AGENCY_TEMPLATE_OFFSET : 0;
setTemplateOffset(offset);
try {
  return _parseAgency(input, config);
} catch (error) {
  // ... errorData.line: error.data.line - offset
} finally {
  setTemplateOffset(0);
}
```

Net result:

| `applyTemplate` | `span.line`         | `currentTemplateOffset` | `loc.line`                   |
|-----------------|---------------------|-------------------------|------------------------------|
| `true`          | user-line + 2       | 2                       | user-line                    |
| `false`         | user-line           | 0                       | user-line                    |

Both modes produce the same `loc.line`. Same for `errorData.line`. There is **one** convention; consumers don't compensate.

## About `start` / `end`

`loc.start` and `loc.end` are byte offsets into the input the parser saw. In `applyTemplate=true` mode, they're offsets into the templated string (which includes the prelude bytes); in `applyTemplate=false` mode, they're offsets into the user source directly.

This is **intentionally** not normalized. Consumers that work in offset space (e.g. LSP `doc.positionAt(start)` for end-line lookups) need to know which offset space they're in. In practice, the only consumers using `start`/`end` are LSP path functions where `applyTemplate=false`, so byte offsets *do* match the user's text buffer there. If you ever introduce a CLI-side consumer of `start`/`end`, be aware those offsets include the 2 prelude lines worth of bytes.

## Module-level state

`currentTemplateOffset` is module-level state in `lib/parsers/parsers.ts`. This follows the existing pattern in the same file (`setInputStr`, `setTraceHost`, `setTraceId`).

**Implications:**

- Not thread-safe. Node single-threaded execution makes this fine in practice.
- Tests that bypass `parseAgency` and call `agencyParser` directly will see whatever `currentTemplateOffset` was last set. The `finally` block in `parseAgency` resets to `0`, which matches the initial value, so direct-parser tests get the "no offset" semantics expected when the source isn't templated. If you add a test that calls `agencyParser` directly with a templated source, you must `setTemplateOffset(AGENCY_TEMPLATE_OFFSET)` first or your `loc.line` values will be off by `+2`.

## Consumers of `loc.line`

All of these now read `loc.line` directly with no compensation:

- `lib/backends/sourceMap.ts` — embeds line numbers into the generated TS source map.
- `lib/cli/definition.ts`, `lib/cli/doc.ts`.
- `lib/lsp/diagnostics.ts`, `definition.ts`, `documentSymbol.ts`, `foldingRange.ts`, `inlayHint.ts`, `semantics.ts`, `typeDefinition.ts`, `workspaceSymbol.ts`.
- `lib/typeChecker/suppression.ts` — compares against `parseSuppressions`'s output, which is also 0-indexed user-source.
- `lib/typeChecker/index.ts` — error reporting.

If any of these adds back an offset, that's a regression — there is no longer any convention to compensate for.

## What changed (vs. the old design)

Before this normalization:

1. `withLoc` subtracted `AGENCY_TEMPLATE_OFFSET` *unconditionally* from spans. Worked when input was templated; produced `user-line - 2` (often negative) when not.
2. LSP code added `+TEMPLATE_OFFSET` at every consumer site (`lib/lsp/locations.ts` exposed `TEMPLATE_OFFSET` and a `toUserSourceLocation` helper).
3. `errorData.line` had no offset adjustment, so in template mode parse errors pointed at lines `+2` from where the user wrote them — a latent bug nobody surfaced.
4. The typechecker carried a `templateApplied: boolean` flag on `CompilationUnit` so `applySuppressions` could re-align suppression-directive line numbers with error locations.
5. `lsp/definition.ts` mixed two populations: `symbol.loc` from the SymbolTable (templated parse → no offset added) and AST locs from the LSP-side parse (un-templated parse → offset added). Easy to introduce a bug in either direction.

After:

- `withLoc` reads `currentTemplateOffset`, set per-parse by `parseAgency`. One subtraction, one source of truth.
- `errorData.line` gets the same conditional subtraction.
- All `+TEMPLATE_OFFSET` sites in LSP deleted; `lib/lsp/locations.ts` deleted.
- `templateApplied` field removed from `CompilationUnit`. `applySuppressions` no longer takes a `lineOffset`.
- `lsp/definition.ts` reads both populations identically; no mixing.

## Test fixtures

Many integration tests under `tests/typescriptGenerator/` and `tests/typescriptBuilder/` snapshot the generated TypeScript. The generated TS embeds a `__sourceMap` constant whose values are `loc.line` for each step. Before the normalization, fixtures contained values like `"line": -1` (the buggy `user-line - 2` for line-0 statements). After: real, non-negative line numbers.

If you change the parser or change which parse mode a path uses, regenerate fixtures with `make fixtures` and review the diff. A diff of `line: <large positive>` flipping to `line: <smaller positive>` (or vice versa) by exactly `2` is a strong signal something has reverted to compensating for the template offset somewhere.

## Common bug shapes (what to check first)

When something looks "off by 2" or "off by N":

1. **Search for `TEMPLATE_OFFSET`, `AGENCY_TEMPLATE_OFFSET`, `+ 2`, `- 2` near anything reading `loc.line`.** New compensations re-introduce inconsistency.

2. **Did someone start parsing without going through `parseAgency`?** Direct calls to `agencyParser` or `_parseAgency` won't set `currentTemplateOffset`. If the caller's input is *templated*, they need `setTemplateOffset(AGENCY_TEMPLATE_OFFSET)` first.

3. **Did the parse mode change without a callsite update?** Switching a caller from `applyTemplate=false` to `true` (or back) doesn't break `loc.line` (the invariant absorbs it), but it does change `loc.start`/`loc.end` meanings.

4. **Did a fixture regen get committed without re-running tests?** Fixtures are golden snapshots; if the surrounding code shifts what gets emitted, the fixtures need updating. Conversely, if fixtures shift but the generator code didn't change, something else is producing different `loc` data.

5. **Do parse-error positions look off by 2?** Check that `parseAgency`'s `errorData.line` subtraction is intact. The `error.data.line - offset` line in the catch block.

6. **Suppression directives misfire under LSP?** Verify `parseAgency` was the entrypoint (LSP path goes through it). Verify nothing reads `applyTemplate` to choose its own offset — there should be no such reads outside `parseAgency` itself.

## What's NOT normalized

- **`loc.col`** — always raw column from tarsec; no offset adjustment is needed because the prelude only adds whole lines, not a column shift on existing user lines.
- **`loc.start` / `loc.end`** — byte offsets into the parser input, including any prelude bytes. Documented above.
- **`applyTemplate=false` callers** — the three legitimate ones stay.

## Pinned by tests

`lib/parser.test.ts` has a `parseAgency loc.line invariant` describe block that:

1. Parses the same source with both `applyTemplate=true` and `applyTemplate=false` and asserts every collected `loc.line` is identical.
2. Asserts ground-truth values (e.g. for a 2-line source, `min(loc.line) == 0` and `max(loc.line) == 1`) so a regression that drifts both modes the same way still fails.

If either test fails, this doc is out of date — read both before fixing.

## Files touched in the normalization

For history-grep purposes (commit `<adit/loc-line-normalization>`):

- `lib/parsers/parsers.ts` — added `setTemplateOffset` + module state; `withLoc` reads `currentTemplateOffset`.
- `lib/parser.ts` — set/reset offset around `_parseAgency`; subtract offset from `errorData.line`.
- `lib/lsp/foldingRange.ts`, `workspaceSymbol.ts`, `diagnostics.ts`, `definition.ts`, `documentSymbol.ts`, `semantics.ts` — drop `+TEMPLATE_OFFSET` and `toUserSourceLocation` calls.
- `lib/lsp/locations.ts` — deleted.
- `lib/typeChecker/index.ts` — drop `templateApplied` field, `lineOffset` arg.
- `lib/typeChecker/suppression.ts` — drop `lineOffset` param.
- `lib/compilationUnit.ts` — drop `templateApplied` field from `CompilationUnit`.
- `lib/cli/commands.ts` — drop the now-unused `!isStdlibIndex` 5th arg to `buildCompilationUnit`.
- `lib/symbolTable.test.ts` — fix two stale hardcoded buggy line numbers.
- `lib/parser.test.ts` — regression tests.
- `tests/typescriptGenerator/*.mjs`, `tests/typescriptBuilder/*.mjs` — regenerated source-map values.
