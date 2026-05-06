# TUI Library and Debugger Test Harness

## Problem

The Agency debugger is built on blessed, an unmaintained TUI library that is difficult to test headlessly. Writing debugger tests requires scripting a sequence of abstract commands upfront and running them blind — when tests fail, there's no way to see what the debugger state looked like at each step. This makes writing and debugging tests extremely painful, which in turn has caused the debugger feature to stagnate.

All existing driver integration tests are currently skipped (`describe.skip`) pending migration work, and the `TestDebuggerIO` mock provides no visual feedback.

## Solution

Build a custom, general-purpose TUI library (`@agency-lang/tui`) designed for testability from the ground up. Use it to replace blessed in the debugger and build a new test harness that produces visual artifacts (HTML snapshots) at each step.

## TUI Library: `@agency-lang/tui`

### Architecture

The library uses an **immediate-mode rendering model**. Each render cycle, the consumer builds a fresh element tree describing the entire screen. The library resolves layout, produces a frame tree, and outputs to a target (terminal, HTML, or plain text). No mutable widget objects, no retained state — each render is a pure function from `(elementTree, terminalSize) -> frameTree`.

Three layers:

1. **Layout Engine** — Takes an element tree and terminal dimensions, resolves flexbox layout, outputs a positioned element tree with absolute `{ x, y, width, height }` on every node.
2. **Renderer** — Takes a positioned element tree, produces a `Frame` tree (nested frames with cells).
3. **Output Adapters** — Take a frame tree and produce final output (ANSI escape codes, HTML, or plain text).

### Element Types

Four element types cover all TUI needs:

- **Box** — Container with optional border, label, background. Can contain text content, child elements, or both.
- **Text** — Styled text content with inline style support (bold, colors).
- **List** — Selectable list of items with a highlighted selection index. When a list has more items than visible rows, it scrolls to keep the selected item visible. Items are rendered as text lines; the selected item is highlighted with a distinct background color.
- **TextInput** — Single-line text input field.

### Element Descriptor

```typescript
type Element = {
  type: "box" | "text" | "list" | "textInput"
  style?: {
    // Flexbox
    flexDirection?: "row" | "column"    // default: "column"
    flex?: number                        // flex grow factor
    justifyContent?: "flex-start" | "center" | "flex-end" | "space-between"
    alignItems?: "flex-start" | "center" | "flex-end" | "stretch"

    // Sizing
    width?: number | string              // fixed or "50%"
    height?: number | string
    minWidth?: number
    minHeight?: number
    maxWidth?: number
    maxHeight?: number

    // Spacing
    padding?: number | { top?: number, bottom?: number, left?: number, right?: number }
    margin?: number | { top?: number, bottom?: number, left?: number, right?: number }

    // Box decoration
    border?: boolean
    borderColor?: string
    label?: string
    labelColor?: string

    // Content styling
    fg?: string
    bg?: string
    bold?: boolean
    scrollable?: boolean
    scrollOffset?: number    // current scroll position (0-indexed line offset)
    visible?: boolean        // default true
  }
  content?: string           // text content (supports inline style tags)
  children?: Element[]
  items?: string[]           // for list
  selectedIndex?: number     // for list
  value?: string             // for textInput
  key?: string               // identity for lookup across renders
}
```

### Builder Functions

Building element trees as raw objects is verbose. The library provides builder functions for a concise, readable API:

```typescript
function box(style: StyleProps, ...children: Element[]): Element
function box(...children: Element[]): Element

function row(style: StyleProps, ...children: Element[]): Element   // shorthand for box with flexDirection: "row"
function row(...children: Element[]): Element

function column(style: StyleProps, ...children: Element[]): Element // shorthand for box with flexDirection: "column"
function column(...children: Element[]): Element

function text(content: string): Element

function list(style: StyleProps, items: string[], selectedIndex?: number): Element

function textInput(style: StyleProps, value?: string): Element
```

`StyleProps` is the `style` object plus `key`:

```typescript
type StyleProps = Element["style"] & { key?: string }
```

Example usage:

