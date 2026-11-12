# Idea: background shells and subagents for the Agency agent

**Status:** ideas, not a design. One part has a spec: `docs/superpowers/specs/2026-11-11-background-jobs.md`.

Paths are relative to `packages/agency-lang`.

## Where this came from

We have been comparing `agency agent` with Pi on SWE-bench. Each comparison starts containers on Daytona, runs both agents in them, and takes most of an hour. Claude Code ran those comparisons. It started each long command in a background shell, kept working, and looked at the output every few minutes.

`agency agent` cannot do that job. It has two gaps:

1. **It cannot start a command and keep working.** Its shell tools wait for the command to end. Since #1448 they also stop a command after 120 seconds unless the model asks for longer.
2. **It cannot start a subagent and keep working.** A subagent is a function call, and the caller waits for it.

This doc collects the ideas for closing both gaps. It covers what other agents do, what Agency already has, and each idea with the problems we know about.

## What other agents do

### Pi

Pi has neither feature. Its README says it "skips features like sub-agents and plan mode". Its bash tool waits for the command.

Pi ships subagents as an example extension, in `~/pi/packages/coding-agent/examples/extensions/subagent/`. The extension starts one Pi process per subagent:

```
pi --mode json -p --no-session
```

It reads the events that process prints and shows them as they arrive. Several subagents can run at once. The tool call still waits until all of them finish.

### Crush

Crush has both features.

**Shells.** The bash tool takes `run_in_background`. A command that runs longer than a minute moves to the background on its own. Two more tools manage a job: `job_output` returns what the job has printed, and `job_kill` stops it. `job_output` takes `wait=true` to block until the job ends. The tool description tells the model not to call `job_output` right after starting a job.

**Subagents.** `agent_dispatch` starts a subagent and returns at once with a label. `agent_send` delivers a message to a subagent. `agent_stop` stops one, and `agent_status` lists them. When a subagent finishes, its report arrives in the parent's conversation as a `<subagent-report>` message. If the parent has ended its turn, the report starts a new turn. Crush calls this waking the parent.

Three details are worth copying or avoiding:

- A subagent call that waits moves to the background after 60 seconds, the same way a shell command does.
- Every result that leaves a subagent running ends with a sentence telling the model not to sleep or poll, because the report will arrive without that. The comment in `agent_dispatch.go` says models otherwise poll `agent_status` until the report lands.
- A subagent that was running when Crush quit is reported as "interrupted" on the next start. Crush cannot continue it.

Crush is a full-screen terminal program, so it can redraw any part of the screen. We did not trace how a background subagent's permission prompt reaches the user.

## What Agency has today

Each row is something that exists and that one of the ideas below could build on.

| What | Where | What it does |
| --- | --- | --- |
| Parallel tool calls | `PromptRunner.parallel`, `docs/dev/agents/promptRunner.md` | When the model asks for several tools in one round, they run at the same time. Two `codeAgent` calls in one round already run side by side. |
| `fork`, `parallel`, `async` | `docs/site/guide/concurrency.md` | Run branches at the same time. Every one of them joins before the enclosing function returns. |
| A child process handle | `HostSubprocess.start` in `lib/host/host.ts` | Starts a child and returns without waiting. The handle has `kill` and `wait`. One caller uses it today, `record` in `lib/stdlib/speech.ts`. |
| Stopping everything a command started | `lib/host/node/processGroups.ts` | Each child runs in its own process group. A stop signals the whole group. The process's exit kills every group still running. |
| Saved long output | `std::spill`, `docs/dev/stdlib/spill.md` | Output past a cap is kept in the run's globals. The model gets a preview and reads the rest with `readSpill` or `grepSpill`. |
| The terminal lock | `withLock("std::tty")` in `stdlib/policy.agency` | Two branches that both need the approval prompt take turns. |
| One handler chain across processes | `docs/dev/runtime/subprocess-ipc.md` | A child started with `run()` asks its parent's handlers about each interrupt. A parent that rejects wins. |
| A child that pauses | same doc | A child whose interrupt nobody answers saves a checkpoint and exits. Answering the interrupt resumes it in a new process. |
| A message into a running conversation | `MessageThread.queueMessage`, `lib/runtime/turnBoundary.ts` | The message is added to the thread at the next safe point between a tool result and the next model request. |
| A message that expires | `systemMessage(msg, expires: "llmCall")`, `docs/dev/runtime/expiring-messages.md` | The message is in the thread for one model call and is then removed. The agent's global instructions use it. |
| Notes for the next user message | `lib/agents/agency-agent/lib/pendingNotes.agency` | Text added to the user's next message. The `!command` feature uses it. |
| A footer pinned to the bottom of the terminal | `installBottomRegion` in `lib/stdlib/cli.ts` | Everything else prints above the footer into normal scrollback. The spinner and the approval prompt use it. |
| Attaching to a running program | `docs/dev/cli/debugger-attach.md` | A running program opens a socket in a per-user sessions directory. `agency debug --attach` connects to it. Several viewers can share one session. |
| Reporting state to Herdr | `docs/dev/agents/herdr.md` | The agent reports idle, working, and blocked to the Herdr workspace manager. |

