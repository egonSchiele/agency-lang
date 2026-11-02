---
name: "agency"
description: "Compile, run, inspect, and generate Agency programs."
---

# agency

Execute Agency source in a child process, inspect module exports and
  effects, or build source with AST and template helpers. Child operations
  still consult the parent's interrupt handlers.

  ```ts
  import { runCode } from "std::agency"

  node main() {
    const result = runCode("export node main() { return 42 }")
    print(result)
  }
  ```

## Types

### CompiledProgram

A compiled program returned by compile; retain the full returned value for execution.

```ts
/** A compiled program returned by compile; retain the full returned value for execution. */
export type CompiledProgram = {
  moduleId: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L81))

### AgencyModuleSource

An installed standard-library module selected by its std:: import name.

```ts
/** An installed standard-library module selected by its std:: import name. */
export type AgencyModuleSource = {
  kind: "module";
  module: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L86))

### AgencyFileSource

An Agency file whose local imports remain inside dir.

```ts
/** An Agency file whose local imports remain inside dir. */
export type AgencyFileSource = {
  kind: "file";
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L88))

### AgencyTextSource

Source text or a complete Template Agency program, optionally with a local import directory.

```ts
/** Source text or a complete Template Agency program, optionally with a local import directory. */
export type AgencyTextSource = {
  kind: "source";
  source: string | Code;
  dir?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L90))

### AgencySource

```ts
export type AgencySource =
  | AgencyModuleSource
  | AgencyFileSource
  | AgencyTextSource
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L91))

### RunOptions

Subprocess limits and working directory, with the same defaults as run.

```ts
/** Subprocess limits and working directory, with the same defaults as run. */
export type RunOptions = {
  wallClock?: number;
  memory?: number;
  ipcPayload?: number;
  stdout?: number;
  logFile?: string;
  cwd?: string;
  maxDepth?: number;
  maxCost?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L94))

### SourceLocation

```ts
export type SourceLocation = {
  line: number;
  col: number;
  start: number;
  end: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L130))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L137))

### TypeCheckReport

```ts
export type TypeCheckReport = {
  errors: TypeCheckDiagnostic[];
  warnings: TypeCheckDiagnostic[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L150))

### InterruptAnswer

```ts
export type InterruptAnswer = {
  action: "approve" | "reject";
  value?: any;
  expectedMessage?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L469))

### TestArguments

```ts
export type TestArguments = Record<string, any>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L475))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L477))

### CaseReport

```ts
export type CaseReport = {
  node: string;
  pass: boolean;
  feedback: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L486))

### TestReport

```ts
export type TestReport = {
  pass: boolean;
  cases: CaseReport[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L492))

### EffectsByExport

Per-exported-symbol effect lists, keyed by node/function name.

```ts
/** Per-exported-symbol effect lists, keyed by node/function name. */
export type EffectsByExport = Record<string, string[]>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L871))

### ExportParam

One parameter of an exported def or node.

```ts
/** One parameter of an exported def or node. */
export type ExportParam = {
  name: string;
  /** The declared type, printed the way the signature prints it. Null when none is declared. */
  type?: string;
  /** The default as Agency source, such as `0` or `null`. Null when the parameter has none. */
  default?: string;
  /** The text of the docstring's `@param` entry for this parameter, or null. */
  description?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L891))

### ExportInfo

Metadata for one public export. The signature omits export and tool
  markers. For functions and nodes, docstring holds the tool description;
  for types, it holds the doc comment.

  Effects use the names and unknown marker returned by getEffects. Types
  and constants have no effects. A re-export names the outermost module
  it came through; an unresolved re-export has unknown effects.

```ts
/** Metadata for one public export. The signature omits export and tool
  markers. For functions and nodes, docstring holds the tool description;
  for types, it holds the doc comment.

  Effects use the names and unknown marker returned by getEffects. Types
  and constants have no effects. A re-export names the outermost module
  it came through; an unresolved re-export has unknown effects. */
export type ExportInfo = {
  name: string;
  kind: "def" | "node" | "type" | "const" | "reexport";
  signature: string;
  /** The declared return type, printed on its own. Null when none is declared. */
  returnType?: string;
  /** True when a def or node returns a `Result`, with the module's own aliases resolved. */
  returnsResult: boolean;
  docstring?: string;
  effects: string[];
  destructive: boolean;
  idempotent: boolean;
  handoff: boolean;
  reexportedFrom?: string;
  /** Each parameter of a def or node; empty for every other kind, and for a re-export that cannot be read from a source string. */
  params: ExportParam[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L908))

### ModuleInfo

```ts
export type ModuleInfo = {
  description?: string;
  exports: ExportInfo[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L926))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L989))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1043))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1050))

