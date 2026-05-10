# Subprocess IPC — How agents run agents

## Overview

Agency agents can compile and execute Agency code at runtime in a subprocess. The parent process's handler chain extends across the process boundary — a parent handler that rejects file deletions will reject them in the subprocess too, even if the subprocess has its own handler that approves.

The user-facing API is two functions in `std::agency`:
- `compile(source)` — compile Agency source code, returns a `Result<CompiledProgram>`
- `run(compiled, { node, args })` — execute a compiled program in a subprocess, returns a `Result`

## Architecture

```
Parent process                          Child process
┌─────────────────────┐                ┌─────────────────────┐
│ Agency code calls   │                │ subprocess-bootstrap │
│ run(compiled, opts) │                │ receives "run" msg   │
│         │           │    fork()      │ imports compiled .js  │
│    _run() in ipc.ts ├───────────────►│ calls node function   │
│         │           │                │         │             │
│         │◄──────────┼── interrupt ───┤  interruptWithHandlers│
│  interruptWithHandlers               │  (IPC mode: sends to │
│  runs parent handlers│                │   parent, awaits     │
│         │           │                │   decision)           │
│         ├───────────┼── decision ───►│         │             │
│         │           │                │  resumes or aborts    │
│         │◄──────────┼── result ──────┤  sends result back    │
│  returns result     │                │  exits                │
└─────────────────────┘                └─────────────────────────┘
```

Communication uses Node's built-in IPC channel (`child_process.fork()`). Stdout/stderr flow through normally for `print()` output.

## Key files

| File | Role |
|------|------|
| `lib/runtime/ipc.ts` | IPC types, `sendInterruptToParent()`, `_run()` (parent-side IPC manager), debug logger |
| `lib/runtime/subprocess-bootstrap.ts` | Entry point forked by `_run()`. Receives run instruction, imports compiled script, calls node, sends result back. |
| `lib/runtime/interrupts.ts` | `interruptWithHandlers()` — has IPC-mode branch that sends interrupts to parent instead of returning `Interrupt[]` |
| `lib/stdlib/agency.ts` | `_compile()` — runs the compilation pipeline, writes compiled JS to `.agency-tmp/` |
| `stdlib/agency.agency` | User-facing `compile()` and `run()` functions |
| `lib/templates/backends/typescriptGenerator/imports.mustache` | `_run` AgencyFunction wrapping (lines 12, 69) |

## How `_run` receives RuntimeContext

`_run` needs `ctx` to call `interruptWithHandlers()` on incoming subprocess interrupts. But stdlib backing functions are raw TypeScript — `__call()` in `call.ts` drops runtime state for non-AgencyFunction targets.

The solution: `_run` is wrapped as an `AgencyFunction` in the imports template, following the same pattern as `checkpoint`, `getCheckpoint`, and `restore`:

```typescript
// imports.mustache
import { _run as __runtime_run_impl } from "agency-lang/runtime";
const _run = __AgencyFunction.create({
  name: "_run", module: "__runtime", fn: __runtime_run_impl,
  params: [{ name: "compiled", ... }, { name: "options", ... }],
  toolDefinition: null
}, __toolRegistry);
```

When generated code calls `__call(_run, descriptor, state)`, `__call` sees an `AgencyFunction`, routes through `invoke()`, which appends `state` as the last argument. `_run` receives `__state: InternalFunctionState` and extracts `ctx` from it.

## How interrupts propagate across the process boundary

### Normal mode (no IPC)

`interruptWithHandlers()` runs the local handler chain. If no handler resolves, it returns `Interrupt[]` to the caller.

### IPC mode (`AGENCY_IPC=1`)

When `AGENCY_IPC=1` is set (the parent sets this env var when forking), `interruptWithHandlers()` changes behavior:

1. Run local (subprocess) handlers as normal
2. If a local handler **rejects** → short-circuit, don't consult parent (reject is final)
3. Otherwise → call `sendInterruptToParent()` with the interrupt data and local handler votes
4. `sendInterruptToParent()` sends the interrupt over IPC and blocks (awaits a Promise) until the parent responds
5. Return the parent's decision (always approve or reject, never propagate)

On the parent side, `_run()` receives the interrupt message and calls `interruptWithHandlers()` on its own `ctx`. The parent's handlers vote, and the result is sent back as a decision message.

### The handler chain rules (same as single-process)

- If **any** handler (subprocess or parent) rejects → **rejected**
- If **any** handler propagates → **propagate to user** (MVP: falls back to reject)
- If all handlers approve → **approved**
- If no handler responds → **propagate to user**

### Message protocol

**Subprocess → Parent:**
```typescript
{ type: "interrupt", interrupt: { kind, message, data, origin }, subprocessVotes: { approved, rejected, propagated, approvedValue } }
{ type: "result", value: { data, messages, tokens } }
{ type: "error", error: string }
```

