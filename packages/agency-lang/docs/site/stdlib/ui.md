# ui

## Overview

  Declarative terminal UI for interactive CLI agents. Two layers
  cooperate so you can pick the level of abstraction that fits the
  task:

  - **Layer 1 — Builders + runLoop.** Pure-function builders
    (`column`, `row`, `box`, `line`, `text`, `list`, `textInput`)
    assemble an `Element` tree; `runLoop` owns the render → key →
    re-render cycle and returns the final state when `isDone`
    returns true.
  - **Layer 2 — `repl()`.** A drop-in widget for chat-style agents.
    Owns one transcript buffer plus a live status line, a slash
    command palette, and a history-aware input bar. Submitted
    prompts, `pushMessage(...)`, and string replies from `onSubmit`
    all append to the transcript buffer; rendering projects that
    buffer into the output pane. Backed by Layer 1; integrates with
    `std::policy.cliPolicyHandler` so interrupt prompts render
    through the active screen instead of fighting with the input bar.

  ## Usage: Layer 1 (custom widgets)

  ```ts
  import { runLoop, column, line, KeyEvent, Element } from "std::ui"

  type S = { n: number; done: boolean }

  def view(s: S): Element {
    return column() as col {
      col.line("count = ${s.n}", bold: true)
      col.line("(↑ / ↓ to change, q to quit)")
    }
  }

  def reduce(s: S, k: KeyEvent): S {
    if (k.key == "up")   { return { ...s, n: s.n + 1 } }
    if (k.key == "down") { return { ...s, n: s.n - 1 } }
    if (k.key == "q")    { return { ...s, done: true } }
    return s
  }

  def isDone(s: S): boolean { return s.done }

  node main(): number {
    const final = runLoop(initialState: { n: 0, done: false },
                          render: view, handleKey: reduce, isDone: isDone)
    return final.n
  }
  ```

  ## Usage: Layer 2 (chat-style agent REPL)

  ```ts
  import { repl } from "std::ui"
  import { cliPolicyHandler } from "std::policy"

  def status(): { left: string, right: string } {
    return { left: "agent", right: "" }
  }

  def onSubmitPrompt(prompt: string): any {
    if (prompt == "/exit") {
      return false
    }
    // ...call your model / route / tools here...
    return "agent: <reply>"
  }

  node main() {
    const handler = cliPolicyHandler({ file: ".policy.json", fields: {} })
    handle {
      repl(status: status, onSubmit: onSubmitPrompt,
           paletteCommands: { "/exit": "Exit" })
    } with handler
  }
  ```

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L100))

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
  ctrl?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L121))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L139))

### ReplInputState

```ts
type ReplInputState = {
  buffer: string;
  history: string[];
  historyIdx: number;
  prompt: string;
  historyFile: string;
  historyMax: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L853))

### ReplPaletteState

```ts
type ReplPaletteState = {
  open: boolean;
  filter: string;
  cursor: number;
  commands: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L862))

### ReplTranscriptState

```ts
type ReplTranscriptState = {
  messages: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L869))

### ReplSubmitState

```ts
type ReplSubmitState = {
  busy: boolean;
  label: string;
  startedAtMs: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L873))

### ReplConfigState

```ts
type ReplConfigState = {
  status: any;
  onSubmit: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L879))

### ReplState

```ts
type ReplState = {
  input: ReplInputState;
  palette: ReplPaletteState;
  transcript: ReplTranscriptState;
  submit: ReplSubmitState;
  config: ReplConfigState;
  done: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L884))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L158))

### _setStyleIfSet

```ts
_setStyleIfSet(style: any, key: string, value: any)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| style | `any` |  |
| key | `string` |  |
| value | `any` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L179))

### line

```ts
line(content: string, flex: number, width: number, height: number, fg: string, bg: string, bold: boolean): Element
```

Build a single-line text element with `height: 1`. The default keeps
  it from stretching via flex when placed inside a `column`. Style
  fields (`fg`, `bg`, `bold`) and layout fields (`flex`, `width`,
  `height`) merge on top of the height-1 default.

  @param content - The text to render
  @param flex - Flex grow factor; omit for natural width
  @param width - Fixed character width; omit for natural width
  @param height - Override the default height of 1
  @param fg - Foreground color (named or hex like "#fff")
  @param bg - Background color (named or hex like "#000")
  @param bold - Render the text bold

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

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L193))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L242))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L291))

### _mkBoxStyle

```ts
_mkBoxStyle(flexDirection: string, flex: number, width: number, height: number, padding: number, border: boolean, borderColor: string, label: string, bg: string, fg: string, visible: boolean): any
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| flexDirection | `string` |  |
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

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L335))

### _makeBuilder

```ts
_makeBuilder(kids: any[]): Builder
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |

**Returns:** [Builder](#builder)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L365))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L381))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L445))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L503))

### _addRow

```ts
_addRow(kids: any[], flex: number, width: number, height: number, padding: number, border: boolean, borderColor: string, label: string, bg: string, fg: string, visible: boolean, block: (Builder) => void): Element
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L560))

