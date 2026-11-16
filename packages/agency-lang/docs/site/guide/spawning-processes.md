---
name: Spawning processes
description: Explains `spawn` from `std::agency`, which starts an Agency file as a separate process that outlives the program that started it, and how that process is approved, limited, watched, and answered.
---

# Spawning processes

`spawn` starts an Agency file as a separate process and returns at once. The new process keeps running after your program ends.

```ts
import { spawn } from "std::agency"

node main() {
  const started = spawn("./scripts", "report.agency") with approve
  if (started is success(process)) {
    print("Started ${process.name} as pid ${process.pid}")
    print("Its output is in ${process.outputFile}")
  }
}
```

Use it for work that should not hold your program up, or that should carry on after your program is done: a long report, a watcher, a second agent working on its own task.

`spawn` does not give you the process's result. It returns the process id, the name, and the path of the file the process's output is saved to. If you want a result back, use [`run`](/stdlib/agency#run) instead, which waits for it.

## A spawned process is on its own

This is the part to understand before you use `spawn`.

A [handler](/guide/handlers) answers the interrupts raised inside its block. A spawned process outlives the block that started it, and it may outlive your whole program. So your handlers cannot answer what it does. In the example above, `with approve` approves **the start**. It approves nothing the spawned process does afterwards.

A spawned process is a new program, the same as one you started yourself with `agency run`. It has:

- its own handlers, the ones written in its own code,
- its own policy, which you give it when you start it,
- its own cost and time limits,
- its own threads, checkpoints, and trace.

It shares no variables and no conversation with the program that started it.

Compare the two ways of running another Agency program:

| | `run()` | `spawn()` |
| --- | --- | --- |
| Returns | when the program finishes, with its result | at once, with a process id |
| The program lives | until `run()` returns | after your program has ended |
| Your handlers | answer the program's interrupts | answer only the start |
| Effect raised | `std::run` | `std::spawn` |

## Giving the process its rules

Because your handlers do not reach into the process, you say how it should behave when you start it.

```ts
import { spawn } from "std::agency"

node main() {
  const started = spawn(
    "./scripts",
    "report.agency",
    policy: {
      "std::read": [{ action: "approve" }],
      "std::write": [{ match: { dir: "/home/me/reports/**" }, action: "approve" }]
    },
    maxCost: 2,
    maxTime: 10m,
  ) with approve
}
```

- **`policy`** is a [policy](/guide/policies), the same JSON `agency run --policy` takes. The process runs under it. The default has no rules.
- **`maxCost`** is the most the process may spend on LLM calls, in dollars.
- **`maxTime`** is the longest it may work. Time it spends waiting for a person does not count.

With no limits, the process has none. Set them.

## Approving a start

`spawn` raises the interrupt `std::spawn` before it starts anything. If the interrupt is rejected, nothing is started and nothing is written to disk.

The interrupt's data shows everything the process will be started with, so a handler, a policy rule, or a person at a prompt can judge it:

| Field | What it holds |
| --- | --- |
| `dir`, `filename`, `node` | The file and the node to start. |
| `args` | The arguments the program reads with `std::args`. |
| `policy` | The policy the process will run under. |
| `maxCost`, `maxTime` | Its limits, or `null` for none. |
| `messageCount` | How many messages its first thread starts with. |
| `name` | The name it shows in `ps`. |
| `cwd` | Its working directory. |
| `outputFile` | Where its output is saved. |
| `depth` | How many `spawn` calls deep it is. |

A handler can refuse a start whose rules it does not accept:

```ts
handle {
  spawn("./scripts", "report.agency", policy: policy, maxCost: 2)
} with (intr) {
  if (intr.effect == "std::spawn" && intr.data.maxCost == null) {
    return reject("A spawned process must have a cost limit")
  }
  return approve()
}
```

`std::spawn` is separate from `std::run`, and it belongs to no [effect set](/guide/effects-and-raises). Approving `Shell`, or `std::run`, does not approve a spawn. A rule has to name `std::spawn`.

When you answer a spawn prompt with "always approve when", the saved rule covers that one file: the same `dir` and `filename`. It does not fix the policy, the limits, or the arguments, so a later start of the same file with a different policy is approved too.

## Questions the process cannot answer

Suppose the spawned process raises an interrupt that its own handlers do not answer and its policy has no rule for. Nobody is at a terminal to ask.

The process does not approve the action, and it does not reject it. It keeps running and holds the question until a person answers. You answer with [`agency attach`](/cli/attach), using the process id `spawn` returned:

```
$ agency attach 48213
Attached to pid 48213 (report.js). Press Ctrl-C to detach.
Reading the sales data...

std::write
────────────────────────────────────

Are you sure you want to write to this file?
{
  "dir": "/home/me/project",
  "filename": "summary.md"
}
(a)pprove / (r)eject / (aa) approve-always / (rr) reject-always:
```

`agency attach` with no process id lists the running programs and marks the ones that are waiting.

A process that waits has paused, so any [background jobs](/stdlib/jobs) it started have stopped.

To avoid questions, give the process a policy that covers what it does.

## Output

A spawned process has no terminal, so what it prints is saved to a file. `spawn` returns the path, and the `std::spawn` interrupt shows it before the process starts.

```ts
const started = spawn("./scripts", "report.agency", outputFile: "./report.log") with approve
```

Without `outputFile`, the output goes to a new file under `~/.agency/spawned/`, in a folder only you can read. Agency does not delete these files.

The process stops saving at 10 MiB for each of its two output streams, and keeps running.

## Starting with a conversation

`messages` gives the process a conversation to start from. The messages go on its first thread, so its first `llm()` call continues from them.

```ts
import { spawn } from "std::agency"

node main() {
  const answer = llm("Summarize the plan we agreed on.")
  const history = [
    { role: "user", content: "Summarize the plan we agreed on." },
    { role: "assistant", content: answer }
  ]
  spawn("./scripts", "carryOut.agency", messages: history) with approve
}
```

The messages are copied. The two programs do not share a thread afterwards.

## Finding and stopping a process

`spawn` does not keep track of what it started. A spawned process shows in `ps` under its name:

```
$ ps -ax | grep "agency run"
48213 ??  0:01.20 agency run report.agency
```

Pass `name` to give it a name of your own. Stop a process with `kill 48213`.

Ctrl-C in your terminal does not reach a spawned process.

## Limits

- A chain of processes that each spawn another may go five deep. A sixth `spawn` returns a failure.
- One run may start about 500 processes.
- `spawn` returns a failure inside a program started with `run()`. That program is sandboxed, and a spawned process is not.

## From the command line

`spawn` runs `agency run --detach` for you. You can run the same command yourself to start a background program by hand. See [running in the background](/cli/run#running-in-the-background).
