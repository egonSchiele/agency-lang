---
name: "ui"
---

# ui

Builds interactive terminal UIs for CLI agents. Assemble a screen from
  builders like `column`, `row`, `box`, `text`, and `textInput`, then drive
  the render loop with `runLoop`. For chat-style agents, `repl()` is a
  drop-in widget bundling a scrollable transcript, a live status line, a
  slash-command palette, and an input bar with history. For quick one-off
  questions outside a `repl()`, use the line-mode prompts `select`,
  `autocomplete`, `prompt`, and `confirm`.

  ```ts
  import { repl } from "std::ui"

  def status(): string {
    return "ready"
  }

  def onLine(line: string): any {
    return "you said: " + line
  }

  node main() {
    repl(status: status, onSubmit: onLine)
  }
  ```

## Types

### Element

* Opaque tree node. The builder functions below produce it. Only
 * `runLoop` and `renderOnce` consume it. Users do not construct one
 * directly.

```ts
/**
 * Opaque tree node. The builder functions below produce it. Only
 * `runLoop` and `renderOnce` consume it. Users do not construct one
 * directly.
 */
export type Element = {
  type: string;
  style?: any;
  content?: string;
  children?: any[];
  items?: string[];
  selectedIndex?: number;
  value?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L68))

### KeyEvent

* Keystroke delivered to `handleKey` blocks.
 *
 * `key` is either a named special key — `"up"`, `"down"`, `"left"`,
 * `"right"`, `"enter"`, `"escape"`, `"backspace"`, `"tab"`,
 * `"home"`, `"end"`, `"pageup"`, `"pagedown"`, `"delete"`,
 * `"insert"` — or a single printable character (e.g. `"q"`, `"/"`,
 * `" "`). Mirrors the encoding in `lib/tui/input/terminal.ts`.
 *
 * `shift` / `ctrl` indicate held modifier keys at keypress time.

```ts
/**
 * Keystroke delivered to `handleKey` blocks.
 *
 * `key` is either a named special key — `"up"`, `"down"`, `"left"`,
 * `"right"`, `"enter"`, `"escape"`, `"backspace"`, `"tab"`,
 * `"home"`, `"end"`, `"pageup"`, `"pagedown"`, `"delete"`,
 * `"insert"` — or a single printable character (e.g. `"q"`, `"/"`,
 * `" "`). Mirrors the encoding in `lib/tui/input/terminal.ts`.
 *
 * `shift` / `ctrl` indicate held modifier keys at keypress time.
 */
export type KeyEvent = {
  key: string;
  shift?: boolean;
  ctrl?: boolean;
  text?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L89))

### Builder

* Builder receiver passed to every container block. Method calls
 * append child elements to the enclosing parent in source order.
 *
 * Container methods (`row`, `column`, `box`) take a trailing block
 * that receives a fresh Builder for the new child's contents. Leaf
 * methods (`line`, `text`, `list`, `textInput`) don't.
 *
 * The methods are typed `any` because each one accepts a different
 * named-arg signature. The top-level builders (`column`, `row`, etc.)
 * document the full signatures.

```ts
/**
 * Builder receiver passed to every container block. Method calls
 * append child elements to the enclosing parent in source order.
 *
 * Container methods (`row`, `column`, `box`) take a trailing block
 * that receives a fresh Builder for the new child's contents. Leaf
 * methods (`line`, `text`, `list`, `textInput`) don't.
 *
 * The methods are typed `any` because each one accepts a different
 * named-arg signature. The top-level builders (`column`, `row`, etc.)
 * document the full signatures.
 */
export type Builder = {
  row: any;
  column: any;
  box: any;
  line: any;
  text: any;
  list: any;
  textInput: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L108))

### ChoiceItem

* One option in a `chooseOption()` modal. `key` is the value the
 * Promise resolves to when the user picks this row; `label` is the
 * human-readable text rendered in the modal.

```ts
/**
 * One option in a `chooseOption()` modal. `key` is the value the
 * Promise resolves to when the user picks this row; `label` is the
 * human-readable text rendered in the modal.
 */
