# Start a program in its own process

**Status:** spec, not built. Date: 2026-11-15.

Paths are relative to `packages/agency-lang`.

This spec replaces the background jobs design in `docs/superpowers/specs/2026-11-15-background-agency-jobs.md` on the branch `adit/agent-messaging`. The section "What we keep from the background jobs design" says which of its ideas carry over.

## The problem

An Agency program can run other Agency code in one way today, with `run()` from `std::agency`:

```agency
import { runFile } from "std::agency"

node main() {
  const result = runFile("./scripts", "report.agency", "main") with approve
  print(result)
}
```

`main` waits on that line until `report.agency` ends. The child is tied to its caller in four ways:

| Tie | What it means |
| --- | --- |
| Handlers | Every interrupt the child raises is sent to the caller's handlers |
| Cost | The child's spending counts against the caller's guards |
| Cancel | Cancelling the caller kills the child |
| Lifetime | When the caller's process ends, the child ends |

These ties are what make `run()` safe for code you do not trust. They also mean a program cannot start a long piece of work and carry on. `agency agent` cannot hand three unrelated tasks to three agents and keep talking to the user.

The earlier design tried to loosen the ties one at a time. A job kept running after the call returned, and its interrupts were answered by a policy held in the parent. Each loosened tie needed a new rule: a stack of the job's own for cost, a policy check in place of the handler chain, a blocked state held by the parent.

The reason is that handlers and guards are scoped by position, like `try` and `catch`. Agency saves and resumes a program by replaying one line of execution. Code that keeps running after its caller has moved on would need the caller's handlers and guards to stay open after their blocks have ended, and that breaks the one line.

## The idea

Cut every tie. The new program runs in a process of its own, as if a person had typed `agency run` in another terminal. It is a new root: it has its own handlers, its own policy, its own budget, and its own checkpoint. The program that started it has no say in what it does after the start.

```agency
import { spawn } from "std::agency"

node main() {
  const policy = {
    "std::read": [{ action: "approve" }]
  }
  const started = spawn("./scripts", "report.agency", policy: policy, maxCost: 2.00) with approve
  if (started is failure) {
    return started
  }
  print("Started ${started.value.name} as pid ${started.value.pid}")
}
```

`spawn` asks one approval, starts the process, and returns at once. `main` can end, and the process keeps running.

The three ways to run Agency code then look like this:

| | A function call | `run()` | `spawn()` |
| --- | --- | --- | --- |
| Where it runs | The caller's process | A child process | Its own process |
| The caller waits | Yes | Yes | No |
| Handlers | The caller's | The caller's, over IPC | Its own |
| Budget | The caller's | The caller's | Its own |
| Ends when the caller ends | Yes | Yes | No |
| Sandboxed | No | Yes | No |
| Use it for | Your own code | Code you do not trust | Your own code that should run alone |

## How a program runs at the root today

A new process is an ordinary `agency run`. This section has the parts of `agency run` this spec builds on.

**The flags.** `agency run` takes `--policy`, `--approve`, and `--reject` for a policy, `--max-cost` and `--max-time` for limits, and `--interactive`. Time spent waiting for a person does not count toward `--max-time`.

**The root policy.** The policy from the flags is installed as the outermost handler of the run (`installRunPolicyHandler` in `lib/runtime/runPolicyHandler.ts`). It answers only the interrupts a rule matches.

**The root endpoint.** An interrupt that no handler settled travels up until the entry node returns it. The generated entry code hands it to `resolveCliInterrupts` (`lib/runtime/cliInterruptResolution.ts`). That function decides each interrupt and then calls `respondToInterrupts`, in the same process, and repeats until the run ends. It decides in one of two ways today:

| Flag | What happens to an interrupt nobody settled |
| --- | --- |
| none | It is rejected |
| `--interactive` | The terminal prompts for an answer. With no terminal, it is rejected (`terminalPrompt` in `lib/runtime/interruptPrompts.ts`). |

**The socket.** Every program run on the Node host opens a Unix socket at `~/.agency/debug-sessions/<pid>.sock` and writes a record beside it (`docs/dev/cli/debugger-attach.md`). `agency debug --attach` lists the records and connects to one. The directory is readable only by its owner, and the runtime refuses to use it otherwise.

**Shell jobs.** A run that returns interrupts to its host has paused, and a pause closes the run's job table (`docs/dev/stdlib/jobs.md`). So a program's shell jobs stop when one of its questions reaches the root.

## Decisions

### 1. `spawn` starts an Agency file as a new root

```agency
export def spawn(
  dir: string,
  filename: string,
  node: string = "main",
  args: string[] = [],
  policy: Record<string, any> = {},
  maxCost?: number,
  maxTime?: number,
  messages: any[] = [],
  name: string = "",
  cwd?: string,
  outputFile?: string,
): Result<ProcessInfo> raises <std::spawn>
```