```typescript
function buildUI(state: AppState): Element {
  return column(
    box({ key: "header", height: 3, border: true, borderColor: "cyan", label: " My App " },
      text("{bold}Welcome to the dashboard{/bold}")
    ),

    row({ flex: 1 },
      list({ key: "items", width: "30%", border: true, label: " Items " },
        state.items, state.selectedIndex
      ),
      box({ key: "details", flex: 1, border: true, label: " Details " },
        text(`Selected: {yellow-fg}${state.items[state.selectedIndex]}{/yellow-fg}`)
      ),
    ),

    box({ key: "logs", height: "25%", border: true, label: " Logs ", scrollable: true,
          scrollOffset: state.scrollOffset },
      text(state.logs.join("\n"))
    ),

    box({ height: 1, fg: "gray" },
      text(" (up/down) navigate  (q) quit")
    ),
  )
}
```

The raw `Element` type remains the underlying data structure. Builder functions are convenience wrappers that produce `Element` objects.

### Inline Style Tags

Text content supports inline style tags using the following syntax, compatible with the existing debugger codebase:

- `{bold}text{/bold}` — bold text
- `{red-fg}text{/red-fg}` — foreground color
- `{blue-bg}text{/blue-bg}` — background color
- Tags can be nested: `{bold}{red-fg}text{/red-fg}{/bold}`

The HTML output adapter maps these to `<span>` elements with CSS styles. The ANSI adapter maps them to escape codes. The plain text adapter strips them.

### Color System

Colors are specified as named strings. The supported set is the standard 16 ANSI terminal colors:

`black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `gray` (alias for bright black), plus bright variants: `bright-red`, `bright-green`, etc.

The ANSI adapter maps these to standard escape codes. The HTML adapter maps them to CSS color values.

### Flexbox-Lite Layout Engine

A minimal, pure-TypeScript flexbox implementation. No native dependencies. Supports:

- `flexDirection`: row and column
- `flex`: grow factor for distributing remaining space
- `justifyContent`: flex-start, center, flex-end, space-between
- `alignItems`: flex-start, center, flex-end, stretch
- Percentage and fixed sizing for width/height
- Min/max constraints
- Padding and margin

The layout engine is a pure function: `(elementTree, width, height) -> positionedTree`. This makes it independently testable.

### Text Overflow and Scrolling

When text content exceeds the available space within an element:

- **Non-scrollable elements**: text is **truncated** at the element boundary. Lines longer than the width are clipped. Lines beyond the height are not rendered.
- **Scrollable elements** (`scrollable: true`): the element acts as a viewport. The `scrollOffset` style property controls which line is at the top of the viewport. Content is clipped to the viewport.

Since the library is immediate-mode (no retained state), scroll position is managed by the consumer. The consumer tracks `scrollOffset` in its own state and passes it into the element tree each render cycle. This keeps the library stateless while giving the consumer full control.

For example, the debugger's activity pane would track its own scroll offset and set `scrollOffset` to show the most recent entries at the bottom:

```typescript
{
  type: "box",
  key: "activity",
  style: { scrollable: true, scrollOffset: Math.max(0, lines.length - visibleHeight) },
  content: activityLines.join("\n")
}
```

### Frame and Cell Model

The renderer produces a tree of frames that mirrors the element tree.

```typescript
type Cell = {
  char: string
  fg?: string
  bg?: string
  bold?: boolean
}

type FrameStyle = {
  border?: boolean
  borderColor?: string
  bg?: string
  label?: string
  labelColor?: string
}

type Frame = {
  key?: string
  x: number
  y: number
  width: number
  height: number
  style: FrameStyle
  content?: Cell[][]         // text content within the frame (after border/padding)
  children?: Frame[]         // nested child frames
}
```

The separation:
- **Frame** = layout + styling (position, size, border, background, label)
- **Cell** = content (a single character with its own fg/bg/bold)

To produce the final screen buffer, the renderer recursively:
1. Fills the frame's area with its background
2. Draws the border and label
3. Renders the content cells in the inner area
4. Recursively renders children on top

Frames are nested, so individual panes can be inspected independently — you can extract just the "locals" frame without parsing the full screen.

### Output Adapters

Three output adapters, all operating on the Frame tree:

- **`toANSI(frame): string`** — Produces ANSI escape codes for real terminal output. Used in production.
- **`toHTML(frame): string`** — Produces an HTML representation with monospace text and CSS colors. Used for test visual artifacts.
- **`toPlainText(frame): string`** — Strips styling, returns just characters. Used for test assertions.

### Input Handling

```typescript
type KeyEvent = {
  key: string              // "s", "tab", "escape", "up", "down", etc.
  shift?: boolean
  ctrl?: boolean
}