## Effects

### std::read

```ts
@alwaysUnder(dir)
effect std::read {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L59))

### std::write

```ts
@alwaysUnder(dir)
effect std::write {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L64))

### std::run

```ts
effect std::run {
  moduleId: string;
  node: string;
  args: Record<string, any>;
  limits: { wallClock: number; memory: number; ipcPayload: number; stdout: number; maxCost: number | null };
  cwd: string;
  logFile: string;
  depth: number;
  module: string;
  function: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L68))

## Constants

### CLI_NOT_AVAILABLE

```ts
export static const CLI_NOT_AVAILABLE = "The agency command line is not available here. Use the tools instead: typecheck(source) or typecheckFile(dir, filename) for type errors; testFile(dir, filename) to run a .test.json harness (write the files it tests first); runFile(dir, filename, node) to run a program; parseAST, format, describe for source analysis."
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1263))

## Functions

### compile

```ts
compile(source: string, dir: string = "", strict: boolean = false): Result
```

Compile Agency source for a later subprocess run. Only std:: and local
  .agency imports are supported; compile-time splices are refused.

  @param dir - Resolve and confine local imports within this directory, or leave empty to disallow them.
  @param strict - Also reject unresolved names and JavaScript globals outside the sandbox allowlist.

Use `runCode` to execute source supplied by an LLM in one call. Use
  `compile` and `run` separately when Agency code can retain the full
  compiled value between calls. Compilation permits standard-library
  imports and local `.agency` files inside the given directory. It refuses
  JS/TS, Node and pkg:: imports, symlinks, and compile-time splices.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| dir | `string` | "" |
| strict | `boolean` | false |

**Returns:** `Result`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L163))

### run

```ts
run(
  compiled: CompiledProgram,
  node: string,
  args: Record<string, any> = {},
  wallClock: number | null = null,
  memory: number | null = null,
  ipcPayload: number | null = null,
  stdout: number | null = null,
  logFile: string | null = null,
  cwd: string | null = null,
  maxDepth: number | null = null,
  maxCost: number | null = null,
): Result
```

Execute a compiled Agency program in a subprocess.

  @param compiled - The complete value returned by compile, including its captured code.
  @param node - The exported entry node to execute.
  @param args - Named arguments for the entry node.
  @param wallClock - The execution time limit in milliseconds, up to one hour, or null for the default.
  @param memory - The V8 heap limit in bytes, up to 4gb, or null for the default.
  @param ipcPayload - The limit per IPC message in bytes, up to 1gb, or null for the default.
  @param stdout - The combined stdout and stderr limit in bytes, up to 100mb, or null for the default.
  @param logFile - An optional statelog JSONL destination for this child run.
  @param cwd - The child working directory, or empty to inherit the caller's process directory.
  @param maxDepth - The subprocess nesting cap, up to ten, also bounded by ancestor caps.
  @param maxCost - The child's LLM spend limit in dollars, or null for no additional cost cap.

