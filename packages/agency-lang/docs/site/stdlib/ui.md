---
name: "ui"
---

# ui

## Types

### Element

* Opaque tree node. Produced only by the builder functions below;
 * consumed only by `runLoop` and `renderOnce`. Users do not
 * construct one directly.

```ts
/**
 * Opaque tree node. Produced only by the builder functions below;
 * consumed only by `runLoop` and `renderOnce`. Users do not
 * construct one directly.
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L164))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L185))

### Builder

* Builder receiver passed to every container block. Method calls
 * append child elements to the enclosing parent in source order.
 *
 * Container methods (`row`, `column`, `box`) take a trailing block
 * that receives a fresh Builder for the new child's contents. Leaf
 * methods (`line`, `text`, `list`, `textInput`) don't.
 *
 * The methods are typed `any` because each one accepts a different
 * named-arg signature; full signatures are documented on the
 * top-level builders (`column`, `row`, etc.).

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
 * named-arg signature; full signatures are documented on the
 * top-level builders (`column`, `row`, etc.).
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L204))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L941))

## Functions

### text

```ts
text(content: string): Element
```

Build a plain text element. No layout sizing — embed inside a `box`
  or `column` for layout. Prefer `line` when you want a single-row
  height-1 element. Returns an opaque tree node; pass it to `runLoop`,
  `renderOnce`, or a `Builder` method.

  @param content - The text to render

* A plain text element. No layout sizing — embed inside a `box` or
 * `column` for layout. Prefer `line` when you want a single-row
 * height-1 element.
 *
 * @param content - The text to render

**Parameters:**

| Name | Type | Default |
|---|---|---|
| content | `string` |  |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L223))

### line

```ts
line(content: string, flex: number, width: number, height: number, fg: string, bg: string, bold: boolean, fill: string): Element
```

Build a single-line text element with `height: 1`. The default keeps
  it from stretching via flex when placed inside a `column`. Style
  fields (`fg`, `bg`, `bold`) and layout fields (`flex`, `width`,
  `height`) merge on top of the height-1 default.

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
 * provided style is merged on top.
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L264))

### list

```ts
list(items: string[], selectedIndex: number, flex: number, width: number, height: number, border: boolean, borderColor: string, visible: boolean): Element
```

Build a scrollable selectable list. `selectedIndex` highlights one
  row; out-of-range values are clamped by the renderer. When `height`
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

* A scrollable selectable list. `selectedIndex` highlights one row;
 * out-of-range values are clamped by the renderer.
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L320))

### textInput

```ts
textInput(value: string, flex: number, width: number, height: number, fg: string, bg: string): Element
```

Build a single-line text input. The renderer displays `value` with
  a cursor; key handling is the caller's responsibility — use
  `runLoop`'s `handleKey` to append printable characters and process
  backspace / enter as the state machine sees fit.

  @param value - Current contents of the buffer
  @param flex - Flex grow factor (typical: 1 inside a row)
  @param width - Fixed character width (omit to flex)
  @param height - Fixed row count (defaults to 1)
  @param fg - Foreground color (named or hex)
  @param bg - Background color (named or hex)

* A single-line text input. The renderer displays `value` with a
 * cursor; key handling is the caller's responsibility (use `runLoop`'s
 * `handleKey` to append characters / handle backspace).
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L369))

### column

```ts
column(flex: number, width: number, height: number, padding: number, border: boolean, borderColor: string, label: string, bg: string, fg: string, visible: boolean, block: (Builder) => void): Element
```

Build a vertical container. Children stack top-to-bottom. Pass a
  trailing `as name { ... }` block to receive a fresh `Builder` that
  appends children in source order. Container chaining is the primary
  way to compose multi-section layouts.

  Use named args for any layout/styling option (the parser otherwise
  treats `column() as col { ... }` positionally and the block lands
  in `flex`).

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L459))

### row

```ts
row(flex: number, width: number, height: number, padding: number, border: boolean, borderColor: string, label: string, bg: string, fg: string, visible: boolean, block: (Builder) => void): Element
```

Build a horizontal container. Children stack left-to-right. Pass a
  trailing `as name { ... }` block to receive a `Builder` for the
  row's contents. All other arguments mirror `column`; see that
  function for full parameter docs.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L523))

### box

```ts
box(flex: number, width: number, height: number, padding: number, border: boolean, borderColor: string, label: string, bg: string, fg: string, visible: boolean, block: (Builder) => void): Element
```

Build a direction-neutral container. Use when you want to apply
  styling (border, padding, background) without forcing a row/column
  layout, e.g. as a flex spacer (`box(flex: 1) as _ {}`). All other
  arguments mirror `column`; see that function for full parameter
  docs.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L581))

### renderOnce

```ts
renderOnce(tree: Element)
```

Render a single Element tree to the screen and return immediately.
  Useful for static UI or first-paint scenarios. For interactive UI,
  use `runLoop` instead.

  @param tree - Opaque tree node built via the `column`/`row`/`box`/`line`/`text`/`list`/`textInput` builders

* Render a single Element tree to the screen and return immediately.
 * For static UI or first-paint scenarios. For interactive UI, use
 * `runLoop`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| tree | [Element](#element) |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L815))

### readKey

```ts
readKey(): KeyEvent
```

Read one key from the terminal. Blocks until a key is pressed.
  Use sparingly — prefer `runLoop` for anything beyond a single
  one-shot blocking prompt. Returns a `KeyEvent` whose `key` field
  is either a named special key (`"up"`, `"enter"`, `"escape"`, ...)
  or a single printable character.

* Read one key from the terminal. Blocks until a key is pressed.
 * Use sparingly; prefer `runLoop` for anything beyond a single
 * blocking prompt.

**Returns:** [KeyEvent](#keyevent)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L831))

### runLoop

```ts
runLoop(initialState: any, render: any, handleKey: any, isDone: any, tickMs: number): any
```

Elm/Ink-style state machine driver. Renders `initialState`, waits
  for each `KeyEvent`, runs `handleKey` to produce the next state,
  re-renders, exits when `isDone` returns true. Returns the final
  state.

  When `tickMs` is set, the loop also re-renders periodically even
  if no key is pressed — what makes a live status line tick.
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
 * `handleKey` does NOT fire on ticks — `render` does (re-evaluates
 * any impure state your view reads).
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L859))

### pushMessage

```ts
pushMessage(message: string)
```

Append a styled message to the active repl() transcript. The
  message renders on the next frame. The string may include std::ui
  style markup or text returned by helpers such as color(...);
  pushMessage stores it unchanged. When no repl() is active the call
  falls back to print(), so the message is still surfaced — just
  without REPL framing.

  @param message - Styled or plain text to append to the transcript

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L977))

### clearMessages

```ts
clearMessages()
```

Remove all messages from the active repl() transcript. Intended
  for explicit "clear conversation" commands inside interactive
  agents. Silent no-op when no repl() is active.

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L998))

### select

```ts
select(message: string, items: ChoiceItem[], allowFreeText: boolean, hint: string): Result<string>
```

Line-mode arrow-key picker, backed by the `prompts` package. Returns
  `success(key)` with the picked item's `key`, or `failure("cancelled")`
  if the user pressed Ctrl+C / Escape. Unlike `autocomplete`, there is
  no type-to-filter — only arrow-key navigation. When `allowFreeText`
  is true, an extra `→ enter free text…` row is appended; picking it
  triggers a follow-up text prompt whose value is returned instead of
  a key.

  Raises if called while a `repl()` owns the screen (use `chooseOption`
  for in-TUI prompts) or if `process.stdout.isTTY` is false (non-TTY
  output has no fallback; the caller must script around it).

  @param message - The question shown above the choices
  @param items - The {key, label} rows
  @param allowFreeText - Append a free-text sentinel row
  @param hint - Dim hint shown after the message

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| items | `ChoiceItem[]` |  |
| allowFreeText | `boolean` | false |
| hint | `string` | "" |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L1015))

### autocomplete

```ts
autocomplete(message: string, items: ChoiceItem[], allowFreeText: boolean, hint: string, cancelOnEscape: boolean): Result<string>
```

Line-mode type-to-filter picker, backed by `prompts.autocomplete`.
  Same return shape as `select`: `success(key)` on resolve,
  `failure("cancelled")` on Ctrl+C / Escape. The filter matches each
  item's `key` OR `label` (substring, case-insensitive). When
  `allowFreeText` is true and the typed input matches nothing, a
  synthetic `→ use as reason: "<input>"` row appears; picking it
  returns the typed text verbatim instead of a key.

  Raises on active `repl()` or non-TTY (see `select` for the same
  contract).

  @param message - The question shown above the choices
  @param items - The {key, label} rows
  @param allowFreeText - Allow returning the typed input verbatim when no item matches
  @param hint - Dim hint shown after the message
  @param cancelOnEscape - When true, pressing Escape raises a cancellation
    (AgencyCancelledError) that unwinds the current run instead of
    returning `failure("cancelled")`. Use for prompts where Escape should
    abort the whole request rather than be re-asked.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| items | `ChoiceItem[]` |  |
| allowFreeText | `boolean` | false |
| hint | `string` | "" |
| cancelOnEscape | `boolean` | false |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L1042))

### prompt

```ts
prompt(message: string, initial: string, hint: string, validate: any): Result<string>
```

Line-mode free-form text prompt, backed by `prompts.text`. Returns
  `success(typed)` or `failure("cancelled")`. The empty string is a
  legitimate value; check the Result tag, not truthiness.

  Named `prompt` rather than `text` to avoid colliding with the
  Layer 1 `text` element builder. Mental model: "prompt the user".

  Raises on active `repl()` or non-TTY.

  `validate`, when supplied, is `(value: string) => boolean | string`.
  Return `true` to accept; return a string to reject and show that
  string as the error message; `prompts` re-asks until the user
  submits a valid value or cancels. Designed for partial-application
  capability constraint: bind `validate` before handing `prompt` to
  an LLM as a tool so the LLM cannot override it.

  @param message - The question shown to the user
  @param initial - Pre-filled value
  @param hint - Dim hint shown after the message
  @param validate - Optional `(value) => true | "error message"` validator

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| initial | `string` | "" |
| hint | `string` | "" |
| validate | `any` | null |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L1073))

### confirm

```ts
confirm(message: string, initial: boolean): Result<boolean>
```

Line-mode yes/no toggle, backed by `prompts.toggle`. Returns
  `success(true)` / `success(false)` / `failure("cancelled")`. Use the
  Result tag — there are three outcomes, not two.

  Raises on active `repl()` or non-TTY.

  @param message - The question shown to the user
  @param initial - Default position (false = "no")

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| initial | `boolean` | false |

**Returns:** `Result<boolean>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L1104))

