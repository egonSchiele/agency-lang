---
name: "agency"
description: "Tools for compiling, type-checking, running, formatting, and inspecting Agency programs from Agency code."
---

# agency

Tools for compiling, type-checking, running, formatting, and inspecting
  Agency programs from Agency code. Compile and run source in a sandboxed
  subprocess, type-check or format it, and walk its AST to find imports,
  functions, or nodes.

  ```ts
  import { compile, run } from "std::agency"

  node main() {
    const program = compile("export node main() { return 42 }")
    const result = run(program, "main")
    print(result)
  }
  ```

## Types

### CompiledProgram

```ts
export type CompiledProgram = {
  moduleId: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L76))

### SourceLocation

```ts
export type SourceLocation = {
  line: number;
  col: number;
  start: number;
  end: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L80))

### TypeCheckDiagnostic

```ts
export type TypeCheckDiagnostic = {
  /** Stable AG#### diagnostic code. Suppress one line with
  `// @tc-ignore AG####`, or match on it instead of parsing the message. */
  code: string;
  severity: string;
  message: string;
  loc?: SourceLocation;
  /** Structured payload of the diagnostic (the values rendered into the
  message, e.g. the expected and actual type strings; counts and positions
  are numbers). */
  params: Record<string, string | number>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L87))

### TypeCheckReport

```ts
export type TypeCheckReport = {
  errors: TypeCheckDiagnostic[];
  warnings: TypeCheckDiagnostic[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L100))

### InterruptAnswer

```ts
export type InterruptAnswer = {
  action: "approve" | "reject";
  value?: any;
  expectedMessage?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L269))

### TestArguments

```ts
export type TestArguments = Record<string, any>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L275))

### AgencyTestCase

```ts
export type AgencyTestCase = {
  node: string;
  args?: TestArguments;
  expected: any;
  interrupts?: InterruptAnswer[];
  wallClock?: number;
  description?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L277))

### CaseReport

```ts
export type CaseReport = {
  node: string;
  pass: boolean;
  feedback: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L286))

### TestReport

```ts
export type TestReport = {
  pass: boolean;
  cases: CaseReport[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L292))

### EffectsByExport

Per-exported-symbol effect lists, keyed by node/function name.

```ts
/** Per-exported-symbol effect lists, keyed by node/function name. */
export type EffectsByExport = Record<string, string[]>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L671))

### ExportInfo

What describe reports for one exported symbol. `signature` is the
printed declaration line without the export keyword or tool markers;
`docstring` is the symbol's docstring (defs and nodes) or doc comment
(types); `effects` uses the same names and "unknown" sentinel as
getEffects, and is empty for types and consts. Re-exported symbols carry
the module path they came through in `reexportedFrom` (the outermost hop
when re-exports chain); when that module cannot be read from a source
string (relative paths), the entry has kind "reexport" and its effects
are ["unknown"] rather than silently missing.

```ts
/** What describe reports for one exported symbol. `signature` is the
printed declaration line without the export keyword or tool markers;
`docstring` is the symbol's docstring (defs and nodes) or doc comment
(types); `effects` uses the same names and "unknown" sentinel as
getEffects, and is empty for types and consts. Re-exported symbols carry
the module path they came through in `reexportedFrom` (the outermost hop
when re-exports chain); when that module cannot be read from a source
string (relative paths), the entry has kind "reexport" and its effects
are ["unknown"] rather than silently missing. */
export type ExportInfo = {
  name: string;
  kind: "def" | "node" | "type" | "const" | "reexport";
  signature: string;
  docstring?: string;
  effects: string[];
  destructive: boolean;
  idempotent: boolean;
  handoff: boolean;
  reexportedFrom?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L700))

### ModuleInfo

