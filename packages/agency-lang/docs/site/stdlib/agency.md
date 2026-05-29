# agency

## Types

### CompiledProgram

```ts
type CompiledProgram = {
  moduleId: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L3))

### SourceLocation

```ts
type SourceLocation = {
  line: number;
  col: number;
  start: number;
  end: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L7))

### TypeCheckDiagnostic

```ts
type TypeCheckDiagnostic = {
  severity: string;
  message: string;
  loc?: SourceLocation;
  variableName?: string;
  expectedType?: string;
  actualType?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L14))

### TypeCheckReport

```ts
type TypeCheckReport = {
  errors: TypeCheckDiagnostic[];
  warnings: TypeCheckDiagnostic[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L23))

### FilterImportsResult

```ts
type FilterImportsResult = {
  source: string;
  filtered: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L122))

## Functions

### compile

```ts
compile(source: string): Result
```

Compile Agency source code. Returns a CompiledProgram on success, or a failure with compilation errors. Only standard library (std::) imports are allowed in the compiled code.
  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L28))

### run

```ts
run(compiled: CompiledProgram, node: string, args: Record<string, any>, wallClock: number, memory: number, ipcPayload: number, stdout: number): Result
```

Execute a compiled Agency program in a subprocess. The parent's handler chain extends to the subprocess — subprocess interrupts must be approved by both subprocess and parent handlers. Returns the subprocess node's result on success.

  Resource limits clamp the subprocess: it is killed and a limit_exceeded failure is returned if it exceeds wallClock, memory, ipcPayload, or stdout.

  @param compiled - A CompiledProgram from compile()
  @param node - Which exported node to run
  @param args - Arguments to pass to the node (defaults to no args)
  @param wallClock - Max wall-clock time before SIGKILL (default 60s, max 1h)
  @param memory - Max V8 heap size (default 512mb, max 4gb)
  @param ipcPayload - Max single IPC message size (default 100mb, max 1gb)
  @param stdout - Max combined stdout+stderr bytes (default 1mb, max 100mb)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| compiled | [CompiledProgram](#compiledprogram) |  |
| node | `string` |  |
| args | `Record<string, any>` | {} |
| wallClock | `number` | 60s |
| memory | `number` | 512mb |
| ipcPayload | `number` | 100mb |
| stdout | `number` | 1mb |

**Returns:** `Result`

**Throws:** `std::run`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L36))

### runFile

```ts
runFile(dir: string, filename: string, node: string, args: Record<string, any>, wallClock: number, memory: number, ipcPayload: number, stdout: number): Result
```

Compile and execute an Agency file in a subprocess. The file is read from dir/filename and compiled with the same stdlib-only import restrictions as compile() before being handed to run() — so the subprocess code can only call into the Agency standard library, not local files, npm packages, or Node modules.

  The dir argument is the sandbox boundary: filename cannot escape it via absolute paths or .. segments (and symlinks are followed and re-checked). dir is required (no default) so the caller must consciously specify the sandbox.

  Use partial application to bind dir to a sandbox directory once, then pass only filename + node at the call site, e.g. const safeRun = runFile.bind(dir: "/safe/dir").

  Resource limits clamp the subprocess: see run() for the full list of caps.

  @param dir - The sandbox directory. filename is resolved against this and must stay inside it.
  @param filename - The agency file to compile and run, resolved relative to dir
  @param node - Which exported node to run
  @param args - Arguments to pass to the node (defaults to no args)
  @param wallClock - Max wall-clock time before SIGKILL (default 60s, max 1h)
  @param memory - Max V8 heap size (default 512mb, max 4gb)
  @param ipcPayload - Max single IPC message size (default 100mb, max 1gb)
  @param stdout - Max combined stdout+stderr bytes (default 1mb, max 100mb)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |
| node | `string` |  |
| args | `Record<string, any>` | {} |
| wallClock | `number` | 60s |
| memory | `number` | 512mb |
| ipcPayload | `number` | 100mb |
| stdout | `number` | 1mb |

**Returns:** `Result`

**Throws:** `std::run`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L68))

### typecheck

```ts
typecheck(source: string): Result
```

Type-check Agency source code without compiling or running it. Returns a TypeCheckReport with separate `errors` and `warnings` arrays — a successful Result with a non-empty `errors` array means the type-checker ran and found problems. A failure Result means the type-checker could not run at all (parse error or unresolved import).

  Unlike compile(), this does NOT restrict imports — type-checking is read-only and does not execute code. Note that std:: and pkg:: imports resolve normally, but relative imports (./foo.agency) cannot be resolved when calling typecheck() with a source string, since there is no on-disk location to resolve them against. Use typecheckFile() for source that contains relative imports.

  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L111))

### parseAST

```ts
parseAST(source: string): Result
```

Parse Agency source code into an abstract syntax tree. Returns the raw AST as a JSON-serializable object on success, or a failure with the parse error message.

  The AST shape is the parser output with `applyTemplate: false, lower: false`, which matches what the formatter consumes — so an AST round-tripped through writeAST() / format() produces canonical Agency source.

  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L127))

### writeAST

```ts
writeAST(ast: any, dir: string, filename: string, overwrite: boolean): Result
```

Format an AST as Agency source and write it to dir/filename. The AST is typically obtained from parseAST() and optionally transformed before being written.

  The output is canonical formatter output: comments are preserved (they live in the AST as nodes), but whitespace and formatting are normalized to the AgencyGenerator's style — the same style produced by `pnpm run fmt`.

  The dir argument is the sandbox boundary: filename cannot escape it via absolute paths or .. segments (symlinks on existing files are followed and re-checked).

  @param ast - The AST to write (typically from parseAST)
  @param dir - The sandbox directory
  @param filename - The agency file to write, resolved relative to dir
  @param overwrite - If false, fail when the file already exists (default true)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ast | `any` |  |
| dir | `string` |  |
| filename | `string` |  |
| overwrite | `boolean` | true |

**Returns:** `Result`

**Throws:** `std::write`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L138))

### format

```ts
format(source: string): Result
```

Format Agency source code using the standard Agency formatter (the same one used by `pnpm run fmt`). Returns the formatted source on success, or a failure with a parse error.

  Comments are preserved. Whitespace and formatting are canonicalized — this is a lossy transformation for whitespace but not for semantics or comments.

  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L164))

### formatFile

```ts
formatFile(dir: string, filename: string): Result
```

Format an Agency file in place. Reads dir/filename, formats it with the standard Agency formatter, and writes the result back to the same path. If the file is already formatted, no write occurs (mtime is preserved).

  The dir argument is the sandbox boundary: filename cannot escape it via absolute paths or .. segments (symlinks are followed and re-checked). Both the read and the write happen inside the same interrupt — approving the interrupt approves both.

  Returns success(true) on a successful format (whether or not a write was needed), or a failure if parsing or I/O fails.

  @param dir - The sandbox directory. filename is resolved against this and must stay inside it.
  @param filename - The agency file to format, resolved relative to dir

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |

**Returns:** `Result`

**Throws:** `std::write`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L175))

### walkAST

```ts
walkAST(ast: any, visitor: (any, any) => any): any
```

Walk every node in a deep-cloned copy of the AST, invoking the visitor with each (node, ancestors) pair. The visitor may mutate the node in place; mutations land in the returned AST. The original AST passed in is never modified.

  Iteration order is pre-order: a node is visited before its children. The set of nodes to visit is determined upfront — if the visitor adds new children (e.g. by appending to a function's body), those new children will NOT be visited on this walk. Similarly, if the visitor replaces a child reference (e.g. node.body = [newNode]), the visitor will still be called on the OLD body's nodes (which are already in the buffered visit list). To re-walk a transformed AST, call walkAST again.

  The ancestors array lists every enclosing node from the root outward (excluding `node` itself). For nodes inside a block argument (e.g. inside `map(arr) as x { ... }`), the block argument appears in ancestors as a node with `type: "blockArgument"`.

  @param ast - The AST to walk (typically from parseAST)
  @param visitor - Called once per node as visitor(node, ancestors). Return value is ignored.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ast | `any` |  |
| visitor | `(any, any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L193))

