# TUI primitives

The `lib/tui` module provides a small terminal UI toolkit used by the
debugger and `agency logs view`. It is layout-driven (flex-like),
state-driven (no event emitters), and fully testable with no terminal
attached.

This document covers the everyday primitives most consumers reach for.
For lower-level details — the layout engine, frame model, element
shape — read the source under `lib/tui/`.

The [logs viewer](../../lib/logsViewer/run.ts) is the canonical
example of all of these primitives in use.

## Single-line rows: `line()` and `lines()`

`text()` defaults to `flex: 1`, which means a `column(t1, t2, t3)`
distributes leftover vertical space between the children. For "a
single line of text" — the common case in lists, logs, command bars
— you want fixed-height rows instead. Use `line()`:

```ts
import { line, lines, column } from "@/tui/index.js";

column(
  line("> j moves down"),
  line("  k moves up"),
  line("  q quits", { fg: "gray" }),
);
```

`lines(strings, style?)` is sugar for a column of `line()`s with
`justifyContent: "flex-start"`, useful for help text or any plain
multi-row block:

```ts
lines(["Loading…", "Press q to cancel."]);
```

## Scroll math: `clampScroll()` and `followCursor()`

Two pure functions, no element/state coupling:

```ts
import { clampScroll, followCursor } from "@/tui/index.js";

const clamped = clampScroll(scrollTop, totalRows, viewportRows);
const scrollTop = cursorIdx >= 0
  ? followCursor(clamped, cursorIdx, viewportRows)
  : clamped;
```

`clampScroll` keeps `scrollTop` inside `[0, max(0, total - viewportRows)]`.
`followCursor` adjusts `scrollTop` so a cursor at `cursorIdx` is the
top row (when above the viewport) or the bottom row (when below).
They are pure, so they belong in the render function rather than in
event handlers.

## Scrollable cursor lists: `scrollList()`

When you want the whole pattern — clamp + cursor-follow + slice +
render each row — wrap it once with `scrollList()`:

```ts
import { scrollList, line } from "@/tui/index.js";

const { element, scrollTop } = scrollList({
  items: visibleRows,
  cursorIdx,
  scrollTop: state.scrollTop,
  viewportRows: viewport.rows,
  renderItem: (row, isCursor) =>
    line(`${isCursor ? "> " : "  "}${row.label}`),
});
```

`scrollList` returns the rendered `Element` plus the
clamped/cursor-followed `scrollTop` that the caller should persist
back into state. Item styling, cursor markup, and key handling are
all up to the caller; `scrollList` only owns the scroll bookkeeping
and the visible-window slicing.

## Render loop: `Screen.runLoop()`

The `draw → nextKey → handleKey → draw → quit` loop is the same in
every TUI app. `runLoop` factors it out:

```ts
await screen.runLoop({
  initialState,
  render: (state) => renderState(state),
  handleKey: (state, event) => handleKey(state, event),
  isDone: (state) => state.quit,
});
```

`runLoop` renders once before the first key press, then for every key
event applies `handleKey` and re-renders. It exits as soon as
`isDone(state)` returns true and returns the final state.

## Key normalization: `formatKey()` and `keyMatches()`

`formatKey({ key, ctrl, shift }) → string` returns a canonical
human-readable name:

| Event | Result |
|---|---|
| `{ key: "j" }` | `"j"` |
| `{ key: "up" }` | `"Up"` |
| `{ key: "c", ctrl: true }` | `"Ctrl+C"` |
| `{ key: "tab", shift: true }` | `"Shift+Tab"` |

`keyMatches(event, name)` is a case-insensitive comparison against the
canonical form. **Caveat:** because it lowercases, single-letter vim
shortcuts that need case sensitivity (`g` vs `G`) must compare
`event.key` directly — see [`logsViewer/input.ts`](../../lib/logsViewer/input.ts)
for the `letter()` helper pattern.

## Typed color palette: `ColorName`

The 16 named ANSI colors are exported as a typed union:

```ts
import type { ColorName } from "@/tui/index.js";

const fg: ColorName = "bright-cyan"; // autocompletes; typos caught at build time
```

Style fields (`fg`, `bg`, `borderColor`, `labelColor`) accept either a
`ColorName` or an arbitrary string (for hex values in the HTML
adapter). A unit test enforces that `COLOR_NAMES`, `ansiColors`,
`ansiBgColors`, and `cssColors` stay in lock-step.

## Test harness: `ScriptedInput` + `FrameRecorder`

`ScriptedInput` replays a list of key events. Pass them at
construction time for the most concise tests:

```ts
import { ScriptedInput, FrameRecorder } from "@/tui/index.js";

const input = new ScriptedInput(["j", "j", { key: "c", ctrl: true }]);
const output = new FrameRecorder();
// ... drive the screen
expect(output.lastText()).toMatch(/quit/);
expect(output.textAt(0)).toMatch(/welcome/);
```

`FrameRecorder.textAt(i)` and `.lastText()` are convenience getters
that flatten a recorded frame to plain text — they're shorter than
`recorder.frames[i].frame.toPlainText()` and read better in
assertions.