```ts
export type ModuleInfo = {
  description?: string;
  exports: ExportInfo[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L712))

### AST

A parsed Agency program, the value `parseAST` returns on success.
  `type` is always "agencyProgram". `nodes` holds the top-level
  declarations (imports, functions, graph nodes, type aliases, ...). Each
  is an object with a `type` discriminant field. Its remaining fields
  vary by node type, so nodes stay untyped.

```ts
/** A parsed Agency program, the value `parseAST` returns on success.
  `type` is always "agencyProgram". `nodes` holds the top-level
  declarations (imports, functions, graph nodes, type aliases, ...). Each
  is an object with a `type` discriminant field. Its remaining fields
  vary by node type, so nodes stay untyped. */
export type AST = {
  type: "agencyProgram";
  nodes: any[];
  docComment?: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L761))

### Code

`Code` is `AST` plus a fragment kind: a value can hold a whole program
  (what `loadTemplate` and `parseAST` produce), a statement list, or a
  single expression. The kind is what lets an expression-sized fragment
  fill an expression hole.

```ts
/** `Code` is `AST` plus a fragment kind: a value can hold a whole program
  (what `loadTemplate` and `parseAST` produce), a statement list, or a
  single expression. The kind is what lets an expression-sized fragment
  fill an expression hole. */
export type Code = {
  type: "agencyProgram";
  kind?: "program" | "statements" | "expr";
  nodes: any[];
  docComment?: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L818))

### HoleInfo

```ts
export type HoleInfo = {
  name: string;
  sort: "expr" | "statements" | "identifier" | "decl";
  splice: boolean;
  type?: string;
  origin?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L825))

## Effects

### std::read

```ts
@alwaysUnder(dir)
effect std::read {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L57))

### std::write

```ts
@alwaysUnder(dir)
effect std::write {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L62))

### std::run

```ts
effect std::run {
  moduleId: string;
  node: string;
  args: Record<string, any>;
  limits: { wallClock: number; memory: number; ipcPayload: number; stdout: number; maxCost: number | null };
  cwd: string;
  logFile: string;
  depth: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L66))

## Constants

### CLI_NOT_AVAILABLE

```ts
export static const CLI_NOT_AVAILABLE = "The agency command line is not available here. Use the tools instead: typecheck(source) or typecheckFile(dir, filename) for type errors; testFile(dir, filename) to run a .test.json harness (write the files it tests first); runFile(dir, filename, node) to run a program; parseAST, format, describe for source analysis."
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1054))

## Functions

### compile

```ts
compile(source: string, dir: string = ""): Result
```

Compile Agency source code. Returns a CompiledProgram on success, or a failure with compilation errors. Imports may name standard library (`std::`) modules and `.agency` files inside `dir`. TypeScript/JavaScript files, Node modules, `pkg::` packages, symlinks, and compile-time splices are refused anywhere in the import closure.

  @param source - Agency source code as a string
  @param dir - Directory relative imports resolve against, and the boundary they are confined to. Empty (the default) means local imports cannot resolve.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| dir | `string` | "" |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L105))

### run

```ts
run(
  compiled: CompiledProgram,
  node: string,
  args: Record<string, any> = {},
  wallClock: number = 60s,
  memory: number = 512mb,
  ipcPayload: number = 100mb,
  stdout: number = 1mb,
  logFile: string = "",
  cwd: string = "",
  maxDepth: number = 5,
  maxCost: number | null = null,
): Result
```

Execute a compiled Agency program in a subprocess and return the node's result.

  @param compiled - A compiled Agency program
  @param node - Which exported node to run
  @param args - Arguments to pass to the node
  @param wallClock - Max wall-clock time in MILLISECONDS before SIGKILL (default 60000 = 60s, max 1h). Pass null for the default.
  @param memory - Max V8 heap size in BYTES (default 536870912 = 512mb, max 4gb). Pass null for the default.
  @param ipcPayload - Max single IPC message size in BYTES (default 104857600 = 100mb, max 1gb). Pass null for the default.
  @param stdout - Max combined stdout+stderr output in BYTES (default 1048576 = 1mb, max 100mb). Pass null for the default.
  @param logFile - Optional statelog JSONL file path for this subprocess run
  @param cwd - Optional working directory for this subprocess run
  @param maxDepth - Max subprocess nesting depth (default 5, hard ceiling 10).
  @param maxCost - Max subprocess LLM spend in dollars (e.g. $0.50). null = no cost limit.

