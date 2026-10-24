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
- Cycle between all the different panels: `tab` and `shift+tab`. Once a panel has focus, the up and down arrow keys move through it: on a panel of rows (locals, globals, call stack, branches, guards) they move the row cursor and the panel scrolls to keep it in view; on the others they scroll. Press `z` to zoom, temporarily making that panel full screen. 
- In the threads panel, you can press `[` or `]` to cycle between the different threads, or `t` to pick one from a list. A thread you picked stays shown while you step; pick the active one (marked `*`) to follow the program again.
- When the program is inside an `llm()` call with tools, the branches panel lists each tool call with its status, and `b` opens one so the locals, globals, and call stack panels show it, and `p` prints from it. The guards panel shows the tool loop's round and each guard's spend against its limit.
- Stop a running program: press space while it runs, after `c` or `n`, and it stops at its next statement. Space is also `continue` at a stop, so it is one key to let the program run and the same key to stop it; `s` and `n` pause too. The bottom bar says `(space)pause` while the program runs. A model call in flight is not interrupted, so the stop comes when the call returns; the bar reads `pausing at the next statement` until then. It also works while the program runs on after one of its own interrupts went to its caller. At a stop, or after the program ended, the key does nothing; and if you press it just as the program stops, it is neither a pause nor a step, so press it again.
- While the program runs, after `c` or `n`, the bottom bar reads `▶ running · (space)pause (q)quit`, and a line above it says what the program is waiting on and for how long: `waiting: in llm() at story.agency:11 · 4s · round 1, waiting on model`, or `· round 2, in tool search(query: "cats")` during a tool call the model made. The source panel marks that `llm()` line with `▶`. It is not a stop: the program is somewhere inside that statement, and the panels keep the last stop's state until the next one.

## Changing the program at a stop

Everything you can change is on a row of a panel, and the change lives on the row. The bottom line says which keys the row under the cursor takes.

- **Say something to the model.** In the threads panel, press `Enter` to open the composer under the messages, type, and press `Enter` again. The message is queued on that thread and shows as `(pending)`; press `c` and the model reads it with its next request. If the thread is waiting on tool results, the message is queued behind them and delivered once they are in. `Esc` closes the composer and keeps what you typed.
- **Set a variable.** Focus the locals panel, move to the variable with the arrow keys, press `Enter`, and type the new value (JSON, or plain text). The panel shows the new value highlighted until the program moves on. `:set name = value` in command mode does the same.
- **Take a tool away from the model.** The call stack panel lists each tool loop's tools under its `llm()` frame. Move to one and press `e`; the model does not see it from its next request on.
- **Give a guard more room, or turn it off.** In the guards panel, `b` on a guard asks for a new budget (`30s`, `2m`, or `$0.50`), and `e` disarms it so it stops tripping. The root budget is the ceiling the host set, so it takes neither.
- **Decide a branch's result yourself.** In the branches panel, `e` on a running fork or parallel branch asks for a value (JSON, or text). The branch is finished with it, and the block that owns it reads the value as the branch's return. The loop records a tool call's own result, so a tool call's branch takes none.
- **Find an edit by name.** `Ctrl+K` opens a list of every edit every row offers, in plain words such as `disarm the guard research`. Type to narrow it, and `Enter` moves to the row and runs the edit.
- **Change your mind.** `x` drops the pending edits. A rewind drops them too, since it resumes an earlier checkpoint.

From `agency debug session`, the same edits are `agency debug session edit`: with no action it lists what this stop takes, for example `append-message --thread [main] --text <text>`, `set-local --name <x|y> --value <json>`, `remove-tool --tool <search|writeUp>`, `disarm-guard --guard <research>`, `set-guard-limit --guard <research> --amount <amount>`, and `set-branch-result --branch <fork_1> --value <json>`; `edit append-message --text "Stop research now. Write up what you have."` queues the message, and `continue` sends it.

The same edits can be made to a saved checkpoint from the command line: `agency resume checkpoint.json agent.agency --edit '{"op":"appendMessage","text":"stop"}'`, or `--edits edits.json` with a file holding a list of them (see [run and resume](run)).

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

opens the debugger on that program. The listing shows the compiled file the process is running, `agent.js` for `agency run agent.agency`, relative to the current directory when it is under it. It stops at the program's next statement, wherever it is, inside a tool call included, and from there stepping, inspecting, `set`, and rewind work as they do when the debugger started the program. Rewind reaches back as far as the attach and no further. `c` lets the program run until its next `debugger()` statement, a question, or the end. An agent driving `agency debug session` can be on the same run as you, and either of you can move the program. The stats line says `with agency debug session` while it is, the activity panel shows what it did (`cli: step`), and if it answers a stop before you do, your key or an open picker is dropped and the panels redraw at the new stop. Space (or `s` or `n`) typed while the program runs stops it at its next statement. That includes the moment between the attach and its first stop, so a space typed then is answered by that stop rather than kept for it. `q` while it runs detaches at once, and so does Ctrl-C; both leave the program running. Other keys typed while it runs are kept and acted on at its next stop. At a stop, `q` detaches: the program runs on without a debugger, and it is let go first. Escape does nothing while attached, so a stray key cannot detach. When the run being debugged finishes while attached, the debugger says so and exits; a program that runs several nodes at once is debugged one run at a time, and the others run on without stopping.

