# `spawn`, holding a question, and `agency attach`

`spawn` in `std::agency` starts an Agency file as a process of its own. The process outlives its caller and shares nothing with the caller's run. It has its own handlers, policy, limits, trace, and checkpoints. Nothing the caller wrote can answer its questions, so a question its own policy does not settle is held until a person answers it from another terminal with `agency attach`.

The first half of this doc covers holding and attaching, which work for any program run with `--wait-for-response`. The second half covers `spawn`.

## The three ways a run answers an interrupt nobody settled

`unansweredMode` in `lib/runtime/runPolicyHandler.ts` reads the run's environment and returns one of three values. Both readers of the setting call it: `installRunPolicyHandler` and `resolveCliInterrupts`.

| Flag | Mode | What happens to the interrupt |
| --- | --- | --- |
| none | `reject` | It is rejected. |
| `--interactive` | `prompt` | A prompt at the terminal. With no terminal it is rejected, on purpose. |
| `--wait-for-response` | `wait` | It is held until `agency attach` answers it. |

The two flags cannot be given together.

`--wait-for-response` travels to the program as `AGENCY_RUN_POLICY_WAIT`. The flag alone makes `resolveRunPolicy` return an empty policy, which installs the root policy handler. Without that handler `resolveCliInterrupts` would report the interrupt as unhandled and exit.

## The rule

A program run with `--wait-for-response` never approves or rejects a question by itself. When nothing can attach to it and no checkpoint was saved, it still waits, and the line it prints says that nothing can answer.

A second rule follows from the first. An approve rule in the policy stays silent for a raise that expects a value (`const x = interrupt …`), in `prompt` mode and in `wait` mode. A person can supply the value in both, so the rule must not answer with no value. `installRunPolicyHandler` passes `unansweredMode(...) !== "reject"` for this.

## The held batch

Interrupts surface in batches: several branches can raise at once, and the run resumes a batch as a whole (`docs/dev/runtime/concurrent-interrupts.md`). So a batch is held and answered as a whole.

`resolveInterruptBatches` in `lib/runtime/interruptResolution.ts` is the loop: decide a batch, resume, and repeat while the result still has interrupts. `resolveInterrupts`, which decides one interrupt at a time, is a caller of it.

`lib/runtime/heldQuestions.ts` holds the batch:

- `holdForAnswers(interrupts)` returns a promise for the responses.
- `heldQuestions()` returns the batch as data. A held question is a `SerializedInterrupt` from `lib/runtime/ipcChild.ts`: the interrupt without its checkpoint. `withoutCheckpoint` makes one.
- `answerHeld(answers)` checks a set of answers and resolves the promise. It returns null, or the reason it refused. A refusal leaves the batch held.
- `onHeldChange(listener)` is called when a batch starts and when it ends.

`answerHeld` accepts a set of answers only when a batch is held, the set has exactly one answer for each held interrupt id, and `validateResumeBatch` accepts the responses. The last check is the one every resume goes through.

The batch is kept on `process`, through `processSlot` in `lib/runtime/processSlot.ts`. It does not belong to a run's context. The debug socket that answers it is one per process, a process can hold more than one copy of the runtime, and the root endpoint of a command-line run is one per process too.

### Staying alive

A Node process that waits on a promise with no open handle exits. `holdForAnswers` starts a timer that does nothing and clears it when the batch is answered. The debug socket cannot do this job, because it is `unref`ed, and because a program whose socket failed to open must still hold.

### Time and jobs while holding

A time budget is paused while a run is halted on an interrupt (`lib/runtime/rootBudget.ts`), so time spent holding is not counted.

A run that surfaces an interrupt has paused, and a pause stops its shell jobs (`docs/dev/stdlib/jobs.md`). A program that holds a question has therefore lost its jobs.

## What the program prints

`waitForResponse` in `lib/runtime/cliInterruptResolution.ts` puts the pieces together for one batch: it saves the checkpoint when the setting asks for that, writes a notice to standard error, holds, and removes the checkpoint file afterwards.

`holdNotice` words the notice from four facts. `isAttachable()` in `lib/runtime/platform.node.ts` supplies one of them: whether the program registered for attach and its socket opened.

| Can attach | Checkpoint saved | First line |
| --- | --- | --- |
| yes | either | `[agency] Waiting for an answer to 1 question. Run: agency attach 48213` |
| no | yes | `[agency] Waiting for an answer to 1 question. Nothing can attach to this process. Stop it with: kill 48213, then resume it.` |
| no | no | `[agency] Waiting for an answer to 1 question. Nothing can attach to this process, so nothing can answer. Stop it with: kill 48213` |