Three earlier pieces of work made decisions that apply here.

**The `async` spec rejected detached tasks.** `docs/superpowers/specs/2026-11-04-spawn.md` considered a task with its own checkpoint that the parent does not wait for. It says: "Each thing fork gives for free (enclosing handlers, branch state, thread ownership, argument aliasing, restore) needed its own rule for a detached task." So `async` shipped as syntax for a `parallel` block, and the call never outlives the function.

**The July idea doc named the same problem.** `docs/superpowers/ideas/2026-07-09-async-background-work.md` says work in flight cannot be saved in a checkpoint: "there is no sensible way to snapshot a promise that is 40% done." It lists two directions. One keeps background work in TypeScript and never saves it. The other adds a language construct whose work is lost on a pause or restore.

**The steering notes list five ways to stop or redirect a running program.** `docs/superpowers/specs/2026-11-06-steering-handoff.md` in the `agent-steering` worktree has the table: cancel, the pause signal, a debugger stop, an interrupt answered by a handler, and `queueMessage`. The owner rejected a steering design that added a sixth. Any idea below that redirects a running agent should use one of the five.

## The ideas

### 1. Background shells

The agent starts a command and gets a job id back at once. It reads the job's output later, and it can stop the job.

This is the smallest idea and the one the comparison work needs. It has a spec, so this section is short.

A shell job is easy where a subagent is hard, because the running thing is an operating system process. Agency only has to remember the process and collect its output. Nothing about the job is Agency code, so the job raises no interrupts after it starts and has no call stack to save.

A job cannot be saved in a checkpoint. The spec's answer is that a job belongs to one run in one process, and it is stopped when that run ends or pauses.

### 2. Checking on a job

The owner's example: "If I ask it to start the comparison in a separate shell, I would want the agent to check up on it occasionally."

Reading the output is the easy half. Deciding when to read it is the hard half, because the model only acts during a turn. There are four ways to get a turn to happen.

**The user asks.** The user types "how is the comparison going?" and the model reads the output. This needs only the tool that reads output.

**The model waits inside its turn.** The model calls a tool that returns when the job ends or after a few minutes. It reads the output, decides whether anything is wrong, and waits again. The user cannot talk to the agent while it waits. Escape cancels the wait.

**The harness wakes the model.** The harness starts a turn without a typed line: when a job ends, when it prints a line that matches a pattern, or on a timer. Claude Code and Crush both work this way. The REPL loop in `lib/stdlib/cli.ts` waits for a typed line and nothing else, so it would have to wait for two things.

**The model sets an alarm.** The model asks the harness to start a turn in ten minutes. This needs the same REPL change.

The first two are in the spec. The harness wake is the better long-term answer. Earlier sessions showed that a model does not reliably use a tool it is merely offered, so a design should not depend on the model remembering to check.

Two questions are open for the wake:

- What does a woken turn look like in the terminal? The user may be typing when it starts.
- Which of the five mechanisms delivers the news? `queueMessage` delivers a message to a conversation that is running. Nothing today starts a conversation that is idle.

### 3. Seeing what is running

The user needs to know which jobs exist and what state each is in.

**A list on request.** A `/jobs` command prints each job's id, command, state, and running time. This is in the spec.

**A jobs footer.** The footer would show one line per job for the whole session. The bottom region exists, and the spinner and approval prompt use it. Neither is a hard test. The spinner is one row, and the prompt redraws only on a keypress. A jobs footer would be several rows, up for hours, and redrawn on a timer while text streams above it. The owner remembers flicker and misrendering from earlier work on the bottom region. This needs a prototype before anyone relies on it.

**A log file per job.** If each job also wrote its output to a file, the user could run `tail -f` on it in another tab. That needs no new UI. The spill store moved off disk because a resumed run could not find its files, so a log file should be a copy for people and never the store the tools read.

**Attaching from another tab.** A command such as `agency agent attach` could show one job's or one subagent's live output. The debugger's attach feature already has the socket, the sessions directory, and rules for several viewers. This is worth more for subagents than for shells, since a shell's output is only text.

