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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L126))

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
  shift: boolean;
  ctrl: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L147))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L165))

## Functions

### initUI

```ts
initUI(title: string)
```

Initialize a terminal UI with a scrollable output area and a fixed input bar at the bottom. Call this once at the start of your agent. The title is shown in the scrollable output area on init; use status() to populate the status bar.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L3))

### destroyUI

```ts
destroyUI()
```

Tear down the terminal UI and restore normal terminal behavior. Called automatically on exit, but you can call it early if needed.

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L10))

### log

```ts
log(message: string)
```

Print a message to the scrollable output area. Supports ANSI colors.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L17))

### status

```ts
status(left: string, right: string)
```

Update the status bar. The left text appears on the left side, the right text on the right.

  @param left - Text for the left side
  @param right - Text for the right side

**Parameters:**

| Name | Type | Default |
|---|---|---|
| left | `string` |  |
| right | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L24))

### chat

```ts
chat(role: string, message: string)
```

Print a chat message with a colored role prefix. Built-in colors: "user" (cyan), "agent" (white). Other roles appear dim.

  @param role - The speaker role
  @param message - The message text

**Parameters:**

| Name | Type | Default |
|---|---|---|
| role | `string` | "" |
| message | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L34))

### code

```ts
code(filename: string, content: string)
```

Display a code block with a filename header and line numbers, inside a bordered box.

  @param filename - The filename to display
  @param content - The code content

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| content | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L44))

### diff

```ts
diff(filename: string, content: string)
```

Display a diff with colored +/- lines, inside a bordered box with the filename as a header.

  @param filename - The filename to display
  @param content - The diff content

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| content | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L54))

### separator

```ts
separator(label: string)
```

Print a horizontal line with an optional label. Useful for visually grouping output sections.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| label | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L64))

### startSpinner

```ts
startSpinner(text: string)
```

Show an animated spinner in the input bar with a label. Useful while the agent is thinking or running a long operation.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` | "working" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L71))

### stopSpinner

```ts
stopSpinner()
```

Stop the spinner and clear the input bar.

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L78))

### prompt

```ts
prompt(question: string): string
```

Prompt the user for text input in the fixed input bar at the bottom of the screen. The question appears as a hint. Returns the user's input as a string.

  Cancellation: a blocked prompt is released on Ctrl-C, race-loser, or time-guard abort, surfacing as an AgencyCancelledError.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| question | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L85))

### getConfirmation

```ts
getConfirmation(question: string): boolean
```

Ask the user a yes/no question in the input bar. Returns true if the user answers yes (y/yes), false otherwise. Useful inside handler blocks to approve or reject interrupts interactively.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| question | `string` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L94))

### emptyLine

```ts
emptyLine()
```

Print an empty line. Useful for adding spacing in the output.

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L105))

### text

```ts
text(content: string): Element
```

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L184))

### line

```ts
line(content: string, flex: number, width: number, height: number, fg: string, bg: string, bold: boolean): Element
```

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L195))

### list

```ts
list(items: string[], selectedIndex: number, flex: number, width: number, height: number, border: boolean, borderColor: string, visible: boolean): Element
```

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L222))

### textInput

```ts
textInput(value: string, flex: number, width: number, height: number, fg: string, bg: string): Element
```

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L249))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L276))

### _makeBuilder

```ts
_makeBuilder(kids: any[]): Builder
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |

**Returns:** [Builder](#builder)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L304))

### column

```ts
column(flex: number, width: number, height: number, padding: number, border: boolean, borderColor: string, label: string, bg: string, fg: string, visible: boolean, block: (Builder) => void): Element
```

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L320))

### row

```ts
row(flex: number, width: number, height: number, padding: number, border: boolean, borderColor: string, label: string, bg: string, fg: string, visible: boolean, block: (Builder) => void): Element
```

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L349))

### box

```ts
box(flex: number, width: number, height: number, padding: number, border: boolean, borderColor: string, label: string, bg: string, fg: string, visible: boolean, block: (Builder) => void): Element
```

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L378))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L405))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L426))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L447))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L468))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L484))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L490))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L508))