### _addColumn

```ts
_addColumn(kids: any[], flex: number, width: number, height: number, padding: number, border: boolean, borderColor: string, label: string, bg: string, fg: string, visible: boolean, block: (Builder) => void): Element
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L591))

### _addBox

```ts
_addBox(kids: any[], flex: number, width: number, height: number, padding: number, border: boolean, borderColor: string, label: string, bg: string, fg: string, visible: boolean, block: (Builder) => void): Element
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L622))

### _addLine

```ts
_addLine(kids: any[], content: string, flex: number, width: number, height: number, fg: string, bg: string, bold: boolean): Element
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| content | `string` |  |
| flex | `number` | null |
| width | `number` | null |
| height | `number` | null |
| fg | `string` | "" |
| bg | `string` | "" |
| bold | `boolean` | false |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L653))

### _addText

```ts
_addText(kids: any[], content: string): Element
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| content | `string` |  |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L676))

### _addList

```ts
_addList(kids: any[], items: string[], selectedIndex: number, flex: number, width: number, height: number, border: boolean, borderColor: string, visible: boolean): Element
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| items | `string[]` |  |
| selectedIndex | `number` | 0 |
| flex | `number` | null |
| width | `number` | null |
| height | `number` | null |
| border | `boolean` | false |
| borderColor | `string` | "" |
| visible | `boolean` | true |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L682))

### _addTextInput

```ts
_addTextInput(kids: any[], value: string, flex: number, width: number, height: number, fg: string, bg: string): Element
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| value | `string` | "" |
| flex | `number` | null |
| width | `number` | null |
| height | `number` | null |
| fg | `string` | "" |
| bg | `string` | "" |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L707))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L735))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L751))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L779))

### _routePrompt

```ts
_routePrompt(text: string, choices: string[]): string
```

Route a prompt through the active REPL when one exists, or fall
  back to raw `print` + `input` otherwise. Used by other stdlib
  modules (notably `std::policy`) to surface interactive prompts
  without fighting with the input bar.

  @param text - The menu/question text shown to the user
  @param choices - The set of strings the user's answer must match

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| choices | `string[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L825))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L900))

### clearMessages

```ts
clearMessages()
```

Remove all messages from the active repl() transcript. Intended
  for explicit "clear conversation" commands inside interactive
  agents. Silent no-op when no repl() is active.

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L921))

### _entryKey

```ts
_entryKey(entry: any): string
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| entry | `any` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L938))

### _filteredPaletteKeys

```ts
_filteredPaletteKeys(state: ReplState): string[]
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L946))

### _matchesFilter

```ts
_matchesFilter(name: string, filterText: string): boolean
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| filterText | `string` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L955))

### _busyLine

```ts
_busyLine(state: ReplState): string
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L959))

### _replView

```ts
_replView(state: ReplState): Element
```

* View: the full terminal. `state.transcript.messages` is the single
 * output buffer and is projected into an auto-scrolling list at the
 * top. Palette + status + input pin to the bottom because none of
 * them are flex; standard `flex-start` column layout packs flex:1
 * first, then the fixed-height tail items.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L976))

### _submitPrompt

```ts
_submitPrompt(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1038))

### _recallPreviousHistory

```ts
_recallPreviousHistory(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1066))

### _recallNextHistory

```ts
_recallNextHistory(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1078))

### _closePalette

```ts
_closePalette(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1094))

### _selectPaletteCommand

```ts
_selectPaletteCommand(state: ReplState, paletteKeys: string[]): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |
| paletteKeys | `string[]` |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1106))

### _movePaletteCursor

```ts
_movePaletteCursor(state: ReplState, paletteKeys: string[], delta: number): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |
| paletteKeys | `string[]` |  |
| delta | `number` |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1125))

### _removePaletteFilterCharacter

```ts
_removePaletteFilterCharacter(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1147))

### _appendPaletteFilterCharacter

```ts
_appendPaletteFilterCharacter(state: ReplState, character: string): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |
| character | `string` |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1158))

### _replReducePaletteOpen

```ts
_replReducePaletteOpen(state: ReplState, keyEvent: KeyEvent): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |
| keyEvent | [KeyEvent](#keyevent) |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1172))

### _appendInputCharacter

```ts
_appendInputCharacter(state: ReplState, character: string): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |
| character | `string` |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1188))

### _removeInputCharacter

```ts
_removeInputCharacter(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1198))

### _openPalette

```ts
_openPalette(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1208))

### _replReduce

```ts
_replReduce(state: ReplState, keyEvent: KeyEvent): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |
| keyEvent | [KeyEvent](#keyevent) |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1220))

### _replIsDone

```ts
_replIsDone(state: ReplState): boolean
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | [ReplState](#replstate) |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1241))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1245))
