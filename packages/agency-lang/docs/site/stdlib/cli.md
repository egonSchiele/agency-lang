---
title: "cli"
name: "cli"
---

# cli

## Functions

### repl

```ts
repl(status: any, onSubmit: any, prompt: string, historyFile: string, historyMax: number, paletteCommands: any)
```

Line-mode REPL. Same call signature as `std::ui.repl` so swapping
  modes is a one-line import change in the calling agent.

  Per iteration: print `prompt`, await one line of input (via Node's
  `readline` — full line editing, history, bracketed paste), call
  `onSubmit(line)`. If `onSubmit` returns `false`, exit. If it
  returns a non-empty string, print the string to stdout. Anything
  else (e.g. the agent's `_runTurn` returning `true` after calling
  `pushMessage`) is silently ignored — the reply already reached
  stdout via the underlying `print` path.

  Exits on `onSubmit` returning `false`, on Ctrl+D (EOF) at the
  prompt, or on Ctrl+C at an idle prompt.

  Round-one limitations (intentional, see the spec):
  - `status` is accepted for signature parity but not yet rendered.
  WL2 will turn it into a per-turn footer.
  - `paletteCommands` is accepted but no tab completion yet (WL6).
  - No spinner during the busy window (WL3).
  - No Ctrl+C cancel of an in-flight turn (WL7).

  @param status - Callback returning {left, right, context}; reserved
  for the WL2 per-turn footer
  @param onSubmit - Called with the submitted line; return `false` to
  exit or a string to print
  @param prompt - String shown before the input buffer (default "> ")
  @param historyFile - Path to a newline-separated history file;
  loaded at start and saved on exit. Empty string disables
  persistence.
  @param historyMax - Trim history to this many most-recent entries
  @param paletteCommands - Map of /cmd -> description; reserved for
  WL6 tab completion

**Parameters:**

| Name | Type | Default |
|---|---|---|
| status | `any` |  |
| onSubmit | `any` |  |
| prompt | `string` | "> " |
| historyFile | `string` | "" |
| historyMax | `number` | 1000 |
| paletteCommands | `any` | null |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/cli.agency#L59))

### clearScreen

```ts
clearScreen()
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/cli.agency#L111))
