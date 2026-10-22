---
name: "cli"
description: "The terminal front end for CLI agents: a line-mode REPL driven by Node's readline, and prompts for one-off questions."
---

# cli

The terminal front end for CLI agents. `repl` is a line-mode REPL driven
  by Node's `readline`: every prompt and reply is a plain line in the
  terminal's scrollback, so you get native search, copy/paste, link
  clicks, line editing, and history for free. The prompts (`select`,
  `autocomplete`, `prompt`, `confirm`, `chooseOption`) ask the user one
  question at a time, and `interruptChoice` is the approval prompt
  `std::policy` uses.

  ```ts
  import { repl, chooseOption } from "std::ui/cli"
  ```

## Types

### ChoiceItem

A row in a choice prompt: the `key` is what the prompt returns, the
`label` is the text shown to the user.

```ts
/**
 * A row in a choice prompt: the `key` is what the prompt returns, the
 * `label` is the text shown to the user.
 */
export type ChoiceItem = {
  key: string;
  label: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L123))

## Functions

### repl

```ts
repl(
  status: any,
  onSubmit: any,
  prompt: string = "> ",
  historyFile: string = "",
  historyMax: number = 1000,
  paletteCommands: any = null,
)
```

A line-mode REPL in the terminal's own scrollback.

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
  @param paletteCommands - Map of /cmd -> description; null uses the palette from `setSlashPalette`

Current limitations: `status` is accepted but not yet rendered;
`paletteCommands` has no tab completion yet; there is no busy
spinner and no Ctrl+C cancel of an in-flight turn.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| status | `any` |  |
| onSubmit | `any` |  |
| prompt | `string` | "> " |
| historyFile | `string` | "" |
| historyMax | `number` | 1000 |
| paletteCommands | `any` | null |

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L47))

### setSlashPalette

```ts
setSlashPalette(paletteCommands: Record<string, string>)
```

Register the slash-command palette (`/cmd` -> description) for `repl()` calls that pass none.

The map is kept outside the execution model, so call this before any
  checkpoint restore and a resumed session shows the running code's
  commands.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| paletteCommands | `Record<string, string>` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L89))

### clearScreen

```ts
clearScreen()
```

Clear the terminal screen.

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L95))

### clearHistory

```ts
clearHistory()
```

Clear the input history of the currently running `repl()` session: both
  its in-session up-arrow recall and the `historyFile` that session was started
  with. A no-op when called outside an interactive `repl()`.

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L100))

### hline

```ts
hline(char: string = "─", width: number = null): string
```

Return a horizontal rule: `char` repeated `width` times (terminal
  width when `width` is omitted).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| char | `string` | "─" |
| width | `number` | null |

**Returns:** `string`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L112))

### pushMessage

```ts
pushMessage(message: string)
```

Print a message to the terminal. The string may include style markup.

  @param message - Styled or plain text to print

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L129))

### select

```ts
select(
  message: string,
  items: ChoiceItem[],
  allowFreeText: boolean = false,
  hint: string = "",
): Result<string>
```

Ask the user to pick from a list with arrow keys (no type-to-filter).
  Returns `success(key)` with the chosen item's `key`, or
  `failure("cancelled")` if the user pressed Ctrl+C / Escape. When
  `allowFreeText` is true, the list appends an extra "enter free text"
  row. Picking it prompts for text and returns that instead of a key.

  @param message - The question shown above the choices
  @param items - The {key, label} rows to choose from
  @param allowFreeText - Append a free-text entry row
  @param hint - Dim hint shown after the message

Needs a terminal: raises when stdout is not a TTY. There is no
non-TTY fallback, so a scripted caller must route around it
(`chooseOption` does).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| items | `ChoiceItem[]` |  |
| allowFreeText | `boolean` | false |
| hint | `string` | "" |

**Returns:** `Result<string>`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L144))

### autocomplete

```ts
autocomplete(
  message: string,
  items: ChoiceItem[],
  allowFreeText: boolean = false,
  hint: string = "",
  cancelOnEscape: boolean = false,
): Result<string>
```

Ask the user to pick from a list, filtering by typed text. Returns
  `success(key)` with the chosen item's `key`, or `failure("cancelled")`
  on Ctrl+C / Escape. The filter matches each item's `key` or `label`
  (substring, case-insensitive). When `allowFreeText` is true and the
  typed input matches no item, picking it returns the typed text
  verbatim instead of a key.

  @param message - The question shown above the choices
  @param items - The {key, label} rows to choose from
  @param allowFreeText - Return the typed input verbatim when no item matches
  @param hint - Dim hint shown after the message
  @param cancelOnEscape - When true, Escape raises a cancellation that
    unwinds the current run instead of returning `failure("cancelled")`.
    Use it where Escape should abort the whole request rather than re-ask

Needs a terminal: raises when stdout is not a TTY.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| items | `ChoiceItem[]` |  |
| allowFreeText | `boolean` | false |
| hint | `string` | "" |
| cancelOnEscape | `boolean` | false |

**Returns:** `Result<string>`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L169))

### prompt

```ts
prompt(
  message: string,
  initial: string = "",
  hint: string = "",
  validate: any = null,
): Result<string>
```

Ask the user for a line of free-form text. Returns `success(typed)`
  or `failure("cancelled")`. The empty string is a legitimate value, so
  check the Result tag rather than truthiness. When `validate` is
  supplied, it runs on each submission: return `true` to accept, or an
  error string to reject and re-ask.

  @param message - The question shown to the user
  @param initial - Pre-filled value
  @param hint - Dim hint shown after the message
  @param validate - Optional `(value) => true | "error message"` validator

Needs a terminal: raises when stdout is not a TTY.

Bind `validate` via `.partial()` before handing `prompt` to an LLM as
a tool so the LLM cannot override the constraint.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| initial | `string` | "" |
| hint | `string` | "" |
| validate | `any` | null |

**Returns:** `Result<string>`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L202))

### confirm

```ts
confirm(message: string, initial: boolean = false): Result<boolean>
```

Ask the user a yes/no question. Returns `success(true)`,
  `success(false)`, or `failure("cancelled")`. That is three outcomes,
  so check the Result tag rather than treating it as a boolean.

  @param message - The question shown to the user
  @param initial - Default position (false = "no")

Needs a terminal: raises when stdout is not a TTY.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| initial | `boolean` | false |

**Returns:** `Result<boolean>`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L227))

### chooseOption

```ts
chooseOption(
  title: string,
  body: string,
  items: ChoiceItem[],
  allowFreeText: boolean = false,
  allowCancel: boolean = false,
): string
```

Show a menu and block until the user picks an entry. Returns the
  chosen item's `key`. In a terminal, typing narrows the visible items
  by substring match on `key` or `label`; otherwise the user types a
  key at a plain prompt. When `allowFreeText` is true and the typed
  text matches no item, it returns that text instead of re-asking
  (empty input still re-asks).

  @param title - Heading (e.g. "Approve interrupt: shell::exec")
  @param body - Multi-line context shown above the choices (or "")
  @param items - The set of {key, label} choices to pick from
  @param allowFreeText - Accept free-form text in addition to item keys
  @param allowCancel - When true, Escape cancels the whole request,
    raising a cancellation that unwinds the run, instead of re-prompting.
    The default of false enforces a "must answer" contract

In a terminal this is an arrow-key picker; otherwise it is a numbered
list read with `input()`, which is what scripted and headless runs
see. Both branches re-ask until the user answers. std::policy uses it
for its approve/reject menus.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |
| body | `string` |  |
| items | `ChoiceItem[]` |  |
| allowFreeText | `boolean` | false |
| allowCancel | `boolean` | false |

**Returns:** `string`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L268))

### interruptChoice

```ts
interruptChoice(
  title: string,
  body: string,
  items: any[],
  allowFreeText: boolean = false,
  allowCancel: boolean = false,
  expectsValue: boolean = false,
): string
```

Approval prompt for line mode: renders a sticky footer pinned to the
  bottom of the terminal so concurrent tool-call output streams above it
  instead of burying the prompt. Type an option key or a rejection reason,
  then press Enter. Falls back to `chooseOption` when no line-mode REPL is
  active (a non-TTY or a headless run).

  @param title - Prompt heading (the interrupt message).
  @param body - Multi-line context shown under the title (or "").
  @param items - The {key, label} choices.
  @param allowFreeText - Accept a free-form rejection reason.
  @param allowCancel - When true, Escape cancels the whole request.
  @param expectsValue - True when the interrupt wants a value back, so the text the user types is their answer. Otherwise typed text is a rejection reason.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |
| body | `string` |  |
| items | `any[]` |  |
| allowFreeText | `boolean` | false |
| allowCancel | `boolean` | false |
| expectsValue | `boolean` | false |

**Returns:** `string`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L369))