export type ChoiceItem = {
  key: string;
  label: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L833))

## Functions

### text

```ts
text(content: string): Element
```

Build a plain text element. It carries no layout sizing of its own,
  so nest it inside a container to position it.

  @param content - The text to render

* A plain text element. It carries no layout sizing, so embed it
 * inside a `box` or `column` for layout. Prefer `line` when you want a
 * single-row height-1 element.
 *
 * @param content - The text to render

**Parameters:**

| Name | Type | Default |
|---|---|---|
| content | `string` |  |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L127))

### line

```ts
line(
  content: string,
  flex: number = null,
  width: number = null,
  height: number = null,
  fg: string = "",
  bg: string = "",
  bold: boolean = false,
  fill: string = "",
): Element
```

Build a single-line text element (height 1) so it does not stretch
  vertically inside a container. Style and layout fields merge on top
  of that default.

  Set `fill` to a single character (e.g. `"─"`) to repeat that
  character across the unused width, turning an empty-content line
  into a horizontal rule.

  @param content - The text to render
  @param flex - Flex grow factor; omit for natural width
  @param width - Fixed character width; omit for natural width
  @param height - Override the default height of 1
  @param fg - Foreground color (named or hex like "#fff")
  @param bg - Background color (named or hex like "#000")
  @param bold - Render the text bold
  @param fill - Character used to pad unused cells (default: space)

* A single-line text element with `height: 1`. The default keeps it
 * from stretching via flex when placed inside a `column`. Caller-
 * provided style merges on top.
 *
 * @param content - The text to render

**Parameters:**

| Name | Type | Default |
|---|---|---|
| content | `string` |  |
| flex | `number` | null |
| width | `number` | null |
| height | `number` | null |
| fg | `string` | "" |
| bg | `string` | "" |
| bold | `boolean` | false |
| fill | `string` | "" |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L166))

### list

```ts
list(
  items: string[],
  selectedIndex: number = 0,
  flex: number = null,
  width: number = null,
  height: number = null,
  border: boolean = false,
  borderColor: string = "",
  visible: boolean = true,
): Element
```

Build a scrollable selectable list. `selectedIndex` highlights one
  row, and the renderer clamps out-of-range values. When `height`
  is smaller than `items.length`, the list auto-scrolls so the
  selected row stays visible.

  @param items - The strings to display, one per row
  @param selectedIndex - 0-based row to highlight (default 0)
  @param flex - Flex grow factor when nested inside a column/row
  @param width - Fixed character width
  @param height - Fixed row count (otherwise uses available space)
  @param border - Draw a single-line border around the list
  @param borderColor - Color name or hex for the border
  @param visible - Set false to render the element as zero-height

* A scrollable selectable list. `selectedIndex` highlights one row.
 * The renderer clamps out-of-range values.
 *
 * @param items - The strings to display, one per row
 * @param selectedIndex - 0-based row to highlight (default 0)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| items | `string[]` |  |
| selectedIndex | `number` | 0 |
| flex | `number` | null |
| width | `number` | null |
| height | `number` | null |
| border | `boolean` | false |
| borderColor | `string` | "" |
| visible | `boolean` | true |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L221))

### textInput

```ts
textInput(
  value: string = "",
  flex: number = null,
  width: number = null,
  height: number = null,
  fg: string = "",
  bg: string = "",
): Element
```

Build a single-line text input. The renderer displays `value` with
  a cursor. The caller owns key handling: append printable characters
  and process backspace / enter in the loop's key handler.

  @param value - Current contents of the buffer
  @param flex - Flex grow factor (typical: 1 inside a row)
  @param width - Fixed character width (omit to flex)
  @param height - Fixed row count (defaults to 1)
  @param fg - Foreground color (named or hex)
  @param bg - Background color (named or hex)