### chooseOption

```ts
chooseOption(title: string, body: string, items: ChoiceItem[], allowFreeText: boolean, allowCancel: boolean): string
```

Show a modal choice prompt over the active repl() and block until
  the user picks one. Returns the picked item's `key`. The modal
  takes over key input — the REPL's input bar, palette, and history
  navigation are inactive until the user confirms (Enter) or cancels
  (Escape). The filter input narrows the visible items by substring
  match on either `key` or `label`.

  When no repl() is currently running, falls back to a plain
  `print` + `input` loop that reprompts until the user types one of
  the valid `key`s. Used by std::policy to surface its approve/reject
  menus through the active REPL without fighting with the input bar.

  When `allowFreeText` is true and the user's typed input doesn't
  match any item key, the prompt resolves with the typed text
  instead of reprompting. In the TUI modal this fires on Enter when
  the typed filter narrows the visible items to zero; in line-mode
  fallback it fires on any non-empty input that isn't a known key.
  Empty input still reprompts. Callers (notably std::policy) use this
  to collapse "pick reject + then type reason" into a single step.

  @param title - Modal heading (e.g. "Approve interrupt: shell::exec")
  @param body - Multi-line context shown above the choices (or "")
  @param items - The set of {key, label} choices to pick from
  @param allowFreeText - Accept free-form text in addition to item keys
  @param allowCancel - When true, Escape cancels the whole request
    (raises a cancellation that unwinds the run) instead of re-prompting,
    and the menu shows an "Esc to cancel" hint. Default false preserves
    the "must answer" contract for callers where skipping isn't safe.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |
