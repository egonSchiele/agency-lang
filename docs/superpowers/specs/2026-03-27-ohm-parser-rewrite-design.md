# Ohm.js Parser Rewrite

## Summary

Replace the tarsec parser combinator-based parser with an ohm.js PEG parser. The rewrite produces identical AST output (same `AgencyProgram` and `AgencyNode` types), populates source location information (`loc` on `BaseNode`), and adds several syntax improvements that were difficult to implement with the combinator approach.

## Motivation

1. **Source locations for VS Code integration.** The `BaseNode.loc` field (already added) needs to be populated by the parser. Ohm provides `this.source` on every parse node for free, with `getLineAndColumn()` and character offsets. Retrofitting tarsec to track positions would require threading offset state through every combinator.

2. **Readable grammar as language documentation.** The current parser is ~3,100 lines of TypeScript combinator source code across 20 files (plus ~13,000 lines of tests). An ohm grammar is a clean, readable DSL that serves as a formal syntax specification.

3. **Syntax improvements.** Several features are hard to add with the combinator approach but fall out naturally from an ohm grammar:
   - Parenthesized expressions anywhere
   - End-of-line comments
   - Arbitrary expressions in string interpolation (currently limited to variable names and value access)
   - Arbitrary expressions as function call arguments
   - Unary operators (`-x`, `!x`)

4. **Left recursion.** Ohm natively supports left-recursive rules, eliminating the manual precedence-climbing algorithm in `binop.ts` and the chain-building logic in `access.ts`.

## Design Decisions

### Drop-in replacement

`parseAgency()` keeps the same signature and return type. The pre-processing steps (Mustache template application, line normalization) are preserved. Downstream pipeline (`buildSymbolTable` → `collectProgramInfo` → preprocessor → builder → codegen) is completely untouched.

### ParserResult type

The current `parseAgency()` return type is `ParserResult<AgencyProgram>` imported from tarsec. Since tarsec is being removed, we define our own compatible type in a new `lib/parsers/parserResult.ts`:

```ts
export type ParserResult<T> =
  | { success: true; result: T; rest: string }
  | { success: false; rest: string; message: string };
```

This matches the tarsec type's shape. All call sites (`lib/cli/commands.ts`, `lib/cli/util.ts`, `scripts/agency.ts`, etc.) check `.success` and `.result` — they'll work unchanged. The `TarsecError` catch in `parseAgency()` and `scripts/agency.ts` is replaced with ohm's `match.message` for error reporting.

### Line normalization and source locations

The current `normalizeCode()` function trims every line with `.trim()`, which strips leading whitespace. This means column numbers from ohm's `this.source.getLineAndColumn()` will reflect positions in the *normalized* code, not the original source. For VS Code integration, we'll need accurate positions in the original source. The fix: remove the `.trim()` from `normalizeCode()` and ensure the ohm grammar handles leading whitespace correctly (which syntactic rules do automatically). This change is safe because the tarsec parser also handled leading whitespace — the `.trim()` was a convenience, not a necessity.

### Single grammar, single semantics

One `agency.ohm` grammar file and one `semantics.ts` file. The grammar is small enough for a single file, and this is how ohm is designed to be used.

### Unified Expression type

The tarsec parser has ad-hoc expression subsets at every position (e.g., `Assignment.value` allows 7 specific types, `IfElse.condition` allows 4 different types, `ForLoop.iterable` allows 3 types). The ohm grammar defines a single `Expr` rule, and the AST types use a unified `Expression` type:

```ts
export type Expression =
  | ValueAccess
  | Literal
  | FunctionCall
  | BinOpExpression
  | AgencyArray
  | AgencyObject;
```