### getNodesOfType

```ts
getNodesOfType(source: string, types: string[]): Result
```

Parse Agency source code and return all AST nodes whose `type` field matches any of the provided types. Walks the entire tree (not just top-level), so e.g. getNodesOfType(src, ["functionCall"]) returns every function call anywhere in the program.

  The returned nodes are references into a freshly-parsed AST; safe to mutate, but mutations do not write back to disk. Use writeAST() with the parsed AST to persist changes.

  @param source - Agency source code as a string
  @param types - List of AST type strings to match (e.g. ["function", "graphNode"])

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| types | `string[]` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L211))

### getImports

```ts
getImports(source: string): Result
```

Return all import statements in the source (i.e. `import { x } from "..."`).

  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L223))

### getFunctions

```ts
getFunctions(source: string): Result
```

Return all function definitions (`def foo(...) { ... }`) in the source.

  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L232))

### getGraphNodes

```ts
getGraphNodes(source: string): Result
```

Return all graph node definitions (`node main() { ... }`) in the source. Note: "graph nodes" here means Agency's `node` declarations, not generic AST nodes — see getNodesOfType for the latter.

  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L241))

### filterImports

```ts
filterImports(source: string, allowedPackages: string[], excludedPackages: string[], allowKinds: string[], excludeKinds: string[]): Result
```