**Parent → Subprocess:**
```typescript
{ type: "run", scriptPath, node, args }       // startup instruction
{ type: "decision", approved: boolean, value } // interrupt response
```

## How compiled code gets executed in the subprocess

1. `_compile()` runs the Agency compilation pipeline (parse → symbol table → compilation unit → TypeScript → esbuild transpile)
2. The compiled JS is written to `.agency-tmp/<nanoid>/<moduleId>.js` under `cwd`
3. `_run()` forks `subprocess-bootstrap.js` with `AGENCY_IPC=1`
4. The bootstrap receives a `{ type: "run" }` message, dynamically imports the compiled script via `pathToFileURL()`, finds the node function, reads `__<nodeName>NodeParams` for argument ordering, and calls the node
5. The node runs normally — any interrupts go through the IPC-mode path in `interruptWithHandlers()`
6. When the node completes, the bootstrap sends `{ type: "result" }` and exits
7. `_run()` receives the result, cleans up the temp directory, and resolves

### Why `.agency-tmp/` instead of `/tmp/`

Compiled Agency code imports from `agency-lang/runtime`, `agency-lang/stdlib/*`, etc. Node resolves packages relative to the importing file's location. If the compiled code lives in `/tmp/`, there's no `node_modules` to resolve against. Writing to `.agency-tmp/` under `cwd` ensures the project's `node_modules` is accessible.

### Import restrictions

`compile()` sets `restrictImports: true`, which rejects relative imports (`./`, `../`). Only `std::` stdlib imports and npm package imports are allowed in generated code. This is both a security constraint (generated code can't reach into the host filesystem) and a practical one (generated code has no meaningful filesystem location for relative imports).

## The `std::run` interrupt gate

`run()` throws a `std::run` interrupt before executing the subprocess:

```
return interrupt std::run("Running agent-generated code in subprocess", { ... })
return try _run(compiled, options)
```

Running agent-generated code is a dangerous operation. The caller must either have a handler that approves `std::run`, or the interrupt propagates to the user for approval.

## Debugging

Set `AGENCY_IPC_DEBUG=1` to log every IPC message to stderr:

```
AGENCY_IPC_DEBUG=1 pnpm run agency run myagent.agency
```

Output:
```
[ipc:parent] 22:24:16.703 send run node=main script=.agency-tmp/.../compiled.js
[ipc:child]  22:24:16.742 recv run node=main script=...
[ipc:child]  22:24:16.730 send interrupt kind=std::bash
[ipc:parent] 22:24:16.730 recv interrupt kind=std::bash
[ipc:parent] 22:24:16.730 send decision approved=true
[ipc:child]  22:24:16.732 recv decision approved=true
[ipc:child]  22:24:16.750 send result data=42
[ipc:parent] 22:24:16.750 recv result data=42
```

Uses `process.stderr.write()` which is synchronous — no flushing issues.

## MVP limitations

These are explicitly out of scope for the initial implementation:

- **Slow-path propagation**: When the combined handler result is "propagate to user," the MVP rejects instead of serializing the subprocess and waiting for user input. Full slow-path requires subprocess checkpoint serialization + resume.
- **Nested subprocesses**: A subprocess calling `run()` immediately fails with "Nested subprocess execution is not supported." Handlers would chain transitively in principle, but it adds complexity.
- **Timeout and AbortSignal**: No timeout on subprocess execution. No integration with the parent's cancellation system.
- **Debugger/trace integration**: The debugger sees `run()` as an opaque step. No stepping into subprocess code.
- **Child propagation votes**: The parent currently ignores `subprocessVotes` when combining handler decisions. This matters for the propagate case (propagate should beat approve), but is moot since the slow path isn't implemented.

## Tests

Tests live in `tests/agency/subprocess/` (agency execution tests) and `tests/agency-js/subprocess-no-handler/` (JS integration test).

| Test | What it verifies |
|------|-----------------|
| `compile-only` | `compile()` succeeds for valid source |
| `compile-failure` | `compile()` returns failure for invalid syntax |
| `run-basic` | Compile + run returns subprocess result |
| `run-with-args` | Arguments pass through to subprocess node |
| `run-multiple-interrupts` | IPC loop handles multiple interrupt round-trips |
| `run-crash` | Runtime error in subprocess returns failure |
| `run-abnormal-exit` | `process.exit()` without IPC message returns failure |
| `handler-approve` | Parent approves subprocess interrupt |
| `handler-reject` | Parent rejects subprocess interrupt (subprocess has no local handler) |
| `nested-blocked` | Subprocess calling `run()` fails immediately |
| `subprocess-no-handler` (agency-js) | `run()` without handler returns `std::run` interrupt to caller |
