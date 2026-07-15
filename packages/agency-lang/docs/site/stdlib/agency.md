---
name: "agency"
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L59))

### SourceLocation

```ts
export type SourceLocation = {
  line: number;
  col: number;
  start: number;
  end: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L63))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L70))

### TypeCheckReport

```ts
export type TypeCheckReport = {
  errors: TypeCheckDiagnostic[];
  warnings: TypeCheckDiagnostic[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L83))

### EffectsByExport

Per-exported-symbol effect lists, keyed by node/function name.

```ts
/** Per-exported-symbol effect lists, keyed by node/function name. */
export type EffectsByExport = Record<string, string[]>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L359))

### Feedback

One review finding. `error: true` means the code is broken (parse or
type error, or the reviewer judged it does not do the task); `error:
false` is advisory feedback, including typecheck warnings.

```ts
/** One review finding. `error: true` means the code is broken (parse or
type error, or the reviewer judged it does not do the task); `error:
false` is advisory feedback, including typecheck warnings. */
export type Feedback = {
  error: boolean;
  feedback: string;
  data?: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L377))

### WriteFailure

The failure payload writeAgency returns on retry exhaustion: the last
generated source and its typecheck diagnostics.

```ts
/** The failure payload writeAgency returns on retry exhaustion: the last
generated source and its typecheck diagnostics. */
export type WriteFailure = {
  source: string;
  errors: TypeCheckDiagnostic[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L586))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L737))

## Effects

### std::read

```ts
effect std::read {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L41))

### std::write

```ts
effect std::write {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L45))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L49))

## Functions

### compile

```ts
compile(source: string): Result
```

Compile Agency source code. Returns a CompiledProgram on success, or a failure with compilation errors. Only standard library (`std::`) imports are allowed in the compiled code.

  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L88))

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

**Throws:** `std::run`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L108))

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
  Only standard-library (`std::`) imports are allowed in the file.

  @param dir - The directory containing the file
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

**Throws:** `std::run`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L208))

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
): Result
```

Compile Agency source code and execute one of its nodes in a subprocess,
  returning the value the node returned. Prefer this over separate
  compile() and run() calls. Only standard-library (`std::`) imports are
  allowed in the source. Compile errors are returned as a failure without
  running anything; fix the source and call again.

  @param source - Agency source code as a string
  @param node - Which exported node to run (default "main")
  @param args - Arguments to pass to the node
  @param wallClock - Max wall-clock time in MILLISECONDS before SIGKILL (default 60000 = 60s, max 3600000 = 1h). Pass null for the default.
  @param memory - Max V8 heap size in BYTES (default 536870912 = 512mb, max 4294967296 = 4gb). Pass null for the default.
  @param ipcPayload - Max single IPC message size in BYTES (default 104857600 = 100mb, max 1073741824 = 1gb). Pass null for the default.
  @param stdout - Max combined stdout+stderr output in BYTES (default 1048576 = 1mb, max 104857600 = 100mb). Pass null for the default.
  @param maxCost - Max subprocess LLM spend in dollars (e.g. 0.50). null = no cost limit.
  @param cwd - Working directory for the subprocess. Empty inherits the caller's process cwd (which may be the package dir, not where you want files); pass the agent working directory so the generated program's file writes land there.

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

**Returns:** `Result`

**Throws:** `std::run`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L288))

### typecheck

```ts
typecheck(source: string): Result<TypeCheckReport>
```

Type-check Agency source code.

  @param source - Agency source code as a string

Unlike some of the other functions in this module,
`typecheck` does not restrict imports to the standard library only.
Relative imports (./foo.agency) cannot be resolved from a source string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<TypeCheckReport>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L349))

### getEffects

```ts
getEffects(source: string): Result<EffectsByExport>
```

Map each exported node and function in the source to the list of
  interrupt effects it can raise, transitively. Bare `interrupt(...)`
  sites appear as the sentinel "unknown", so the envelope never
  silently under-reports. Use this to show or check what a program can
  do before running it.

  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<EffectsByExport>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L361))

### mergeFeedback