With a checkpoint file a second line gives the `agency resume` command, with the flags described under "Resuming from the file" below.

A program cannot be attached to when `AGENCY_NO_ATTACH=1` is set, on Windows, or when its sessions directory was refused.

## The checkpoint setting

`spawn.interrupts.preemptivelyCreateCheckpoint` in `agency.json` is off by default. A checkpoint holds the program's whole state, so Agency does not write one to disk unless the user asked.

The command line reads the config and carries the setting to the program as `AGENCY_SAVE_HELD_CHECKPOINT`, so the setting is in neither the generated code nor the runtime context.

With it on, `saveHeldCheckpoint` in `lib/runtime/heldCheckpoint.ts` writes the batch's checkpoint to `~/.agency/held/<traceId>-<pid>.json` before the program starts to hold. Every interrupt in a batch carries the same checkpoint, so it writes the first one's. The folder is made with `host.files.privateDir` (mode `0700`), the file has mode `0600`, and the write refuses to replace an existing file. `removeHeldCheckpoint` deletes the file once the batch is answered, and refuses a path outside the folder.

A surfaced checkpoint holds live values, such as a `Date` or a `Set` in a local variable. The file is written with `nativeTypeReplacer`, which keeps them in the form a resume revives. Plain `JSON.stringify` would turn a `Set` into `{}`.

A save that fails is reported on standard error and the batch is held with no file. A removal that fails is reported and the answers are still used.

### Resuming from the file

If the process dies while it holds, the file stays. A resume does not delete it, so the user removes it when they no longer need it.

A checkpoint does not hold the run's policy or its cost and time limits. The policy comes from `--policy`, and the limits from `--max-cost` and `--max-time` (`lib/runtime/rootBudget.ts` drops a restored limit the resuming command does not set). A resume without those flags would run with no rules and no limits. So the resume command the program prints carries them:

```
agency resume <file> <program> --wait-for-response --policy <policy file> --max-cost 2 --max-time 600000ms
```

`resumeCommand` in `lib/runtime/heldCheckpoint.ts` builds the line from the run's own settings. The policy has to be a file, and the person who resumes may not have one: `spawn` deletes the policy file it launched with. So `saveHeldCheckpoint` writes the run's policy beside the checkpoint, as `<traceId>-<pid>.policy.json`, when the policy has rules. The policy is written first, and removed again if the checkpoint write fails, so a save that fails half way leaves neither file. `removeHeldCheckpoint` deletes both files. The paths in the printed command are quoted for a shell when they need it.

The resumed process raises the same interrupt and holds it again. It registers for attach the way a fresh run does: `resumeCliFromCheckpoint` in `lib/runtime/interrupts.ts` calls `registerAttach`.

## `agency attach`

`agency attach` with no pid prints the listing `agency debug --attach` prints. The listing has a `STATE` column that reads `waiting` for a program that holds a question. With a pid it connects to the program's debug socket as a `watch` client, shows the approval prompt for each held question, and sends the answers. The client is `lib/cli/attachWatch.ts`, and the run side is `lib/debugger/attach/watch.ts`. `docs/dev/cli/debugger-attach.md` has the socket and the messages.

Attaching is not debugging. A `watch` client never opens a debugger session, so the program does not stop for it. Ctrl-C ends the command and leaves the program as it was.

Ctrl-C or Ctrl-D at an open prompt detaches and sends no answer. The host's `readLine` returns an empty line for both, and the approval prompt reads an empty line as a rejection, so attach asks through its own `askOrClose`, which rejects with `PromptClosed`. `watch` then closes the connection without sending `answers`. The question texts are shared with the terminal prompt (`approvalQuestion` and `valueQuestion` in `lib/runtime/interruptPrompts.ts`).

A client answers only the batch the program holds now. Another client can answer a batch while this one has a prompt open for it. Each `held` message replaces what this client thinks is held, and the client checks that before every prompt and before it sends. A batch that is no longer held gets no more prompts and no answers, and the person is told another client answered first.

The prompt reads as the one `--interactive` shows, from `buildDecider({ interactive: true })`, including the value prompt for a raise that expects a value. An "approve always" answer is remembered for that effect until the command exits.

The command refuses to attach when its standard input is not a terminal. The prompt rejects a question when there is no terminal, and an attach must not answer for the person.