Runs agent-generated Agency code in a child process.
Any interrupts and guards defined in the parent process will
apply to the child process. Any callbacks in scope will also apply.
Exceeding a resource limit kills the subprocess and returns a
limit_exceeded failure. Exceeding maxCost kills the subprocess and
returns a limit_exceeded failure, like the other limits.

For `maxDepth`, if an ancestor process has a lower maxDepth,
the lower value is used. For example, if a parent process has maxDepth=3
and a child process has maxDepth=5, maxDepth=3 is used.

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
| logFile | `string` | "" |
| cwd | `string` | "" |
| maxDepth | `number` | 5 |
| maxCost | `number \| null` | null |

**Returns:** `Result`

**Throws:** `std::run`, `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L126))

### runFile

```ts
runFile(
  dir: string,
  filename: string,
  node: string,
  args: Record<string, any> = {},
  wallClock: number = 60s,
  memory: number = 512mb,
  ipcPayload: number = 100mb,
  stdout: number = 1mb,
  maxCost: number | null = null,
): Result
```

Compile and execute an Agency file in a subprocess and return the node's result.
  Imports may name standard library (`std::`) modules and `.agency` files inside
  `dir`; TypeScript/JavaScript files, Node modules, `pkg::` packages, symlinks, and
  compile-time splices are refused anywhere in the import closure.

  @param dir - The directory containing the file; also the boundary its local imports are confined to
  @param filename - The agency file to compile and run
  @param node - Which node to run
  @param args - Arguments to pass to the node
  @param wallClock - Max wall-clock time in MILLISECONDS before SIGKILL (default 60000 = 60s, max 1h). Pass null for the default.
  @param memory - Max V8 heap size in BYTES (default 536870912 = 512mb, max 4gb). Pass null for the default.
  @param ipcPayload - Max single IPC message size in BYTES (default 104857600 = 100mb, max 1gb). Pass null for the default.
  @param stdout - Max combined stdout+stderr output in BYTES (default 1048576 = 1mb, max 100mb). Pass null for the default.
  @param maxCost - Max subprocess LLM spend in dollars (e.g. $0.50). null = no cost limit.

Just like `run`, any interrupts and guards defined in the parent process
will apply to the child process. Any callbacks in scope will also apply.
Exceeding a resource limit kills the subprocess and returns a `limit_exceeded` failure.

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
| maxCost | `number \| null` | null |

**Returns:** `Result`

**Throws:** `std::run`, `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L226))

### test

```ts
test(
  dir: string,
  filename: string,
  cases: AgencyTestCase[],
  wallClock: number = 60s,
  memory: number = 512mb,
  ipcPayload: number = 100mb,
  stdout: number = 1mb,
  maxCost: number | null = null,
): Result<TestReport>
```

Run test cases against an Agency file in the sandboxed subprocess and return a per-case report. The file's imports may name std:: modules, .agency files inside dir, and pkg:: packages with a pure-Agency closure.

  @param dir - The directory containing the tested file; also the boundary its local imports are confined to
  @param filename - The agency file whose exported nodes the cases run
  @param cases - The cases: which node, what args, what value to expect
  @param wallClock - Max wall-clock time per case in MILLISECONDS (default 60000 = 60s); a case's own wallClock overrides it
  @param memory - Max V8 heap size per case in BYTES (default 536870912 = 512mb)
  @param ipcPayload - Max single IPC message size per case in BYTES (default 104857600 = 100mb)
  @param stdout - Max combined stdout+stderr output per case in BYTES (default 1048576 = 1mb)
  @param maxCost - Max LLM spend in dollars for the WHOLE call. null = no cost limit.

