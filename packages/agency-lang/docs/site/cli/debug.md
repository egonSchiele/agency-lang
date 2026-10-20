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

## Options

- `--node <name>` — node to execute (defaults to `main`).
- `--rewind-size <n>` — size of the rolling checkpoint window. Defaults to 30. Larger values let you rewind further at the cost of memory.
- `--trace <file>` — load and inspect an existing `.trace` file instead of running the program live.
- `--checkpoint <file>` — load a saved checkpoint file and start the debugger from that point.
- The run flags of `agency run`: `--policy`, `--approve`, `--reject`, `--max-cost`, `--max-time`, `--model`, `--local`, `--max-tool-call-rounds`, `--log-file`, and the others. For example, `agency debug agent.agency --policy recommended --max-cost 2` debugs the agent under the recommended policy with a two dollar cap. The policy answers the interrupts it has rules for; the debugger asks you about the rest. The cap applies to one timeline: a rewind restores the spending recorded at the checkpoint, so a run that spent a dollar, rewound to the start, and ran again has spent two dollars while the guard counts one.
- `--dist-dir <dir>` — import pre-compiled JS from this directory instead of compiling the `.agency` file on the fly. Useful when you've already built your project and want to skip the compile step.