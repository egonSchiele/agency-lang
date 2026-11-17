# Agents talking to agents: what we are trying to do, and the options so far

Date: 2026-11-14. Status: a discussion record. Nothing here is built, and
there is no spec yet.

This file records a design conversation that started on 2026-11-12, during
the review of the background jobs PR (#1454). It says what we want, every
option we looked at, what each one costs, what has been decided, and what
is still open. It is written so that someone who was not in the
conversation can pick the design up from here.

## What we are trying to do

Agency has no way for a running program to exchange messages with anything
outside itself, apart from interrupts. We want one. The uses we have in
mind, roughly from nearest to furthest:

1. An agent and the subagents it starts.
2. Two agents running on the same machine, such as two `agency agent`
   sessions in two terminals that hand work to each other.
3. A local agent and an always-on agent running in the cloud.
4. An agent and a tool built to be shared by an agent and a person, such
   as the logs viewer and the `tv` table viewer. The agent pushes data to
   the tool, and the person's actions in the tool reach the agent.
5. Background jobs, which today have their own hand-built notification
   pieces.

The idea began with the "inputs" in Martha Wells's Murderbot Diaries: a
set of feeds the character holds, reads when it chooses, and notices when
one drops.

**The first case we will design is number 2: two agents in two terminals
that hand work to each other.**

## The two constraints every option has to meet

### A program can save itself and exit

An Agency program can serialize its whole execution state into a
checkpoint, exit, and resume later at the same line, possibly in another
process. This is how interrupts reach a person. See
`docs/dev/runtime/checkpointing.md` and `docs/dev/runtime/interrupts.md`.

Two things follow:

- A live connection, such as a process or a socket, cannot be saved. What
  can be saved is a name for it. The job table already works this way: the
  program holds the string `job-3fa9c1`, and the table that maps it to a
  process is a field on `RuntimeContext` that is never put in a checkpoint.
- The other side may send a message when no process is running to receive
  it. Something has to hold the message, or wake the program.

### Every run is isolated

When a node is called from TypeScript, each call is a separate run with
its own copy of every global variable. A hundred concurrent requests get a
hundred isolated runs. See `docs/site/guide/state-isolation.md` and
`docs/site/guide/global-vs-static.md`.

So "the remote agent" is not one thing. It is any number of runs at once.
A design in which a run holds shared messages cannot work, because each
run would hold its own private copy.

## The options we considered

### Option 1: Unix-style signals

A signal interrupts a process at an arbitrary point and runs a handler.

- For: familiar from Unix.
- Against: interrupting at an arbitrary point is the one thing a
  serializable program cannot allow. Signals are also the part of Unix
  that people most regret.

Set aside early. The better Unix pattern is the file descriptor: the
program holds a small number, the kernel holds the table, and the program
reads when it chooses.

### Option 2: A mailbox per agent (the Erlang actor model)

Each agent has one inbox. Anyone can send to it. Reading removes the
message, and only the owner reads.

- For: the simplest to explain. Natural for two arms of one run.
- Against: one reader only, so no broadcast. A reply has no type. It has
  no answer for many concurrent runs of one agent.

### Option 3: A shared log with a read position per reader (the Kafka model)

An input is an append-only list. Writers append. Each reader keeps only a
number, which is how far it has read. A third party holds the list:
neither the writer nor the reader.

- For:
  - Many readers each see every message.
  - A message is never "in flight" between two checkpoints. It is in the
    list, and a reader's checkpoint holds a number.
  - `restore()` moves the number back and loses nothing.
  - Moving the list from memory to a file or a server changes nothing for
    the program.
- Against:
  - The most concepts. Once many runs of one agent read the same input,
    the position has to belong to a named reader instead of a run, which
    is Kafka's consumer group. A store outside every run is needed too.
  - The owner found it confusing, and users likely would as well.
  - A reader can see a message twice after a restore. The owner said this
    is acceptable when each message has an id.

Kafka delivers by pull. A reader asks for everything after its position,
and the broker holds the request open until a message arrives or a time
limit passes. A program that saved itself and exited cannot pull, so its
host would have to pull for it and resume it.

Shelved, not rejected. It may come back for the "tool that talks back"
case and for broadcast.

### Option 4: Function calls

Each agent says which functions it exposes, and other agents call them.
This is the shape of a REST API and of MCP.

- For:
  - Types come free. An exported function already has a checked signature,
    and `agency serve` already publishes it at `/list`.
  - Isolation comes free. One call is one run. A shared `foodOrders`
    mailbox becomes a `placeOrder(order)` function.
  - Interrupts already travel this way. `agency serve http` hands a paused
    run's interrupts to the caller, and `/resume` continues it.
  - The handler chain can cross the call, as it already does for a
    subprocess (`docs/dev/runtime/subprocess-ipc.md`).
- Against:
  - Long work: a call that takes forty minutes blocks the caller unless
    the caller gets a handle it can poll.
  - The callee cannot speak first. A cloud agent cannot call a laptop.
  - No broadcast.
  - Arms of one run cannot exchange messages mid-flight.

**This is the model we chose.**

## Which wire carries the calls

### MCP

- For:
  - Reach. An Agency agent could call any MCP server, and any MCP client
    could call an Agency agent. With a custom protocol the only things on
    the other end are Agency programs, and Agency has one user today.
  - Authorization, discovery, and schemas are already designed.
  - Both ends exist: `agency serve mcp` and the `mcp()` client in
    `packages/mcp`.
  - Better MCP support in `agency agent` is wanted anyway.
- Against:
  - It was built for a model calling a tool, not for two peers.
  - It cannot carry checkpoints, effects, or a crossing handler chain
    without squeezing them into the fields it allows.
  - The spec moves. The 2026-07-28 revision removed sessions and the
    startup handshake, moved tasks to an extension, replaced
    server-initiated requests with a result of type `input_required`, and
    deprecated sampling.
  - It is heavy for an agent talking to its own subagent, or for two
    agents on one machine.

Facts checked on 2026-11-14:

- `agency serve mcp` answers interrupts from a stored policy
  (`lib/serve/mcp/interruptLoop.ts`) and does not hand them to the caller.
- `packages/mcp` has `@modelcontextprotocol/sdk` 1.29.0 installed, which
  speaks the 2025-11-25 revision. The newest SDK was 1.32.2. Whether it
  supports the 2026-07-28 revision was not checked.
- `mcp()` returns tools for `llm()`. Calling a remote function directly
  from Agency code with static types would need generated stubs.

### Agent2Agent (A2A)

A newer standard made for agents calling agents. Version 1.0. It has an
Agent Card for discovery, tasks with states that include "input required",
streaming, and webhooks.

- For: it has the pieces MCP lacks for peers, and its "input required"
  state matches an Agency interrupt.
- Against: a second protocol to implement, and heavier than we need. We
  could not judge how widely it is used from what we read.

Left for later.

### Our own protocol

Agency already has one: the four routes of `agency serve http`, which are
`/list`, `/functions/:name`, `/nodes/:name`, and `/resume`.

- For: it carries Agency's features exactly, it is small, and it changes
  when we decide.
- Against: Agency only. We would design per-caller identity, long work,
  and callbacks ourselves, and two agents are not enough use to find the
  mistakes.

### Where this landed

Design the messages once and vary what carries them. The four HTTP routes
amount to four messages: list the functions, call one, hand back
interrupts, resume with answers.

| Distance | Carrier |
| --- | --- |
| Same process | None. A direct function call |
| Child process | Node's built-in channel, which `run()` uses today |
| Same machine | A Unix socket |
| Another machine | HTTP, which exists |
| Anything that is not Agency | MCP, as a translation of the same messages |

Start with something simple and local, see how it works, and then extend
to HTTP and MCP. Build each later feature on MCP first, and add it to the
HTTP routes only when the MCP version loses something that matters.

Useful existing pieces:

- Every running Agency program already listens on a private Unix socket
  under `~/.agency/debug-sessions`, for `agency debug --attach`. The
  directory is readable only by the same user.
- The debugger's attach feature has a `Channel` type (`send`, `onMessage`,
  `onClose`, `close`) and a schema for every message
  (`lib/debugger/attach/`).
