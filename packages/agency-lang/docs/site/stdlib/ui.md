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
    Bundles a scrollable transcript, a live status line, a slash
    command palette, and a history-aware input bar. Backed by
    Layer 1; integrates with `std::policy.cliPolicyHandler` so
    interrupt prompts render through the active screen instead of
    fighting with the input bar.

  Both layers are testable: `setScriptedKeys` feeds a deterministic
  sequence into the loop so unit tests don't need a TTY.

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

  let transcript: string[] = []

  def out(): string[]                          { return transcript }
  def stat(): { left: string, right: string }  { return { left: "agent", right: "" } }
  def onSub(msg: string): boolean {
    if (msg == "/exit") { return false }
    transcript.push("you: ${msg}")
    // ...call your model / route / tools here...
    transcript.push("agent: <reply>")
    return true
  }

  node main() {
    const handler = cliPolicyHandler({ file: ".policy.json", fields: {} })
    handle {
      repl(output: out, status: stat, onSubmit: onSub,
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L89))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L110))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L128))

### ReplState

```ts
type ReplState = {
  buffer: string;
  history: string[];
  historyIdx: number;
  paletteOpen: boolean;
  paletteFilter: string;
  paletteCursor: number;
  done: boolean;
  outputLinesWritten: number;
  prompt: string;
  paletteCommands: any;
  historyFile: string;
  historyMax: number;
  output: any;
  status: any;
  onSubmit: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L608))

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

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L147))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L158))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L185))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L212))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L239))

### _makeBuilder

```ts
_makeBuilder(kids: any[]): Builder
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| kids | `any[]` |  |

**Returns:** [Builder](#builder)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L267))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L283))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L312))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L341))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L368))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L389))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L410))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L431))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L447))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L453))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L471))

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
| tree | [Element](#element) |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L493))

### readKey

```ts
readKey(): KeyEvent
```

* Read one key from the terminal. Blocks until a key is pressed.
 * Use sparingly; prefer `runLoop` for anything beyond a single
 * blocking prompt.

**Returns:** [KeyEvent](#keyevent)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L502))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L523))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L545))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L557))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L589))

### _filteredPaletteKeys

```ts
_filteredPaletteKeys(s: ReplState): string[]
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| s | [ReplState](#replstate) |  |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L628))

### _replView

```ts
_replView(s: ReplState): Element
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| s | [ReplState](#replstate) |  |

**Returns:** [Element](#element)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L646))

### _appendNewScrollLines

```ts
_appendNewScrollLines(s: ReplState): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| s | [ReplState](#replstate) |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L677))

### _persistHistory

```ts
_persistHistory(s: ReplState): boolean
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| s | [ReplState](#replstate) |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L694))

### _replReduce

```ts
_replReduce(s: ReplState, k: KeyEvent): ReplState
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| s | [ReplState](#replstate) |  |
| k | [KeyEvent](#keyevent) |  |

**Returns:** [ReplState](#replstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L703))

### _replIsDone

```ts
_replIsDone(s: ReplState): boolean
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| s | [ReplState](#replstate) |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L797))

### repl

```ts
repl(output: any, status: any, onSubmit: any, prompt: string, historyFile: string, historyMax: number, paletteCommands: any, tickMs: number)
```

* Drop-in REPL widget for interactive CLI agents. Bundles a scroll
 * output area (via the terminal's native scroll region), a status
 * line, a command palette (triggered by `/`), and an input line
 * with history navigation.
 *
 * Lifecycle: installs a scroll region on entry, runs the bounded
 * `runLoop` with `tickMs` so the status line stays live during a
 * turn, tears down the region on exit (clean exit, onSubmit -> false,
 * or exception). The handler block ensures the region is reset even
 * if an exception escapes the loop.
 *
 * @param output - Re-evaluated every render; new tail lines stream to scrollback
 * @param status - Re-evaluated every render; populates the status line
 * @param onSubmit - Called with the submitted line; return `false` to exit
 * @param prompt - String shown before the input buffer (default `"> "`)
 * @param historyFile - Reserved for future use (history persistence is v2)
 * @param historyMax - Trim oldest entries beyond this count
 * @param paletteCommands - Map of `/cmd` -> description, iterated in order
 * @param tickMs - Render cadence in milliseconds (default 100)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| output | `any` |  |
| status | `any` |  |
| onSubmit | `any` |  |
| prompt | `string` | "> " |
| historyFile | `string` | "" |
| historyMax | `number` | 1000 |
| paletteCommands | `any` | null |
| tickMs | `number` | 100 |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L820))
