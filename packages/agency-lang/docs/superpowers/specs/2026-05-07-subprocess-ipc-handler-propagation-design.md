# Subprocess IPC + Handler Propagation: Design Spec

## Overview

Give Agency agents the ability to write Agency code and execute it in a subprocess, with the parent process's handler chain extending across the process boundary. The subprocess cannot escape the parent's safety constraints.

This is the foundation for "agents writing agents" — agent-generated code is structured, typed, and verifiable, constrained by the same handler safety chain as the parent.

## Motivation

Today, agents operate within a fixed program. They can call tools, make LLM requests, and follow control flow, but they can't create new structured behavior at runtime. Giving agents the ability to write and execute Agency code lets them create structured, typed, verifiable plans instead of relying purely on probabilistic LLM reasoning.

This is analogous to structured output: just as schemas constrain LLM data output to be more reliable, Agency code constrains agent planning to be more structured and verifiable.

The critical safety property: the parent's handlers wrap the subprocess. If the parent has a handler that rejects file deletions, the subprocess cannot delete files — even if the agent writes `return approve()` in the generated code. The "any reject wins" rule extends across the process boundary.

## API

### Import

```
import { compile, run } from "std::agency"
```

Follows the existing stdlib pattern. The backing implementation lives in `stdlib/agency.agency` importing from `stdlib/lib/agency.ts`.

### compile()

```
const compiled = compile(source)
```

- **Input**: `source: string` — Agency source code
- **Output**: `Result<CompiledProgram>` — on success, an opaque `CompiledProgram` value; on failure, compilation errors (syntax errors, type errors)
- **Behavior**: Compiles the Agency source through the standard pipeline (parse, symbol table, compilation unit, TypeScript preprocessor, TypeScript builder, print). Writes the compiled JavaScript to a temp file (using `os.tmpdir()` and a nanoID-based filename). The `CompiledProgram` contains the path to this temp file.
- **Restrictions on generated code**: Local imports are not supported (no relative paths). Only stdlib imports (`std::`) and npm package imports are allowed. This is both a security constraint and a practical one (generated code has no meaningful filesystem location for relative imports).
- **Module ID**: Auto-generated using nanoID. The generated code doesn't need a meaningful module ID since it has no filesystem identity.

### run()

```
const result = run(compiled, { node: "main", args: { query: "hello" } })
```

- **Input**:
  - `compiled: CompiledProgram` — output of `compile()`
  - `options: { node: string, args: object }` — which node to execute and what arguments to pass
- **Output**: `Result<RunNodeResult>` — same shape as calling a node from TypeScript. On success, contains:
  - `data` — the node's return value
  - `messages` — the thread store (conversation history) as JSON
  - `tokens` — token usage stats (input, output, cached)
- **Behavior**:
  1. Triggers an interrupt before launching the subprocess (running agent-generated code is a dangerous operation)
  2. If approved, forks the compiled script as a Node.js child process with IPC enabled
  3. Manages the IPC protocol (interrupt propagation, handler votes, approve/reject decisions)
  4. Cleans up the temp file when execution completes
  5. Returns the subprocess's result wrapped in a `Result`

### Example usage

```
import { compile, run } from "std::agency"

node main() {
  const source = llm("Write an Agency program that greets the user by name", {
    // LLM generates Agency source code
  })

  const compiled = compile(source)
  if (isFailure(compiled)) {
    print("Compilation failed: " + compiled.error)
    return failure(compiled.error)
  }

  // Parent's handler applies to the subprocess
  handle {
    const result = run(compiled, { node: "main", args: { name: "Alice" } })
    if (isSuccess(result)) {
      return result.value.data
    }
    return result.error
  } with (data) {
    // This handler sees ALL interrupts from the subprocess
    if (data.kind == "std::bash") {
      return reject()
    }
    return approve()
  }
}
```

## Subprocess Communication

### Transport: Node IPC

Communication between parent and subprocess uses Node's built-in IPC channel. The parent spawns the subprocess with `fork()`, which automatically creates a bidirectional IPC channel separate from stdin/stdout/stderr.

- **IPC channel**: Structured JSON messages via `process.send()` / `process.on('message')`
- **stdout**: Stays clean for `print()` output — subprocess print calls appear in the parent's stdout
- **stderr**: Flows through normally for error output