- `lib/serve/` has one core shared by the HTTP and MCP servers, and a
  policy store.

## Decisions made so far

1. The model is function calls, not mailboxes or logs.
2. Types are checked with Agency's own type and schema machinery. From
   prior art we take lessons and plain formats, such as JSON and JSON
   Schema, and no broker as a dependency.
3. A send or call between arms of the same program raises no effect,
   because nothing leaves the program.
4. A send or call that leaves the process raises an effect, with the
   destination in its data, so a handler or a policy can allow one
   destination and reject another. Example, with invented names:

   ```agency
   handle {
     send(cloudInbox, report)
   } with (intr) {
     if (intr.effect == "std::send" && intr.data.to.startsWith("https://agents.example.com/")) {
       return approve()
     }
     return reject()
   }
   ```

5. What an agent receives from another agent is untrusted text. It never
   carries authority. Whatever the receiver does next still raises through
   its own handlers.
6. An always-on agent does not have to be served by `agency serve`. A
   TypeScript web server with a compiled agent behind it must work too. A
   process that never exits is the simplest always-on agent.
7. The logic lives in one module in `lib/runtime/`. Agency stdlib
   functions and the `agency.*` TypeScript helpers are thin layers over
   it. Host code, which runs outside any run, gets plain functions that
   take their dependencies as arguments, because `agency.*` throws when no
   run is current.