Run a compiled program in a child process. Parent handlers and guards
  apply to the child, and supported lifecycle callbacks are forwarded.
  Streaming callbacks are not forwarded. A resource-limit failure reports
  `limit_exceeded`. Each execution segment gets its own wall-clock, memory,
  IPC, and output budget; paused time does not count. The lowest ancestor
  maxDepth remains in force.

  Success carries the subprocess result envelope, including its `data`
  value and usage information. Use `runCode` for just the node's value.

  The run interrupt's module and function labels describe a prepared call;
  they do not verify compiled code stored in a checkpoint. Use
  module-specific approval rules only with trusted saved state. External
  hosts should verify checkpoint integrity before resuming saved code; see
  [checkpoint integrity](https://github.com/egonSchiele/agency-lang/blob/main/packages/agency-lang/docs/dev/runtime/checkpoint-integrity.md).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| compiled | [CompiledProgram](#compiledprogram) |  |
| node | `string` |  |
| args | `Record<string, any>` | {} |
| wallClock | `number \| null` | null |
| memory | `number \| null` | null |
| ipcPayload | `number \| null` | null |
| stdout | `number \| null` | null |
| logFile | `string \| null` | null |
| cwd | `string \| null` | null |
| maxDepth | `number \| null` | null |
| maxCost | `number \| null` | null |

**Returns:** `Result`

**Throws:** `std::run`, `std::guard`

**Needs:** `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L192))

### runFunction

```ts
runFunction(
  source: AgencySource,
  functionName: string,
  args: Record<string, any> = {},
  options: RunOptions = {},
): Result
```

Call a public exported Agency function in a fresh subprocess.

  @param source - A std:: module, contained Agency file, or complete Agency source program.
  @param functionName - The public exported def to call, excluding nodes and handoff functions.
  @param args - Named arguments, with ordinary Agency defaults and aliases.
  @param options - Per-call resource limits, statelog destination, and working directory.

Call a public exported def without writing an entry node. The source
  can name a std:: module, a file inside a directory, or source text or
  complete Template Agency Code. Local imports must remain inside the
  directory; the same import restrictions as `compile` apply. Nodes and
  handoff functions are not supported.

  Each call starts a fresh subprocess with the parent handlers, policies,
  guards, and supported callbacks. A returned Result passes through
  unchanged; a plain value becomes a success.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | [AgencySource](#agencysource) |  |
| functionName | `string` |  |
| args | `Record<string, any>` | {} |
| options | [RunOptions](#runoptions) | {} |

**Returns:** `Result`

**Throws:** `std::run`, `std::guard`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L324))

### learn

```ts
learn(
  source: AgencySource,
  names: string[] = [],
  namespace: string = "",
  options: RunOptions = {},
): Result<any[]>
```

Create callable tools from public exported Agency functions. Module
  initialization runs during inspection and can pause or fail. The batch fails
  if any selected def is a handoff, requires a function argument, or lacks a
  concrete parameter schema.

  @param source - A std:: module, contained Agency file, or complete Agency source program.
  @param names - Public exported defs to select, or empty for all public defs.
  @param namespace - An optional prefix using letters, digits, underscores, or hyphens, keeping each full tool name within 64 characters.
  @param options - Resource limits, statelog destination, and working directory for inspection and calls.

Creates callable tools with the source functions' descriptions, schemas,
  aliases, and argument binding. Import preparation captures local source
  files, so later calls use those bytes. A namespace prefixes advertised
  names as `namespace_exportName`.

  Learning runs module initialization in a subprocess to inspect tool
  metadata. That can pause, fail, or be rejected; it does not call the
  selected bodies. Inspection and each later tool call use the normal run
  gate and parent handlers. The module and function labels follow the
  trusted-state rules documented on `run`; the inspection launch uses the
  module label with `function` set to `<inspect>`, so a module-specific
  `std::run` rule can match or refuse it.

  The whole batch fails if a selected function is a handoff, needs a
  required function argument, or lacks a concrete parameter schema. The
  returned functions are not saved or added to an agent's tool list.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | [AgencySource](#agencysource) |  |
| names | `string[]` | [] |
| namespace | `string` | "" |
| options | [RunOptions](#runoptions) | {} |

**Returns:** `Result<any[]>`

**Throws:** `std::run`, `std::guard`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L387))

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

Compile an Agency file and execute its exported node in a subprocess.
  Only std:: and contained .agency imports are supported.

  @param dir - The directory containing the file and confining its local imports.
  @param filename - A relative Agency filename that stays inside dir.
  @param node - The exported entry node to execute.
  @param args - Named arguments for the entry node.
  @param wallClock - The execution time limit in milliseconds, up to one hour.
  @param memory - The V8 heap limit in bytes, up to 4gb.
  @param ipcPayload - The limit per IPC message in bytes, up to 1gb.
  @param stdout - The combined stdout and stderr limit in bytes, up to 100mb.
  @param maxCost - The child's LLM spend limit in dollars, or null for no additional cost cap.

Compiles a file and runs its exported node through `run`, with the same
  parent handlers, guards, callbacks, and subprocess limits. Local imports
  remain within the supplied directory. The import restrictions on
  `compile` apply to the full dependency closure.

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

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L428))

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

Run test cases against an Agency file in subprocesses and report each
  case's result. Only std:: and contained .agency imports are supported.

  @param dir - The directory containing the tested file and confining local imports.
  @param filename - A relative Agency source filename that stays inside dir.
  @param cases - Exported entry nodes, named arguments, expected values, and optional scripted interrupt answers.
  @param wallClock - Milliseconds per case, overridden by a case's own wallClock value.
  @param memory - The V8 heap limit per case in bytes.
  @param ipcPayload - The byte limit per IPC message in each case.
  @param stdout - The combined stdout and stderr limit per case in bytes.
  @param maxCost - The LLM spend limit in dollars for the whole batch, or null for no additional cost cap.

Each case runs in its own child process through `run`. Parent handlers
  vote on both the launch and the tested code's interrupts. Scripted
  interrupt answers add handler votes in order; a parent rejection still
  wins. Exhausted answers let outer handlers decide. Leftover answers or
  an expected-message mismatch fail the case.

  Compilation errors fail the whole call. A failed value check, rejected
  interrupt, or per-case resource limit appears in the report and does
  not stop later cases. The cost cap covers the whole batch and returns a
  `limit_exceeded` failure when reached.

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

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L510))

### testFile

```ts
testFile(
  dir: string,
  filename: string,
  maxCost: number | null = null,
): Result<TestReport>
```

Run the test cases declared in an Agency .test.json file.

  @param dir - The directory containing the test file and its source file.
  @param filename - A relative .test.json filename that stays inside dir.
  @param maxCost - The LLM spend limit in dollars for the whole batch, or null for no additional cost cap.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |
| maxCost | `number \| null` | null |

**Returns:** `Result<TestReport>`

**Throws:** `std::read`, `std::guard`, `std::run`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L653))

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

Compile Agency source and execute an exported node in one call. Prefer
  this over separate compile and run calls. Only std:: and contained .agency
  imports are supported; splices are refused. Compile errors come back as a
  failure without running anything; fix the source and call again.

  @param node - The exported entry node to execute.
  @param args - Named arguments for the entry node.
  @param wallClock - A positive execution time limit in milliseconds, up to one hour.
  @param memory - A positive V8 heap limit in bytes, up to 4gb.
  @param ipcPayload - A positive byte limit per IPC message, up to 1gb.
  @param stdout - A positive combined stdout and stderr byte limit, up to 100mb.
  @param maxCost - The child's LLM spend limit in dollars, or null for no additional cost cap.
  @param cwd - The runtime working directory. Empty inherits the caller's process directory, which may not be where you want files; pass the agent working directory so the program's file writes land there.
  @param dir - Resolve and confine local imports within this directory, or leave empty to disallow them.

Use this when an LLM supplies source code to execute. It combines
  compilation and execution so the model does not need to copy a compiled
  program value into another call. The node's value is returned without
  the subprocess envelope.

  Parent handlers, guards, and supported callbacks apply as in `run`.
  A compile error returns a failure before execution. The full import
  closure follows `compile` restrictions. `cwd` controls runtime file
  operations; `dir` separately controls local import resolution.

  The function is unmarked because arbitrary supplied code determines
  whether retrying is appropriate. Each new attempt raises the run gate
  and the child's own effects again.

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

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L765))

### typecheck

```ts
typecheck(
  source: string,
  ignoreCodes: string[] = [],
  dir: string = "",
  strict: boolean = false,
): Result<TypeCheckReport>
```

Type-check Agency source and return errors and warnings. To check a file
  already on disk, call typecheckFile with its path instead of pasting its
  contents. A clean report does not mean compile or run will accept the code
  unless strict is true.

  @param ignoreCodes - Diagnostic codes, such as AG3009, to omit from errors and warnings.
  @param dir - Resolve relative imports within this directory, or leave empty when no local imports are needed.
  @param strict - Also report sandbox import violations, unresolved names, and disallowed JavaScript globals.

Checks source text without writing it. With a directory, relative
  imports resolve as if the source were a file there. Use `typecheckFile`
  for an existing file.

  A normal check can accept imports that subprocess compilation refuses.
  Enable strict checking to apply the sandbox import and bound-name checks
  before trying to run generated code.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| ignoreCodes | `string[]` | [] |
| dir | `string` | "" |
| strict | `boolean` | false |

**Returns:** `Result<TypeCheckReport>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L829))