```ts
mergeFeedback(a: Result<Feedback[]>, b: Result<Feedback[]>): Result<Feedback[]>
```

Merge two feedback Results by concatenating their success arrays or
  returning the first failure.

  @param a - First feedback Result
  @param b - Second feedback Result

**Parameters:**

| Name | Type | Default |
|---|---|---|
| a | `Result<Feedback[]>` |  |
| b | `Result<Feedback[]>` |  |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L383))

### review

```ts
review(source: string, task: string = ""): Result<Feedback[]>
```

Review Agency source code. Always merges parse and typecheck findings;
  when a task description is given, an LLM pass also judges whether the
  code accomplishes the task.

  @param source - Agency source code as a string
  @param task - Optional description of what the code should do

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| task | `string` | "" |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L454))

### renderFeedback

```ts
renderFeedback(feedback: Result<Feedback[]>): string
```

Render a feedback Result as human-readable text, one line per finding.

  @param feedback - The Result review() returned

**Parameters:**

| Name | Type | Default |
|---|---|---|
| feedback | `Result<Feedback[]>` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L485))

### feedbackHasErrors

```ts
feedbackHasErrors(feedback: Result<Feedback[]>): boolean
```

True when any finding is an error, or when the feedback Result itself
  is a failure.

  @param feedback - The Result review() returned

**Parameters:**

| Name | Type | Default |
|---|---|---|
| feedback | `Result<Feedback[]>` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L497))

### failOpenFeedback

```ts
failOpenFeedback(r: Result<Feedback[]>): Result<Feedback[]>
```

Pass a successful feedback list through unchanged; map any failure to
  no findings. Used to make verification fail open. A verifier that could
  not run reports nothing rather than a blocking error.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| r | `Result<Feedback[]>` |  |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L514))

### syntaxHintFor

```ts
syntaxHintFor(errors: string): string
```

A specific syntax reminder to inject next to a diagnostic, or "" when no
  known pattern matches. Point-of-need guidance: the rule lands better delivered
  alongside the error than buried in the system prompt. Matches on the actual
  diagnostic wording the compiler emits, not on the user's source.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| errors | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L525))

### verify

```ts
verify(task: string): Result<Feedback[]>
```

Reconstruct a task's success criteria, run the produced artifact against
  them, and return findings. `error: true` marks an unmet criterion (strict
  on the output contract); `error: false` a satisfied one. Fails open (empty
  success) if verification cannot run, so it never blocks.

  @param task - The original task description to verify against.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L568))

### writeAgency

```ts
writeAgency(
  task: string,
  context: string = "",
  maxAttempts: number = 3,
): Result<string, WriteFailure>
```

Generate Agency source code for a task description. Typechecks each
  attempt and feeds diagnostics back to the model, up to maxAttempts
  tries. Success holds source that compiles and typechecks; on retry
  exhaustion the failure holds { source, errors } for the last attempt.

  @param task - What the generated program should do
  @param context - Optional extra material (available data, examples)
  @param maxAttempts - Max generation attempts before giving up (default 3)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` | "" |
| maxAttempts | `number` | 3 |

**Returns:** `Result<string, WriteFailure>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L649))

### typecheckFile

```ts
typecheckFile(dir: string, filename: string): Result
```

Type-check an Agency file on disk. The file is read from dir/filename,
  with relative imports inside it resolved against the file's directory.

  @param dir - The directory containing the file
  @param filename - The agency file to type-check

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |

**Returns:** `Result`

**Throws:** `std::read`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L717))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L743))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L755))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L777))

### formatFile

```ts
formatFile(dir: string, filename: string): Result
```

Format an Agency file in place using the standard Agency formatter.

  @param dir - The directory containing the file
  @param filename - The agency file to format

Read and write happen inside the same interrupt, so approving it approves both.
  If the file is already formatted, no write occurs and its mtime is preserved.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |

**Returns:** `Result`

**Throws:** `std::write`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L788))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L807))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L827))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L837))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L846))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L855))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L882))

### getVersion

```ts
getVersion(): string
```

Get the current version of the Agency standard library.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L908))