It lives in `std::agency`, beside `run`. It returns as soon as the process has started:

```agency
export type ProcessInfo = {
  pid: number;
  name: string;
  outputFile: string
}
```

The file is compiled the way `agency run` compiles it. It may import TypeScript and packages, because it is the caller's own code. Code that is not trusted goes through `run()`.

Each parameter after `node` maps to something `agency run` already has, or to one of the two new flags in decisions 4 and 6:

| Parameter | What the process gets |
| --- | --- |
| `args` | The program's arguments, read with `std::args` |
| `policy` | Its root policy, as `--policy` gives one |
| `maxCost`, `maxTime` | Its budget, as `--max-cost` and `--max-time` give one |
| `messages` | A conversation to start from. See decision 6. |
| `name` | Its name in `ps`. See decision 7. |
| `cwd` | Its working directory. The default is the caller's. |
| `outputFile` | The file that what it prints is saved to. See decision 7. |

The parent keeps nothing after the start. There is no table of started processes, and no function to read one's output or stop one. Those belong to later work on how processes find and talk to each other.

### 2. The start raises its own effect

```agency
effect std::spawn {
  dir: string;
  filename: string;
  node: string;
  args: string[];
  policy: Record<string, any>;
  maxCost: number | null;
  maxTime: number | null;
  messageCount: number;
  name: string;
  cwd: string;
  outputFile: string;
  depth: number
}
```

The start is the only moment the caller's handlers have a say, so the payload shows everything the process will run under: the policy, both limits, and the file its output is saved to. A handler can refuse a start whose policy it does not accept.

```agency
handle {
  spawn("./scripts", "report.agency", policy: policy)
} with (intr) {
  if (intr.effect == "std::spawn" && intr.data.maxCost == null) {
    return reject("A process needs a cost limit.")
  }
  return pass()
}
```

The effect is separate from `std::run`. Approving `std::run` approves a child whose every interrupt still comes back to the approver. Approving a start approves a program that answers to nobody afterwards. A handler or a saved rule that approves `std::run` must not approve that.

A policy that fails `validatePolicy` fails the call before anything is raised. A rejected `std::spawn` starts nothing.

The payload carries the number of seed messages and not the messages. A conversation can be large, and the caller already has it.

### 3. Limits on starting

**Depth.** A process started by `spawn` may start another. Each start passes a depth count to the new process. A start that would go past depth 5 returns a failure. This is the default cap `run()` uses for nested subprocesses.

**Count.** One run may call `spawn` successfully at most 500 times. The next call returns a failure. The count is of processes that were really started. It is saved in every checkpoint, so a run that pauses and is resumed carries on counting. A `fork` does not reset it. A `restore()` does not lower it, because going back to an earlier checkpoint does not un-start a process.

Both are backstops against a loop that starts processes without end. The control a person has is the start effect, which every start raises.

**Inside `run()`.** `spawn` returns a failure when it is called inside a `run()` subprocess. Code in a subprocess is sandboxed, and a started process is not, so allowing it would give sandboxed code a way out of the sandbox.

### 4. A question nobody answered is held

The root endpoint gets a third behaviour. It is turned on with a new flag on `agency run` and `agency resume`:

```
agency run --wait-for-response report.agency
```

| Flag | What happens to an interrupt nobody settled |
| --- | --- |
| none | It is rejected, as today. |
| `--interactive` | The terminal prompts, as today. With no terminal it is rejected, as today. |
| `--wait-for-response` | The process keeps running and waits for a client to answer. |

`spawn` always passes the flag. A started process never approves or rejects on its own. An interrupt is settled by a handler in the program, by a rule in the policy, or by a person.

A person can use the flag too, for a program they start by hand under `nohup`, `tmux`, or a scheduler.

`--interactive` is left alone. With no terminal it rejects today, on purpose, so that a script never hangs. Reusing it would turn those rejections into waits. The two flags cannot be given together.

**What waiting does, in order:**

1. The entry node returns the interrupts that nobody settled, as it does today.
2. When the checkpoint setting is on, the process writes the checkpoint those interrupts carry to a file. See below.
3. The process waits. Time spent waiting does not count toward `--max-time`.
4. A client connects and sends one answer for each question. The process checks the answers with `validateResumeBatch`, calls `respondToInterrupts`, and deletes the file if it wrote one.

A second batch of questions later in the run is held the same way.

**A rule cannot answer a raise that expects a value.** Under the flag the root policy is built the way it is under `--interactive`: an approving rule stays silent for a raise such as `question()`, so the question is held and a person supplies the value.

**Shell jobs.** A question that reaches the root pauses the run, so the process's shell jobs stop at step 1. This is today's behaviour for every program whose question reaches its host. Fixing it is separate work.