Runs agency tests the way run() runs a node: each case executes in the
sandboxed subprocess, so every interrupt the tested code raises — and the
per-case std::run launch itself — is voted on by the caller's handlers, and
any reject wins.

A case's scripted `interrupts` answers are ONE VOTE each, consumed in
order by a handler wrapped closest around the case; parents still see
every interrupt, so a test file can never approve something the caller's
handler would reject. Exhausted answers stay silent (the interrupt
propagates outward); leftover answers fail the case; an `expectedMessage`
mismatch fails the case.

A compile failure (including "the tested file does not export X's import")
is a whole-call failure: fix the input and call again. A case failing —
wrong value, rejected interrupt, per-case limit — is a `pass: false` entry
in a success report, and never stops the batch. `maxCost` guards the WHOLE
call, in the same limit_exceeded shape as run()'s other limits.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |
| cases | `AgencyTestCase[]` |  |
| wallClock | `number` | 60s |
| memory | `number` | 512mb |
| ipcPayload | `number` | 100mb |
| stdout | `number` | 1mb |
| maxCost | `number \| null` | null |

**Returns:** `Result<TestReport>`

**Throws:** `std::guard`, `std::run`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L314))

### testFile

```ts
testFile(
  dir: string,
  filename: string,
  maxCost: number | null = null,
): Result<TestReport>
```

Run the test cases a .test.json file declares against its source file.

  @param dir - The directory holding the .test.json and the file it tests
  @param filename - The .test.json file
  @param maxCost - Max LLM spend in dollars for the WHOLE call. null = no cost limit.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |
| maxCost | `number \| null` | null |

**Returns:** `Result<TestReport>`

**Throws:** `std::read`, `std::guard`, `std::run`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L456))

### runCode

```ts
runCode(
  source: string,
  node: string = "main",
  args: Record<string, any> = {},
  wallClock: number = 60s,
  memory: number = 512mb,
  ipcPayload: number = 100mb,
  stdout: number = 1mb,
  maxCost: number | null = null,
  cwd: string = "",
  dir: string = "",
): Result
```

Compile Agency source code and execute one of its nodes in a subprocess,
  returning the value the node returned. Prefer this over separate
  compile() and run() calls. Imports may name standard library (`std::`)
  modules and `.agency` files inside `dir`; TypeScript/JavaScript files,
  Node modules, `pkg::` packages, symlinks, and compile-time splices are
  refused anywhere in the import closure. Compile
  errors are returned as a failure without running anything; fix the source
  and call again.

  @param source - Agency source code as a string
  @param node - Which exported node to run (default "main")
  @param args - Arguments to pass to the node
  @param wallClock - Max wall-clock time in MILLISECONDS before SIGKILL (default 60000 = 60s, max 3600000 = 1h). Pass null for the default.
  @param memory - Max V8 heap size in BYTES (default 536870912 = 512mb, max 4294967296 = 4gb). Pass null for the default.
  @param ipcPayload - Max single IPC message size in BYTES (default 104857600 = 100mb, max 1073741824 = 1gb). Pass null for the default.
  @param stdout - Max combined stdout+stderr output in BYTES (default 1048576 = 1mb, max 104857600 = 100mb). Pass null for the default.
  @param maxCost - Max subprocess LLM spend in dollars (e.g. 0.50). null = no cost limit.
  @param cwd - Working directory for the subprocess AT RUN TIME. Empty inherits the caller's process cwd (which may be the package dir, not where you want files); pass the agent working directory so the generated program's file writes land there. Independent of dir.
  @param dir - Directory relative imports resolve against AT COMPILE TIME, and the boundary they are confined to. Empty (the default) means local imports cannot resolve. Independent of cwd.

Just like `run`, any interrupts and guards defined in the parent process
will apply to the child process. Any callbacks in scope will also apply.
Exceeding a resource limit kills the subprocess and returns a `limit_exceeded` failure.

Designed for LLM tool use: compile() returns a CompiledProgram the model
would have to echo back into run() verbatim (it will not — see the
compile→run "CompiledProgram has no code" failure mode). runCode takes
the source directly, so nothing large round-trips through the model.