* A single-line text input. The renderer displays `value` with a
 * cursor. The caller owns key handling; use `runLoop`'s `handleKey`
 * to append characters and handle backspace.
 *
 * @param value - Current contents of the buffer

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` | "" |
| flex | `number` | null |
| width | `number` | null |
| height | `number` | null |
| fg | `string` | "" |
| bg | `string` | "" |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L270))

### column

```ts
column(
  flex: number = null,
  width: number = null,
  height: number = null,
  padding: number = null,
  border: boolean = false,
  borderColor: string = "",
  label: string = "",
  bg: string = "",
  fg: string = "",
  visible: boolean = true,
  block: (Builder) -> void = null,
): Element
```

Build a vertical container; children stack top-to-bottom. Pass a
  trailing `as name { ... }` block whose builder appends children in
  source order.

  @param flex - Flex grow factor when nested inside a parent
  @param width - Fixed character width
  @param height - Fixed row count
  @param padding - Inner padding (cells on all sides)
  @param border - Draw a single-line border
  @param borderColor - Color name or hex for the border
  @param label - Optional title rendered into the top border
  @param bg - Background color (named or hex)
  @param fg - Foreground color (named or hex)
  @param visible - Set false to render as zero-height
  @param block - Builder callback; appended children populate the column

* A vertical container. Children stack top-to-bottom. The trailing
 * block receives a fresh `Builder` to populate the column.
 *
 * Always pass at least one named arg: `column() as col { ... }` parses
 * positionally, which lands the block in `flex`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| flex | `number` | null |
| width | `number` | null |
| height | `number` | null |
| padding | `number` | null |
| border | `boolean` | false |
| borderColor | `string` | "" |
| label | `string` | "" |
| bg | `string` | "" |
| fg | `string` | "" |
| visible | `boolean` | true |
| block | `(Builder) => void` | null |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L362))

### row

```ts
row(
  flex: number = null,
  width: number = null,
  height: number = null,
  padding: number = null,
  border: boolean = false,
  borderColor: string = "",
  label: string = "",
  bg: string = "",
  fg: string = "",
  visible: boolean = true,
  block: (Builder) -> void = null,
): Element
```

Build a horizontal container; children stack left-to-right. Pass a
  trailing `as name { ... }` block whose builder appends children in
  source order.

  @param flex - Flex grow factor when nested inside a parent
  @param width - Fixed character width
  @param height - Fixed row count
  @param padding - Inner padding (cells on all sides)
  @param border - Draw a single-line border
  @param borderColor - Color name or hex for the border
  @param label - Optional title rendered into the top border
  @param bg - Background color (named or hex)
  @param fg - Foreground color (named or hex)
  @param visible - Set false to render as zero-height
  @param block - Builder callback; appended children populate the row

* A horizontal container. Children stack left-to-right. The trailing
 * block receives a fresh `Builder` to populate the row.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| flex | `number` | null |
| width | `number` | null |
| height | `number` | null |
| padding | `number` | null |
| border | `boolean` | false |
| borderColor | `string` | "" |
| label | `string` | "" |
| bg | `string` | "" |
| fg | `string` | "" |
| visible | `boolean` | true |
| block | `(Builder) => void` | null |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L421))

### box

```ts
box(
  flex: number = null,
  width: number = null,
  height: number = null,
  padding: number = null,
  border: boolean = false,
  borderColor: string = "",
  label: string = "",
  bg: string = "",
  fg: string = "",
  visible: boolean = true,
  block: (Builder) -> void = null,
): Element
```

Build a direction-neutral container. Use it to apply styling
  (border, padding, background) without forcing a row/column layout,
  e.g. as a flex spacer (`box(flex: 1) as _ {}`).

  @param flex - Flex grow factor when nested inside a parent
  @param width - Fixed character width
  @param height - Fixed row count
  @param padding - Inner padding (cells on all sides)
  @param border - Draw a single-line border
  @param borderColor - Color name or hex for the border
  @param label - Optional title rendered into the top border
  @param bg - Background color (named or hex)
  @param fg - Foreground color (named or hex)
  @param visible - Set false to render as zero-height
  @param block - Builder callback; appended children populate the box

* A direction-neutral container. Use when you want to apply styling
 * (border, padding, background) without setting `flexDirection`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| flex | `number` | null |
| width | `number` | null |
| height | `number` | null |
| padding | `number` | null |
| border | `boolean` | false |
| borderColor | `string` | "" |
| label | `string` | "" |
| bg | `string` | "" |
| fg | `string` | "" |
| visible | `boolean` | true |
| block | `(Builder) => void` | null |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L478))

### renderOnce

```ts
renderOnce(tree: Element)
```

Render a single Element tree to the screen and return immediately.
  Useful for static UI or first-paint scenarios.

  @param tree - The element tree to render

* Render a single Element tree to the screen and return immediately.
 * For static UI or first-paint scenarios. For interactive UI, use
 * `runLoop`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| tree | [Element](#element) |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L710))

### readKey

```ts
readKey(): KeyEvent
```

Read one key from the terminal, blocking until a key is pressed.
  Returns a `KeyEvent` whose `key` field is either a named special key
  (`"up"`, `"enter"`, `"escape"`, ...) or a single printable character.

* Read one key from the terminal. Blocks until a key is pressed.
 * Use sparingly; prefer `runLoop` for anything beyond a single
 * blocking prompt.

**Returns:** [KeyEvent](#keyevent)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L725))

### runLoop

```ts
runLoop(
  initialState: any,
  render: any,
  handleKey: any,
  isDone: any,
  tickMs: number = null,
): any
```

Elm/Ink-style state machine driver. Renders `initialState`, waits
  for each `KeyEvent`, runs `handleKey` to produce the next state,
  re-renders, exits when `isDone` returns true. Returns the final
  state.

  When `tickMs` is set, the loop also re-renders periodically even
  if no key is pressed. This is what makes a live status line tick.
  `handleKey` does NOT fire on ticks; only `render` does (so it can
  re-read any impure state your view depends on).

  @param initialState - The opening state record
  @param render - Pure (state) -> Element; re-runs every tick / key
  @param handleKey - Pure (state, key) -> state; runs on real keys only
  @param isDone - Pure (state) -> boolean; loop exits when true
  @param tickMs - Milliseconds between forced re-renders (omit for event-driven only)

* Elm/Ink-style state machine driver. Renders the initial state,
 * waits for each `KeyEvent`, runs `handleKey` to produce the next
 * state, re-renders, exits when `isDone` returns `true`. Returns
 * the final state.
 *
 * When `tickMs` is set, the loop also re-renders periodically even
 * if no key is pressed. This is what makes a live status line tick.
 * `handleKey` does NOT fire on ticks. Only `render` does,
 * re-evaluating any impure state your view reads.
 *
 * @param initialState - The opening state record
 * @param render       - Pure (state) -> Element. Re-runs every tick / key.
 * @param handleKey    - Pure (state, key) -> state. Runs only on real keys.
 * @param isDone       - Pure (state) -> boolean. Loop exits when true.
 * @param tickMs       - Milliseconds between forced re-renders (omit for event-driven only)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| initialState | `any` |  |
| render | `any` |  |
| handleKey | `any` |  |
| isDone | `any` |  |
| tickMs | `number` | null |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L751))

### pushMessage

```ts
pushMessage(message: string)
```

Append a message to the active REPL transcript. It renders on the
  next frame. The string may include style markup, which the
  transcript stores unchanged. When no REPL is active, the message
  prints normally instead.

  @param message - Styled or plain text to append to the transcript

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L869))

### clearMessages

```ts
clearMessages()
```

Remove all messages from the active REPL transcript. Use it for an
  explicit "clear conversation" command. Silent no-op when no REPL is
  active.

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L888))

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

* Raises if a `repl()` owns the screen, or if stdout is not a TTY.
 * When a `repl()` owns the screen, use an in-TUI modal prompt instead.
 * Non-TTY output has no fallback, so the caller must script around it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| items | `ChoiceItem[]` |  |
| allowFreeText | `boolean` | false |
| hint | `string` | "" |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L910))

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

* Raises if a `repl()` owns the screen or if stdout is not a TTY.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| items | `ChoiceItem[]` |  |
| allowFreeText | `boolean` | false |
| hint | `string` | "" |
| cancelOnEscape | `boolean` | false |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L934))

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

* Named `prompt` rather than `text` to avoid colliding with the Layer 1
 * `text` element builder. Raises if a `repl()` owns the screen or if
 * stdout is not a TTY.
 *
 * Bind `validate` via `.partial()` before handing `prompt` to an LLM as
 * a tool so the LLM cannot override the constraint.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| initial | `string` | "" |
| hint | `string` | "" |
| validate | `any` | null |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L968))

### confirm

```ts
confirm(message: string, initial: boolean = false): Result<boolean>
```

Ask the user a yes/no question. Returns `success(true)`,
  `success(false)`, or `failure("cancelled")`. That is three outcomes,
  so check the Result tag rather than treating it as a boolean.

  @param message - The question shown to the user
  @param initial - Default position (false = "no")

* Raises if a `repl()` owns the screen or if stdout is not a TTY.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| initial | `boolean` | false |

**Returns:** `Result<boolean>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L992))

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

