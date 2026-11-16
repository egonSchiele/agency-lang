# Holding a question, and `agency attach`

A program run from the command line can meet an interrupt that no handler and no policy rule settled. This doc covers the third way a run answers one: it holds the question and waits for a person to answer it from another terminal with `agency attach`.

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

`resumeCommand` in `lib/runtime/heldCheckpoint.ts` builds the line from the run's own settings. The policy has to be a file, and the person who resumes may not have one: `spawn` deletes the policy file it launched with. So `saveHeldCheckpoint` writes the run's policy beside the checkpoint, as `<traceId>-<pid>.policy.json`, when the policy has rules. `removeHeldCheckpoint` deletes both files.

The resumed process raises the same interrupt and holds it again. It registers for attach the way a fresh run does: `resumeCliFromCheckpoint` in `lib/runtime/interrupts.ts` calls `registerAttach`.

## `agency attach`

`agency attach` with no pid prints the listing `agency debug --attach` prints. The listing has a `STATE` column that reads `waiting` for a program that holds a question. With a pid it connects to the program's debug socket as a `watch` client, shows the approval prompt for each held question, and sends the answers. The client is `lib/cli/attachWatch.ts`, and the run side is `lib/debugger/attach/watch.ts`. `docs/dev/cli/debugger-attach.md` has the socket and the messages.

Attaching is not debugging. A `watch` client never opens a debugger session, so the program does not stop for it. Ctrl-C ends the command and leaves the program as it was.

Ctrl-C or Ctrl-D at an open prompt detaches and sends no answer. The host's `readLine` returns an empty line for both, and the approval prompt reads an empty line as a rejection, so attach asks through its own `askOrClose`, which rejects with `PromptClosed`. `watch` then closes the connection without sending `answers`. The question texts are shared with the terminal prompt (`approvalQuestion` and `valueQuestion` in `lib/runtime/interruptPrompts.ts`).

A client answers only the batch the program holds now. Another client can answer a batch while this one has a prompt open for it. Each `held` message replaces what this client thinks is held, and the client checks that before every prompt and before it sends. A batch that is no longer held gets no more prompts and no answers, and the person is told another client answered first.

The prompt reads as the one `--interactive` shows, from `buildDecider({ interactive: true })`, including the value prompt for a raise that expects a value. An "approve always" answer is remembered for that effect until the command exits.

The command refuses to attach when its standard input is not a terminal. The prompt rejects a question when there is no terminal, and an attach must not answer for the person.

## Tests

`lib/cli/wait.spawn.test.ts` runs the built command line with a real program and a client on its socket. A test that starts a process uses `startCli` from `lib/cli/spawnTestHelpers.ts`. Every process started that way exits by itself at a deadline, and a test stops a process only through the handle it started it with, never through a pid read from output.