**A full-screen UI.** This would allow panes side by side and lines that update in place. It costs the terminal's own scrolling, selection, and copying, which would have to be rebuilt or taken from an npm package. The owner prefers to keep printing to the terminal. If this is ever built, it should be a separate package, so its dependencies stay out of `agency-lang`.

### 4. Parallel subagents inside one turn

The main agent starts three subagents, waits for all three, and continues.

This already works when the model asks for the three in one round. What we have not checked:

- Whether the models we use ask for several subagents in one round.
- Whether the trace lines from three subagents are readable when they interleave.
- Whether the approval prompt says which subagent is asking. The prompts queue on the terminal lock, so they do not overlap.

This idea needs measurement before design. It may need only a label on each trace line and on the prompt.

### 5. Subagents that keep running after the turn

The main agent starts a subagent, replies to the user, and takes more turns while the subagent works.

This is the idea the `async` spec rejected for the language. The reasons still hold, and each one needs an answer.

**Handlers.** A handler applies to the code inside its `handle` block. The agent's policy handler wraps the whole session in `runSession` (`lib/agents/agency-agent/lib/turn.agency`). Handlers inside a turn are removed when the turn's code returns. A subagent that outlives the turn must still run under the session's policy handler. This is a safety requirement, not a detail: a detached subagent must never run with fewer handlers than the session has.

**The checkpoint.** A checkpoint records one call stack. A subagent running beside that stack is not in it.

**The conversation.** A subagent's model calls must not write into the main conversation while the main agent is using it.

**Cost and budgets.** A subagent runs under a time and cost guard today. The guard belongs to the call that started the subagent.

Two directions look possible.

**A scope at the session level.** The harness owns a scope for the whole session. A subagent is started into that scope, and the scope joins when the session ends. The rule "the call never outlives its scope" stays true. The scope is just longer than a function. Handlers around the scope apply to everything in it. This is a language or runtime feature, and it needs its own design.

**A subagent in its own process.** The subagent is a second `agency agent` process, the way Pi's extension does it. The handler chain already crosses a process boundary for `run()`. Two things do not fit today. `run()` waits for its child. And `run()` compiles a closure of pure Agency files, while the agent imports TypeScript. We have not checked whether the agent's compiled code could be started through the same bootstrap.

### 6. A blocked subagent that waits for nothing

A background subagent needs approval while the user is typing something else. What should happen?

A full-screen agent shows a dialog. Agency can do something else. A child process whose interrupt nobody answers already saves a checkpoint and exits. The subprocess doc says: "The child process is gone while the user thinks."

So a blocked subagent could park:

- It uses no process while it waits.
- The jobs list shows it as blocked, with the question it is asking.
- The user answers when ready, from this terminal or another.
- It resumes in a new process, from the line where it stopped.
- It would survive quitting and restarting the agent. Crush can only report such a subagent as interrupted.

This is the part of the whole idea where Agency's checkpoints give something other agents do not have.

Today a paused child's interrupts travel up through the parent's `run()` call, and the parent pauses too. Parking needs them to go to a list the harness owns. That is new runtime work in `lib/runtime/ipc.ts`.

The checkpoint is the program. A parked subagent's checkpoint sits on disk until the user answers, and someone who can edit it can change what the subagent does when it resumes. `docs/dev/runtime/checkpoint-integrity.md` describes the checksum that guards against this. A parking design has to use it.

### 7. Subagents and the main agent talking to each other

Crush has no direct channel between subagents. Everything goes through the parent.

If a subagent is a job the way a shell is, most of this follows from the job tools. The parent reads the subagent's progress, stops it, and sends it a message. Sending is the one new operation. `queueMessage` already delivers a message into a running conversation at a safe point, and the steering notes cover the limits of that.

We do not have a use for two subagents talking without the parent between them.

## A possible order

1. Background shells, with the wait and the `/jobs` list. This is the spec.
2. Measure parallel subagents inside one turn, and fix what the measurement shows.
3. The harness wake, so the agent learns a job ended without being asked.
4. A prototype of the jobs footer, to find out whether the bottom region holds up.
5. Detached subagents, starting from a decision between a session scope and separate processes.
6. Parking, once detached subagents exist.

Steps 1 to 4 do not depend on the language changing. Steps 5 and 6 do, or they depend on new runtime work, and each needs its own spec.

## Open questions

1. What do we want detached subagents for that parallel subagents inside one turn cannot do? The answer decides whether steps 5 and 6 are worth their cost.
2. Should a woken turn be allowed to start while the user is typing?
3. Should a job's output also go to a log file, for `tail -f` and for a later attach command?
4. Does the main agent or the coder start jobs? The main agent has no shell tool today.
