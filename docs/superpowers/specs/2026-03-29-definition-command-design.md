# Go-to-Definition Command

## Summary

Add a `definition` CLI command that takes a cursor position and returns the source location of the symbol's definition. This powers "go to definition" in the VS Code extension.

## CLI Interface

```bash
pnpm agency definition --line 5 --column 10 --file main.agency < file.agency
```

- `--line` — 0-indexed line number of the cursor
- `--column` — 0-indexed column number of the cursor
- `--file` — filename to report in output (the VS Code extension passes this for context; the actual content comes from stdin to handle unsaved buffers)
- stdin — the full file content

## Supported Symbols (v1)

- **Graph node definitions** — `node foo()` → looks up `foo`
- **Function definitions** — `def greet()` → looks up `greet`
- **Type alias definitions** — `type Category = ...` → looks up `Category`

Variable assignments and cross-file imports are out of scope for v1.

## Implementation

New file: `lib/cli/definition.ts`

### Step 1: Extract word at cursor

Scan the source text at the given line/column to find the identifier under the cursor. Walk left and right from the position while characters are valid identifier chars (`[a-zA-Z0-9_]`). If the cursor is on whitespace, a non-identifier character, or out of bounds, return `null`.

### Step 2: Parse and collect definitions

Parse the source with `parseAgency`. Walk `program.nodes` to build a map of symbol name → `SourceLocation`:

- `graphNode` → key: `node.nodeName`, value: `node.loc`
- `function` → key: `node.functionName`, value: `node.loc`
- `typeAlias` → key: `node.aliasName`, value: `node.loc`

If a node doesn't have `loc` (shouldn't happen for these types since they use `withLoc`), skip it.

### Step 3: Look up and return

If the extracted word exists in the definitions map, return:

```json
{ "file": "main.agency", "line": 12, "column": 0 }
```

Where `line` and `column` come from the definition's `loc` field, and `file` is the `--file` argument.

If the word is not found or the cursor is not on an identifier, output `null`.

## CLI Wiring

New `definition` command in `scripts/agency.ts` using commander, following the same stdin-reading pattern as the existing `diagnostics` command. Reads stdin via `readStdin()`, parses `--line`, `--column`, and `--file` options.

## Output Format

Success:
```json
{ "file": "main.agency", "line": 12, "column": 0 }
```

No definition found:
```json
null
```

Output is written to stdout as JSON for the VS Code extension to consume.

## Testing

Unit tests in `lib/cli/definition.test.ts`:

- Given source with a node definition and cursor on a call to that node → returns the node's loc
- Given source with a function definition and cursor on a call to that function → returns the function's loc
- Given source with a type alias and cursor on a type annotation using it → returns the type's loc
- Cursor on whitespace → returns null
- Cursor on a keyword (`if`, `return`) → returns null
- Cursor on an undefined variable name → returns null