Left unmarked (neither destructive nor idempotent): it runs arbitrary
code whose danger depends on that code, so its failures reach a
tool-calling model as the neutral, re-callable tier. Each attempt
re-raises std::run and the child's own effects re-prompt.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| node | `string` | "main" |
| args | `Record<string, any>` | {} |
| wallClock | `number` | 60s |
| memory | `number` | 512mb |
| ipcPayload | `number` | 100mb |
| stdout | `number` | 1mb |
| maxCost | `number \| null` | null |
| cwd | `string` | "" |
| dir | `string` | "" |

**Returns:** `Result`

**Throws:** `std::run`, `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L566))

### typecheck

```ts
typecheck(
  source: string,
  ignoreCodes: string[] = [],
  dir: string = "",
): Result<TypeCheckReport>
```

Type-check Agency source code given as a string. To check a file that is already on disk, call `typecheckFile` with its path instead of pasting its contents here.

  @param source - Agency source code as a string
  @param ignoreCodes - Diagnostic codes (e.g. ["AG3009"]) to drop from the report's errors and warnings
  @param dir - Directory the source's relative imports resolve against. Empty (the default) means local imports cannot resolve.

Without `dir`, relative imports (./foo.agency) cannot be resolved from a
source string. With `dir`, the source is checked as if it were a file in
`dir`, so its relative imports resolve against the files there, the way
`typecheckFile` resolves them. Nothing is written to `dir`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| ignoreCodes | `string[]` | [] |
| dir | `string` | "" |

**Returns:** `Result<TypeCheckReport>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L633))

### getEffects

```ts
getEffects(source: string): Result<EffectsByExport>
```

Map each exported node and function in the source to the list of
  interrupt effects it can raise, transitively. Bare `interrupt(...)`
  sites appear as the sentinel "unknown", so the envelope never
  silently under-reports. Use this to show or check what a program can
  do before running it.

  Not visible to this: code generated by a compile-time splice, a
  function received as a parameter and then called, and a function
  reference stored in a variable before being passed on. An empty list
  means nothing risky was found, not that nothing risky exists.

  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<EffectsByExport>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L673))

### describe

```ts
describe(source: string): Result<ModuleInfo>
```

Describe what an Agency module exports: each exported function, node, type, const, and re-export, in source order, with its signature, docstring, transitive effect list, and destructive/idempotent/handoff markers. Anything marked @hidden is left out, as is anything whose name starts with an underscore - both are the same visibility rule `agency doc` applies, so this is the module surface a reader sees. Re-exports from std:: modules resolve to full entries; re-exports from relative paths cannot be read from a source string and come back with effects ["unknown"]. Use this instead of reading source when generating code shaped by a module - for example, one handler per effect its tools can raise.

  @param source - Agency source code as a string

The reify primitive: exports-as-data, so generators can be shaped by
what a module contains instead of hand-maintained lists. Omits what
`agency doc` omits: `@hidden` declarations, and underscore-prefixed
exports (lowering targets, not caller surface). `description` is the
module doc comment's one-line summary.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<ModuleInfo>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L722))

### typecheckFile

```ts
typecheckFile(dir: string, filename: string): Result
```

Type-check an Agency file on disk. The file is read from dir/filename,
  with relative imports inside it resolved against the file's directory.

  @param dir - The directory containing the file
  @param filename - The agency file to type-check. Must stay inside dir; to
    read another directory, pass it in `dir`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |

**Returns:** `Result`

**Throws:** `std::read`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L736))

### parseAST

```ts
parseAST(source: string): Result<AST>
```

Parse Agency source code into an abstract syntax tree.

  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<AST>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L767))

### writeAST

```ts
writeAST(
  ast: AST,
  dir: string,
  filename: string,
  overwrite: boolean = true,
): Result
```