### getEffects

```ts
getEffects(source: string): Result<EffectsByExport>
```

List the interrupt effects each exported function or node can raise.
  Dynamic calls can escape the analysis, so an empty list does not prove
  that execution has no effects.

Includes effects propagated through statically known calls. Bare
  interrupts appear as `unknown`. Compile-time generated code, functions
  received as parameters, and function references passed through variables
  can escape the analysis. Use this to inspect a program, with those limits
  in mind.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<EffectsByExport>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L881))

### describe

```ts
describe(
  source: string,
  dir: string = "",
  filename: string = "",
): Result<ModuleInfo>
```

Describe an Agency module's public exports, signatures, documentation,
  and statically known effects.

  @param source - Module source text matching the file exactly when a filename is supplied.
  @param dir - Supply with filename to resolve local imports within this directory.
  @param filename - The module's path relative to dir, or empty when describing source without local imports.

Use export metadata when generating code from a module, for example
  one handler per effect its tools can raise. It uses the visibility
  rules of `agency doc`: hidden and underscore-prefixed exports are
  omitted. The description is the module's one-line summary.

  For a module with local imports, supply its directory and filename along
  with the file's exact source text. The import closure is checked under
  the same restrictions as compilation. Imported source is read to compute
  metadata without a separate read interrupt. Relative re-exports remain
  entries with `unknown` effects; std:: re-exports resolve to full entries.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| dir | `string` | "" |