When the program has an output file, attach also prints the program's output: the last 64 KB of what the file holds (`START_TAIL_BYTES`), and then what is added to it. A detached program can have saved megabytes, and printing all of it would push the question off the screen. When earlier output was skipped, the first line says how much and names the file. `outputFollower` in `lib/cli/outputFollower.ts` polls the file's size, since `fs.watch` behaves differently on each platform. `watch` pauses it while a prompt has the terminal and lets it catch up afterwards. The path comes from the record on disk, so a symbolic link there is refused.

## `spawn` and how it differs from `run()`

| | `run()` | `spawn()` |
| --- | --- | --- |
| The child lives | until the call returns | after the caller has ended |
| The caller's handlers | answer the child's interrupts over IPC | answer nothing the child raises |
| The result | comes back to the caller | is not returned; `spawn` returns a pid |
| The effect | `std::run` | `std::spawn` |

A handler chain is scoped by position in the caller's code. Code that outlives its caller cannot reach back into blocks that have closed, so a spawned program is a new root.

`spawn` in `stdlib/agency.agency` does its checks, builds one `SpawnQuestion` value, raises `std::spawn` with it, and then hands the same value to `_spawn` in `lib/stdlib/spawn.ts`. What was approved is what runs. A rejected start has written nothing: `_spawnPaths` only names paths, and the folder is made after the approval.

### The effect

`std::spawn` carries the file, the node, the arguments, the policy, both limits, the number of seed messages, the name, the working directory, the output file, and the depth. The payload has the count of the seed messages and not the messages.

`std::spawn` is in no effect set in `stdlib/effectSets.agency`. `Shell` holds `std::run`, and a rule that approves running sandboxed code must not approve starting a process that outlives the program.

The effect declares `@always(dir, filename)` (`docs/dev/language/effect-always-tag.md`). An "always approve when" answer to a spawn prompt therefore pins the folder and the file being started. It does not pin the policy, the limits, or the arguments.

### The launch

`_spawn` runs the command line: `agency run --detach <output-file> --wait-for-response …`. The command line is the one place that turns run flags into settings, so `spawn` builds a command and copies none of that logic. `spawnCommand` states the flags as rows of data, and always writes `--` before the program's arguments, so they are never read as `agency`'s.

`--detach <output-file>` is a flag of `run` and `resume` (`startDetached` in `lib/cli/detached.ts`). The program starts in its own process group with both output streams appended to the file, and the command prints `{"pid", "outputFile"}` as its last line and exits. The pid is the program's own, the one `ps` shows and `agency attach` takes. The file is opened with `O_NOFOLLOW`, so a symbolic link at the path is refused. The mode `0600` applies when the file is created, and an existing file keeps its mode. `--detach` cannot be given with `-i` or `--capture-workdir`.

The policy reaches the command in a file, `policy.json` in the program's folder, which `_spawn` removes once the command has returned. A policy with no rules needs no file, since `--wait-for-response` alone installs an empty policy.

### The carriers

`--name`, `--messages`, and `--detach` travel from the command to the program as `AGENCY_PROCESS_TITLE`, `AGENCY_SEED_MESSAGES`, and `AGENCY_OUTPUT_FILE`. `withRootCarriers` in `lib/cli/childEnv.ts` holds them as rows in `TEXT_CARRIERS`, clears each one, and sets the ones given. `runLaunchFrom` in `lib/cli/runLaunch.ts` turns the three flags into one `RunLaunch` value for `run()`.

The program takes the three out of its environment as soon as it starts (`takeLaunchSettings` in `lib/runtime/launchSettings.ts`, called by `runCliEntry`) and keeps them in a `processSlot`. Left in the environment, every process the program starts would inherit them. A shell job that ran a compiled Agency program would be seeded with this program's conversation, or would try to read a seed from its own standard input.

`runCliEntry` sets `process.title` from the first, so every `agency run` shows in `ps` as `agency run <name>`, with the input file's name as the default.

### The environment a spawned program gets

`spawnEnvironment` builds the launcher's whole environment: the caller's, without `AGENCY_TRACE_ID`, `AGENCY_CONFIG_OVERRIDES`, and every `AGENCY_IPC*` variable, and with `AGENCY_SPAWN_DEPTH` set. Those three tie a process to its caller's run. Without them the spawned program has a trace of its own and reads its own `agency.json`.

### The seed

`agency run --messages <file>` puts a list of messages on the program's first thread. `spawn` passes `--messages -`, and the messages travel through the launcher's standard input to the program's. They are never written to a file on that path. A person who names their own file keeps it: Agency reads it and leaves it.