Format an AST as Agency source and write it to dir/filename. Absolute paths and .. segments cannot escape dir. Symlinks on existing files are followed and re-checked.

  @param ast - The AST to write (typically a parsed Agency AST)
  @param dir - The sandbox directory
  @param filename - The agency file to write, resolved relative to dir
  @param overwrite - If false, fail when the file already exists (default true)

Output is canonical formatter output (the same style as `pnpm run fmt`):
  the formatter preserves comments (they live in the AST as nodes) but
  normalizes whitespace and formatting.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ast | [AST](#ast) |  |
| dir | `string` |  |
| filename | `string` |  |
| overwrite | `boolean` | true |

**Returns:** `Result`

**Throws:** `std::write`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L779))

### format

```ts
format(source: string): Result
```

Format Agency source code with the standard Agency formatter.

  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L805))

### loadTemplate

```ts
loadTemplate(dir: string, filename: string): Result<Code>
```

Load an Agency file containing holes as a template.

  @param dir - The sandbox directory
  @param filename - The template file, resolved relative to dir. Must stay
    inside dir; to read another directory, pass it in `dir`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |

**Returns:** `Result<Code>`

**Throws:** `std::read`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L833))

### holesOf

```ts
holesOf(template: Code): HoleInfo[]
```

The unfilled holes in a template, in the order they appear. Each entry has the hole's name, its sort (what category of thing fills it), whether it is a splice, and its type when one is known. origin names the fill this hole most recently arrived through when it came in via a grafted fragment (best-effort; null for holes written directly in the template).

  @param template - A template loaded with loadTemplate

**Parameters:**

| Name | Type | Default |
|---|---|---|
| template | [Code](#code) |  |

**Returns:** `HoleInfo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L852))

### fill

```ts
fill(template: Code, values: Record<string, Json | Code>): Result<Code>
```

Fill holes in a template. Plain values become literals and are never parsed; Code values are grafted as trees. Filling some holes and not others returns a template with the rest still in it.

  @param template - A template loaded with loadTemplate
  @param values - A record mapping hole names to values

**Parameters:**

| Name | Type | Default |
|---|---|---|
| template | [Code](#code) |  |
| values | `Record<string, Json \| Code>` |  |

**Returns:** `Result<Code>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L861))

### combine

```ts
combine(codes: Code[]): Result<Code>
```

Merge several Code fragments into one, in order. Use this to build one
  fragment from a loop, for example one function per item in a list.
  Fragments of the same kind merge into that kind. Expressions merge into
  a statement list. A whole-program fragment cannot merge with loose
  statements or expressions.

  @param codes - The fragments to merge, in order

**Parameters:**

| Name | Type | Default |
|---|---|---|
| codes | `Code[]` |  |

**Returns:** `Result<Code>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L874))

### toSource

```ts
toSource(code: Code): string
```

Print a Code value back to Agency source, including any unfilled holes.

  @param code - A template or filled program

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | [Code](#code) |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L887))

### parseExpr

```ts
parseExpr(source: string): Result<Code>
```

Parse a single Agency expression into a Code fragment that can fill an expr hole. Fails on anything other than exactly one expression.

  @param source - Agency source for one expression

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<Code>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L896))

### parseStatements

```ts
parseStatements(source: string): Result<Code>
```

Parse a list of Agency statements into a Code fragment that can fill a statements hole.

  @param source - Agency source for one or more statements

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<Code>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L905))

### formatFile

```ts
formatFile(dir: string, filename: string): Result
```

Format an Agency file in place using the standard Agency formatter.

  @param dir - The directory containing the file
  @param filename - The agency file to format. Must stay inside dir; to
    write another directory, pass it in `dir`.

Read and write happen inside the same interrupt, so approving it approves both.
  If the file is already formatted, no write occurs and its mtime is preserved.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |

**Returns:** `Result`

**Throws:** `std::write`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L916))

### walkAST

```ts
walkAST(ast: AST, visitor: (node: any, ancestors: any[]) -> any): AST
```

Walk every node in a deep-cloned copy of the AST, invoking the visitor
  with each (node, ancestors) pair, and return the modified clone.
  The visitor may mutate nodes in place. This will not modify the original tree.
  The ancestors array lists every enclosing node from the root outward, excluding the node itself.

  @param ast - The AST to walk
  @param visitor - Called once per node as visitor(node, ancestors). Mutate node in place, return value is ignored.

- Iteration is pre-order (a node is visited before its children)
- The visit list is fixed upfront: nodes the visitor adds during
  the walk are not visited. Replacing a child reference still visits the old subtree.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ast | [AST](#ast) |  |
| visitor | `(node: any, ancestors: any[]) => any` |  |

**Returns:** [AST](#ast)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L940))

### getNodesOfType

```ts
getNodesOfType(source: string, types: string[]): Result<any[]>
```

Parse Agency source code and return every AST node whose `type` field matches any of the provided types.

  @param source - Agency source code
  @param types - List of AST type strings to match (e.g. ["function", "graphNode"])

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| types | `string[]` |  |

**Returns:** `Result<any[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L960))

