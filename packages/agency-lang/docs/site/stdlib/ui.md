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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L107))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L128))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L146))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L787))

### ReplPaletteState

```ts
type ReplPaletteState = {
  open: boolean;
  filter: string;
  cursor: number;
  commands: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L796))

### ReplTranscriptState

```ts
type ReplTranscriptState = {
  messages: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L803))

### ReplSubmitState

```ts
type ReplSubmitState = {
  busy: boolean;
  label: string;
  startedAtMs: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L807))

### ReplConfigState

```ts
type ReplConfigState = {
  status: any;
  onSubmit: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L813))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L818))

## Functions

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L165))

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L179))

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L224))

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L268))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L309))

### _makeBuilder

```ts
_makeBuilder(kids: any[]): Builder
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |

**Returns:** `Builder`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L359))

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L375))

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L417))

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L457))

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L495))

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L526))

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L557))

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L588))

### _addText

```ts
_addText(kids: any[], content: string): Element
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |
| content | `string` |  |

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L611))

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L617))

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

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L642))

### renderOnce

```ts
renderOnce(tree: Element)
```

* Render a single Element tree to the screen and return immediately.
 * For static UI or first-paint scenarios. For interactive UI, use
 * `runLoop`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| tree | `Element` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L670))

### readKey

```ts
readKey(): KeyEvent
```

* Read one key from the terminal. Blocks until a key is pressed.
 * Use sparingly; prefer `runLoop` for anything beyond a single
 * blocking prompt.

**Returns:** `KeyEvent`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L679))

### runLoop

```ts
runLoop(initialState: any, render: any, handleKey: any, isDone: any, tickMs: number): any
```

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L700))

### setScriptedKeys

```ts
setScriptedKeys(keys: KeyEvent[])
```

* Seed the next `runLoop` (or `repl`) entry with a scripted key
 * sequence. Internal — used by tests in `tests/agency/ui-*`.
 *
 * @param keys - Array of `KeyEvent` records consumed in order

**Parameters:**

| Name | Type | Default |
|---|---|---|
| keys | `KeyEvent[]` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L722))

### setQuitAfterMs

```ts
setQuitAfterMs(ms: number)
```

* Schedule a `q` keypress N milliseconds after the next `runLoop`
 * starts. Internal — used by the tickMs coverage test so a
 * tick-driven loop terminates without a key-timeline that matches
 * the tick cadence.
 *
 * @param ms - Milliseconds before the synthetic `q` arrives

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ms | `number` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L734))

### _routePrompt

```ts
_routePrompt(text: string, choices: string[]): string
```

* Private — used by other stdlib modules (notably `std::policy`)
 * to route a prompt through the active REPL when one exists, or
 * fall back to raw `print` + `input` otherwise.
 *
 * Not part of the public API; the underscore prefix is convention,
 * but the export is required so cross-module imports work.
 *
 * @param text - The menu/question text shown to the user
 * @param choices - The set of strings the user's answer must match

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| choices | `string[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L768))

### pushMessage

```ts
pushMessage(message: string)
```

* Append a styled message to the active `repl()` transcript.
 *
 * The message is rendered immediately on the next frame. The string
 * may include `std::ui` style markup or text returned by helpers
 * such as `color(...)`; `pushMessage` stores it unchanged.
 *
 * @param message - Styled or plain text to append to the transcript

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L836))

### clearMessages

```ts
clearMessages()
```

* Remove all messages from the active `repl()` transcript.
 *
 * This is intended for tests and explicit "clear conversation"
 * commands inside interactive agents.

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L846))

### recordedFrameTexts

```ts
recordedFrameTexts(): string[]
```

* Return the text snapshots recorded by scripted TUI tests.
 * Internal test helper used by Agency and agency-js integration
 * tests; real terminals return an empty array.

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L855))

### _filteredPaletteKeys

```ts
_filteredPaletteKeys(state: ReplState): string[]
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L861))

### _busyLine

```ts
_busyLine(state: ReplState): string
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L880))

### _replView

```ts
_replView(state: ReplState): Element
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |

**Returns:** `Element`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L895))

### _submitPrompt

```ts
_submitPrompt(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L957))

### _recallPreviousHistory

```ts
_recallPreviousHistory(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L985))

### _recallNextHistory

```ts
_recallNextHistory(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L997))

### _closePalette

```ts
_closePalette(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1013))

### _selectPaletteCommand

```ts
_selectPaletteCommand(state: ReplState, paletteKeys: string[]): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |
| paletteKeys | `string[]` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1025))

### _movePaletteCursor

```ts
_movePaletteCursor(state: ReplState, paletteKeys: string[], delta: number): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |
| paletteKeys | `string[]` |  |
| delta | `number` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1044))

### _removePaletteFilterCharacter

```ts
_removePaletteFilterCharacter(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1066))

### _appendPaletteFilterCharacter

```ts
_appendPaletteFilterCharacter(state: ReplState, character: string): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |
| character | `string` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1077))

### _replReducePaletteOpen

```ts
_replReducePaletteOpen(state: ReplState, keyEvent: KeyEvent): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |
| keyEvent | `KeyEvent` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1091))

### _appendInputCharacter

```ts
_appendInputCharacter(state: ReplState, character: string): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |
| character | `string` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1107))

### _removeInputCharacter

```ts
_removeInputCharacter(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1117))

### _openPalette

```ts
_openPalette(state: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1127))

### _replReduce

```ts
_replReduce(state: ReplState, keyEvent: KeyEvent): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |
| keyEvent | `KeyEvent` |  |

**Returns:** `ReplState`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1139))

### _replIsDone

```ts
_replIsDone(state: ReplState): boolean
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `ReplState` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1157))

### repl

```ts
repl(status: any, onSubmit: any, prompt: string, historyFile: string, historyMax: number, paletteCommands: any, tickMs: number)
```

* Drop-in REPL widget for interactive CLI agents. Bundles a
 * scrollable output area, a live status line, a slash-command
 * palette (triggered by `/`), and an input line with history
 * navigation.
 *
 * Owns the full terminal via `runLoop` (alt-screen) and owns one
 * transcript buffer. Submitted prompts, `pushMessage(...)`, and
 * string replies from `onSubmit` all append to that buffer; rendering
 * projects it into the auto-scrolling output pane at the top of the
 * column. Returning `false` from `onSubmit` exits the REPL.
 *
 * Lifecycle: `runLoop` enters and exits alt-screen automatically;
 * its `TerminalOutput` installs SIGINT/SIGTERM/exit handlers that
 * restore the terminal even on abrupt termination.
 *
 * @param status - Re-evaluated every render; populates the status line
 * @param onSubmit - Called with the submitted line; return a string to append or `false` to exit
 * @param prompt - String shown before the input buffer (default `"> "`)
 * @param historyFile - Reserved for future use (history persistence is v2)
 * @param historyMax - Trim oldest entries beyond this count
 * @param paletteCommands - Map of `/cmd` -> description, iterated in order
 * @param tickMs - Render cadence in ms. Default `null` chooses 100ms
 *   so spinner/timer and async transcript updates paint without
 *   waiting for another keypress.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1187))