| filename | `string` | "" |

**Returns:** `Result<ModuleInfo>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L944))

### typecheckFile

```ts
typecheckFile(dir: string, filename: string): Result
```

Type-check an Agency file on disk.

  @param filename - A relative Agency filename that stays inside dir.

Resolves imports relative to the file's own directory. This check does
  not apply subprocess import restrictions, so a clean report can still be
  refused by `runFile`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |

**Returns:** `Result`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L967))

### parseAST

```ts
parseAST(source: string): Result<AST>
```

Parse Agency source into an abstract syntax tree.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<AST>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L995))

### writeAST

```ts
writeAST(
  ast: AST,
  dir: string,
  filename: string,
  overwrite: boolean = true,
): Result
```

Format an Agency AST as source and write it to a file.

  @param filename - A relative output filename that stays inside dir.
  @param overwrite - If false, fail when the output file already exists.

Writes the canonical formatter output, preserving comments while
  normalizing whitespace. The target must stay inside the supplied
  directory; symlinks below that directory are refused.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ast | [AST](#ast) |  |
| dir | `string` |  |
| filename | `string` |  |
| overwrite | `boolean` | true |

**Returns:** `Result`

**Throws:** `std::write`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1008))

### format

```ts
format(source: string): Result
```

Format Agency source with the standard Agency formatter.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1032))

### loadTemplate

```ts
loadTemplate(dir: string, filename: string): Result<Code>
```

Read an Agency file containing template holes.

  @param filename - A relative template filename that stays inside dir.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |

**Returns:** `Result<Code>`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1059))

### holesOf

```ts
holesOf(template: Code): HoleInfo[]
```

List the unfilled holes in an Agency code template.

Inspect remaining holes before filling a template. Each name appears
  once, in encounter order. The origin identifies the fill through which
  a grafted hole arrived when known; original holes have no origin.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| template | [Code](#code) |  |

**Returns:** `HoleInfo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1081))

### fill

```ts
fill(template: Code, values: Record<string, Json | Code>): Result<Code>
```

Fill selected holes in an Agency code template.

  @param values - Map existing hole names to literal data or Code fragments of the required kind.

Plain values become literal nodes; Code fragments are inserted as
  trees. String values are not parsed as source. A partial fill returns
  a template whose remaining holes can be filled later.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| template | [Code](#code) |  |
| values | `Record<string, Json \| Code>` |  |

**Returns:** `Result<Code>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1093))

### combine

```ts
combine(codes: Code[]): Result<Code>
```

Combine Agency code fragments in order. Whole programs cannot be mixed
  with loose statements or expressions.

Use this when generating one fragment per item, then joining the
  results. Fragments of the same kind retain that kind; expressions
  combine into a statement list. Whole programs cannot combine with
  loose expressions or statements.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| codes | `Code[]` |  |

**Returns:** `Result<Code>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1111))

### toSource

```ts
toSource(code: Code): string
```

