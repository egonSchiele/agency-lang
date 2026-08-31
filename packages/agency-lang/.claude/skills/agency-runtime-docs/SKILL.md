---
name: agency-runtime-docs
description: Developer docs for the Agency runtime: the execution engine, interrupts and how a program resumes mid-block, concurrent interrupts, checkpointing, rewind, traces, threads, async calls, global state, guards and saveDraft, locks, subprocess IPC, and AgencyConfig. Use when changing how compiled Agency programs execute.
---

# Runtime developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/runtime/simplemachine.md` — The graph execution engine that runs compiled Agency programs.
- `docs/dev/runtime/interrupts.md` — How a program resumes in the middle of a block after an interrupt, using step counters.
- `docs/dev/runtime/concurrent-interrupts.md` — What happens when several concurrent execution paths interrupt at the same time.
- `docs/dev/runtime/runBatch.md` — The one primitive that owns concurrent-interrupt orchestration for forks, parallel blocks, tool calls, and subprocesses.
- `docs/dev/runtime/checkpoint-integrity.md` — The optional HMAC checksum embedded in a checkpoint, and how a host verifies it.
- `docs/dev/runtime/checkpointing.md` — Snapshotting execution state so a program can restore back to it later.
- `docs/dev/runtime/rewind.md` — Replaying execution from a checkpoint, optionally with different values for its local variables.
- `docs/dev/runtime/trace.md` — Execution traces: a checkpoint per step, written to a file the debugger can replay.
- `docs/dev/runtime/threads.md` — How LLM conversation history accumulates and flows through thread and subthread blocks.
- `docs/dev/runtime/globalstore.md` — Module-namespaced storage for top-level variables at runtime.
- `docs/dev/runtime/async.md` — How async function calls work, and the problems the design solves.
- `docs/dev/runtime/async-behavior-checklist.md` — The case-by-case behavioral checklist the async implementation was built against.
- `docs/dev/runtime/async-context.md` — The async-context frame that carries runtime state, and how stdlib TypeScript helpers read it.
- `docs/dev/runtime/callback-hooks.md` — Registering callbacks for runtime events such as node, function, and tool lifecycle.
- `docs/dev/runtime/saveDraft.md` — How a scope's best-so-far value survives a guard trip instead of being lost.
- `docs/dev/runtime/lock.md` — A per-run mutex for serializing access to shared resources such as the terminal prompt.
- `docs/dev/runtime/subprocess-ipc.md` — How an agent compiles and runs Agency code in a subprocess, and how the parent's handler chain extends across that boundary.
- `docs/dev/runtime/config.md` — Every `AgencyConfig` option, with types and defaults, and how config is resolved.