type InputSource = {
  nextKey(): Promise<KeyEvent>
  nextLine(prompt: string): Promise<string>
  destroy(): void
}
```

Two implementations:

- **`TerminalInput`** — Production use. Puts stdin in raw mode, reads keypresses, maps escape sequences to KeyEvents.
- **`ScriptedInput`** — Test use. Replays a programmatic sequence of key events.

### The Screen Class

The `Screen` class is the top-level orchestrator that ties together layout, rendering, input, and output. It owns the render cycle.

```typescript
class Screen {
  constructor(opts: {
    output: OutputTarget       // terminal, html recorder, etc.
    input: InputSource         // terminal or scripted
    width: number
    height: number
  })

  // Run one render cycle: layout the element tree, produce frames, write output
  render(root: Element): Frame

  // Wait for the next key event from the input source
  nextKey(): Promise<KeyEvent>

  // Prompt for text input (switches to line mode)
  nextLine(prompt: string): Promise<string>

  // Get the current terminal dimensions
  size(): { width: number, height: number }

  // Clean up (restore terminal state, etc.)
  destroy(): void
}
```

`OutputTarget` is an interface for where frames go:

```typescript
type OutputTarget = {
  write(frame: Frame): void    // output a frame (e.g., write ANSI to terminal)
  flush?(): void               // optional: flush output
}
```

Implementations:
- **`TerminalOutput`** — Writes ANSI to stdout. Handles alternate screen buffer, cursor hiding, and differential updates.
- **`FrameRecorder`** — Collects frames in memory for later export to HTML. Used by the test harness.

The consumer's main loop looks like:

```typescript
const screen = new Screen({ output, input, width: 120, height: 40 })

while (true) {
  const elementTree = buildUI(state)    // consumer builds fresh element tree
  screen.render(elementTree)            // layout + render + output
  const key = await screen.nextKey()    // wait for input
  state = update(state, key)            // consumer updates its state
}
```

### Package Structure

```
packages/tui/
  lib/
    elements.ts         # Element type definitions
    builders.ts         # Builder functions (box, row, column, text, list, textInput)
    layout.ts           # Flexbox layout engine
    frame.ts            # Frame, Cell, FrameStyle types and Frame utilities (findByKey, image, etc.)
    render/
      renderer.ts       # Renderer: positioned elements -> Frame tree
      ansi.ts           # ANSI output adapter
      html.ts           # HTML output adapter
      plaintext.ts      # Plain text output adapter
    input/
      terminal.ts       # Real stdin input
      scripted.ts       # Programmatic input for tests
    output/
      terminal.ts       # TerminalOutput (ANSI to stdout)
      recorder.ts       # FrameRecorder (collect frames for HTML export)
    screen.ts           # Screen class (orchestrates render cycle)
  test/
    layout.test.ts
    render.test.ts
    ...
```

The library has zero dependency on Agency. It is a standalone package publishable as `@agency-lang/tui`.

## Debugger Test Harness

### Overview

A new `DebuggerTestSession` class replaces `TestDebuggerIO` entirely. It provides a step-at-a-time API where each input is sent individually, and the state can be inspected and exported after every step.

### Integration with the Driver

`DebuggerTestSession` implements the `DebuggerIO` interface internally, bridging between the TUI lib and the existing `DebuggerDriver`. The integration works as follows:

1. The constructor takes a compiled module (same as `makeDriver` today) and sets up the driver, the TUI `Screen` with a `ScriptedInput` and `FrameRecorder`, and all necessary wiring.
2. Internally, it implements `DebuggerIO` using the TUI lib's `Screen`. The key mapping — translating raw key events like `"s"` into `DebuggerCommand` objects like `{ type: "step" }` — lives in this implementation, ported from the current `DebuggerUI.waitForCommand()`.
3. Each `press()` call feeds a key event to the `ScriptedInput`, which unblocks the `Screen.nextKey()` call inside the driver's `waitForCommand()`. The driver processes the command, runs until the next pause, and renders. The `FrameRecorder` captures the frame.
4. Interactive overlays (rewind selector, checkpoints panel) are handled transparently. When the driver calls `showRewindSelector()`, the overlay renders as part of the element tree. Subsequent `press()` calls send keys to the overlay (up/down to navigate, enter to select, escape to cancel). The test sees the overlay in the captured frames just like any other UI state.

```typescript
// Constructor handles all the wiring that makeDriver + TestDebuggerIO did
const session = new DebuggerTestSession({
  mod,                           // compiled module (from freshImport)
  terminalSize: { width: 120, height: 40 },  // optional, defaults provided
  checkpoints: [],               // optional, for trace replay
  nodeArgs: [arg1, arg2],        // optional, arguments for the main node
})
```

The constructor internally:
- Extracts `sourceMap` from `mod.__sourceMap` and computes `rewindSize` automatically
- Calls `mod.__setDebugger(debuggerState)`
- Creates the `DebuggerDriver` with the internal `DebuggerIO` implementation
- Calls `mod.main(...nodeArgs)` with the driver's callbacks to get the initial debug interrupt
- Is ready for `press()` calls

Note: tests must call `freshImport()` before constructing a session to get a cache-busted module with clean state. `DebuggerTestSession` does not handle module importing — it receives the already-imported module.

### API

```typescript
const session = new DebuggerTestSession({ mod })