Print Agency Code as source, preserving any unfilled template holes.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | [Code](#code) |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1119))

### parseExpr

```ts
parseExpr(source: string): Result<Code>
```

Parse exactly one Agency expression into a Code fragment for an expression hole.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<Code>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1126))

### parseStatements

```ts
parseStatements(source: string): Result<Code>
```

Parse Agency statements into a Code fragment for a statements hole.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<Code>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1133))

### formatFile

```ts
formatFile(dir: string, filename: string): Result
```

Format an Agency file in place.

  @param filename - A relative Agency filename that stays inside dir.

Read and write happen inside the same interrupt, so approving it approves both.
  If the file is already formatted, no write occurs and its mtime is preserved.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |

**Returns:** `Result`

**Throws:** `std::write`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1143))

### walkAST

```ts
walkAST(ast: AST, visitor: (node: any, ancestors: any[]) -> any): AST
```

Visit and modify nodes in a cloned Agency AST.

  @param visitor - Called with the node and its ancestors, allowing in-place edits and ignoring the return value.

Visits parents before children in a deep-cloned tree. Mutate each
  visited node in place to transform the returned clone. The original
  tree is unchanged.

  The visit list is fixed before callbacks run: added nodes are not
  visited, and replacing a child reference does not remove the old subtree
  from that list. Ancestors run from the root to the parent, excluding
  the visited node.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ast | [AST](#ast) |  |
| visitor | `(node: any, ancestors: any[]) => any` |  |

**Returns:** [AST](#ast)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1170))

### getNodesOfType

```ts
getNodesOfType(source: string, types: string[]): Result<any[]>
```

Parse Agency source and find AST nodes matching the requested kinds.

  @param types - AST discriminants such as "function", "graphNode", or "importStatement".

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| types | `string[]` |  |

**Returns:** `Result<any[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1186))

### getImports

```ts
getImports(source: string): Result<any[]>
```

Find import statements in Agency source.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<any[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1198))

### getFunctions

```ts
getFunctions(source: string): Result<any[]>
```

Find function definitions in Agency source.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<any[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1205))

### getGraphNodes

```ts
getGraphNodes(source: string): Result<any[]>
```

Find graph node definitions in Agency source.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<any[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1212))

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

Remove imports that fail the supplied allow and exclude rules. Excludes
  win; empty rule lists permit every import.

  @param allowedPackages - Import-path globs to retain, unless an exclude rule matches.
  @param excludedPackages - Import-path globs to remove even when allowed elsewhere.
  @param allowKinds - Retain imports of kind stdlib, pkg, local, or node.
  @param excludeKinds - Remove imports of these kinds even when allowed elsewhere.

Use to remove unwanted imports from generated source before further
  checking. This only filters import statements; it does not validate the
  remaining dependency closure. The returned source is formatted.

  Import kinds are stdlib for std:: paths, pkg for pkg:: paths, local for
  file paths, and node for bare Node specifiers. Package patterns use
  picomatch syntax against the original import path. Excludes always win.
  With no allow rules, remaining imports pass. Otherwise an allowed kind
  or an allowed path pattern is enough to retain an import.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| allowedPackages | `string[]` | [] |
| excludedPackages | `string[]` | [] |
| allowKinds | `string[]` | [] |
| excludeKinds | `string[]` | [] |

**Returns:** `Result<{ source: string; filtered: boolean }>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1230))

### getVersion

```ts
getVersion(): string
```

Get the current version of the Agency standard library.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1255))

### cliHandles

```ts
cliHandles(subcommand: string): boolean
```

Check whether the in-process Agency command helper supports a subcommand.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| subcommand | `string` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1267))

### cli

```ts
cli(args: string[], cwd: string = "."): Result<ExecResult>
```

Run a supported Agency file command and return stdout, stderr, and exitCode.

  @param args - Exactly a supported subcommand and filename, such as ["test", "x.test.json"].
  @param cwd - The directory containing the file argument.

Runs supported file commands through the matching functions in this
  module, without spawning an installed Agency CLI. Supports test,
  typecheck/tc, ast, fmt, and run. The run command selects node main.
  The fmt command returns formatted source without writing it back.
  Use the underlying functions when you need flags or other options.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| args | `string[]` |  |
| cwd | `string` | "." |

**Returns:** `Result<ExecResult>`

**Throws:** `std::read`, `std::guard`, `std::run`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency.agency#L1281))
