# Formatter Improvements Design Spec

## Goal

Bring the Agency formatter up to parity with standard language formatters (Prettier, gofmt, rustfmt) by adding line-length wrapping, import sorting, trailing newline enforcement, and trailing whitespace removal.

## Context

The Agency formatter works by parsing source into an AST and re-rendering it via `AgencyGenerator`. It already handles indentation, multi-line arrays (wrapping at 80 chars), multi-line objects, and multi-line pipe chains. Blank line preservation was just added via a sentinel pre-pass.

The formatter lives in:
- `lib/formatter.ts` — entry point (`formatSource`)
- `lib/cli/commands.ts` — CLI entry point (`format`, `formatFile`)
- `lib/backends/agencyGenerator.ts` — the generator that renders AST nodes back to Agency source

## Features

### 1. Line-length wrapping for function/node signatures

When a function or node definition's signature line exceeds 80 characters, break parameters onto individual lines.

**Before:**
```
def processData(inputFile: string, outputFile: string, format: string, verbose: boolean) {
```

**After:**
```
def processData(
  inputFile: string,
  outputFile: string,
  format: string,
  verbose: boolean,
) {
```

Node example:
```
// Before
public node handleRequest(message: string, context: Context, options: Options) {

// After
public node handleRequest(
  message: string,
  context: Context,
  options: Options,
) {
```

Rules:
- The 80-char threshold counts from column 0 (includes leading indentation)
- Render the full signature inline first
- If it exceeds 80 chars, re-render with each parameter on its own line, indented one level deeper than the statement's current indentation (uses the existing `increaseIndent()`/`decreaseIndent()` machinery)
- Add a trailing comma after the last parameter
- The closing `) {` goes on a new line at the original indent level

**Files:** `agencyGenerator.ts` — `processFunctionDefinition`, `processGraphNode`

### 2. Line-length wrapping for function call arguments

Same pattern as signatures: if a function call's inline argument list exceeds 80 characters, break to multi-line.

**Before:**
```
const result = someFunction("a very long argument", anotherArg, yetAnotherArg, moreStuff)
```

**After:**
```
const result = someFunction(
  "a very long argument",
  anotherArg,
  yetAnotherArg,
  moreStuff,
)
```

With a trailing `as` block:
```
const mapped = someFunction(
  longArg1,
  longArg2,
  longArg3,
) as item {
  return item + 1
}
```

Rules:
- Same 80-char threshold (counted from column 0, includes indentation)
- Each argument on its own line, indented one level deeper than the current statement's indentation
- Trailing comma after last argument
- If the call has a trailing block (`as` syntax), the `as` clause goes on the same line as the closing `)`

**Files:** `agencyGenerator.ts` — `renderArgList`, `generateFunctionCallExpression`

### 3. Line-length wrapping for import statements

When a named import exceeds 80 characters, break imported names onto individual lines.

**Before:**
```
import { foo, bar, baz, qux, quux, corge, grault } from "./utils.agency"
```

**After:**
```
import {
  foo,
  bar,
  baz,
  qux,
  quux,
  corge,
  grault,
} from "./utils.agency"
```

Named imports can include `safe` prefixes and `as` aliases. These are preserved in multi-line form:
```
import {
  safe foo,
  bar as baz,
  qux,
} from "./utils.agency"
```

Rules:
- Same 80-char threshold (counted from column 0)
- Only applies to named imports (`{ ... }`)
- Default imports, namespace imports stay on one line
- `safe` prefixes and `as` aliases are preserved
- Trailing comma after last name

**Files:** `agencyGenerator.ts` — `processImportStatement`, `processImportNameType`

### 4. Trailing newline

Ensure formatted output always ends with exactly one `\n`.

Currently `generateAgency` calls `.trim()` which strips trailing newlines. Change to `.trim() + "\n"`.

**Files:** `agencyGenerator.ts` — `generateAgency`

### 5. Import sorting

Sort imports into groups separated by blank lines, alphabetized within each group:

1. **Stdlib imports** (`std::*`) — alphabetized by module path
2. **Package imports** (`pkg::*`) — alphabetized by module path
3. **Relative imports** (`./`, `../`) — alphabetized by module path

**Before:**
```
import { bar } from "./bar.agency"
import { bash } from "std::shell"
import { foo } from "./foo.js"
import { mcp } from "pkg::@agency-lang/mcp"
import { read } from "std::index"
```

**After:**
```
import { read } from "std::index"
import { bash } from "std::shell"

import { mcp } from "pkg::@agency-lang/mcp"

import { bar } from "./bar.agency"
import { foo } from "./foo.js"
```

Rules:
- Node imports (`import node { ... }`) and tool imports (`import tool { ... }`) sort with relative imports. These are collected separately in `generate` as `importNodeStatement` nodes; they must be merged into the same sorted list as regular import statements before rendering.
- If a group is empty, skip it (no extra blank line)
- The stdlib auto-import from the template is not present in formatter output (formatter uses `applyTemplate: false`)

**Files:** `agencyGenerator.ts` — `generate` method. Currently `importStatements` (strings) and `importedNodes` (AST nodes) are collected separately. Both need to be rendered to strings, classified by group, sorted, and joined with blank lines between groups.

### 6. Trailing whitespace removal

Remove trailing spaces and tabs at the end of every line in the formatted output.

Apply as a final pass: `output.replace(/[ \t]+$/gm, "")`.

**Files:** `agencyGenerator.ts` — `generateAgency`, applied after joining all output sections

## Testing

- **Round-trip test:** Update `tests/formatter/roundtrip.agency` to include examples of all wrapping scenarios (long function signatures, long calls, long imports). The file should be pre-formatted so that formatting it produces identical output.
- **Wrapping tests:** Add tests to `lib/formatter.test.ts` that verify:
  - Short signatures stay on one line
  - Long signatures wrap correctly
  - Short calls stay inline, long calls wrap
  - Short imports stay inline, long imports wrap
- **Import sorting test:** Input with unsorted imports produces correctly grouped and sorted output
- **Trailing newline test:** Output always ends with `\n`
- **Trailing whitespace test:** No line ends with spaces/tabs
- **Existing tests:** All 2344 existing tests must continue to pass

## Out of scope

- Comment reflowing (wrapping long `//` comments)
- Alignment (aligning values in objects or match arms)
- Configurable line length (hardcoded at 80 for now)
- Semicolon insertion/removal (Agency is semicolon-optional, formatter preserves as-is)