// Send input and run until next pause
await session.press("s")

// Inspect the current frame
const frame = session.frame()
expect(frame.findByKey("locals").toPlainText()).toContain("x = 1")

// Send more input
await session.press("s")

// Type a command (enters command mode, types text, presses enter)
await session.type(":set x = 10")

// Step with override applied
await session.press("s")
const frame3 = session.frame()
expect(frame3.findByKey("locals").toPlainText()).toContain("x = 10")

// Export visual snapshot of current frame (full screen)
await session.image("debug-step-3.html")

// Export just a single pane
await session.frame().findByKey("locals").image("locals.html")

// Bulk input
await session.press("s", { times: 5 })

// Continue to completion
await session.press("c")
expect(session.returnValue()).toBe(12)

// Export all frames as a navigable HTML file
session.writeHTML("test-output/step-test.html")
```

### Interacting with Overlays

The rewind selector and checkpoints panel are interactive overlays. In the new model, they are simply different element trees rendered by the debugger UI. Tests interact with them the same way they interact with the main debugger:

```typescript
// Press "r" to open the rewind selector
await session.press("r")

// The frame now shows the overlay — we can verify it
expect(session.frame().findByKey("rewind-selector")).toBeDefined()

// Navigate and select a checkpoint
await session.press("up")
await session.press("up")
await session.press("enter")

