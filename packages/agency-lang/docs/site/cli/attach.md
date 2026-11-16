---
title: Attaching to a running program
description: Documents the `agency attach` command, which lists running Agency programs and answers the interrupts a program is waiting on.
---

# Attaching to a running program

`agency attach` connects your terminal to an Agency program that is already running. You use it to answer an interrupt the program is waiting on.

A program waits when you start it with `--wait-for-response`. Suppose `agent.agency` wants to write a file, and nothing in the program or its policy approves the write:

```
$ agency run --wait-for-response agent.agency
[agency] Waiting for an answer to 1 question. Run: agency attach 48213
```

The program has not stopped. It is still running and it holds the question. In another terminal, attach to it by the process id it printed:

```
$ agency attach 48213
Attached to pid 48213 (agent.js). Press Ctrl-C to detach.

std::write
────────────────────────────────────

Are you sure you want to write to this file?
{
  "dir": "/home/me/project",
  "filename": "notes.md"
}
(a)pprove / (r)eject / (aa) approve-always / (rr) reject-always:
```

This is the prompt `agency run --interactive` shows. Type `a` and the program writes the file and carries on. Type `r` and the write fails, the way a rejected interrupt always does.

Attaching is not debugging. The program does not pause when you attach, and you do not land in a debugger. To step through a running program, use [`agency debug --attach`](./debug) instead.

## Listing the running programs

With no process id, the command lists the programs you can attach to:

```
$ agency attach
  PID    PROGRAM    NODE  STARTED    STATE
  48213  agent.js   main  4m12s ago  waiting
  51002  report.js  main  38s ago
```

`waiting` marks a program that holds a question. `PROGRAM` is the compiled file the process is running: `agent.js` for `agency run agent.agency`.

## Answers

- **A plain interrupt** takes `a` to approve or `r` to reject.
- **`aa` and `rr`** also answer every later interrupt with the same effect, for as long as you stay attached.
- **An interrupt that asks for a value**, such as `question()`, asks you to type the value. An empty line rejects it.

When several interrupts are raised at the same moment, the program holds them together. You answer each one in turn, and the program resumes once you have answered all of them.

## Detaching

Press Ctrl-C to detach. The program keeps running.

If you detach while a prompt is open, no answer is sent. The program goes on holding the question, and you or someone else can attach again later.

Two people can attach to the same program. Both see the question, and the first complete answer is used.

## When nothing can attach

A program can only be attached to when it has opened its socket, which it does under `~/.agency/debug-sessions` when it starts. Three things prevent that: Windows, the variable `AGENCY_NO_ATTACH=1`, and a `~/.agency/debug-sessions` directory that other users can read.

A program that cannot be attached to still waits. It never approves or rejects a question by itself. The line it prints tells you so, and tells you how to stop it:

```
[agency] Waiting for an answer to 1 question. Nothing can attach to this process, so nothing can answer. Stop it with: kill 48213
```

To keep such a program recoverable, turn on [saved checkpoints](./run#saving-a-checkpoint-while-waiting). You can then stop the program and resume it somewhere a person can answer.

## Who can attach

Anyone who can read `~/.agency/debug-sessions` can answer a program's questions. The directory is readable by your user alone, and Agency refuses to use it otherwise. Keep it that way: an answer here approves what the program does next.

The command reads your answers from the terminal. It refuses to attach when its input is not a terminal, so a script cannot answer by accident.