**Saving the checkpoint is a setting, and it is off by default.**

```json
{
  "spawn": {
    "interrupts": {
      "preemptivelyCreateCheckpoint": true
    }
  }
}
```

A checkpoint holds the program's whole state, including any secret a variable holds. Agency does not write that to disk unless the user asked for it. With the setting on, the file goes under `~/.agency/held/`, named for the run, and it is signed when `AGENCY_CHECKPOINT_KEY` is set.

The process that holds the question reads the setting, from the `agency.json` of its own working directory. It applies to any program run with `--wait-for-response`, whether `spawn` started it or a person did.

With the setting off, a held question lives only in the process's memory. If the process dies, the question and the run are lost.

With the setting on, a process that died while it held a question can be resumed:

```
agency resume ~/.agency/held/<run>.json report.agency --wait-for-response
```

A resume runs the statement that raised the interrupt again. The program's handlers and the policy are consulted again, and a question they still do not settle is held again. A person at a terminal can pass `--interactive` instead and answer at the prompt.

### 5. A client answers over the socket

A new command attaches a terminal to a running program:

```
agency attach            # lists the running programs, and marks one that holds a question
agency attach 48213      # attaches to pid 48213
```

Attaching is like attaching to a window in `tmux`. The person sees the program, and does not land in a debugger:

1. The command prints what the program has printed so far, from its output file, and keeps printing as more arrives.
2. When the program holds a question, the command shows the prompt `--interactive` shows: approve or reject for a plain raise, and a typed value for a raise that expects one.
3. Ctrl-C detaches. The program keeps running.

The command is a new kind of client on the socket the program already opens for `agency debug --attach`. It uses the same sessions directory, the same listing, and the same check that the pid still names the program that registered. It does not install a debugger on the program, so it never pauses it.

Rules for the exchange:

- A client that detaches without answering changes nothing. The question stays held.
- When two clients answer, the first complete and valid set of answers is used. The other is told the questions were answered.
- An answer set with a missing answer, an extra answer, or an unknown interrupt is refused, and the question stays held.
- A program that cannot open its socket still holds the question. With the checkpoint setting on, the resume command is the way to answer it.

Whoever can connect to the socket can answer for the user. The sessions directory is already treated as a credential for this reason, and no new rule is needed.

### 6. A conversation to start from

A new flag on `agency run` seeds the program's first thread:

```
agency run --messages history.json report.agency
```

The file holds a list of messages, in the shape a `thread` block gives when it is assigned to a variable. The runtime puts them on the first thread the program uses, before the program's own first message. An `llm()` call in the program then continues that conversation.

`spawn` takes the list as `messages` and sends it on the new program's standard input, with `--messages -`. A conversation can hold anything the user typed or a tool read, so `spawn` never writes it to a file.

The seed is applied once per process, to the first node the program runs.

**A dangling tool call is dropped.** When a model starts a process by calling a tool, the conversation at that moment ends with an assistant message that holds the call and no result. A provider refuses a request in that state. So the seed drops every tool call in the last assistant message that has no result. A message left with no text and no calls is removed.

A flag is used and not an environment variable. A variable would be inherited by every process and shell job the program starts, and each of those would be seeded with the same conversation.

Nothing else in the seed is changed. A program that opens its own `thread { }` block starts that thread empty, as it does today.

### 7. A name, and a file for output

**The name.** The process sets its title to `agency run <name>`, so `ps` shows it. The default name is the file's name. A person finds a forgotten process with `ps`, and stops it with `kill`.

**Output.** A started process has no terminal. What it prints, and its errors, are saved to one file. The caller names the file with `outputFile`. The default is a new file under `~/.agency/spawned/`, private to the user.

A program's output can hold sensitive data, so the file is never a surprise:

- Its path is in the `std::spawn` payload, so whoever approves the start sees where the output will go.
- Its path is in the returned `ProcessInfo`.
- `agency attach` reads from it.

Each stream is capped at 10 MiB, the cap a shell job has. Past the cap the process keeps running and nothing more is written, and the file's last line says so. Agency does not delete these files.

**Other logging.** The process is an ordinary `agency run` in its working directory, so it reads `agency.json` like any other run. A `log.logFile`, a statelog host, or a `traceDir` set there applies to it.

**Signals.** The process is started in its own process group, as shell jobs are. Ctrl-C in the caller's terminal does not reach it.

## Interrupts, handlers, and checkpoints

**Is a handler skipped?** No handler chain is changed. The caller's handlers hear `std::spawn` and nothing after it, because nothing after it happens in the caller's run. The started program's own handlers and its root policy hear every interrupt it raises, as in any run.

**What the caller gives up.** A handler around the start cannot stop what the process does later. The guide's promise that you can wrap code in a handler and decide everything it does holds for `run()`. It does not hold for `spawn`, and the function's docstring must say so.