Parse Agency source, drop imports that fail the policy, and return the resulting source plus a flag indicating whether anything was dropped.

  Imports are classified by `kind`:
    - "stdlib" — `std::*` (e.g. `std::shell`)
    - "pkg"    — `pkg::*` (e.g. `pkg::wikipedia`)
    - "local"  — relative or absolute file paths (e.g. `./util.agency`)
    - "node"   — bare specifiers resolved by Node (e.g. `fs`, `child_process`)

  Policy:
    - `allowedPackages` / `excludedPackages` are glob patterns (picomatch syntax) matched against the raw import path string.
    - `allowKinds` / `excludeKinds` accept the kind strings above.
    - Exclude rules always win: if a path matches anything in `excludedPackages` or `excludeKinds`, it is dropped.
    - When all four lists are empty, every import is allowed (default-allow).
    - When at least one allow list is non-empty, an import must match an allowed kind OR an allowed package glob (union across the two axes). Note that allowKinds=["stdlib"] is still a restriction even with the package lists empty — only stdlib passes.

  The returned source is regenerated via the Agency formatter, so whitespace and formatting are canonicalized. Comments are preserved (see writeAST docstring for details).

  @param source - Agency source code as a string
  @param allowedPackages - Glob patterns; matched imports are allowed (subject to excludes)
  @param excludedPackages - Glob patterns; matched imports are dropped
  @param allowKinds - Kind strings ("stdlib" | "pkg" | "local" | "node") to allow
  @param excludeKinds - Kind strings to drop

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| allowedPackages | `string[]` | [] |
| excludedPackages | `string[]` | [] |
| allowKinds | `string[]` | [] |
| excludeKinds | `string[]` | [] |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L250))

### typecheckFile

```ts
typecheckFile(dir: string, filename: string): Result
```

Type-check an Agency file on disk. The file is read from dir/filename, and relative imports inside the file are resolved against the file's directory.

  The dir argument is the sandbox boundary for the entry file: filename cannot escape it via absolute paths or .. segments (and symlinks are followed and re-checked). Note that transitive imports from the entry file are NOT confined to dir — type-checking is read-only, so the sandbox only governs which file the caller can ask to be type-checked.

  Use partial application to bind dir once, e.g. const tc = typecheckFile.partial(dir: "/safe/dir").

  Returns a TypeCheckReport with `errors` and `warnings` arrays on success; returns a failure when the file cannot be read, the sandbox is violated, or the source cannot be parsed.

  @param dir - The sandbox directory. filename is resolved against this and must stay inside it.
  @param filename - The agency file to type-check, resolved relative to dir

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |

**Returns:** `Result`

**Throws:** `std::read`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L284))

### toolGuidelines

```ts
toolGuidelines(tools: any[]): string
```

Collect every tool's `promptGuidelines` (set via `.withGuidelines(...)`) into a single prompt-ready block. Use this when assembling a system prompt to surface per-tool advice (e.g. "edit: prefer one call with multiple entries") to the LLM. Returns an empty string when no tool has guidelines, so it composes cleanly with `sysPrompt + toolGuidelines(tools)`.

  @param tools - Array of tools (AgencyFunctions) to harvest guidelines from

**Parameters:**

| Name | Type | Default |
|---|---|---|
| tools | `any[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L304))