While the program runs, the status line names the model request or tool call it is in, with the time it has been there, and the source panel marks the `llm()` line (see the list above). Attaching in the middle of a long call shows that call at once, with how long it has already run. The time is the whole step's, which for a model request includes looking up memory before the request is sent. Nothing moves while the program is between slow calls: the status line names no wait and the panels keep the last stop.

A program's own interrupts keep going wherever the program sends them: a policy, the `--approve` and `--reject` flags, or the program's terminal under `--interactive`. The debugger shows them going by and does not answer them. A question asked with `input()` goes to the program's terminal as well.

How it works: a running program listens for the `SIGUSR2` signal and opens a Unix socket under `~/.agency/debug-sessions` when it arrives; `--attach` sends the signal and connects. Only a process running as the same user can send it, the directory is readable by that user alone, and a program nobody signals opens nothing. Two things follow from the signal: a program run under `nodemon`, which restarts a child with `SIGUSR2`, opens its debug socket instead of restarting; and whoever can reach that directory can do what the program's owner can do, including changing a variable, so keep it yours.

## Driving the debugger from a script

`agency debug session` is the same debugger, one command at a time, for a script or an agent that works by running a command and reading what it printed. The session lives in the program: a command connects, is shown where the program is, answers or reads, and disconnects, and the next command picks up where the last left off. A program held this way with no command for ten minutes lets itself go and runs on.

```
$ agency debug session list
  PID    PROGRAM          NODE  STARTED  SESSION
  48213  agent.js         main  4m ago   none

$ agency debug session attach 48213
agent.js · node main · pid 48213
stopped in search ("in search") · agent.agency:8
  const url = "https://example.test/" + query
stack   main › llm() (round 3) › search
threads main (12 messages) · search (3 messages, active)
guards  research · cost $0.42 of $0.50 · root budget · time 4m10s of 30m
usage   31,204 tokens · $0.42
next    step, next, continue, frame, thread, branches, guards, detach
```

`attach` opens the session; the program stops at its next statement. Then, with one session held, no pid is needed:

- `where` prints the summary again. Run it first, and after every move.
- The readers, none of which moves the program: `frame [n] [--globals]`, `stack`, `threads`, `thread [label] [--last n]`, `branches`, `branch <key>`, `guards`, `source [--context n]`, `checkpoints`.
- The moves: `step`, `next`, `in`, `out`, `continue`, `back`, `rewind <id>`, `set <name> <json>`, `checkpoint [label]`, `save <path>`, `load <path>`. Each answers the stop and prints `where` at the next one. `continue` prints that the program is running and returns at once.
- `wait [--for 5m]` blocks until the program stops or ends, then prints `where`; `pause` asks a running program to stop at its next statement, and `wait` returns at that stop.
- `answer <json>` replies when the program is waiting on a question rather than stopped at a statement: a guard trip (`{"type":"approve"}` or `{"type":"reject","value":"why"}`), a node's arguments (a JSON array), or `input()` (a JSON string). A move is refused at such a stop and says so.
- `detach` releases the session. With no one else on the run the program runs on with no debugger; with a person at `agency debug --attach`, they keep driving and the program waits for them.

A move the debugger could not do, `back` at the earliest checkpoint, or a `save` to a path it cannot write, is a refusal with the debugger's own line, not a stop. Readable text by default, `--json` for the same facts as fields, `--pid <pid>` when more than one session is held. The exit codes: 0 for an answer, 1 for a refusal, with what to do instead on stderr (in the JSON on stdout with `--json`), 2 when the program has ended, 3 when `wait` ran out.

A person can be on the same run at `agency debug --attach`. Both see every stop, and whichever answers first moves the program. A move the person got to first is refused: `the stop you saw was answered by the terminal (continue); run \`where\` and decide again`. The person's moves show up in `where` as `since   terminal: continue`, and `where` says `a terminal debugger is attached too`. The program's own interrupts go to its caller, as they do for the terminal debugger; neither party answers them.

An agent such as Claude Code can drive this for you: the `debug-run` skill teaches it when to attach, what to look at first, to ask before stopping a program you are watching, and to leave the run's state alone unless you say so. [`agency skills install debug-run`](/cli/skills) adds the skill to Claude Code or another agent.

## Options

- `--attach [pid]` — attach to the running program with that pid, or with no pid, list the programs that can take a debugger. It takes no file and none of the other flags: the program keeps the options it was started with, so `--policy` or `--rewind-size` with `--attach` is refused rather than ignored.
- `--node <name>` — node to execute (defaults to `main`).
- `--rewind-size <n>` — size of the rolling checkpoint window. Defaults to 30. Larger values let you rewind further at the cost of memory.
- `--trace <file>` — load and inspect an existing `.trace` file instead of running the program live.
- `--checkpoint <file>` — load a saved checkpoint file and start the debugger from that point.
- The run flags of `agency run`: `--policy`, `--approve`, `--reject`, `--max-cost`, `--max-time`, `--model`, `--local`, `--max-tool-call-rounds`, `--log-file`, and the others. For example, `agency debug agent.agency --policy recommended --max-cost 2` debugs the agent under the recommended policy with a two dollar cap. The policy answers the interrupts it has rules for; the debugger asks you about the rest. The cap applies to one timeline: a rewind restores the spending recorded at the checkpoint, so a run that spent a dollar, rewound to the start, and ran again has spent two dollars while the guard counts one.
- `--dist-dir <dir>` — import pre-compiled JS from this directory instead of compiling the `.agency` file on the fly. Useful when you've already built your project and want to skip the compile step.