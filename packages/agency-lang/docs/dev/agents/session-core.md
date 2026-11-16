# The shared session core and handoff (SPIKE)

A spike on branch `spike/remote-agent`, not to be merged as is. The question
it answers: can one agent session move between different front-ends (the
terminal and an app such as Perry) and back, through a checkpoint?

It can, if every front-end runs the same small **session core**.

## Why the core is needed

A checkpoint resumes only in the same code. More exactly, only the modules
with a **live frame on the saved stack** are fingerprinted (see
`docs/dev/runtime/checkpoint-code-fingerprints.md`). A module the paused run
merely imports can differ, or change while the session is paused.

A saved `agency agent` session is pinned to `agent.agency`, `turn.agency`,
`repl.agency` and `std::ui/cli`. Those modules are the whole terminal
front-end. An app with different code could never resume it.

So the core makes sure that, at every pause, the stack holds only code both
front-ends share:

```
terminal front-end (core.agency)   ──setup──► goto agentSession(...) ─┐
Perry front-end (perry.agency)     ──setup──► goto agentSession(...) ─┤
                                                                      ▼
                   std::agents/session: loop { raise agentSession::userMessage
                                               agencyAgent(message)
                                               emit agentSession.reply }
```

`goto` is a permanent transition. The front-end's node has returned, and
none of its frames are on the stack.

## The core: `stdlib/agents/session.agency`

`agentSession(cwd, model, provider)` does the following:

1. It sets the run's LLM options and the agent's working folder.
2. It loops, and each pass:
   - raises `agentSession::userMessage`, which a front-end answers with
     `approve(text)`,
   - runs `agencyAgent`,
   - emits `agentSession.reply` or `agentSession.error`.

A budget stop is handled inside the core, the way `agency agent` handles it.
Every other effect propagates to the front-end's policy and then to the front-end.

**Where a session can pause:**

- **At the message pause.** The stack holds only `stdlib/agents/session.agency`.
- **At an approval mid-turn.** The stack holds the core plus the stdlib
  modules running the turn, so both sides need the same agency-lang build.
  This was tested in Perry's experiments (`experiments/handoff/real`): a read
  approval raised in one program was approved in another.

## Rules for anything that must survive a handoff

- **It lives in the core**: its arguments, its globals, the threads and the
  run's LLM options. A front-end's own globals do not come along.
- **Only data crosses.** A function value travels by name and module. A
  front-end that hands the core its own function, such as an MCP tool, breaks
  the other side:

  > Function "terminalOnlyTool" from module "frontA.agency" crossed a
  > serialization boundary into a process that never loaded its module, and
  > was invoked there.

  So presets, MCP servers and settings must reach the core as data. Each
  front-end then turns that data back into code after a resume.
- **A person answers outside the core.** The core never prompts at a
  terminal. Everything a person decides raises out of it, and the front-end
  answers.
- **Process-level setup runs in every front-end.** `disableMemory`, MCP
  connections and the like are set up again by each process before it
  resumes.

## The terminal front-end: `agency agent --core`

- **`lib/agents/agency-agent/core.agency`** is the front-end's Agency side:
  its setup (memory off), then `goto agentSession`.
- **`lib/cli/coreAgent.ts`** is the driver. It runs the program and answers
  the core's interrupts at the terminal:
  - the message pause, with a `readline` line,
  - each approval, with y/n.

  It uses the `recommended` policy, with the message pause pinned to
  `propagate`.
- **`/handoff`** writes the paused session to a handoff file and exits.
- **`--handoff <file>`** picks a handed-off session up and replays its
  transcript.
- **`lib/cli/agent.ts`** routes `agency agent --core` here.

It is a bare loop. Slash commands, presets, MCP, history, Esc-to-cancel and
the status line are not there. Moving them over is the real work: each one
becomes front-end setup, or data passed into the core.

## The handoff file: `lib/cli/handoffFile.ts`

Plain JSON, mode 0600, so a front-end in any language can read it.

| Field | What it holds |
| --- | --- |
| `version`, `core` | `1`, and `"std::agents/session"` |
| `cwd`, `model`, `provider` | The core's arguments, so the next front-end can show them |
| `from`, `createdAt` | Where it came from, for display |
| `interrupts` | The paused session: the interrupts, each with its checkpoint (about 9 KB at a message pause) |
| `transcript` | `{ role, text }[]`, the history to show |

`agency agent --core` writes to `~/.agency/handoffs/`, or to
`AGENCY_HANDOFF_DIR`. Perry's engine picks files up from there. Going the
other way, Perry writes into its own folder and shows the
`agency agent --core --handoff <file>` command.

## What the spike found in agency-lang

- **ADI-320: a fresh process that only resumes never initializes statics.**
  The next turn then fails with "Tried to read static `COORDINATOR_PROMPT`
  before its initializer ran". Both front-ends work around it by starting one
  throwaway run first.
- **Importing a node from `std::` emitted an unresolvable import.**
  `typescriptBuilder.preprocess` built the graph import as
  `agencyFile.replace(".agency", ".js")`. That left `std::agents/session`
  as is, and Node can't load it. The spike sends `std::` paths through
  `toCompiledImportPath`. This needs its own fix and a test.
- **Resume callbacks given in two places are both called.**
  `respondToInterrupts` takes `callbacks` at the top level and still reads
  `metadata.callbacks`. A caller that passes both gets every event twice.
- **`lib/stdlib/stdlibModules.data.ts`** is regenerated with the new module
  (`make generated-data`).

## Files

| File | Job |
| --- | --- |
| `stdlib/agents/session.agency` | The shared core |
| `lib/agents/agency-agent/core.agency` | The terminal front-end's setup and `goto` |
| `lib/cli/coreAgent.ts` | The terminal driver: prompts, approvals, `/handoff`, `--handoff` |
| `lib/cli/handoffFile.ts` | The handoff file: type, read, write |
| `lib/cli/agent.ts` | Routes `--core` |
| `lib/backends/typescriptBuilder.ts` | The `std::` node-import path fix |