`takeSeedMessages` in `lib/runtime/platform.node.ts` reads the seed, and `runNode` puts it on the thread with `seedFirstThread`. The seed is taken once per process (`takeSeedSource` clears it), because `runNode` runs for every node a process starts. A `run()` child inherits its parent's environment and is not seeded.

`seedFrom` in `lib/runtime/seedMessages.ts` drops every tool call in the last assistant message that has no result. A conversation looks like that at the moment a model starts a process by calling a tool, and a provider refuses it. `keepToolCalls` in `lib/runtime/threadRepair.ts` does the edit, and `dropHandoffToolCall` uses the same function.

`--messages` is a flag of `run` only. A resumed program's threads come from its checkpoint.

### The folder

A spawned program's default output file is `~/.agency/spawned/<id>/output.log`. `_spawn` makes the folder with `host.files.privateDir` (mode `0700`). When the caller names its own output file and the policy has no rules, no folder is made. Nothing removes old folders yet.

### The depth and the count

`MAX_SPAWN_DEPTH` is 5. The depth travels in `AGENCY_SPAWN_DEPTH`, which `withRootCarriers` leaves alone on purpose, so a shell job that runs `agency run --detach` is counted too.

`MAX_SPAWNS_PER_RUN` is 500. The count is `spawnCount` on the run's `RuntimeContext`, so every branch of a `fork` shares it. It is saved in every checkpoint taken after the first start (`Checkpoint.spawnCount`), and the checkpoint's signature covers it.

`restoreState` calls `adoptSpawnCount`, which keeps the larger of the live count and the saved one. A resume in a new process starts at zero and takes the saved count. A `restore()` inside a run that has started more programs since keeps its own count, because those processes were started and a restore does not un-start them. A run's spend behaves the other way: it is set back on a restore (`docs/dev/runtime/cost-is-state.md`). A count that followed spend would let a loop of `restore()` and `spawn` start processes without limit.

The limit is close and not exact. Three cases let a run start a few more than 500:

- Branches of a `fork` that call `spawn` at the same moment all pass the check before any of them has counted its start.
- A debugger rewind builds a new context, which starts at zero and takes the count saved in the checkpoint it rewinds to. Programs started after that checkpoint are no longer counted.
- A launch that times out is counted, since the command may have started the program before it was stopped. That errs the other way.

`spawn` fails inside a `run()` subprocess, which is a sandbox tied to its parent.

### What is checked before the interrupt

`_spawnProblem` refuses a `node` that is not a plain name, and a limit that is negative or not a number, before anything is asked. The node check is a safety check. The command's target is `<file>:<node>`, and `parseTarget` treats the whole string as a filename when the text after the last colon is not a name. A node such as `x/../../other.agency` would then make the command run a file other than the one the approver was shown, and an "always approve when" rule pins only `dir` and `filename`. `spawnCommand` checks the same thing again: the target it built must read back as the approved file and node.

`_checkSpawnFile` refuses a `filename` that is not a regular file in `dir`, so nobody is asked to approve a file that is not there. Whether the file declares the node is not checked. That would mean parsing the file before the approval, and the launcher reports a missing node in the program's output file.

### What is checked after the approval

A person can take a while to answer, and the file or a folder above it could be swapped for a symbolic link in that time. So `_spawn` calls `_checkSpawnFile` again before it launches. The check goes through `host.files.fixedRoot`, which refuses a link at any part of the approved folder's path, and a contained `stat`, which refuses one below it.

The launcher is a separate process and reads the file a moment later, by its path. That last gap is not closed.

### The output cap

A detached program saves at most 10 MiB of each output stream (`SPAWN_OUTPUT_LIMIT_BYTES`). The command that started it has exited, so the program limits itself: `runCliEntry` calls `capOutput` in `lib/runtime/outputCap.ts` when `AGENCY_OUTPUT_FILE` is set. The line written at the limit says so.

The cap covers what the program itself writes. A child started through the host (`lib/host/node/nodeSubprocess.ts`) gets pipes or nothing for its output and never the program's own streams, so `std::shell` commands and shell jobs do not write to the file directly.

## Tests

`lib/cli/wait.spawn.test.ts`, `lib/cli/detach.spawn.test.ts`, and `lib/cli/spawn.spawn.test.ts` run the built command line with real programs. A test that starts a process uses `startCli` from `lib/cli/spawnTestHelpers.ts`. Every process started that way exits by itself at a deadline, and a test stops a process only through the handle it started it with, never through a pid read from output. `tests/agency/spawn.agency` covers the checks that end before a program starts.
