---
name: "cli"
description: "Terminal conversations, menus, text entry, and approval prompts."
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
  import { chooseOption } from "std::ui/cli"

  const choice = chooseOption("Next step", "", [
    { key: "continue", label: "Continue working" },
    { key: "stop", label: "Stop here" },
  ])
  print(choice)
  ```

## Types

### ChoiceItem

A row in a choice prompt: the `key` is what the prompt returns, the
`label` is the text shown to the user. `interruptChoice` also reads
`detail`, shown dim after the label to say what the answer covers, and
`tone`, which colors the key green for an approval or red for a rejection.

```ts
/**
A row in a choice prompt: the `key` is what the prompt returns, the
`label` is the text shown to the user. `interruptChoice` also reads
`detail`, shown dim after the label to say what the answer covers, and
`tone`, which colors the key green for an approval or red for a rejection.
*/
export type ChoiceItem = {
  key: string;
  label: string;
  detail?: string;
  tone?: "approve" | "reject"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L152))

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
  herdrName: string = "",
)
```

Run a terminal conversation loop, calling onSubmit for each submitted line.

Each non-empty submitted line calls `onSubmit`. Returning false exits; a
non-empty string is printed, and a list of interrupts is shown as a turn
without a reply. Other return values are ignored.

The terminal supports line editing, history, slash-command completion, and
a busy indicator. Escape cancels an active turn; Ctrl+D or Ctrl+C exits at
an idle prompt. `/paste` opens a multi-line editor: Enter adds a newline,
Ctrl+D submits, and Ctrl+C or Escape cancels the paste.

Ctrl+G opens the text typed so far in `$EDITOR`, and submits what you save.
Tab completes a file path in a last word that starts with `@`, such as
`@lib/ma`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| status | `any` |  | Callback returning {left, right, context} strings for the footer, or null |
| onSubmit | `any` |  | Return false to exit, a string to print, or interrupts that stopped the turn |
| prompt | `string` | "> " |  |
| historyFile | `string` | "" | JSON history path; empty disables persistence |
| historyMax | `number` | 1000 | Maximum number of recent history entries to retain |
| paletteCommands | `any` | null | Object mapping /commands to descriptions; null uses setSlashPalette |
| herdrName | `string` | "" | Name shown in a Herdr pane; empty disables state reporting |

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L65))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L101))

### lineWasTyped

```ts
lineWasTyped(): boolean
```

True when the line the repl is handling was typed and entered by hand.

Use this before acting on a line in a way no approval covers. Text the
user pasted, wrote in `/paste`, or wrote in their editor is not typed, and
neither is a line read from a pipe. Outside a `repl()` callback it is
always false.

**Returns:** `boolean`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L113))

### clearScreen

```ts
clearScreen()
```

Clear the terminal screen.

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L121))

### clearHistory

```ts
clearHistory()
```

Clear the active repl session's input recall and saved history file.
  Does nothing outside an interactive repl.

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L126))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L139))

### pushMessage

```ts
pushMessage(message: string)
```

Print a message to the terminal.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L160))

### select

```ts
select(
  message: string,
  items: ChoiceItem[],
  allowFreeText: boolean = false,
  hint: string = "",
): Result<string>
```

Ask the user to choose with arrow keys in a terminal. Returns the selected
  key, free text when enabled, or a failure if cancelled.

Requires stdout to be a terminal. Ctrl+C exits the process. There is no
non-TTY fallback, so a scripted caller must route around it
(`chooseOption` does).

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| message | `string` |  |  |
| items | `ChoiceItem[]` |  |  |
| allowFreeText | `boolean` | false | Add a choice that opens a text-entry prompt |
| hint | `string` | "" | Dim hint shown after the question |

**Returns:** `Result<string>`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L173))

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

Ask the user to choose in a terminal, filtering keys by case-insensitive
  substring. Returns the selected key, free text when enabled, or a failure
  if cancelled.

Requires stdout to be a terminal. Ctrl+C exits the process.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| message | `string` |  |  |
| items | `ChoiceItem[]` |  |  |
| allowFreeText | `boolean` | false | Offer the typed text when no key matches |
| hint | `string` | "" | Dim hint shown after the question |
| cancelOnEscape | `boolean` | false | Cancel the current request instead of returning a cancellation failure |

**Returns:** `Result<string>`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L193))

### prompt

```ts
prompt(
  message: string,
  initial: string = "",
  hint: string = "",
  validate: any = null,
): Result<string>
```

Ask the user for a line of text in a terminal, or return a cancellation failure.

Requires stdout to be a terminal. Ctrl+C exits the process.

An empty string is a valid answer; check the Result tag rather than truthiness.
Bind `validate` via `.partial()` before handing `prompt` to an LLM as
a tool so the LLM cannot override the constraint.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| message | `string` |  |  |
| initial | `string` | "" | Prefilled answer |
| hint | `string` | "" | Dim hint shown after the question |
| validate | `any` | null | Callback returning true to accept, or an error message to ask again |

**Returns:** `Result<string>`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L220))

### confirm

```ts
confirm(message: string, initial: boolean = false): Result<boolean>
```

Ask a yes/no question in a terminal. Returns success(true), success(false),
  or a cancellation failure; check the Result tag before reading the answer.

Requires stdout to be a terminal. Ctrl+C exits the process.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| initial | `boolean` | false |

**Returns:** `Result<boolean>`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L240))

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

Ask the user to select a key, using a terminal picker or a plain input prompt.
  Invalid answers are requested again.

In a terminal this is an arrow-key picker. Otherwise it prints the
title and body and reads a key with `input()`, which is what scripted
and headless runs see. Both branches re-ask after a cancelled choice unless `allowCancel` is true.
In a terminal, Ctrl+C exits the process regardless of `allowCancel`.
std::policy uses it for its approve/reject menus.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| title | `string` |  |  |
| body | `string` |  | Additional context shown above the choices; empty omits it |
| items | `ChoiceItem[]` |  |  |
| allowFreeText | `boolean` | false | Accept a non-empty answer that matches no item key |
| allowCancel | `boolean` | false | In a terminal, let Escape cancel the request instead of asking again |

**Returns:** `string`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L278))

### interruptBodyWidth

```ts
interruptBodyWidth(): number
```

The width, in columns, that the approval prompt wraps its body to. Render a table at this width so the prompt does not wrap it a second time.

**Returns:** `number`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L378))

### interruptChoice

```ts
interruptChoice(
  title: string,
  body: string,
  items: any[],
  allowFreeText: boolean = false,
  allowCancel: boolean = false,
  expectsValue: boolean = false,
  risk: string = "",
): string
```

Ask for an approval choice or a free-text answer, using the active terminal
  conversation when available.

During a line-mode `repl`, the prompt stays at the bottom of the terminal
while tool output appears above it. Outside that session, this delegates
to `chooseOption`, including its plain-input fallback.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| title | `string` |  |  |
| body | `string` |  | Additional context shown below the heading |
| items | `any[]` |  | Choices with key and label fields |
| allowFreeText | `boolean` | false | Accept an answer outside the listed choices |
| allowCancel | `boolean` | false | Let Escape cancel the current request in a terminal |
| expectsValue | `boolean` | false | Treat free text as an answer value instead of a rejection reason |
| risk | `string` | "" | "read", "change", or "danger": colors the prompt's divider and labels it "approval needed". Empty for a plain divider. |

**Returns:** `string`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui/cli.agency#L391))