### getImports

```ts
getImports(source: string): Result<any[]>
```

Return every import statement in the source (i.e. `import { x } from "..."`).

  @param source - Agency source code

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<any[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L973))

### getFunctions

```ts
getFunctions(source: string): Result<any[]>
```

Return every function definition (`def foo(...) { ... }`) in the source.

  @param source - Agency source code

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<any[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L982))

### getGraphNodes

```ts
getGraphNodes(source: string): Result<any[]>
```

Return every graph node definition (`node main() { ... }`) in the source.

  @param source - Agency source code

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<any[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L991))

### filterImports

```ts
filterImports(
  source: string,
  allowedPackages: string[] = [],
  excludedPackages: string[] = [],
  allowKinds: string[] = [],
  excludeKinds: string[] = [],
): Result<{ source: string; filtered: boolean }>
```

Filter imports in Agency source code according to the given policy.
  Returns the filtered source and a boolean indicating whether any imports were dropped.

  @param source - Agency source code
  @param allowedPackages - Glob patterns; matched imports are allowed (subject to excludes)
  @param excludedPackages - Glob patterns; matched imports are dropped
  @param allowKinds - Kind strings ("stdlib" | "pkg" | "local" | "node") to allow
  @param excludeKinds - Kind strings to drop

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
  - When at least one allow list is non-empty, an import must match an allowed kind OR an allowed package glob (union across the two axes). Note that allowKinds=["stdlib"] is still a restriction even with the package lists empty, only stdlib passes.

  We format the source with the Agency formatter before returning it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| allowedPackages | `string[]` | [] |
| excludedPackages | `string[]` | [] |
| allowKinds | `string[]` | [] |
| excludeKinds | `string[]` | [] |

**Returns:** `Result<{ source: string; filtered: boolean }>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1018))

### getVersion

```ts
getVersion(): string
```

Get the current version of the Agency standard library.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1044))

### cliHandles

```ts
cliHandles(subcommand: string): boolean
```

Whether `cli` runs this agency subcommand in-process.

  @param subcommand - The first CLI argument, e.g. "test"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| subcommand | `string` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1058))

### cli

```ts
cli(args: string[], cwd: string = "."): Result<ExecResult>
```

Run an `agency <subcommand> <file>` command line through the matching function: `test` runs testFile, `typecheck`/`tc` runs typecheckFile, `ast` runs parseAST, `fmt` runs format, `run` runs runFile on node main. The result has the CLI's shape: stdout, stderr, exitCode. Anything else (a flag, another subcommand, a missing file argument) is a failure saying what the call should have been.

  @param args - The CLI arguments, subcommand first, e.g. ["test", "x.test.json"]
  @param cwd - The directory the file argument is inside

**Parameters:**

| Name | Type | Default |
|---|---|---|
| args | `string[]` |  |
| cwd | `string` | "." |

**Returns:** `Result<ExecResult>`

**Throws:** `std::read`, `std::guard`, `std::run`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1067))