**The caller's checkpoint.** The start is a step like any other. Once it has completed, a resume of the caller does not run it again. A `restore()` to a point before the start runs it again and starts a second process, as it would repeat any other side effect.

**The process's checkpoint.** A held question's checkpoint stays in the process's memory unless the checkpoint setting is on. On disk it holds the program's whole state, including any secret a variable holds. The file is private to the user. Signing guards against edits when `AGENCY_CHECKPOINT_KEY` is set, and `agency resume` already refuses a file whose signature does not verify.

**State.** The new process is a fresh run. It shares no globals, threads, or job table with the caller.

## What we keep from the background jobs design

| Idea | Where it is in this spec |
| --- | --- |
| A start effect that shows the policy | Decision 2 |
| An approval of `std::run` does not approve the start | Decision 2 |
| A rule never approves a raise that expects a value | Decision 4 |
| Pending interrupts as data, and answers checked against them | Decision 5 |
| Tests that wait on a file and never on a sleep | How to test |

The rest of that design is dropped: the second kind of job, the blocked state, the job's own stack, `jobInterrupts`, `resumeJob`, and the changes to `ipc.ts`.

## What this does not cover

- **How processes find and talk to each other.** The caller gets no result back and no notice that a process holds a question.
- **A list of started processes, and stopping one from Agency code.**
- **Answering from code.** A person answers with `agency attach`. A program cannot yet answer another program's questions.
- **A `resume` function in the standard library.** `agency resume` is a command only.
- **`agency agent`.** Starting an agent as a process, a slash command for it, and answering from inside the agent are later work.
- **Shell jobs that survive a held question.**
- **Running a tool call in a child process, and moving running code to the background.**
- **Windows.** A program there cannot open the socket, so a held question can only be answered by a resume.

## Needs the owner's decision

The spec picks an answer for each of these so the plan can be written.

1. **The flag's name, `--wait-for-response`.**
2. **Depth 5.** The owner chose 500 starts per run.
3. **`spawn` fails inside a `run()` subprocess.**
4. **The setting applies to any program run with `--wait-for-response`,** though its name begins with `spawn`.
5. **The default output folder, `~/.agency/spawned/`, and the 10 MiB cap.**
6. **`agency attach` prints the program's output as well as its questions.**

Also decided by the owner: the count of starts survives a resume, and `std::spawn` declares `@always(dir, filename)`, so that an "always approve when" answer pins the file being started.

Decided by the owner: the names `spawn` and `std::spawn`, a new `agency attach` command that is not the debugger, the setting `spawn.interrupts.preemptivelyCreateCheckpoint`, off by default, the title `agency run <name>`, and that a started program's output is saved.

## How to test

Make every change first. Then run `make` once and each test file once, with the output saved to a file.

**Unit tests.**

- The seed drops a dangling tool call, keeps a call that has a result, and removes a message left empty.
- The depth check and the count check each return a failure at the cap.
- Under `--wait-for-response`, an approving rule stays silent for a raise that expects a value.
- An answer set with a missing, extra, or unknown answer is refused.
- `--interactive` with no terminal still rejects.

**Agency tests, real processes, no model calls.** Each started program writes a marker file, and the test waits on that file. No test sleeps.

1. A rejected `std::spawn` starts nothing.
2. A handler that approves `std::run` and rejects every other effect does not let a process start.
3. A policy that is not valid fails the call, and nothing is raised.
4. A started program whose interrupt its policy approves runs to the end.
5. A program started inside `handle { ... } with approve` raises an interrupt its policy has no rule for. It is held: the handler did not approve it.
6. The caller's run ends, and the started program is still running afterwards.
7. `spawn` inside a `run()` subprocess returns a failure.
8. A program started with `messages` reads them on its first thread.

**Spawn tests for the command line.**

- With `--wait-for-response`, a question nobody settled leaves the process up, and no file is written.
- With the checkpoint setting on, the file is written, and it is deleted once the question is answered.
- An approval from `agency attach` lets the program finish.
- A rejection with a reason reaches the program.
- A raise that expects a value gets the value that was typed.
- A client that detaches leaves the question held, and the program keeps running.
- `agency attach` prints what the program printed before the client connected.
- A started program's output is in its output file, and the path is in the `std::spawn` payload.
- With the setting on, the process is killed while holding. `agency resume` on the file holds the question again, and an answer then finishes the program.
- `--interactive` and `--wait-for-response` together are refused.

**By hand.**

- Start a process, quit the caller, and find the process in `ps` as `agency run <name>`.
- Press Ctrl-C in the caller's terminal while a process runs. The process keeps running.
- `agency attach` with no pid marks a process that holds a question.
- Attach to a process, watch its output arrive, and press Ctrl-C. The process keeps running.
