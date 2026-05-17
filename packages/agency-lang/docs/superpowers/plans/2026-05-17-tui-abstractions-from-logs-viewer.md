# TUI Abstractions Extracted from the Logs Viewer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the abstractions in `lib/tui` that I found myself reinventing while building [packages/agency-lang/lib/logsViewer/run.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.ts) (merged in `a49249b6`). The viewer hand-rolled key normalization, single-line row wrappers, scroll bookkeeping, the render/input loop, line clipping, color names, and test harness boilerplate. Every future TUI app would do the same. This plan pushes each pain point down into the library and adopts it from the viewer (and, where they obviously apply, from the debugger and any existing in-tree consumers).

**Tech Stack:** TypeScript, existing `lib/tui` module, Vitest. No new dependencies.

**Reference:** PR #154 (logs viewer) and the post-merge discussion that surfaced these gaps.

---

## Background

While shipping `agency logs view` I hit eight separate places where the right primitive was missing from `lib/tui`:

1. **Key normalization** — each app rebuilds the `{key, ctrl, shift}` → string switch ([run.ts mapKey](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.ts#L107-L127)).
2. **Single-line rows** — `text()` defaults to `flex: 1`, so a `column(...lines)` triple-spaces itself and shifts the parent when children grow. I worked around it with an inline `row()` that hard-codes `height: 1`.
3. **Scrollable list with cursor tracking** — `scrollTop` clamping + cursor-visibility were hand-rolled in [run.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.ts#L100-L122). The Copilot reviewer caught one regression here (blank screen after collapse) that an abstraction would have prevented.
4. **Render/input loop** — `draw → nextKey → handleKey → draw → quit` is the same in every TUI app; the viewer's [runViewer](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.ts#L23-L84) is mostly this loop.
5. **Text element self-clipping** — I pre-clip every line with `slice(0, cols-1) + "…"`. The renderer already knows each element's resolved width; clipping should live there. Same place to one day fix the UTF-16-vs-display-cell width issue.
6. **Color name discoverability** — `colors.ts` has 16 named colors; nothing surfaces that set to autocomplete.
7. **ScriptedInput ergonomic constructor** — every test writes a local `feed(input, ["j", "l", "q"])` helper because `ScriptedInput` only exposes `feedKey(KeyEvent)`.
8. **FrameRecorder convenience getters** — `out.frames[i].frame.toPlainText()` is awkward; `out.textAt(i)` / `out.lastText()` would shorten every test.

These are independent — they can be implemented in parallel by separate workers if desired. The plan groups them into atomic tasks so each one is reviewable on its own.

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| [packages/agency-lang/lib/tui/input/format.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/input/format.ts) | `formatKey(event): string` and `keyMatches(event, name): boolean` |
| [packages/agency-lang/lib/tui/input/format.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/input/format.test.ts) | Tests for `formatKey` / `keyMatches` |
| [packages/agency-lang/lib/tui/test/runLoop.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/test/runLoop.test.ts) | Integration test for `Screen.runLoop` |
| [packages/agency-lang/lib/tui/scroll.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/scroll.ts) | `clampScroll()` + `followCursor()` reusable helpers |
| [packages/agency-lang/lib/tui/scroll.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/scroll.test.ts) | Tests for the scroll helpers |

### Modified files

| File | Change |
|---|---|
| [packages/agency-lang/lib/tui/builders.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/builders.ts) | Add `line(content, style?)` and `lines(strings[], style?)` builders |
| [packages/agency-lang/lib/tui/builders.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/builders.test.ts) | New tests for the line builders (file may not exist yet — create if so) |
| [packages/agency-lang/lib/tui/render/renderer.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/render/renderer.ts) | Clip rendered `text` content to its resolved width inside the renderer |
| [packages/agency-lang/lib/tui/test/renderer.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/test/renderer.test.ts) | Test that overlong text is auto-clipped with `…` |
| [packages/agency-lang/lib/tui/colors.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/colors.ts) | Export a `ColorName` union derived from `ansiColors` |
| [packages/agency-lang/lib/tui/elements.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/elements.ts) | Narrow `Style.fg` / `bg` / `borderColor` / `labelColor` to `ColorName \| string` (string kept for hex) |
| [packages/agency-lang/lib/tui/screen.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/screen.ts) | Add `Screen.runLoop({ render, handleKey })` |
| [packages/agency-lang/lib/tui/input/scripted.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/input/scripted.ts) | Accept `(KeyEvent \| string)[]` in the constructor; document semantics |
| [packages/agency-lang/lib/tui/test/scripted.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/test/scripted.test.ts) | Tests for the new constructor |
| [packages/agency-lang/lib/tui/output/recorder.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/output/recorder.ts) | Add `textAt(i)` and `lastText()` convenience getters |
| [packages/agency-lang/lib/tui/test/recorder.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/test/recorder.test.ts) | Tests for the new getters |
| [packages/agency-lang/lib/tui/index.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/index.ts) | Export everything new |
| [packages/agency-lang/lib/logsViewer/run.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.ts) | Adopt the new primitives (delete local `mapKey`, `row`, `clampScrollTop`, `ensureCursorVisible`) |
| [packages/agency-lang/lib/logsViewer/render.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/render.ts) | Delete the manual `…` slice now that the renderer clips |
| [packages/agency-lang/lib/logsViewer/run.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.test.ts) | Switch `new ScriptedInput()` + `feed(...)` to the array constructor |
| [packages/agency-lang/lib/logsViewer/render.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/render.test.ts) | Drop tests that asserted the manual `…` slice if any |

---

## Task Decomposition

### Task 1 — `formatKey(event)` and `keyMatches(event, name)`

**Files:** create [lib/tui/input/format.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/input/format.ts) + co-located test; re-export from [lib/tui/index.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/index.ts).

The API:

```ts
// "j" → "j"; "up" → "Up"; "c" + ctrl → "Ctrl+C"; "tab" + shift → "Shift+Tab"
export function formatKey(event: KeyEvent): string

// case-insensitive name match, accepts the same strings formatKey returns
export function keyMatches(event: KeyEvent, name: string): boolean
```

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { formatKey, keyMatches } from "../input/format.js";

describe("formatKey", () => {
  it("returns single-char keys verbatim", () => {
    expect(formatKey({ key: "j" })).toBe("j");
    expect(formatKey({ key: "G" })).toBe("G");
  });
  it("title-cases named keys", () => {
    expect(formatKey({ key: "up" })).toBe("Up");
    expect(formatKey({ key: "enter" })).toBe("Enter");
    expect(formatKey({ key: "pagedown" })).toBe("PageDown");
  });
  it("prefixes with Ctrl+ / Shift+ in canonical order", () => {
    expect(formatKey({ key: "c", ctrl: true })).toBe("Ctrl+C");
    expect(formatKey({ key: "tab", shift: true })).toBe("Shift+Tab");
    expect(formatKey({ key: "right", ctrl: true, shift: true }))
      .toBe("Ctrl+Shift+Right");
  });
});

describe("keyMatches", () => {
  it("matches by canonical name, case-insensitively", () => {
    expect(keyMatches({ key: "j" }, "j")).toBe(true);
    expect(keyMatches({ key: "c", ctrl: true }, "ctrl+c")).toBe(true);
    expect(keyMatches({ key: "up" }, "UP")).toBe(true);
    expect(keyMatches({ key: "j" }, "k")).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm fail** (`pnpm vitest run lib/tui/input/format.test.ts`)
- [ ] **Step 3: Implement**

```ts
import type { KeyEvent } from "./types.js";

const TITLE_CASED: Record<string, string> = {
  up: "Up", down: "Down", left: "Left", right: "Right",
  enter: "Enter", escape: "Escape", tab: "Tab", backspace: "Backspace",
  delete: "Delete", insert: "Insert", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown",
};

export function formatKey(event: KeyEvent): string {
  const base = TITLE_CASED[event.key] ?? event.key;
  const prefix: string[] = [];
  if (event.ctrl) prefix.push("Ctrl");
  if (event.shift) prefix.push("Shift");
  const body =
    event.ctrl && base.length === 1 ? base.toUpperCase() : base;
  return [...prefix, body].join("+");
}

export function keyMatches(event: KeyEvent, name: string): boolean {
  return formatKey(event).toLowerCase() === name.toLowerCase();
}
```

- [ ] **Step 4: Pass tests**
- [ ] **Step 5: Re-export from [lib/tui/index.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/index.ts)**: `export { formatKey, keyMatches } from "./input/format.js";`
- [ ] **Step 6: Commit** `tui: formatKey / keyMatches utilities`

---

### Task 2 — `line(content, style?)` and `lines(strings[], style?)` builders

**Files:** modify [lib/tui/builders.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/builders.ts); test in `builders.test.ts` (create if absent).

Rationale: `text()` defaults to `flex: 1`, which is wrong for the common case of "a single line of text inside a column". Don't change `text()` (would be breaking); add a new builder that explicitly fixes `height: 1`. `lines()` is a convenience that wraps a `string[]` into a `column` of fixed-height rows.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { line, lines } from "../builders.js";
import { layout } from "../layout.js";

describe("line()", () => {
  it("produces a text element with height: 1", () => {
    const el = line("hi");
    expect(el.type).toBe("text");
    expect(el.content).toBe("hi");
    expect(el.style?.height).toBe(1);
  });
  it("merges caller-provided fg / bg / bold", () => {
    const el = line("hi", { fg: "red", bold: true });
    expect(el.style).toMatchObject({ height: 1, fg: "red", bold: true });
  });
});

describe("lines()", () => {
  it("returns a column of fixed-height rows, justified flex-start", () => {
    const tree = lines(["a", "b", "c"]);
    expect(tree.type).toBe("box");
    expect(tree.style?.flexDirection).toBe("column");
    expect(tree.style?.justifyContent).toBe("flex-start");
    expect(tree.children).toHaveLength(3);
    for (const child of tree.children!) {
      expect(child.style?.height).toBe(1);
    }
  });
  it("does NOT stretch to fill its parent (placed inside a tall box)", () => {
    // Sanity: confirm the layout engine does not give the column
    // extra height when its children declare height: 1.
    const root = lines(["one", "two"]);
    const positioned = layout(root, 80, 24);
    // First child must end up at y == row 0 of the lines() box (no
    // pre-padding) and the second at y == 1.
    const [a, b] = positioned.children!;
    expect(b.resolvedY - a.resolvedY).toBe(1);
  });
});
```

- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement in [builders.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/builders.ts)**

```ts
export function line(content: string, style?: Style): Element {
  return { type: "text", content, style: { height: 1, ...style } };
}

export function lines(strings: string[], style?: Style): Element {
  return column(
    { flexDirection: "column", justifyContent: "flex-start", ...style },
    ...strings.map((s) => line(s)),
  );
}
```

(Confirm the `column()` builder accepts the merged style; if `column` already forces `flexDirection: column`, the explicit field above is harmless redundancy.)

- [ ] **Step 4: Pass tests**
- [ ] **Step 5: Re-export from index** (likely already exported via `export * from "./builders.js"`)
- [ ] **Step 6: Commit** `tui: line() / lines() builders for fixed-height text rows`

---

### Task 3 — `clampScroll()` and `followCursor()` helpers

**Files:** create [lib/tui/scroll.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/scroll.ts) + test.

Pure functions, no element/state coupling. Both are used together in the viewer's `draw()`.

```ts
// Clamp scrollTop into [0, max(0, total - viewportRows)].
export function clampScroll(scrollTop: number, total: number, viewportRows: number): number

// If cursorIdx is above the viewport, scroll up; if below, scroll
// down so it's the last visible row. Otherwise leave scrollTop alone.
export function followCursor(
  scrollTop: number, cursorIdx: number, viewportRows: number,
): number
```

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { clampScroll, followCursor } from "../scroll.js";

describe("clampScroll", () => {
  it("keeps a valid scrollTop", () => {
    expect(clampScroll(3, 20, 5)).toBe(3);
  });
  it("clamps when scrollTop exceeds the maximum", () => {
    // 20 rows, viewport 5 → max scrollTop = 15
    expect(clampScroll(99, 20, 5)).toBe(15);
  });
  it("returns 0 when the content fits the viewport", () => {
    expect(clampScroll(99, 3, 10)).toBe(0);
  });
  it("clamps negative values to 0", () => {
    expect(clampScroll(-5, 20, 5)).toBe(0);
  });
});

describe("followCursor", () => {
  it("scrolls up when cursor is above the viewport", () => {
    expect(followCursor(10, 3, 5)).toBe(3);
  });
  it("scrolls down when cursor is below the viewport", () => {
    // scrollTop 0, viewport 5 → visible rows 0..4; cursor at 7 means
    // we need scrollTop = 3 (so 3..7 is visible).
    expect(followCursor(0, 7, 5)).toBe(3);
  });
  it("does nothing when cursor is already visible", () => {
    expect(followCursor(0, 2, 5)).toBe(0);
  });
});
```

- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3: Implement**

```ts
export function clampScroll(
  scrollTop: number, total: number, viewportRows: number,
): number {
  const max = Math.max(0, total - viewportRows);
  if (scrollTop < 0) return 0;
  if (scrollTop > max) return max;
  return scrollTop;
}

export function followCursor(
  scrollTop: number, cursorIdx: number, viewportRows: number,
): number {
  if (cursorIdx < scrollTop) return cursorIdx;
  const lastVisible = scrollTop + viewportRows - 1;
  if (cursorIdx > lastVisible) return cursorIdx - viewportRows + 1;
  return scrollTop;
}
```

- [ ] **Step 4: Pass tests**
- [ ] **Step 5: Re-export from [lib/tui/index.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/index.ts)**: `export * from "./scroll.js";`
- [ ] **Step 6: Commit** `tui: clampScroll / followCursor helpers`

---

### Task 4 — `Screen.runLoop({ render, handleKey })`

**Files:** modify [lib/tui/screen.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/screen.ts); create [lib/tui/test/runLoop.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/test/runLoop.test.ts).

The loop:

```ts
async runLoop<S>(opts: {
  initialState: S;
  render: (state: S) => Element;       // (or string[], see step 3)
  handleKey: (state: S, event: KeyEvent) => S;
  isDone: (state: S) => boolean;
  label?: string;
}): Promise<S>
```

Returns the final state after `isDone` flips to true. The host owns "what is done" — keeps `runLoop` ignorant of quit-key semantics, and lets callers drive the loop from things other than keys (e.g. timed updates) in v2.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { Screen } from "../screen.js";
import { ScriptedInput } from "../input/scripted.js";
import { FrameRecorder } from "../output/recorder.js";
import { line } from "../builders.js";

describe("Screen.runLoop", () => {
  it("renders, handles keys, and stops when isDone returns true", async () => {
    const input = new ScriptedInput();
    input.feedKey({ key: "j" });
    input.feedKey({ key: "j" });
    input.feedKey({ key: "q" });
    const output = new FrameRecorder();
    const screen = new Screen({ input, output, width: 20, height: 5 });
    const finalState = await screen.runLoop({
      initialState: { n: 0, done: false },
      render: (s) => line(`n=${s.n}`),
      handleKey: (s, event) => {
        if (event.key === "q") return { ...s, done: true };
        if (event.key === "j") return { ...s, n: s.n + 1 };
        return s;
      },
      isDone: (s) => s.done,
    });
    expect(finalState.n).toBe(2);
    // Four frames: initial render + one after each key.
    expect(output.frames.length).toBe(4);
  });
});
```

- [ ] **Step 2: Implement on `Screen`**

```ts
async runLoop<S>(opts: {
  initialState: S;
  render: (state: S) => Element;
  handleKey: (state: S, event: KeyEvent) => S;
  isDone: (state: S) => boolean;
  label?: string;
}): Promise<S> {
  let state = opts.initialState;
  this.render(opts.render(state), opts.label);
  while (!opts.isDone(state)) {
    const event = await this.nextKey();
    state = opts.handleKey(state, event);
    this.render(opts.render(state), opts.label);
  }
  return state;
}
```

- [ ] **Step 3: Pass tests**
- [ ] **Step 4: Commit** `tui: Screen.runLoop wraps the render → key → render cycle`

---

### Task 5 — Renderer auto-clips overlong `text` to its box width

**Files:** modify [lib/tui/render/renderer.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/render/renderer.ts); test in [lib/tui/test/renderer.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/test/renderer.test.ts).

Today `text` content longer than its resolved width overflows or is silently truncated by the cell grid depending on the path. Make the truncation explicit and consistent: clip to `(resolvedWidth - 1)` and append `…` whenever clipped.

> **NOTE:** Width is measured in UTF-16 code units to match today's behavior. Grapheme-aware clipping is out of scope for this task and tracked separately (see render.ts comment from PR #154); call it out in the renderer comment so the next reader knows.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { layout } from "../layout.js";
import { render } from "../render/renderer.js";
import { line } from "../builders.js";

describe("renderer auto-clips long text", () => {
  it("appends an ellipsis when text exceeds the resolved width", () => {
    const positioned = layout(line("abcdefghij"), 5, 1);
    const frame = render(positioned);
    expect(frame.toPlainText()).toBe("abcd…");
  });
  it("leaves text untouched when it fits", () => {
    const positioned = layout(line("abc"), 10, 1);
    const frame = render(positioned);
    expect(frame.toPlainText()).toBe("abc");
  });
});
```

- [ ] **Step 2: Find the renderer's text-content path** (around `parseStyledText` invocation) and clip the produced cells to `resolvedWidth`, substituting the last cell with `…` when overrun. Centralize as a `clipCellsToWidth(cells, width)` helper inside `renderer.ts`.
- [ ] **Step 3: Pass tests** — also re-run the full TUI test suite (`pnpm vitest run lib/tui/`) to make sure no existing text-rendering tests regress.
- [ ] **Step 4: Commit** `tui: renderer auto-clips overlong text content with an ellipsis`

---

### Task 6 — Typed `ColorName` union exported from `lib/tui`

**Files:** modify [lib/tui/colors.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/colors.ts) and [lib/tui/elements.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/elements.ts); index re-export.

Goal: get autocomplete for `fg: "..."` and compile-time validation for the 16 supported color names without breaking the hex-string escape hatch the HTML adapter already supports.

- [ ] **Step 1: Derive a const union from `ansiColors`**

In `colors.ts`:

```ts
export const COLOR_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "gray",
  "bright-red", "bright-green", "bright-yellow", "bright-blue",
  "bright-magenta", "bright-cyan", "bright-white",
] as const;
export type ColorName = (typeof COLOR_NAMES)[number];
```

Add a unit test that every key of `ansiColors` is in `COLOR_NAMES` and vice versa (catches drift):

```ts
import { ansiColors, COLOR_NAMES } from "../colors.js";
it("ColorName covers exactly the named ANSI palette", () => {
  expect([...COLOR_NAMES].sort()).toEqual(Object.keys(ansiColors).sort());
});
```

- [ ] **Step 2: Narrow `Style` fields**

In `elements.ts`, change `fg?: string` (and `bg`, `borderColor`, `labelColor`) to `fg?: ColorName | (string & {})`. The `& {}` trick keeps hex strings (e.g. `"#abc"`) compiling without losing the autocomplete on the named branch. Add a comment explaining.

- [ ] **Step 3: Re-export from [lib/tui/index.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/index.ts)**: `export type { ColorName } from "./colors.js"; export { COLOR_NAMES } from "./colors.js";`
- [ ] **Step 4: Build the project** (`pnpm run build`); fix any callers in `lib/logsViewer/render.ts`, `lib/debugger/`, etc. that were passing color names that don't exist in the palette. The build will surface them all.
- [ ] **Step 5: Commit** `tui: typed ColorName union and narrowed Style color fields`

---

### Task 7 — `ScriptedInput` constructor accepts `(KeyEvent | string)[]`

**Files:** modify [lib/tui/input/scripted.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/input/scripted.ts); test in [lib/tui/test/scripted.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/test/scripted.test.ts).

Sugar: pass keys directly when constructing; mixed string/KeyEvent items welcome.

- [ ] **Step 1: Write failing test**

```ts
it("constructor accepts a list of strings or KeyEvents", async () => {
  const input = new ScriptedInput(["j", "k", { key: "c", ctrl: true }]);
  expect(await input.nextKey()).toEqual({ key: "j" });
  expect(await input.nextKey()).toEqual({ key: "k" });
  expect(await input.nextKey()).toEqual({ key: "c", ctrl: true });
});
```

- [ ] **Step 2: Implement**

```ts
constructor(initial?: ReadonlyArray<KeyEvent | string>) {
  if (initial) {
    for (const item of initial) {
      this.feedKey(typeof item === "string" ? { key: item } : item);
    }
  }
}
```

- [ ] **Step 3: Pass tests** and confirm existing `ScriptedInput` tests still pass (the no-arg path must keep working).
- [ ] **Step 4: Commit** `tui: ScriptedInput accepts an array of keys in its constructor`

---

### Task 8 — `FrameRecorder.lastText()` / `textAt(i)`

**Files:** modify [lib/tui/output/recorder.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/output/recorder.ts); test in [lib/tui/test/recorder.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/tui/test/recorder.test.ts).

- [ ] **Step 1: Write failing test**

```ts
it("textAt() and lastText() expose recorded frames as plain text", () => {
  const rec = new FrameRecorder();
  rec.write(/* frame with content "first" */);
  rec.write(/* frame with content "second" */);
  expect(rec.textAt(0)).toBe("first");
  expect(rec.lastText()).toBe("second");
});
```

(Build the frames via `layout(line("first"), w, h)` + `render(...)` like the runner does.)

- [ ] **Step 2: Implement**

```ts
textAt(i: number): string {
  return this.frames[i].frame.toPlainText();
}

lastText(): string {
  return this.textAt(this.frames.length - 1);
}
```

- [ ] **Step 3: Pass tests**
- [ ] **Step 4: Commit** `tui: FrameRecorder.textAt() / lastText() convenience getters`

---

### Task 9 — Adopt the new primitives in the logs viewer

This is the load-bearing task: prove each new abstraction works for its motivating use case. Touches viewer code only; the test files should mostly tighten, not change behavior.

- [ ] **Step 1: Replace `mapKey()` + key strings with `keyMatches()`**

In [lib/logsViewer/input.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/input.ts), accept a `KeyEvent` directly (drop the `Key` string union) and use `keyMatches(event, "j")` / etc. inside the switch. Delete `mapKey` from [run.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.ts) and pass the raw `KeyEvent` straight into `handleKey`.

Adjust [input.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/input.test.ts) to pass `{ key: "j" }` shapes (or string-named keys via a small wrapper) — they were already using single-char strings that match `formatKey`.

- [ ] **Step 2: Replace inline `row()` with `line()`**

In [run.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.ts) delete the local `row()` helper and call `line(content, { fg })` from `lib/tui`. The empty-state branch becomes `screen.render(lines(["No events found."]))`.

- [ ] **Step 3: Replace `clampScrollTop()` + `ensureCursorVisible()` with `clampScroll()` + `followCursor()`**

In [run.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.ts) the new `draw()` becomes (sketch):

```ts
const rows = flattenVisibleRows(state);
const cursorIdx = rows.findIndex((r) => r.node.id === state.cursorId);
const clamped = clampScroll(state.scrollTop, rows.length, opts.viewport.rows);
state = { ...state, scrollTop: followCursor(clamped, cursorIdx, opts.viewport.rows) };
```

Delete the two local helpers.

- [ ] **Step 4: Replace the manual `…` slice in [render.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/render.ts)**

`renderRow` no longer needs the `line.length > cols` branch — the renderer handles it. Delete the slice + the ASCII-width comment block (the comment migrates to the renderer in Task 5).

- [ ] **Step 5: Replace the loop body with `screen.runLoop()`**

```ts
return await screen.runLoop({
  initialState,
  render: (s) => column(/* ... build elements from s ... */),
  handleKey: (s, event) => handleKey(s, event),
  isDone: (s) => s.quit,
});
```

- [ ] **Step 6: Replace `feed(input, [...])` test helpers with the array constructor**

In [run.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/logsViewer/run.test.ts) delete the `feed()` function and rewrite to `new ScriptedInput(["j", "l", "q"])`.

- [ ] **Step 7: Replace `out.frames[i].frame.toPlainText()` with `out.textAt(i)` / `out.lastText()`** throughout the viewer's tests.

- [ ] **Step 8: Run the full suite**

```bash
pnpm test:run
node tests/integration/statelog/test.mjs
pnpm run lint:structure
make
```

All previously-passing counts must hold; the viewer should still behave identically.

- [ ] **Step 9: Manually smoke the CLI** against a real `.jsonl` file to confirm the looped-rendering and color output are unchanged.
- [ ] **Step 10: Commit** `logsViewer: adopt tui line/lines, scroll helpers, runLoop, key utils`

---

### Task 10 — Update documentation

- [ ] Add a section to [docs/site/guide/observability.md](file:///Users/adityabhargava/agency-lang/packages/agency-lang/docs/site/guide/observability.md) only if anything user-facing changed (it shouldn't; this is internal refactor).
- [ ] Add a short developer-facing reference: `docs/dev/tui.md` (create if missing) covering: `line` / `lines`, `clampScroll` / `followCursor`, `Screen.runLoop`, `formatKey` / `keyMatches`, `ColorName`. Two paragraphs each, with the existing logs viewer cited as the canonical example.
- [ ] **Commit** `docs: developer reference for the new TUI primitives`

---

## Validation Checklist

Before opening the PR, verify all of:

- [ ] `pnpm test:run` shows the previously-known passing count + the new tests (≈ 20 new tests across `lib/tui/` and `lib/tui/input/`; viewer test count holds steady).
- [ ] `pnpm run lint:structure` clean except for the pre-existing `lib/lsp/hover.ts` error.
- [ ] `make` builds cleanly with no new warnings.
- [ ] `node tests/integration/statelog/test.mjs` → 8/8 scenarios pass.
- [ ] Manual smoke: `pnpm run agency logs view <real-file>` opens, navigates, expands/collapses, scrolls long content, exits cleanly — identical to current behavior.
- [ ] `lib/logsViewer/run.ts` is shorter than its current ~110 lines (concrete win is "deletions > additions").
- [ ] No file outside `lib/tui/`, `lib/logsViewer/`, and `docs/` is modified, unless the typed `ColorName` migration in Task 6 forced a callsite update (which is fine — list any such callsites in the PR description).

---

## Anti-pattern review

Per [docs/dev/anti-patterns.md](file:///Users/adityabhargava/agency-lang/packages/agency-lang/docs/dev/anti-patterns.md), this plan deliberately avoids:

- **Dynamic imports** — every new export is statically resolved through `lib/tui/index.ts`.
- **Maps / Sets** — `clampScroll` and `followCursor` operate on plain `number`s; `COLOR_NAMES` is a tuple, not a `Set`.
- **Order-dependent mutable state inside helpers** — `clampScroll`, `followCursor`, `formatKey`, `keyMatches` are pure; `runLoop` mutates `state` via reassignment but the contract is functional (`handleKey(s, e) => s`).
- **Nested ternaries** — none introduced.
- **Helper duplication** — every helper extracted from the viewer is deleted from the viewer in Task 9.

---

## Out of scope (deferred)

- **Grapheme-aware text clipping** (UTF-16 vs display cells). Tracked from PR #154; rolled into a follow-up issue when Task 5 lands.
- **`<ScrollableList>` element with selection model**. The functional `clampScroll`/`followCursor` helpers handle the viewer's needs today. A higher-level component is worth doing once a second consumer needs it.
- **Generalized "key chord" parsing** (multi-key sequences like `gg`). `formatKey` returns single-key strings only.
- **Cursor styling via inverse video or bg-highlight**. The viewer keeps its leading `> ` prefix; revisit when we add a `<ListItem selected>` abstraction.
