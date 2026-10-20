---
title: The Agency debugger
description: Documents the `agency debug` command, an interactive terminal debugger that supports stepping forward and backward through execution, viewing checkpoints, and overriding variable values.
---

# The Agency debugger

*Still a work in progress*

Agency has a very good built-in debugger. Lets try using it. Put the following code in a file called `test.agency`:

```ts
node main() {
 const name = "world"
 const greeting = llm("Say hello to ${name}!")
 print(greeting)
}
```

and then invoke the debugger using

```
agency debug test.agency
```

Here are some things you may want to do with the debugger: 

- Step forward: Press `s` or the down arrow. 
- Continue until you hit a `debugger` statement: Press `c` or `space`. 
- Rewind or step backwards: Press the up arrow, or press `r` to see a list of checkpoints. Press up/down to scroll and you'll see the line each checkpoint is for.
- Override the value of a variable: Enter `:set varName=newValue`. Then when you press `s`, the next statement will execute with the variable's value overwritten.
- Cycle between all the different panels: `tab` and `shift+tab`. Once a panel has focus, you can press the up or down arrow keys to scroll, or press `z` to zoom, temporarily making that panel full screen. 
- In the threads panel, you can press `[` or `]` to cycle between the different threads, or `t` to pick one from a list. A thread you picked stays shown while you step; pick the active one (marked `*`) to follow the program again.
- When the program is inside an `llm()` call with tools, the branches panel lists each tool call with its status, and `b` opens one so the locals, globals, and call stack panels show it, and `p` prints from it. The guards panel shows the tool loop's round and each guard's spend against its limit.

## Attaching to a program that is already running

A program started with `agency run`, or from TypeScript, can take the debugger while it runs. Nothing has to be planned in advance: no flag, no trace mode. In one terminal:

```
agency run agent.agency
```

In another:

```
agency debug --attach
```

lists the programs that can take a debugger, with their process ids:

```
  PID    PROGRAM   NODE  STARTED
  48213  agent.js  main  4m12s ago
```

and

```
agency debug --attach 48213
```

opens the debugger on that program. The listing shows the compiled file the process is running, `agent.js` for `agency run agent.agency`, relative to the current directory when it is under it. It stops at the program's next statement, wherever it is, inside a tool call included, and from there stepping, inspecting, `set`, and rewind work as they do when the debugger started the program. Rewind reaches back as far as the attach and no further. `c` lets the program run until its next `debugger()` statement, a question, or the end. Keys typed while the program runs are kept and acted on at its next stop, so pressing `q` while it runs detaches at the next stop, not before. Ctrl-C detaches at any time and leaves the program running. At a stop, `q` detaches: the program runs on without a debugger, and it is let go first. Escape does nothing while attached, so a stray key cannot detach. When the program finishes while attached, the debugger says so and exits.

A program's own interrupts keep going wherever the program sends them: a policy, the `--approve` and `--reject` flags, or the program's terminal under `--interactive`. The debugger shows them going by and does not answer them. A question asked with `input()` goes to the program's terminal as well.

How it works: a running program listens for the `SIGUSR2` signal and opens a Unix socket under `~/.agency/debug-sessions` when it arrives; `--attach` sends the signal and connects. Only a process running as the same user can send it, the directory is readable by that user alone, and a program nobody signals opens nothing. Two things follow from the signal: a program run under `nodemon`, which restarts a child with `SIGUSR2`, opens its debug socket instead of restarting; and whoever can reach that directory can do what the program's owner can do, including changing a variable, so keep it yours.

## Options

- `--attach [pid]` — attach to the running program with that pid, or with no pid, list the programs that can take a debugger. It takes no file and none of the other flags: the program keeps the options it was started with, so `--policy` or `--rewind-size` with `--attach` is refused rather than ignored.
- `--node <name>` — node to execute (defaults to `main`).
- `--rewind-size <n>` — size of the rolling checkpoint window. Defaults to 30. Larger values let you rewind further at the cost of memory.
- `--trace <file>` — load and inspect an existing `.trace` file instead of running the program live.
- `--checkpoint <file>` — load a saved checkpoint file and start the debugger from that point.
- The run flags of `agency run`: `--policy`, `--approve`, `--reject`, `--max-cost`, `--max-time`, `--model`, `--local`, `--max-tool-call-rounds`, `--log-file`, and the others. For example, `agency debug agent.agency --policy recommended --max-cost 2` debugs the agent under the recommended policy with a two dollar cap. The policy answers the interrupts it has rules for; the debugger asks you about the rest. The cap applies to one timeline: a rewind restores the spending recorded at the checkpoint, so a run that spent a dollar, rewound to the start, and ran again has spent two dollars while the guard counts one.
- `--dist-dir <dir>` — import pre-compiled JS from this directory instead of compiling the `.agency` file on the fly. Useful when you've already built your project and want to skip the compile step.