// We're back in the debugger, rewound to the selected checkpoint
expect(session.frame().findByKey("source").toPlainText()).toContain("> 2")
```

### Key Methods

- **`press(key, opts?)`** — Sends a key event, runs the driver until it pauses for the next command, captures the resulting frame. Supports `{ times: N }` for bulk input.
- **`type(text)`** — Types text into a text input. If the text starts with `:`, it first presses `:` to enter command mode, then types the remaining text and presses enter. If it doesn't start with `:`, it types the text directly and presses enter (for use with `promptForInput`, e.g., typing "approve" at an interrupt prompt).
- **`frame()`** — Returns the most recent Frame for inspection and assertions.
- **`image(path, opts?)`** — Exports the current frame as an HTML file. Supports `{ key: "pane-name" }` to export a single pane.
- **`writeHTML(path)`** — Exports all captured frames as a single navigable HTML file with prev/next navigation. Each frame is labeled with the command that was just executed.
- **`returnValue()`** — Returns the program's final return value after completion.

### Remaining DebuggerIO Methods

The `DebuggerIO` interface has several methods beyond `waitForCommand` and `render`. Here's how each maps to the new model:

- **`promptForNodeArgs(parameters)`** — Node arguments are provided via the `nodeArgs` constructor option. The internal `DebuggerIO` implementation returns these directly.
- **`promptForInput(prompt)`** — Used during user interrupt handling (approve/reject/resolve). In the test harness, the next `type()` call provides the response. The internal implementation uses `Screen.nextLine()`, which reads from the `ScriptedInput`.
- **`appendStdout(text)`** — Appends to an internal stdout buffer. The stdout content is rendered in the "stdout" pane of the element tree, so it's visible in captured frames.
- **`renderActivityOnly()`** — Triggers a render cycle (same as `render()` but the element tree naturally shows the updated activity log).
- **`startSpinner()` / `stopSpinner()`** — In production, shows a spinner animation in the command bar. In tests, these are no-ops — the spinner is a cosmetic detail irrelevant to test assertions.
- **`showRewindSelector(checkpoints)` / `showCheckpointsPanel(checkpoints)`** — Render as overlays in the element tree. See "Interacting with Overlays" section.

### Behavior After Program Completion

After the program finishes (either by running to completion or via `press("c")`), `press()` calls that would move execution forward (step, next, stepIn, stepOut, continue) are no-ops — the driver returns the "Already at end of execution" message, visible in the activity log. Backward commands (stepBack, rewind) still work. `returnValue()` returns the final result. This matches the current driver behavior.

### Frame Inspection

`Frame` is a class with utility methods for inspection and export:

- **`findByKey(key)`** — Recursively search children for a frame with the given key. Returns a `Frame` or `undefined`.
- **`toPlainText()`** — Flatten the frame to plain text (strips all styling). Calls the plain text output adapter on this frame.
- **`toHTML()`** — Render the frame as styled HTML. Calls the HTML output adapter on this frame.
- **`image(path)`** — Export the frame to an HTML file (convenience method that calls `toHTML()` and writes to disk).

These methods work on any frame in the tree, including sub-frames returned by `findByKey()`, so you can inspect and export individual panes.

### HTML Output Format

The `writeHTML()` output is a single HTML file containing all frames captured during the test session. Each frame shows:

- The full TUI rendered in a monospace font with terminal colors
- A label showing which command was just executed (e.g., "After: press s", "After: type :set x = 10")
- Navigation between frames (prev/next or scrollable)

Individual `image()` calls produce single-frame HTML files. When called on a sub-frame (via `findByKey`), only that pane is rendered.

### Test Artifact Location

Test artifacts (HTML files from `image()` and `writeHTML()`) should be written to a `test-output/` directory at the project root. This directory is gitignored. Artifacts are generated on every test run so they're always available for inspection. In CI, they could be uploaded as build artifacts for debugging failures.

### Location

The `DebuggerTestSession` lives in `packages/agency-lang/lib/debugger/` since it is specific to the Agency debugger. It depends on `@agency-lang/tui` for rendering and input, and on the debugger driver for execution.

## Debugger Migration

The existing `DebuggerUI` class (`lib/debugger/ui.ts`) will be rewritten to use `@agency-lang/tui` instead of blessed. The `DebuggerIO` interface remains the same — the driver doesn't need to change. Only the UI implementation changes.

The new UI implementation will build an element tree each render cycle (immediate mode) instead of mutating blessed widget objects (retained mode). The element tree describes the same layout: source pane, locals, globals, call stack, activity, stdout, threads, command bar.

### Dynamic Layout Examples

The current debugger has several dynamic layout behaviors that map naturally to the immediate-mode model. Instead of mutating widget properties and calling show/hide, the consumer conditionally includes elements in the tree.

**Threads pane (conditionally shown):**

```typescript
// When threads are available, source shrinks and threads pane appears
const sourceWidth = hasThreads ? "65%" : "100%"
const topRow = [
  box({ key: "source", width: sourceWidth, height: "40%" }, text(sourceContent)),
]
if (hasThreads) {
  topRow.push(box({ key: "threads", flex: 1, height: "40%" }, text(threadsContent)))
}
return row(...topRow)
```

**Zoom (full-screen a single pane):**

```typescript
if (zoomedPane) {
  return column(
    box({ key: zoomedPane, width: "100%", flex: 1 }, text(paneContent)),
    commandBar,
  )
} else {
  return normalLayout
}
```

**Checkpoints panel overlay:**

```typescript
if (showCheckpointsPanel) {
  return column(
    checkpointListPane,
    checkpointDetailPane,
    helpBar,
  )
} else {
  return normalLayout
}
```

## Migration Plan

1. **Build the TUI lib** — `packages/tui/` with layout engine, renderers, input handling, Screen class. Test independently with simple examples.
2. **Build the test harness** — `DebuggerTestSession` using the TUI lib. Validate with a simple fixture (e.g., `step-test.agency`).
3. **Migrate the debugger UI** — Rewrite `ui.ts` to use the TUI lib instead of blessed. Verify by writing basic debugger tests with the new harness that exercise stepping, continue, rewind, variable inspection, and the rewind/checkpoints overlays.
4. **Rewrite debugger tests** — Replace all `TestDebuggerIO`-based tests with `DebuggerTestSession`-based tests. Un-skip the currently skipped test suites.

## Out of Scope

- Browser-based interactive rendering (the `InputSource` interface allows adding this later)
- Constraint-based or grid layout (flexbox-lite is sufficient)
- Animation or transitions
- Mouse input
