---
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

  Built-in `/paste` (TTY only): opens a multi-line editor (à la Node's
  REPL `.editor`). Enter inserts a newline, Ctrl+D submits the whole
  buffer as one message, and Ctrl+C / Esc cancels. Because Enter no
  longer submits while in this mode, pasting a multi-line block lands
  intact instead of firing one turn per line.

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
  @param historyFile - Path to a JSON history file (array of entries);
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/cli.agency#L70))

### clearScreen

```ts
clearScreen()
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/cli.agency#L131))

### clearHistory

```ts
clearHistory()
```

Clear the input history of the **currently running** `repl()` session —
  both its in-session up-arrow recall and the `historyFile` that session was
  started with. The file path comes from the `_historyFile` execution-model
  global (set by `repl()`), so the runtime remembers which file to clear; the
  live up-arrow recall is wiped via the active REPL. A no-op when called
  outside an interactive `repl()`.

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/cli.agency#L135))

### termWidth

```ts
termWidth(): number
```

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/cli.agency#L145))

### hline

```ts
hline(char: string, width: number): string
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| char | `string` | "─" |
| width | `number` | null |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/cli.agency#L149))