This avoids the need for message framing, multiplexing, or protocol parsing. Node handles serialization automatically.

Interrupt handling is strictly serialized: the subprocess sends one interrupt at a time and blocks until the parent responds with a decision. There is no pipelining of multiple interrupt requests.

### IPC mode

The subprocess runtime knows it's in IPC mode via the `AGENCY_IPC=1` environment variable. When this is set, the runtime replaces the normal interrupt handling behavior:

- **Normal mode**: Unhandled interrupts are returned to the TypeScript caller as `Interrupt[]` objects
- **IPC mode**: Interrupts (including handler votes from subprocess handlers) are sent to the parent over IPC, and the subprocess awaits the parent's decision before resuming or aborting

### Message protocol

**Subprocess to parent:**

```typescript
// Interrupt occurred — subprocess handlers have voted, parent's turn
{
  type: "interrupt",
  interrupt: {
    kind: string,      // e.g. "std::bash", "std::read"
    message: string,   // human-readable description
    data: any,         // interrupt payload
    origin: string,    // module origin
  },
  subprocessVotes: {
    approved: boolean,   // did any subprocess handler approve?
    rejected: boolean,   // did any subprocess handler reject? (note: if true, this message is informational only — the subprocess already short-circuited)
    propagated: boolean, // did any subprocess handler propagate?
    approvedValue: any,  // value from the last (outermost) approving subprocess handler, matching single-process semantics
  }
}

// Execution completed successfully
{
  type: "result",
  value: RunNodeResult  // { data, messages, tokens }
}

// Execution failed
{
  type: "error",
  error: string
}
```

**Parent to subprocess:**

```typescript
// Handler decision (always a final approve or reject — never propagate)
{
  type: "decision",
  approved: boolean,
  value: any  // resolve value if approved with data
}
```

When the combined handler result is "propagate to user," the parent pauses and presents the interrupt to its own caller (the TypeScript code, or the user via the CLI). The subprocess remains blocked on IPC until the parent receives the user's final decision. The parent then sends the resolved approve or reject decision to the subprocess. From the subprocess's perspective, it only ever sees a final approve or reject — never propagate.

## Handler Propagation

### Core principle

All handlers across all processes form one unified chain. The process boundary is invisible to handler semantics. Subprocess handlers are innermost; parent handlers are outermost.

### Flow