8. The jobs PR was merged without waiting for this design. Its follow-ups
   are in ADI-295.

## Ideas worth keeping

- **A callback resumes a run. It does not start one.** If agent A asks B
  for long work and B calls back later, isolation means the callback lands
  in a new run of A. The fix is for A's waiting run to raise an interrupt
  that means "waiting for B's result" and save itself. B's callback is the
  answer to that interrupt, and A's host resumes the run with it. The
  answer needs a one-time token so only B can resume that run.
- **A long remote call looks like a job.** Start it, get an id, poll or
  wait, stop it. That is the shape of `startJob` and `jobOutput`, and of
  an A2A task.
- **Permissions are per-caller policies.** "I gave ART access to X but not
  to Y" has three layers: which functions a caller can see, what a call
  from that caller may do, and who may answer an interrupt the call
  raises. A policy is already a data file of approved effects. Today the
  serve code has one API key and one policy for every caller.
- **A remote caller's approval must not count by default.** In a
  subprocess the parent's approval counts, because the parent owns the
  child. A remote caller is a stranger. It may reject, and it may supply
  input that was asked for. Its approval counts only where the callee's
  own policy says this caller may decide.
- **A tool that talks back.** The logs viewer and `tv` are like tool calls
  where the tool can also speak first. That maps onto two channels per
  session: commands from the agent, and events from the tool. Saved for
  later. This is where an event feed, and possibly the log from option 3,
  would earn its place.
- **Reaching a laptop.** A cloud agent cannot call a laptop. The laptop
  polls, or holds a request open.

## Update, later on 2026-11-14: a better first case

We set the two-terminals case aside. It had no concrete use, and designing
it raised more questions than it answered (lifetime, startup order, which
handlers govern an incoming call). A look at what people use several
agents for found fan-out of independent work, read-only helpers such as
reviewers, and steering one session from a phone. It found almost nothing
on agents handing work to each other across machines with no person in
between.

The owner then pointed out a case that has a real user: item 1 of ADI-295.
`agency test` and `agency run` cannot run as background jobs.

How it works today: `safeBash("agency test x.test.json")` never starts the
`agency` program. `cli()` in `stdlib/agency.agency` turns the line into a
call to `testFile`, `typecheckFile`, or `runFile`. Those start the code in
a child process and stay connected to it, and each interrupt the child
raises is sent to the parent's handlers
(`docs/dev/runtime/subprocess-ipc.md`). The parent waits for the whole
run.

What we want: the child keeps running after the call returns, and its
interrupts still reach the agent.

Why this is the agent-to-agent problem in its smallest form:

- A named, long-lived other party: the child, held in the job table.
- Messages both ways: the child asks, the parent answers, and the child
  reports its result.
- The other party speaks first: the child raises an interrupt when the
  parent is doing something else.
- It leaves out the hard parts we had no use for. There is no discovery,
  no stranger to distrust (the parent owns the child, so its approval
  counts, as it does today), one machine, and a protocol that exists.

The one new question it forces is the same one the two-terminals case
forced: who answers when the parent is not waiting in the call? The
handlers inside the turn that started the child are gone by then. The
answer has to be the session's own handlers, at a defined point such as
the prompt or a turn boundary. It must not be whatever handlers happen to
be in force where the main code is, because a `with approve` around some
unrelated call could then approve the child's request by accident.