AST types that currently have ad-hoc unions are widened to use `Expression`. The type checker enforces semantic validity (e.g., you can't use an object literal as an `if` condition).

Positions widened to `Expression`: `Assignment.value`, `ReturnStatement.value`, `IfElse.condition`, `WhileLoop.condition`, `ForLoop.iterable`, `FunctionCall.arguments`, `SpecialVar.value`, `BinOpExpression.left`/`BinOpExpression.right` (replacing `BinOpArgument`), `MatchBlock.expression`, `MatchBlockCase.caseValue`, `AgencyArray` items, `AgencyObject` values, `InterpolationSegment.expression`.

Special cases that are **not** widened to `Expression`:
- **`MatchBlockCase.body`** — Currently allows `Assignment | Literal | FunctionCall | ValueAccess | AgencyArray | AgencyObject | ReturnStatement`. This includes `ReturnStatement`, which is a statement, not an expression. This position keeps its own union type rather than using `Expression`.
- **`SplatExpression`** — Appears inside `AgencyArray.items` and `AgencyObject.entries` as `...expr`. This is a syntactic modifier, not a standalone expression. The grammar handles it with a `"..." Expr` rule within array/object literals. `SplatExpression.value` is widened to `Expression` (currently `ValueAccess | FunctionCall | Literal`). `AgencyArray.items` becomes `(Expression | SplatExpression)[]` and `AgencyObject.entries` becomes `(AgencyObjectKV | SplatExpression)[]` (unchanged shape, but `SplatExpression.value` is wider).
- **`MatchBlockCase.caseValue`** — Widened to `Expression`, but `DefaultCase` (`"_"`) is kept as an additional alternative: `caseValue: Expression | DefaultCase`.
- **`Assignment.value` and `MessageThread`** — Currently `Assignment.value` accepts `MessageThread`. Since `MessageThread` is a block statement (not an expression), the `Assignment` type keeps `MessageThread` as an explicit alternative alongside `Expression`: `value: Expression | MessageThread`.

### Source locations via wrappers

The ohm `toAST()` operation populates `loc` on every AST node using `this.source.getLineAndColumn()`. The `parseAgency()` entry point returns full location data. Wrapper functions (used by tests) strip `loc` before returning so all existing tests pass unchanged.

## File Structure

### New files

- **`lib/parsers/agency.ohm`** — Complete Agency grammar (~500-600 lines). Pure syntax, no code. Organized into sections: Program & Statements, Functions & Nodes, Control Flow, Expressions, Access & Calls, Literals, Types, Imports, Threads & Other, Lexical rules.

- **`lib/parsers/semantics.ts`** — The `toAST()` semantic operation. Imports and compiles the grammar, creates the semantics object. Exports a `parse(input: string, startRule?: string)` function. Every action function returns the same AST node types used today, with `loc` populated.

- **`lib/parsers/wrappers.ts`** — Exports every parser function that test files currently import (`assignmentParser`, `functionCallParser`, `stringParser`, etc.). Each wrapper calls `parse()` with a specific start rule, strips `loc`, and returns `ParserResult<T>` matching the tarsec signature. Also exports a `stripLoc` utility.

### Modified files

- **`lib/parser.ts`** — `parseAgency()` calls the ohm-based parse instead of the tarsec `agencyParser`. Same signature, same pre-processing. Does not strip `loc`.

- **`lib/types.ts`** — Add `Expression` type. Update `AgencyNode` union if needed.

- **AST type files in `lib/types/`** — Widen ad-hoc expression unions to use `Expression`.

- **Test files in `lib/parsers/*.test.ts`** — Change imports from individual parser files to `./wrappers.js`.

### Deleted files

All tarsec parser source files in `lib/parsers/`: `access.ts`, `binop.ts`, `comment.ts`, `dataStructures.ts`, `forLoop.ts`, `function.ts`, `functionCall.ts`, `importStatement.ts`, `keyword.ts`, `literals.ts`, `matchBlock.ts`, `multiLineComment.ts`, `newline.ts`, `parserUtils.ts`, `returnStatement.ts`, `skill.ts`, `specialVar.ts`, `tools.ts`, `typeHints.ts`, `utils.ts`.

The tarsec dependency is removed. Outside of parser files, tarsec is only used in `scripts/agency.ts` (for `TarsecError` in debug commands) and `lib/parser.ts` — both of which are updated as part of this migration.

## Grammar Design

The grammar is a single `Agency` grammar with rules organized into these sections:

### 1. Program & Statements

Top-level `Program = Statement*`, with `Statement` being the big alternation (equivalent of the current 26-way `or()` in `agencyParser`).

### 2. Functions & Nodes

`FunctionDef`, `GraphNodeDef`, parameter lists, return types, doc strings. Handles `safe`/`async`/`sync` keyword prefixes.

### 3. Control Flow

`If`, `While`, `For`, `MatchBlock`, `HandleBlock`, `ReturnStatement`, `Keyword` (break/continue).

### 4. Expressions

Left-recursive precedence cascade for binary operators. Assignment operators (`+=`, `-=`, `*=`, `/=`) remain in the `Operator` type and continue to be parsed as `BinOpExpression` nodes, matching the current behavior. They sit at the lowest precedence level (0) in the cascade.

```
Expr = AssignOpExpr
AssignOpExpr = OrExpr assignOp Expr       -- assign
             | OrExpr
OrExpr       = OrExpr "||" AndExpr        -- or
             | AndExpr
AndExpr      = AndExpr "&&" EqExpr        -- and
             | EqExpr
EqExpr       = EqExpr ("==" | "!=") RelExpr  -- eq
             | RelExpr
RelExpr      = RelExpr ("<=" | ">=" | "<" | ">") AddExpr  -- rel
             | AddExpr
AddExpr      = AddExpr ("+" | "-") MulExpr  -- add
             | MulExpr
MulExpr      = MulExpr ("*" | "/") UnaryExpr  -- mul
             | UnaryExpr
UnaryExpr    = "-" UnaryExpr              -- neg
             | "!" UnaryExpr              -- not
             | AccessExpr
```

This replaces the manual precedence-climbing algorithm in `binop.ts`.

### 5. Async/Sync/Await Prefixes

The current parser supports `async`, `sync`, and `await` as prefix keywords on value access expressions, setting an `async` boolean on the AST node (`true` for `async`, `false` for `sync`/`await`). These are not unary operators — they modify function calls and value access, not arbitrary expressions. They are handled as prefix keywords in the access expression rule:

```
AccessExpr = "async" AccessExpr           -- async
           | ("sync" | "await") AccessExpr  -- sync
           | AccessExpr "." ident          -- property
           | ...
```

The `stream` keyword (used before `llm` calls) is also parsed at this level:

```
AccessExpr = ...
           | "stream" AccessExpr          -- stream
           | ...
```

`stream` sets a flag on the AST node similar to `async`/`sync`, and the preprocessor/builder handle its semantics.

### 6. Access & Calls

Left-recursive rule replacing the chain-building logic in `access.ts`:

```
AccessExpr = AccessExpr "." ident         -- property
           | AccessExpr "(" ListOf<Expr, ","> ")"  -- call
           | AccessExpr "[" Expr "]"      -- index
           | PrimaryExpr
```

### 7. Primary Expressions

```
PrimaryExpr = "(" Expr ")"               -- paren
            | arrayLiteral
            | objectLiteral
            | number
            | string
            | multiLineString
            | boolean
            | ident
```

Parenthesized expressions are handled here — they work everywhere automatically.

### 8. Literals

Numbers, strings (with `${Expr}` interpolation), multi-line strings (triple-quoted), booleans, variable names. Lexical rules (lowercase) — no auto-whitespace skipping.

### 9. Types

`TypeExpr` for the full type system: primitives, arrays (`type[]` and `array<type>`), unions (`type1 | type2`), objects (`{ key: type }`), literal types, type aliases. Recursive.

### 10. Imports

Three variants: `import nodes {...} from "..."`, `import tools { safe ... } from "..."`, and standard ES import syntax (named, namespace, default).

### 11. Threads & Other

`thread`/`subthread` blocks, `use`/`+` tool declarations, `skill`, `shared` assignments, special vars (`__model`, `__messages`), comments (single-line and multi-line).

### Key grammar design decisions

- **Syntactic rules (uppercase) handle whitespace automatically.** No manual `optionalSpaces` plumbing.
- **Lexical rules (lowercase) for tokens.** `ident`, `number`, string internals. No whitespace skipping.
- **`stream` and `llm` are regular identifiers**, not special syntax. The preprocessor and builder handle their semantics.
- **Semicolons are optional everywhere**, matching current behavior.
- **End-of-line comments** are supported by including `comment` in the `space` rule override (ohm's `space` rule controls what gets skipped between tokens in syntactic rules).

## Error Reporting

The current parser catches `TarsecError` and uses `prettyMessage` for error output. The CLI (`scripts/agency.ts`) also catches `TarsecError` for debug commands.

With ohm, parse errors are reported via `matchResult.message` (which includes position information and expected alternatives) and `matchResult.shortMessage`. Rule descriptions (e.g., `ident (an identifier) = ...`) are used in error messages to provide human-readable context.

The `parseAgency()` function will check `matchResult.failed()` and return a failure `ParserResult` with `matchResult.message` as the error message. The `TarsecError` catch blocks in `parseAgency()` and `scripts/agency.ts` are replaced with this check. The CLI debug commands that currently catch `TarsecError` are updated to use the failure message from `ParserResult`.

## Grammar File Loading

The `agency.ohm` grammar file needs to be available at runtime. Since the project compiles TypeScript to `dist/`, the `.ohm` file must be either:

1. **Read from the filesystem** using `fs.readFileSync` with a path relative to the module — simple and works for the CLI use case.
2. **Inlined as a string constant** in a `.ts` file — avoids filesystem dependency, works in all environments.

We'll use option 1 (filesystem read) since Agency is a CLI/Node.js tool, and keep option 2 as a fallback if bundling becomes needed. The `.ohm` file will be copied to `dist/` as part of the build step.

## Syntax Improvements

These are features that were difficult or impossible with the tarsec parser:

### Parenthesized expressions

Any expression can be wrapped in parentheses: `foo = (llm("hi"))`, `if ((x + 1) == 2) { ... }`. The `PrimaryExpr = "(" Expr ")"` rule handles this at the bottom of the precedence cascade, so parentheses work everywhere.

### End-of-line comments

Comments at the end of a line are allowed: `if (true) { // this works now`. This is handled by including single-line comments in the `space` rule, so they're automatically skipped as whitespace in syntactic rules.

### Arbitrary expressions in string interpolation

`"hello ${foo()}"` and `"result: ${a + b}"` now work. The interpolation rule is `"${" Expr "}"` instead of being limited to variable names and value access.

### Arbitrary expressions as function arguments

`foo(a + b, bar())` works naturally since function arguments are `ListOf<Expr, ",">`.

### Unary operators

`-x` and `!x` are supported via the `UnaryExpr` rule in the precedence cascade.

### Additional improvements to identify during implementation

As the grammar is written, other gaps in the tarsec parser will likely surface. These should be noted and addressed rather than replicated. The guiding principle: what would TypeScript allow here? If it's useful and consistent with Agency's design, add it.

## Testing Strategy

### Existing tests via wrappers (~13K lines)

All existing parser test files stay as-is. Test imports change from individual parser files to `./wrappers.js`. The wrapper functions call the ohm parser with a specific start rule, strip `loc`, and return `ParserResult<T>` matching the tarsec signature. These tests validate that the ohm parser produces identical AST output.

### Existing integration test fixtures

The `.agency` + `.mts` fixture pairs in `tests/typescriptGenerator/` and `tests/typescriptBuilder/` test the full pipeline end-to-end. These pass unchanged since the AST types are structurally the same.

### New feature tests

New tests for: parenthesized expressions, end-of-line comments, unary operators, arbitrary expressions in string interpolation and function arguments, and any other improvements identified during implementation.

## Migration Steps

1. Add `ohm-js` dependency
2. Add `Expression` type to `lib/types.ts` and widen ad-hoc expression unions in AST types
3. Add `lib/parsers/parserResult.ts` with the `ParserResult` type
4. Write `agency.ohm`, `semantics.ts`, `wrappers.ts`
5. Wire ohm parser into `lib/parser.ts`; remove `.trim()` from `normalizeCode()`; update error handling
6. Update build step to copy `agency.ohm` to `dist/`
7. Update test imports to use wrappers
8. Verify full test suite passes
9. Update `scripts/agency.ts` to remove `TarsecError` usage
10. Remove `tarsecTraceHost` from `AgencyConfig` in `lib/config.ts` (dead code after tarsec removal); replace with ohm's `grammar.trace()` if tracing is still needed
11. Add new feature tests (parenthesized expressions, end-of-line comments, unary operators, arbitrary expressions in interpolation/function args)
12. Delete old tarsec parser files and remove tarsec dependency

## Risks

- **Subtle AST differences.** The ohm parser might produce slightly different AST shapes for edge cases (e.g., whitespace handling, error recovery behavior). The existing test suite catches these immediately.
- **Runtime grammar errors.** Ohm grammars are strings, so grammar bugs surface at runtime, not compile time. Mitigated by the extensive test suite.
- **Semantic action arity mismatches.** If the grammar changes, all action functions must be updated. Ohm catches these at runtime. Again mitigated by tests.
- **Performance.** Ohm builds a full CST then walks it with semantic actions, vs tarsec building only what's needed. Unlikely to matter for Agency file sizes, but worth benchmarking if concerned.
