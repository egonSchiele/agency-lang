---
name: "cli"
---

# cli

A line-mode REPL for CLI agents, driven by Node's `readline` instead of
  the alt-screen TUI engine in `std::ui`. It gives up the pinned status
  line, live spinner, and in-app scrolling. In exchange, every prompt
  and reply is a plain line in the terminal's scrollback, so you get
  native search, copy/paste, link clicks, line editing, and history for
  free. It shares `std::ui`'s `repl` call signature, so switching modes is
  a one-line import change:

  ```ts
  // TUI mode (alt-screen)
  import { repl } from "std::ui"

  // Line mode (scrollback)
  import { repl } from "std::ui/cli"
  ```

## Functions

### repl

```ts
repl(status: any, onSubmit: any, prompt: string, historyFile: string, historyMax: number, paletteCommands: any)
```

Line-mode REPL with the same call signature as the std::ui TUI repl,
  so switching modes is a one-line import change.

  Each iteration prints `prompt`, awaits one line of input (full line
  editing, history, bracketed paste), and calls `onSubmit(line)`.
  Returning false exits; returning a non-empty string prints it;
  anything else is ignored. Also exits on Ctrl+D (EOF) or Ctrl+C at an
  idle prompt. Type `/paste` (TTY only) to open a multi-line editor:
  Enter inserts a newline, Ctrl+D submits the whole buffer as one
  message, and Ctrl+C / Esc cancels.

  @param status - Callback returning {left, right, context}
  @param onSubmit - Called with the submitted line; return false to exit or a string to print
  @param prompt - String shown before the input buffer (default "> ")
  @param historyFile - Path to a JSON history file; loaded at start and saved on exit. Empty string disables persistence.
  @param historyMax - Trim history to this many most-recent entries
  @param paletteCommands - Map of /cmd -> description

* Line-mode sibling of the std::ui TUI repl. Current limitations:
 * `status` is accepted for signature parity but not yet rendered;
 * `paletteCommands` has no tab completion yet; there is no busy
 * spinner and no Ctrl+C cancel of an in-flight turn.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| status | `any` |  |
| onSubmit | `any` |  |
| prompt | `string` | "> " |
| historyFile | `string` | "" |
| historyMax | `number` | 1000 |
| paletteCommands | `any` | null |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L61))

### clearScreen

```ts
clearScreen()
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L101))

### clearHistory

```ts
clearHistory()
```

Clear the input history of the currently running `repl()` session: both
  its in-session up-arrow recall and the `historyFile` that session was started
  with. A no-op when called outside an interactive `repl()`.

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L105))

### termWidth

```ts
termWidth(): number
```

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L112))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L116))