| body | `string` |  |
| items | `ChoiceItem[]` |  |
| allowFreeText | `boolean` | false |
| allowCancel | `boolean` | false |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L1140))

### repl

```ts
repl(status: any, onSubmit: any, prompt: string, historyFile: string, historyMax: number, paletteCommands: any, tickMs: number)
```

Drop-in REPL widget for interactive CLI agents. Bundles a
  scrollable output area, a live status line, a slash-command
  palette (triggered by `/`), and an input line with history
  navigation. Owns the full terminal via runLoop (alt-screen) and
  owns one transcript buffer. Submitted prompts, pushMessage(...),
  and string replies from onSubmit all append to that buffer.
  Returning false from onSubmit exits the REPL. While the REPL is
  active, console.log / .warn / .error and raw stdout/stderr writes
  from any code running underneath are captured and appended to the
  transcript instead of being dropped behind the alt-screen.

  @param status - Re-evaluated every render; populates the status line
  @param onSubmit - Called with the submitted line; return a string to append or false to exit
  @param prompt - String shown before the input buffer (default "> ")
  @param historyFile - Reserved for future use (history persistence is v2)
  @param historyMax - Trim oldest entries beyond this count
  @param paletteCommands - Map of /cmd -> description, iterated in order
  @param tickMs - Render cadence in ms. Default null = event-driven
  (status only re-renders on key events). A positive value enables
  live status / spinner updates between keys but currently leaks
  one pinned runtime checkpoint per render, so prefer the default.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ui.agency#L1909))