Show a modal choice prompt and block until the user picks one. Returns
  the chosen item's `key`. The modal takes over key input until the user
  confirms (Enter) or cancels (Escape). Typing narrows the visible items
  by substring match on `key` or `label`. When `allowFreeText` is true
  and the typed text matches no item, it resolves with that text instead
  of re-prompting (empty input still re-prompts).

  @param title - Modal heading (e.g. "Approve interrupt: shell::exec")
  @param body - Multi-line context shown above the choices (or "")
  @param items - The set of {key, label} choices to pick from
  @param allowFreeText - Accept free-form text in addition to item keys
  @param allowCancel - When true, Escape cancels the whole request,
    raising a cancellation that unwinds the run, instead of re-prompting.
    The default of false enforces a "must answer" contract

* When no `repl()` is running, falls back to a plain print + input
 * loop that re-asks until the user answers. std::policy uses it to
 * surface its approve/reject menus through the active REPL without
 * fighting the input bar.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |
| body | `string` |  |
| items | `ChoiceItem[]` |  |
| allowFreeText | `boolean` | false |
| allowCancel | `boolean` | false |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L1032))

### repl

```ts
repl(
  status: any,
  onSubmit: any,
  prompt: string = "> ",
  historyFile: string = "",
  historyMax: number = 1000,
  paletteCommands: any = null,
  tickMs: number = null,
)
```