1. Subprocess code hits an interrupt (e.g., `bash("rm -rf /")`)
2. Subprocess runs `interruptWithHandlers` against its own `ctx.handlers`
3. **Exception**: If a subprocess handler **rejected**, the interrupt is rejected immediately (reject is final and short-circuits, matching current semantics). The subprocess does not consult the parent. It notifies the parent that a rejection occurred, but the parent cannot override it.
4. **Otherwise** (subprocess handlers approved, propagated, or didn't respond), the interrupt data and subprocess handler votes are sent to the parent over IPC. The subprocess blocks until it receives a decision.
5. Parent receives the interrupt and runs it through its own `ctx.handlers`
6. Combined result across all handlers follows the standard rules:
   - If any handler (subprocess or parent) rejected: **rejected**
   - If any handler (subprocess or parent) propagated: **propagate to user** (propagate beats approve, matching current single-process semantics)
   - If all handlers approved: **approved**
   - If no handler responded: **propagate to user**
7. If the combined result is "propagate to user," the parent presents the interrupt to the user (or returns it as an `Interrupt[]` to its TypeScript caller) and waits for the user's decision. The subprocess remains blocked on IPC during this time.
8. Parent sends the final decision (always approve or reject, never propagate) back to the subprocess over IPC
9. Subprocess resumes (if approved) or aborts (if rejected)

### Why subprocess approval doesn't short-circuit

In the current single-process model, if all handlers approve, the interrupt is approved and never reaches the TypeScript caller. But in the subprocess model, the parent's handlers must also get a chance to vote. A subprocess handler approving is just one vote — the parent's handler can still reject.

This ensures the safety property: a parent that rejects file deletions will always reject them, regardless of what the subprocess's own handlers say.

### Example

```
// Parent code
handle {
  run(compiled, { node: "main", args: {} })
} with (data) {
  if (data.kind == "std::remove") {
    return reject()  // Parent rejects all file deletions
  }
  return approve()
}
```

```
// Subprocess code (agent-generated)
import { remove } from "std::fs"
import { bash } from "std::shell"

node main() {
  handle {
    remove("/tmp/file.txt")
    bash("echo done")
  } with (data) {
    return approve()  // Subprocess approves everything
  }
}
```

When `remove("/tmp/file.txt")` fires:
1. Subprocess handler approves
2. Interrupt + votes sent to parent
3. Parent handler sees `kind == "std::remove"` and rejects
4. Result: **rejected** (any reject wins)
5. `remove()` returns a failure in the subprocess

When `bash("echo done")` fires:
1. Subprocess handler approves
2. Interrupt + votes sent to parent
3. Parent handler approves
4. Result: **approved** (all approved)
5. `bash()` proceeds

## Implementation Details

### Subprocess lifecycle

1. Parent calls `run(compiled, options)`
2. `run()` triggers its own interrupt (`std::run` kind) — "Are you sure you want to run agent-generated code?"
3. If approved, parent forks the compiled JS file: `fork(compiledPath, [], { stdio: ['pipe', 'inherit', 'inherit', 'ipc'], env: { ...process.env, AGENCY_IPC: '1' } })`
   - `stdin`: pipe (for potential future use)
   - `stdout`: inherit (print output flows to parent's stdout)
   - `stderr`: inherit (error output flows to parent's stderr)
   - Fourth fd: IPC channel
   - The subprocess inherits the parent's full environment (`...process.env`), including API keys (`OPENAI_API_KEY`, etc.) and configuration. No additional env var forwarding is needed beyond setting `AGENCY_IPC`.
4. Subprocess executes the specified node with the provided args
5. On interrupt: IPC exchange as described above
6. On completion: subprocess sends `{ type: "result", value: RunNodeResult }` and exits
7. On error: subprocess sends `{ type: "error", error: string }` and exits
8. On crash (subprocess exits without sending a message): parent detects the `close`/`exit` event, returns a failure with the exit code and any stderr output
9. Parent receives the result (or detects abnormal exit), cleans up the temp file, returns `Result<RunNodeResult>`

The parent monitors both the IPC `message` event and the subprocess `close`/`exit` event. If the subprocess exits abnormally (segfault, uncaught exception before IPC setup, OOM kill) without sending a `result` or `error` message, `run()` returns a failure.

### Cleanup

- Temp files are deleted when `run()` completes (success or failure)
- If the parent process crashes or is cancelled, the subprocess receives SIGHUP and terminates
- The parent's `AbortSignal` (from Agency's cancellation system) should kill the subprocess if the parent agent is cancelled
- Timeout: `run()` should support an optional timeout parameter. If the subprocess doesn't complete within the timeout, it's killed and `run()` returns a failure.

### Runtime changes

The runtime needs a new code path for IPC mode. When `AGENCY_IPC=1` is set:

1. At startup, the subprocess runtime reads this env var
2. The `interruptWithHandlers` function (or a wrapper) changes behavior:
   - Instead of returning `Interrupt[]` to the caller when unhandled, it sends the interrupt over IPC and awaits a response
   - Even when handlers approve, it sends the interrupt + votes to the parent and awaits final decision
   - Only when a local handler rejects does it short-circuit without consulting the parent
3. The subprocess's entry point sends the final `RunNodeResult` back over IPC when the node completes

### Stdlib implementation

`stdlib/agency.agency`:

```
import { _compile, _run } from "./lib/agency.js"

// Opaque type — users should not depend on internal fields.
// The path field is an implementation detail (temp file location).
type CompiledProgram = {
  moduleId: string
}

export def compile(source: string): Result {
  """
  Compile Agency source code. Returns a CompiledProgram on success, or a failure with compilation errors.
  @param source - Agency source code as a string
  """
  return try _compile(source)
}

export def run(compiled: CompiledProgram, options: { node: string, args: object }): Result {
  """
  Execute a compiled Agency program in a subprocess. The parent's handler chain extends to the subprocess. Returns the subprocess node's result on success.
  @param compiled - A CompiledProgram from compile()
  @param options - Which node to run and what arguments to pass
  """
  return interrupt std::run("Are you sure you want to run this agent-generated code?", {
    moduleId: compiled.moduleId,
    node: options.node,
    args: options.args
  })

  return try _run(compiled, options)
}
```

`stdlib/lib/agency.ts` contains the TypeScript implementation:
- `_compile(source)`: Runs the Agency compilation pipeline in-process, writes compiled JS to a temp file, returns `{ path, moduleId }`
- `_run(compiled, options)`: Forks the compiled JS with IPC, manages the interrupt protocol, returns `RunNodeResult`

### Dependencies

- Refactoring `lib/cli/commands.ts` to extract the compilation pipeline into a reusable function that doesn't call `process.exit` or `console.log`
- New IPC-mode code path in the runtime's interrupt handling
- New `stdlib/agency.agency` and `stdlib/lib/agency.ts` files

## Isolation and State

- **Message history**: Isolated. The subprocess gets its own empty `ThreadStore`. If the parent wants to pass conversation context, it passes it as a node argument, and the subprocess uses it in LLM calls via the `messages` option.
- **Global state**: Isolated. Each subprocess execution gets its own global state, same as any node call.
- **Handlers**: The subprocess has its own `ctx.handlers` stack. These are the innermost handlers. The parent's handlers are consulted via IPC and are the outermost handlers.
- **Checkpoints**: The subprocess has its own checkpoint store. Checkpoint/restore within the subprocess works normally. The parent cannot restore into a subprocess checkpoint (and vice versa).

## Not in MVP Scope

- **In-memory execution**: Always write to temp file. In-memory execution (via `vm` module or dynamic import) can be added later.
- **Hot-reload / self-modification (Model B)**: Agent rewriting its own code and restarting. Requires static analysis infrastructure to be safe. Separate future feature.
- **Nesting**: A subprocess spawning its own subprocess. Works in principle (handlers chain transitively), but not implemented in MVP. When `AGENCY_IPC=1` is set, calling `run()` immediately returns a failure: "Nested subprocess execution is not supported." The `compile()` function still works normally in a subprocess.
- **Debugger integration**: Stepping into subprocess code from the parent's debugger. Future work — initially, the debugger just sees `run()` as an opaque step with inputs and outputs.
- **Policy checking on generated code**: Declarative rules about what generated code can/can't do, enforced at compile time. Separate idea with its own spec.
- **Handler coverage analysis**: Static check that generated code handles all interrupts. Separate idea.
- **Dry-run execution**: Execute generated code with mocked tools first. Separate idea.
- **Guards integration**: Budget/timeout limits applying across subprocess boundary. Depends on the guards feature being implemented first.

## Unplanned/Unplanned

Issues discovered during implementation that the spec and plan did not anticipate. Each entry includes what was learned and where to look for more context.

### 1. stdlib cannot import from `lib/` due to separate tsconfig compilation units

**The problem:** `tsconfig.stdlib.json` has `rootDir: "./stdlib"` and `outDir: "./stdlib"`, meaning stdlib TypeScript files compile in-place (e.g., `stdlib/lib/agency.ts` → `stdlib/lib/agency.js`). The main tsconfig compiles `lib/**/*.ts` into `dist/lib/`. These are separate compilation units with different output trees, so a relative import like `import { foo } from "../../lib/runtime/ipc.js"` in `stdlib/lib/agency.ts` resolves to `lib/runtime/ipc.js` at runtime — which doesn't exist (the compiled JS is at `dist/lib/runtime/ipc.js`).

**What we did:** For `_compile`, we added a `"./compiler"` package export in `package.json` so stdlib could `import { compileSource } from "agency-lang/compiler"`. When this problem recurred for the bootstrap script path, we generalized to a catch-all `"./internal/*": "./dist/lib/*"` export so stdlib can import anything from `lib/` via `import { ... } from "agency-lang/internal/..."`. This scales without adding per-feature exports.

**Current state:** The `./internal/*` catch-all export is in `package.json`. The `./compiler` per-feature export also remains (it was shipped in PR #112). Both work. Future stdlib backing code should use `agency-lang/internal/...` to import from `lib/`.

**Where to look:**
- `tsconfig.stdlib.json` — stdlib compilation config
- `tsconfig.json` — main compilation config (rootDir `.`, outDir `./dist`)
- `package.json` `"exports"` field — all package exports including `./internal/*`
- `stdlib/lib/agency.ts` — the stdlib backing file that needs these imports
- PR #112 — the original `./compiler` export and discussion of this problem

### 2. Bootstrap script path resolution across build output trees

**The problem:** The subprocess bootstrap script (`lib/runtime/subprocess-bootstrap.ts`) compiles to `dist/lib/runtime/subprocess-bootstrap.js`. But `stdlib/lib/agency.ts` compiles to `stdlib/lib/agency.js` (in-place). At runtime, resolving the bootstrap path relative to the stdlib file (`resolve(__dirname, "../../lib/runtime/subprocess-bootstrap.js")`) yields `lib/runtime/subprocess-bootstrap.js` — the TypeScript source, not the compiled JS in `dist/`.

**What we did:** Used the `./internal/*` catch-all export (from issue #1 above). The `ipc.ts` module exports a `subprocessBootstrapPath` constant computed via `path.join(__dirname, "subprocess-bootstrap.js")` — since `ipc.ts` and `subprocess-bootstrap.ts` are in the same directory (`lib/runtime/`), the relative path works within that compilation unit. Then `stdlib/lib/agency.ts` imports it: `import { subprocessBootstrapPath } from "agency-lang/internal/runtime/ipc.js"`.

**Current state:** This approach works but is partially implemented — the `subprocessBootstrapPath` export was added to `ipc.ts` and the import was added to `stdlib/lib/agency.ts`, but the full build/test cycle hasn't been completed yet.

**Where to look:**
- `lib/runtime/ipc.ts` — exports `subprocessBootstrapPath`
- `lib/runtime/subprocess-bootstrap.ts` — the bootstrap entry point that gets forked
- `stdlib/lib/agency.ts` — imports the bootstrap path
- `package.json` `"exports"` field — the `./internal/*` catch-all

### 3. Stdlib backing functions cannot receive RuntimeContext (`ctx`)

**The problem:** `_run()` needs access to the parent's `RuntimeContext` (`ctx`) to call `interruptWithHandlers()` on incoming subprocess interrupts. But raw TypeScript functions imported in `.agency` files do not receive the runtime state parameter.

The call chain: Agency code `return try _run(compiled, options)` generates `__call(_run, { type: "positional", args: [compiled, options] }, { ctx, threads, stateStack })`. The `__call` function in `lib/runtime/call.ts` checks if the target is an `AgencyFunction` — if yes, it passes `state` as the last argument via `AgencyFunction.invoke()`. If the target is a raw function (like `_run`), it calls `target(...descriptor.args)` and **drops the state entirely** (line 24 of `call.ts`).

**What we learned:** The codebase already has a pattern for functions that need `ctx`: `checkpoint`, `getCheckpoint`, and `restore` in `lib/runtime/checkpoint.ts`. These are:
1. Imported with an alias in the imports template (`checkpoint as __checkpoint_impl`)
2. Wrapped as `AgencyFunction` instances at module init (`__AgencyFunction.create({ fn: __checkpoint_impl, params: [...] })`)
3. This wrapping makes `AgencyFunction.invoke()` pass `state` (including `ctx`) as the last argument

The challenge is that this wrapping happens in `lib/templates/backends/typescriptGenerator/imports.mustache`, which is included in **every** compiled module. It's hardcoded for those three specific runtime functions. There's no general mechanism for stdlib backing functions to opt into receiving state.

**Options considered but not yet decided:**
- **Apply the same AgencyFunction wrapping pattern** — Move `_run` to `lib/runtime/`, export from `agency-lang/runtime`, add wrapping to `imports.mustache`. Works mechanically but mixes stdlib and runtime concerns, and doesn't scale to future stdlib functions that need ctx.
- **Pass state to all raw functions in `__call`** — Change line 24 of `call.ts` to `target(...descriptor.args, state)`. JS functions ignore extra arguments. Simple but leaky — every raw function silently receives internal runtime state. Rejected as too broad.
- **AsyncLocalStorage** — Store execution-specific `RuntimeContext` in Node's `AsyncLocalStorage` during `runNode()`. Any function can call `getExecutionContext()` to access it. Standard Node.js pattern, solves the problem for all future functions. But it's a new pattern for the codebase and adds implicit state.
- **Teach the compiler to wrap specific backing imports** — A naming convention or annotation that tells the compiler "this imported function needs state, wrap it as AgencyFunction." Most principled long-term solution but requires compiler work.

**Current state:** Unresolved. This is the primary blocker for Task A.

**Where to look:**
- `lib/runtime/call.ts` — `__call()` function, line 24 is where state is dropped for raw functions
- `lib/runtime/agencyFunction.ts` — `AgencyFunction.invoke()` (line 96-104) shows how state is passed as last arg
- `lib/runtime/checkpoint.ts` — example of functions that receive `__state: InternalFunctionState` as last param
- `lib/templates/backends/typescriptGenerator/imports.mustache` — lines 12, 66-68 show the import aliasing and AgencyFunction wrapping pattern
- `lib/runtime/types.ts` — `InternalFunctionState` type definition (has `ctx`, `threads`, `stateStack`, `moduleId`, `scopeName`, `stepPath`)
- Compiled output `stdlib/agency.js` — line ~331 shows `__call(_run, { type: "positional", args: [...] }, { ctx: __ctx, ... })` — the state IS available at the call site, it's just not forwarded

### 4. The AgencyFunction wrapping pattern is hardcoded in the imports template

**The problem:** The imports template (`imports.mustache`) is the only place where raw functions get wrapped as `AgencyFunction` instances to receive state. It's a hardcoded list: `checkpoint`, `getCheckpoint`, `restore`. There's no mechanism for a stdlib author to say "this backing function needs runtime context."

This is a subset of issue #3 but worth calling out separately because it reveals an architectural gap: the compiler has no concept of "state-aware backing functions." All backing functions (functions imported from `.ts` files in `.agency` code) are treated as raw functions that take only their declared parameters.

**What we learned:** The wrapping happens at module initialization time, not at call time. The imports template generates code like:
```typescript
import { checkpoint as __checkpoint_impl } from "agency-lang/runtime";
const checkpoint = __AgencyFunction.create({ name: "checkpoint", fn: __checkpoint_impl, params: [...] }, __toolRegistry);
```
This runs once when the module loads. At call time, `__call(checkpoint, descriptor, state)` sees an `AgencyFunction` and routes through `invoke()`, which appends `state`.

For stdlib functions defined with `def` in `.agency` files (like `run`), the compiler automatically generates an `AgencyFunction` wrapper (see `stdlib/agency.js` line ~378: `const run = __AgencyFunction.create({ fn: __run_impl, ... })`). The issue is only with **imported backing functions** called from within those `def` functions.

**Where to look:**
- `lib/templates/backends/typescriptGenerator/imports.mustache` — the template with hardcoded wrapping
- `lib/templates/backends/typescriptGenerator/imports.ts` — the compiled template
- `lib/backends/typescriptBuilder.ts` — the builder that renders this template (search for `runtimeContextCode`)
- `stdlib/agency.js` — generated output showing how Agency `def` functions ARE wrapped but their imported backing functions are NOT

### 5. Type mismatch: `compile()` returns `Result` but `run()` expects `CompiledProgram`

**The problem:** In Agency code, `compile(source)` returns `Result` (because the function body uses `return try _compile(source)`, which wraps the return in a `Result`). But `run(compiled, options)` declares its first parameter as `CompiledProgram`. When the user writes `run(compiled, ...)` where `compiled` is the return value of `compile()`, the type checker warns: "Argument type 'Result' is not assignable to parameter type 'CompiledProgram'".

The user is expected to check `isSuccess(compiled)` first, which narrows the type to the success value (`CompiledProgram`). But Agency's type narrowing may not be sophisticated enough to track this through if-blocks (needs investigation).

**What we learned:** This is a minor ergonomic issue — the warning appears but doesn't block execution. The actual runtime value works fine because `compiled` is indeed a `CompiledProgram` after the `isSuccess` check. But it signals that either:
- Agency's type narrowing doesn't propagate through if/return control flow
- Or the `Result` type needs special handling in the type checker for this pattern

**Where to look:**
- `stdlib/agency.agency` — the `compile()` and `run()` function signatures
- `lib/typeChecker/` — type checker implementation, specifically narrowing logic
- `tests/agency/subprocess/run-basic.agency` — test file that triggers the warning
- `docs/dev/typechecker.md` — type checker documentation