A child whose question nobody answers can save a checkpoint and exit, as
a subprocess already does, and show in the jobs list as blocked with its
question.

## Background children: what we worked out

The scope is a parent that starts and controls its own child processes.
Talking to a separate process is out, because it adds discovery and a way
to intercept its interrupts.

**It is possible.** In `lib/runtime/ipc.ts` a subprocess call is a session
object (`RunSession`) with event listeners for the child's messages, plus
a promise the caller awaits. The listeners work whether or not anyone
awaits. Backgrounding means keeping the session, in the job table, and
returning at once.

**What the waiting call does today that a background child must replace:**

- The child's output is forwarded to the parent's terminal. Collect it as
  the job's output instead.
- The caller's cancel signal kills the child. Give the child its own stop
  signal, as shell jobs have.
- The wall-clock limit defaults to 60 seconds, with a hard ceiling of one
  hour (`LIMIT_CEILINGS`). Shell jobs allow twelve hours. Paused time does
  not count.
- The result is returned to the caller. It becomes the job's report.
- A paused child's checkpoint is kept in the caller's frame. Keep it on
  the job.

**How a child's interrupt is answered.** This follows the handler rules in
`docs/site/guide/handlers.md`: any reject rejects, otherwise any propagate
goes to the user, otherwise an approve approves, and if every handler
passes it goes to the user.

1. The child's own handlers run first. A reject there is final.
2. The parent's handlers run next. Handlers are code. A model never
   answers an interrupt.
3. If no handler settled it, the child saves a checkpoint and exits, as a
   subprocess does today. The job becomes blocked.
4. The UI tells the user. The user answers through the normal approval
   prompt, and a fresh child resumes from the checkpoint.

The model is not told about a blocked job with a message of its own. The
job's state is already in the report `jobOutput` returns, and in the one
line the jobs message has for a running job. The only thing the model's
side needs is that a `jobOutput` wait on a blocked job returns at once.

**Which parent handlers answer.** A handler applies only inside the branch
that registered it (`inSiblingBranch` in `lib/runtime/interrupts.ts`). A
forwarded interrupt is raised on the stack `run()` was called on. So a
handler in a sibling branch, such as another tool call, never hears it.
But today the stack that called `run()` is waiting, so no new handler can
appear on it or above it. With a background child that stack carries on,
and a handler registered later on it or on an ancestor would be consulted.
`gatherChainOutcome` takes an `eligible` filter. A background child should
pass one that admits only the handlers registered when it started. If one
of those has since been removed, the child would be running with fewer
handlers than it started with, and it should be stopped.

**What a child can run, checked on 2026-11-14 with `learn` in a child
process:**

- `reviewAgent` from `std::agents/review` loads and is offered. A reviewer
  as a background child looks close.
- `codingAgent` from `std::agents/coding` fails with "Export 'codingAgent'
  is a handoff function, which is not supported". A coder as a child needs
  an entry point that is a plain `def`.

A subagent in a child cannot see the parent's state, so what it needs is
passed as arguments, and a function value such as `extraTools` cannot be
passed at all.

## Open questions

1. For two local agents, how does one find the other? The debug sessions
   directory is a starting point.
2. Does the user tell an agent to hand work over, or can an agent decide
   to? The repo's rule is that the harness decides and the model does not
   get an optional tool it may ignore.
3. What does the receiving terminal show when work arrives, and what does
   its user approve?
4. Under whose policy does handed-over work run? The decision above says
   the callee's.
5. How does the result come back: does the caller wait in the call, or
   get a handle?
6. What does `restore()` do to a job's read position? This is item 3 in
   ADI-295, and any event feed will need the same answer.
7. Is "input" still the right name for anything in the language, now that
   the model is function calls?

## Sources

- MCP specification changelog, 2026-07-28:
  https://modelcontextprotocol.io/specification/2026-07-28/changelog
- A2A protocol specification, v1.0:
  https://a2a-protocol.org/latest/specification/
- The full conversation is in the Claude Code transcript
  `~/.claude/projects/-Users-adityabhargava-agency-lang-packages-agency-lang/2a3e02c5-6b62-499c-b2de-a7adc0a6f2cc.jsonl`.