Drop-in REPL widget for interactive CLI agents. Bundles a scrollable
  output area, a live status line, a slash-command palette (triggered
  by `/`), and an input line with history navigation. It owns the full
  terminal (alt-screen) and one transcript buffer. Submitted prompts,
  appended messages, and string replies from `onSubmit` all show up in
  that buffer. Returning false from `onSubmit` exits. While it is
  active, the transcript captures any console / stdout / stderr writes
  from code running underneath, instead of losing them behind the
  alt-screen.

  @param status - Re-evaluated every render; populates the status line
  @param onSubmit - Called with the submitted line; return a string to append or false to exit
  @param prompt - String shown before the input buffer (default "> ")
  @param historyFile - Reserved for future use (history persistence is v2)
  @param historyMax - Trim oldest history entries beyond this count
  @param paletteCommands - Map of /cmd -> description, iterated in order
  @param tickMs - Render cadence in ms; null (default) is event-driven

* A positive `tickMs` enables live status / spinner updates between
 * keys but currently leaks one pinned runtime checkpoint per render,
 * so prefer the event-driven default.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| status | `any` |  |
| onSubmit | `any` |  |
| prompt | `string` | "> " |
| historyFile | `string` | "" |
| historyMax | `number` | 1000 |
| paletteCommands | `any` | null |
| tickMs | `number` | null |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L1791))
