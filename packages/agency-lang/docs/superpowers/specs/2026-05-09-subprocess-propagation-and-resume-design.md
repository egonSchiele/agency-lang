# Subprocess Propagation & Resume Design

## Goal

Enable subprocess interrupts to propagate all the way to the user (the "slow path"), and allow subprocesses to resume from a checkpoint instead of starting from scratch.

## Architecture

Child and parent handlers form one unified chain — the process boundary is invisible to the semantics. The subprocess's execution state is fully serializable via checkpoints, so we can kill the child, return the interrupt to the user, and later resume in a new child process.

Split into two stages:
1. **Stage 1**: `run()` accepts a checkpoint + interrupt responses to resume a subprocess
2. **Stage 2**: Wire propagation to use Stage 1 — when propagation is needed, the child is killed and the interrupt (with checkpoint) is returned to the user

## Stage 1: Resume from Checkpoint

### API Change

`run()` in `stdlib/agency.agency` already uses named parameters (not an options object). Add optional `interrupts` and `responses` parameters:

```agency
export def run(
  compiled: CompiledProgram,
  node: string,
  args: object,
  wallClock: number = 60s,
  memory: number = 512mb,
  ipcPayload: number = 100mb,
  stdout: number = 1mb,
  interrupts: Interrupt[] = [],
  responses: InterruptResponse[] = [],
): Result {
  ...
}
```

When `interrupts` and `responses` are provided, the subprocess resumes from the checkpoint on the interrupt rather than starting fresh.

### IPC Protocol

New message type alongside `{ type: "run" }`:

```typescript
type ResumeInstruction = {
  type: "resume";
  scriptPath: string;
  interrupts: Interrupt[];
  responses: InterruptResponse[];
  ipcPayload?: number;
};
```

### Bootstrap

When the bootstrap receives a `"resume"` message, it imports the compiled module and calls `mod.respondToInterrupts(interrupts, responses)` instead of `mod[nodeName](...args)`. The compiled module's `respondToInterrupts` is already bound to its `__globalCtx` (which has the graph), so no new machinery is needed.

The resume path uses the same try/catch, error reporting, and `sendResultOrLimitError` as the existing run path.

### Parent Side (`_run` in ipc.ts)

`_run` gains `interrupts` and `responses` parameters (matching the named-params pattern). When these are non-empty, `attachSessionHandlers` sends a `"resume"` message instead of `"run"`. All resource limits, stdout forwarding, and session management apply identically to both run and resume modes.

## Stage 2: Propagation Wiring

### Handler Combining Semantics

All handlers (child + parent) form one logical chain. Rules:
- If any handler **rejects** → reject. (Child reject returns early, never reaches parent.)
- If any handler **propagates** → propagate to user.
- Otherwise, if any handler **approves** → approve.

The child already sends `subprocessVotes: { propagated: boolean }` to the parent. The parent already runs its own handlers via `interruptWithHandlers`. The missing piece is that the parent ignores `subprocessVotes.propagated`.

### Checkpoint Creation in IPC Mode

In normal (non-IPC) mode, checkpoints are created in the **generated code** after `interruptWithHandlers` returns `Interrupt[]`. But in IPC mode, `interruptWithHandlers` never returns `Interrupt[]` to the generated code — it blocks inside `sendInterruptToParent`.

Therefore, the checkpoint must be created inside `interruptWithHandlers` before calling `sendInterruptToParent`. `interruptWithHandlers` already has access to `ctx` (which has `ctx.checkpoints` and `ctx.globals`) and `stack` (the StateStack). It can call `ctx.checkpoints.create(stack, ctx)` to produce a checkpoint.

The checkpoint is then passed to `sendInterruptToParent` (which gains a `checkpoint` parameter) for inclusion in the IPC message. `sendInterruptToParent` remains a pure IPC transport function — it does not create checkpoints itself.

### Checkpoint in Interrupt Message

The child includes its checkpoint in the IPC interrupt message:

```typescript
export type IpcInterruptMessage = {
  type: "interrupt";
  interrupt: {
    kind: string;
    message: string;
    data: any;
    origin: string;
  };
  subprocessVotes: SubprocessVotes;
  checkpoint: Checkpoint;  // NEW
};
```

**Serialization note:** Node's IPC channel uses JSON serialization. The `Checkpoint` arrives at the parent as a plain object, not a class instance. The parent (or the resume path) must reconstruct it if any class methods are needed, e.g. via `Checkpoint.fromJSON()` or by treating it as plain data (since `respondToInterrupts` in the child's compiled module will handle reconstruction on the resume side).

### Parent Decision Flow (in `handleInterruptMessage`)

After the parent runs its handlers:

1. **Parent rejects** → send reject decision to child, done.
2. **Either `msg.subprocessVotes.propagated` OR parent's handlers returned `Interrupt[]`** → parent kills child (via `settleWithLimitFailure`-style kill pattern), returns `Interrupt[]` from `_run` with the subprocess checkpoint attached to the interrupt data. The parent's own execution gets checkpointed as usual by the interrupt machinery.
3. **Otherwise (approved)** → send approve decision to child, child continues.

### How `_run` Returns Interrupts

When propagation is needed, `_run` resolves its promise with `Interrupt[]` instead of a normal result value. The calling code in the compiled module detects this via `hasInterrupts()` checks (the same mechanism used for any function that can return interrupts) and propagates them up the call stack.

The `run()` function in `agency.agency` currently does `return try _run(compiled, node, args, ...)`. The `try` wrapper catches exceptions and wraps them as `failure()` Results, but interrupt arrays are not exceptions — they are return values that propagate through the normal `hasInterrupts` check before reaching the `try` wrapper.

### Temp File Cleanup

When propagation occurs, the compiled temp files must survive — the resume will need them. The `cleanupTempDir` call in `settle()` must be skipped when the session settles due to propagation. Cleanup happens on final completion or error only.

### Resume After Propagation

When the user responds to the propagated interrupt, the parent's execution resumes and calls `run()` again with the checkpoint + responses. This forks a new subprocess in resume mode (Stage 1), which picks up where the killed child left off.

## Files Changed

| File | Stage | Change |
|------|-------|--------|
| `stdlib/agency.agency` | 1 | Add `interrupts`/`responses` params to `run()` |
| `lib/runtime/ipc.ts` — `_run` | 1, 2 | Add `interrupts`/`responses` params; send resume message when provided; `handleInterruptMessage` checks `subprocessVotes.propagated`; returns interrupts on propagation |
| `lib/runtime/ipc.ts` — types | 1, 2 | Add `ResumeInstruction`; add `checkpoint` to `IpcInterruptMessage` |
| `lib/runtime/ipc.ts` — `attachSessionHandlers` | 1 | Send `"resume"` or `"run"` based on whether interrupts/responses are provided |
| `lib/runtime/ipc.ts` — `settle`/cleanup | 2 | Skip temp file cleanup on propagation |
| `lib/runtime/subprocess-bootstrap.ts` | 1 | Handle `"resume"` message type, call `mod.respondToInterrupts` |
| `lib/runtime/interrupts.ts` | 2 | Create checkpoint in `interruptWithHandlers` before IPC send; pass checkpoint to `sendInterruptToParent` (new parameter) |

## What This Does NOT Cover

- Timeout / AbortSignal integration (separate feature)
- Nested subprocess execution (blocked by design)
- Debugger / trace integration across process boundary
