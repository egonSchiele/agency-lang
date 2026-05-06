# TUI Library and Debugger Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a testable TUI library (`@agency-lang/tui`) to replace blessed in the Agency debugger, and a new test harness that produces visual HTML artifacts for easy debugging.

**Architecture:** Immediate-mode TUI library with flexbox-lite layout engine, multiple output adapters (ANSI, HTML, plain text), and pluggable input sources. The debugger test harness wraps the TUI lib and debugger driver, providing a step-at-a-time API with frame inspection.

**Tech Stack:** TypeScript, vitest, pnpm workspace

**Spec:** `docs/superpowers/specs/2026-05-05-tui-library-and-debugger-test-harness-design.md`

---

## File Structure

### New package: `packages/tui/`

```
packages/tui/
  package.json
  tsconfig.json
  vitest.config.ts
  lib/
    index.ts              # Public API re-exports
    elements.ts           # Element, Style, StyleProps types
    builders.ts           # box(), row(), column(), text(), list(), textInput()
    layout.ts             # Flexbox-lite layout engine
    frame.ts              # Frame class, Cell type, FrameStyle type, flatten utility
    styleParser.ts        # Parse inline style tags ({bold}, {red-fg}, etc.)
    colors.ts             # Color name -> ANSI code / CSS color mappings
    render/
      renderer.ts         # Element tree -> Frame tree
      flatten.ts          # Composite Frame tree into 2D cell grid (shared by all adapters)
      ansi.ts             # Frame -> ANSI escape codes
      html.ts             # Frame -> HTML string
      plaintext.ts        # Frame -> plain text string
    input/
      types.ts            # KeyEvent, InputSource types
      terminal.ts         # TerminalInput (stdin raw mode)
      scripted.ts         # ScriptedInput (programmatic)
    output/
      types.ts            # OutputTarget type
      terminal.ts         # TerminalOutput (ANSI to stdout)
      recorder.ts         # FrameRecorder (collect frames)
    screen.ts             # Screen class
  test/
    elements.test.ts
    builders.test.ts
    layout.test.ts
    styleParser.test.ts
    frame.test.ts
    renderer.test.ts
    ansi.test.ts
    html.test.ts
    plaintext.test.ts
    scripted.test.ts
    recorder.test.ts
    screen.test.ts
```

### Modified in `packages/agency-lang/`

```
lib/debugger/
  testSession.ts          # NEW: DebuggerTestSession class
  testSession.test.ts     # NEW: Tests for DebuggerTestSession
  ui.ts                   # REWRITE: Replace blessed with @agency-lang/tui
  driver.test.ts          # REWRITE: Use DebuggerTestSession instead of TestDebuggerIO
  testHelpers.ts          # MODIFY: Update/simplify helpers, keep freshImport
```

---

## Task 1: Package scaffolding

**Files:**
- Create: `packages/tui/package.json`
- Create: `packages/tui/tsconfig.json`
- Create: `packages/tui/vitest.config.ts`
- Create: `packages/tui/lib/index.ts`

- [ ] **Step 1: Create `packages/tui/package.json`**

```json
{
  "name": "@agency-lang/tui",
  "version": "0.0.1",
  "description": "A testable TUI library with immediate-mode rendering and flexbox layout",
  "type": "module",
  "main": "./dist/lib/index.js",
  "types": "./dist/lib/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/lib/index.d.ts",
      "import": "./dist/lib/index.js"
    }
  },
  "files": ["dist/"],
  "scripts": {
    "build": "tsc",
    "test": "vitest",
    "test:run": "vitest run"
  },
  "keywords": ["tui", "terminal", "ui", "flexbox"],
  "author": "Aditya Bhargava",
  "license": "ISC",
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/tui/tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "esnext",
    "declaration": true,
    "outDir": "./dist",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["lib"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create `packages/tui/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create empty `packages/tui/lib/index.ts`**

```typescript
// Public API — exports will be added as modules are built
```

- [ ] **Step 5: Install dependencies**

Run: `cd packages/tui && pnpm install`

- [ ] **Step 6: Verify build works**

Run: `cd packages/tui && pnpm run build`
Expected: Compiles with no errors, creates `dist/` directory.

- [ ] **Step 7: Commit**

```
feat(tui): scaffold @agency-lang/tui package
```

---

## Task 2: Element types and builder functions

**Files:**
- Create: `packages/tui/lib/elements.ts`
- Create: `packages/tui/lib/builders.ts`
- Create: `packages/tui/test/builders.test.ts`

- [ ] **Step 1: Write the test for builder functions**

```typescript
// test/builders.test.ts
import { describe, it, expect } from "vitest";
import { box, row, column, text, list, textInput } from "../lib/builders.js";

describe("builders", () => {
  it("text() creates a text element", () => {
    const el = text("hello");
    expect(el).toEqual({ type: "text", content: "hello" });
  });

  it("box() with style and children", () => {
    const el = box({ border: true, key: "mybox" }, text("hi"));
    expect(el.type).toBe("box");
    expect(el.key).toBe("mybox");
    expect(el.style?.border).toBe(true);
    expect(el.children).toHaveLength(1);
    expect(el.children![0].content).toBe("hi");
  });

  it("box() without style treats all args as children", () => {
    const el = box(text("a"), text("b"));
    expect(el.type).toBe("box");
    expect(el.style).toBeUndefined();
    expect(el.children).toHaveLength(2);
  });

  it("row() sets flexDirection to row", () => {
    const el = row({ flex: 1 }, text("a"));
    expect(el.style?.flexDirection).toBe("row");
  });

  it("column() sets flexDirection to column", () => {
    const el = column({ flex: 1 }, text("a"));
    expect(el.style?.flexDirection).toBe("column");
  });

  it("list() creates a list element", () => {
    const el = list({ key: "mylist" }, ["a", "b", "c"], 1);
    expect(el.type).toBe("list");
    expect(el.items).toEqual(["a", "b", "c"]);
    expect(el.selectedIndex).toBe(1);
  });

  it("textInput() creates a textInput element", () => {
    const el = textInput({ key: "input" }, "hello");
    expect(el.type).toBe("textInput");
    expect(el.value).toBe("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tui && pnpm vitest run test/builders.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Implement `elements.ts`**

Define the `Element`, `StyleProps`, `Cell`, `FrameStyle` types and the `PositionedElement` type used by the layout engine. See the spec's "Element Descriptor" section for the full type. Also define `Cell` and `FrameStyle` here since they are foundational types.

```typescript
// lib/elements.ts
export type Element = {
  type: "box" | "text" | "list" | "textInput";
  style?: Style;
  content?: string;
  children?: Element[];
  items?: string[];
  selectedIndex?: number;
  value?: string;
  key?: string;
};

export type Style = {
  flexDirection?: "row" | "column";
  flex?: number;
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between";
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch";
  width?: number | string;
  height?: number | string;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  padding?: number | { top?: number; bottom?: number; left?: number; right?: number };
  margin?: number | { top?: number; bottom?: number; left?: number; right?: number };
  border?: boolean;
  borderColor?: string;
  label?: string;
  labelColor?: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  scrollable?: boolean;
  scrollOffset?: number;
  visible?: boolean;
};

export type StyleProps = Style & { key?: string };

export type Cell = {
  char: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
};

export type FrameStyle = {
  border?: boolean;
  borderColor?: string;
  bg?: string;
  label?: string;
  labelColor?: string;
};

export type PositionedElement = Element & {
  resolvedX: number;
  resolvedY: number;
  resolvedWidth: number;
  resolvedHeight: number;
  children?: PositionedElement[];
};
```

- [ ] **Step 4: Implement `builders.ts`**

```typescript
// lib/builders.ts
import type { Element, StyleProps } from "./elements.js";

function isStyleProps(arg: any): arg is StyleProps {
  return arg !== null && typeof arg === "object" && !("type" in arg);
}

function splitStyleAndKey(props: StyleProps): { style: Element["style"]; key?: string } {
  const { key, ...style } = props;
  return { style: Object.keys(style).length > 0 ? style : undefined, key };
}

export function box(styleOrChild?: StyleProps | Element, ...children: Element[]): Element {
  if (styleOrChild === undefined) {
    return { type: "box" };
  }
  if (isStyleProps(styleOrChild)) {
    const { style, key } = splitStyleAndKey(styleOrChild);
    return { type: "box", style, key, children: children.length > 0 ? children : undefined };
  }
  return { type: "box", children: [styleOrChild, ...children] };
}

export function row(styleOrChild?: StyleProps | Element, ...children: Element[]): Element {
  if (styleOrChild === undefined) {
    return { type: "box", style: { flexDirection: "row" } };
  }
  if (isStyleProps(styleOrChild)) {
    const { style, key } = splitStyleAndKey(styleOrChild);
    return {
      type: "box",
      style: { ...style, flexDirection: "row" },
      key,
      children: children.length > 0 ? children : undefined,
    };
  }
  return { type: "box", style: { flexDirection: "row" }, children: [styleOrChild, ...children] };
}

export function column(styleOrChild?: StyleProps | Element, ...children: Element[]): Element {
  if (styleOrChild === undefined) {
    return { type: "box", style: { flexDirection: "column" } };
  }
  if (isStyleProps(styleOrChild)) {
    const { style, key } = splitStyleAndKey(styleOrChild);
    return {
      type: "box",
      style: { ...style, flexDirection: "column" },
      key,
      children: children.length > 0 ? children : undefined,
    };
  }
  return { type: "box", style: { flexDirection: "column" }, children: [styleOrChild, ...children] };
}

export function text(content: string): Element {
  return { type: "text", content };
}

export function list(style: StyleProps, items: string[], selectedIndex?: number): Element {
  const { style: resolvedStyle, key } = splitStyleAndKey(style);
  return { type: "list", style: resolvedStyle, key, items, selectedIndex };
}

export function textInput(style: StyleProps, value?: string): Element {
  const { style: resolvedStyle, key } = splitStyleAndKey(style);
  return { type: "textInput", style: resolvedStyle, key, value };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/tui && pnpm vitest run test/builders.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Export from index.ts**

Add to `lib/index.ts`:
```typescript
export * from "./elements.js";
export * from "./builders.js";
```

- [ ] **Step 7: Commit**

```
feat(tui): add element types and builder functions
```

---

## Task 3: Style tag parser and color system

**Files:**
- Create: `packages/tui/lib/styleParser.ts`
- Create: `packages/tui/lib/colors.ts`
- Create: `packages/tui/test/styleParser.test.ts`

- [ ] **Step 1: Write tests for the style tag parser**

The parser takes a string like `"{bold}hello{/bold} {red-fg}world{/red-fg}"` and returns an array of styled spans: `[{ text: "hello", bold: true }, { text: " " }, { text: "world", fg: "red" }]`.

```typescript
// test/styleParser.test.ts
import { describe, it, expect } from "vitest";
import { parseStyledText, type StyledSpan } from "../lib/styleParser.js";

describe("parseStyledText", () => {
  it("returns plain text as a single span", () => {
    expect(parseStyledText("hello")).toEqual([{ text: "hello" }]);
  });

  it("parses bold tags", () => {
    expect(parseStyledText("{bold}hi{/bold}")).toEqual([{ text: "hi", bold: true }]);
  });

  it("parses fg color tags", () => {
    expect(parseStyledText("{red-fg}hi{/red-fg}")).toEqual([{ text: "hi", fg: "red" }]);
  });

  it("parses bg color tags", () => {
    expect(parseStyledText("{blue-bg}hi{/blue-bg}")).toEqual([{ text: "hi", bg: "blue" }]);
  });

  it("handles nested tags", () => {
    const result = parseStyledText("{bold}{red-fg}hi{/red-fg}{/bold}");
    expect(result).toEqual([{ text: "hi", bold: true, fg: "red" }]);
  });

  it("handles mixed styled and unstyled text", () => {
    const result = parseStyledText("hello {bold}world{/bold} foo");
    expect(result).toEqual([
      { text: "hello " },
      { text: "world", bold: true },
      { text: " foo" },
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseStyledText("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tui && pnpm vitest run test/styleParser.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `colors.ts`**

Map named colors to ANSI codes and CSS values. See the spec's "Color System" section.

```typescript
// lib/colors.ts
export const ansiColors: Record<string, string> = {
  black: "\x1b[30m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", white: "\x1b[37m",
  gray: "\x1b[90m",
  "bright-red": "\x1b[91m", "bright-green": "\x1b[92m", "bright-yellow": "\x1b[93m",
  "bright-blue": "\x1b[94m", "bright-magenta": "\x1b[95m", "bright-cyan": "\x1b[96m",
  "bright-white": "\x1b[97m",
};

export const ansiBgColors: Record<string, string> = {
  black: "\x1b[40m", red: "\x1b[41m", green: "\x1b[42m", yellow: "\x1b[43m",
  blue: "\x1b[44m", magenta: "\x1b[45m", cyan: "\x1b[46m", white: "\x1b[47m",
  gray: "\x1b[100m",
  "bright-red": "\x1b[101m", "bright-green": "\x1b[102m", "bright-yellow": "\x1b[103m",
  "bright-blue": "\x1b[104m", "bright-magenta": "\x1b[105m", "bright-cyan": "\x1b[106m",
  "bright-white": "\x1b[107m",
};

export const cssColors: Record<string, string> = {
  black: "#000", red: "#c00", green: "#0a0", yellow: "#aa0",
  blue: "#00a", magenta: "#a0a", cyan: "#0aa", white: "#ccc",
  gray: "#888",
  "bright-red": "#f55", "bright-green": "#5f5", "bright-yellow": "#ff5",
  "bright-blue": "#55f", "bright-magenta": "#f5f", "bright-cyan": "#5ff",
  "bright-white": "#fff",
};
```

- [ ] **Step 4: Implement `styleParser.ts`**

Parse inline style tags into spans. The parser walks the string, tracking a style stack. Opening tags like `{bold}` push onto the stack, closing tags like `{/bold}` pop.

```typescript
// lib/styleParser.ts
export type StyledSpan = {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
};

export function parseStyledText(input: string): StyledSpan[] {
  // Implementation: regex-based tag parser that maintains a style stack.
  // Opens: {bold}, {red-fg}, {blue-bg}
  // Closes: {/bold}, {/red-fg}, {/blue-bg}
  // Between tags: accumulate text into current span with current style.
  // See spec "Inline Style Tags" section for the full tag syntax.
  // ...
}
```

Implement the full parser. Key behavior:
- `{bold}` pushes bold onto style stack
- `{COLOR-fg}` pushes fg color onto style stack
- `{COLOR-bg}` pushes bg color onto style stack
- `{/TAG}` pops matching entry from style stack
- Text between tags becomes a `StyledSpan` with the current accumulated style
- Return `[]` for empty string

Also implement `escapeStyleTags(text: string): string` — escapes `{` and `}` in user-provided text so they aren't interpreted as style tags. This is the equivalent of blessed's `blessed.escape()`, which the current debugger UI calls on all variable values, file paths, and log messages before rendering. Without this, a variable containing `{bold}` would be misinterpreted.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/tui && pnpm vitest run test/styleParser.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Export from index.ts**

Add to `lib/index.ts`:
```typescript
export * from "./styleParser.js";
export * from "./colors.js";
```

- [ ] **Step 7: Commit**

```
feat(tui): add style tag parser and color system
```

---

## Task 4: Flexbox-lite layout engine

**Files:**
- Create: `packages/tui/lib/layout.ts`
- Create: `packages/tui/test/layout.test.ts`

This is the most complex task. The layout engine is a pure function: `(element, width, height) -> PositionedElement`. It resolves flexbox properties to absolute positions.

- [ ] **Step 1: Write tests for the layout engine**

Test cases cover: fixed sizing, percentage sizing, flex grow, row vs column direction, nested layouts, padding, margin, border space, min/max constraints, invisible elements. Write at least 10-15 tests.

```typescript
// test/layout.test.ts
import { describe, it, expect } from "vitest";
import { layout } from "../lib/layout.js";
import { box, row, column, text } from "../lib/builders.js";

describe("layout", () => {
  it("single box fills available space", () => {
    const el = box({ key: "a" });
    const result = layout(el, 80, 24);
    expect(result.resolvedX).toBe(0);
    expect(result.resolvedY).toBe(0);
    expect(result.resolvedWidth).toBe(80);
    expect(result.resolvedHeight).toBe(24);
  });

  it("fixed width and height", () => {
    const el = box({ width: 40, height: 10 });
    const result = layout(el, 80, 24);
    expect(result.resolvedWidth).toBe(40);
    expect(result.resolvedHeight).toBe(10);
  });

  it("percentage width", () => {
    const el = box({ width: "50%" });
    const result = layout(el, 80, 24);
    expect(result.resolvedWidth).toBe(40);
  });

  it("column direction stacks children vertically", () => {
    const el = column(
      box({ key: "a", height: 5 }),
      box({ key: "b", height: 5 }),
    );
    const result = layout(el, 80, 24);
    const a = result.children!.find(c => c.key === "a")!;
    const b = result.children!.find(c => c.key === "b")!;
    expect(a.resolvedY).toBe(0);
    expect(b.resolvedY).toBe(5);
  });

  it("row direction places children horizontally", () => {
    const el = row(
      box({ key: "a", width: 20 }),
      box({ key: "b", width: 30 }),
    );
    const result = layout(el, 80, 24);
    const a = result.children!.find(c => c.key === "a")!;
    const b = result.children!.find(c => c.key === "b")!;
    expect(a.resolvedX).toBe(0);
    expect(b.resolvedX).toBe(20);
  });

  it("flex distributes remaining space", () => {
    const el = row(
      box({ key: "a", width: 20 }),
      box({ key: "b", flex: 1 }),
    );
    const result = layout(el, 80, 24);
    const b = result.children!.find(c => c.key === "b")!;
    expect(b.resolvedWidth).toBe(60);
  });

  it("multiple flex children split space proportionally", () => {
    const el = row(
      box({ key: "a", flex: 1 }),
      box({ key: "b", flex: 2 }),
    );
    const result = layout(el, 90, 24);
    const a = result.children!.find(c => c.key === "a")!;
    const b = result.children!.find(c => c.key === "b")!;
    expect(a.resolvedWidth).toBe(30);
    expect(b.resolvedWidth).toBe(60);
  });

  it("border reduces inner space by 2 in each dimension", () => {
    const el = box({ width: 20, height: 10, border: true },
      box({ key: "inner", flex: 1 })
    );
    const result = layout(el, 80, 24);
    const inner = result.children!.find(c => c.key === "inner")!;
    expect(inner.resolvedWidth).toBe(18);
    expect(inner.resolvedHeight).toBe(8);
  });

  it("invisible elements take no space", () => {
    const el = column(
      box({ key: "a", height: 5 }),
      box({ key: "b", height: 5, visible: false }),
      box({ key: "c", height: 5 }),
    );
    const result = layout(el, 80, 24);
    const c = result.children!.find(c => c.key === "c")!;
    expect(c.resolvedY).toBe(5);
  });

  it("nested layout", () => {
    const el = column(
      box({ key: "top", height: "40%" }),
      row({ flex: 1 },
        box({ key: "left", width: "50%" }),
        box({ key: "right", flex: 1 }),
      ),
    );
    const result = layout(el, 100, 20);
    const top = result.children!.find(c => c.key === "top")!;
    expect(top.resolvedHeight).toBe(8);
    const rowEl = result.children![1];
    const left = rowEl.children!.find(c => c.key === "left")!;
    const right = rowEl.children!.find(c => c.key === "right")!;
    expect(left.resolvedWidth).toBe(50);
    expect(right.resolvedWidth).toBe(50);
    expect(left.resolvedY).toBe(8);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tui && pnpm vitest run test/layout.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `layout.ts`**

Implement the `layout(element, width, height): PositionedElement` function. The algorithm:

1. Resolve the root element's size (use provided width/height if no explicit size).
2. For each element with children, determine the main axis (row = horizontal, column = vertical).
3. First pass: allocate fixed and percentage children along the main axis. Track remaining space.
4. Second pass: distribute remaining space to flex children proportionally.
5. Position children along the main axis according to `justifyContent`.
6. Position children along the cross axis according to `alignItems`.
7. Account for border (reduces inner area by 1 on each side) and padding.
8. Skip invisible elements (`visible: false`).
9. Recurse into children.

See spec sections "Flexbox-Lite Layout Engine" and "Text Overflow and Scrolling".

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/tui && pnpm vitest run test/layout.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Export from index.ts**

Add to `lib/index.ts`:
```typescript
export * from "./layout.js";
```

- [ ] **Step 6: Commit**

```
feat(tui): add flexbox-lite layout engine
```

---

## Task 5: Frame class

**Files:**
- Create: `packages/tui/lib/frame.ts`
- Create: `packages/tui/test/frame.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// test/frame.test.ts
import { describe, it, expect } from "vitest";
import { Frame } from "../lib/frame.js";

describe("Frame", () => {
  it("findByKey returns matching child", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 80, height: 24, style: {},
      children: [
        new Frame({ key: "a", x: 0, y: 0, width: 40, height: 24, style: {} }),
        new Frame({ key: "b", x: 40, y: 0, width: 40, height: 24, style: {} }),
      ],
    });
    expect(frame.findByKey("b")).toBeDefined();
    expect(frame.findByKey("b")!.key).toBe("b");
  });

  it("findByKey searches recursively", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 80, height: 24, style: {},
      children: [
        new Frame({
          key: "parent", x: 0, y: 0, width: 80, height: 24, style: {},
          children: [
            new Frame({ key: "nested", x: 0, y: 0, width: 40, height: 12, style: {} }),
          ],
        }),
      ],
    });
    expect(frame.findByKey("nested")).toBeDefined();
  });

  it("findByKey returns undefined for missing key", () => {
    const frame = new Frame({ x: 0, y: 0, width: 80, height: 24, style: {} });
    expect(frame.findByKey("nope")).toBeUndefined();
  });

  it("toPlainText produces text from content cells", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 5, height: 1, style: {},
      content: [[
        { char: "h" }, { char: "e" }, { char: "l" }, { char: "l" }, { char: "o" },
      ]],
    });
    expect(frame.toPlainText()).toContain("hello");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tui && pnpm vitest run test/frame.test.ts`

- [ ] **Step 3: Create stub output adapter files**

The Frame class imports `toPlainText` and `toHTML`, which are implemented fully in Task 7. Create stubs now so imports resolve:

```typescript
// lib/render/plaintext.ts
import type { Frame } from "../frame.js";
export function toPlainText(frame: Frame): string {
  // Stub — full implementation in Task 7
  const lines: string[] = [];
  for (const row of frame.content ?? []) {
    lines.push(row.map(c => c.char).join(""));
  }
  return lines.join("\n");
}
```

```typescript
// lib/render/html.ts
import type { Frame } from "../frame.js";
export function toHTML(frame: Frame): string {
  // Stub — full implementation in Task 7
  return `<pre>${frame.content?.map(row => row.map(c => c.char).join("")).join("\n") ?? ""}</pre>`;
}
```

- [ ] **Step 4: Implement `frame.ts`**

```typescript
// lib/frame.ts
import type { Cell, FrameStyle } from "./elements.js";
import { toPlainText } from "./render/plaintext.js";
import { toHTML } from "./render/html.js";
import * as fs from "fs";

type FrameArgs = {
  key?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: FrameStyle;
  content?: Cell[][];
  children?: Frame[];
};

export class Frame {
  key?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: FrameStyle;
  content?: Cell[][];
  children?: Frame[];

  constructor(args: FrameArgs) {
    this.key = args.key;
    this.x = args.x;
    this.y = args.y;
    this.width = args.width;
    this.height = args.height;
    this.style = args.style;
    this.content = args.content;
    this.children = args.children;
  }

  findByKey(key: string): Frame | undefined {
    if (this.key === key) return this;
    for (const child of this.children ?? []) {
      const found = child.findByKey(key);
      if (found) return found;
    }
    return undefined;
  }

  toPlainText(): string {
    return toPlainText(this);
  }

  toHTML(): string {
    return toHTML(this);
  }

  image(path: string): void {
    fs.writeFileSync(path, this.toHTML());
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/tui && pnpm vitest run test/frame.test.ts`

- [ ] **Step 6: Export from index.ts**

Add to `lib/index.ts`:
```typescript
export * from "./frame.js";
```

- [ ] **Step 7: Commit**

```
feat(tui): add Frame class with findByKey, toPlainText, toHTML, image
```

---

## Task 6: Renderer (element tree -> frame tree)

**Files:**
- Create: `packages/tui/lib/render/renderer.ts`
- Create: `packages/tui/test/renderer.test.ts`

The renderer takes a `PositionedElement` tree (output of layout) and produces a `Frame` tree. It handles: borders, labels, text content (parsed via styleParser), scrolling, list rendering, text input rendering.

- [ ] **Step 1: Write tests**

Test that the renderer produces correct Frame trees with cells for: plain text, styled text, borders with labels, scrollable content with offset, list items with selection highlight, text input with cursor.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement `renderer.ts`**

The `render(positioned: PositionedElement): Frame` function:
1. Create a Frame with the element's resolved position/size.
2. If the element has a border, draw border characters into cells. If it has a label, render label text into the top border.
3. Parse content with `parseStyledText()`, render spans into cells. Apply scrollOffset for scrollable elements (skip `scrollOffset` lines, clip to available height).
4. For `list` elements: render items as lines, highlight selectedIndex with a distinct bg. Auto-scroll to keep selected item visible.
5. For `textInput` elements: render the value text, optionally show a cursor character.
6. Recurse into children.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Export from index.ts and commit**

```
feat(tui): add renderer (element tree to frame tree)
```

---

## Task 7: Output adapters (plain text, HTML, ANSI)

**Files:**
- Create: `packages/tui/lib/render/plaintext.ts`
- Create: `packages/tui/lib/render/html.ts`
- Create: `packages/tui/lib/render/ansi.ts`
- Create: `packages/tui/test/plaintext.test.ts`
- Create: `packages/tui/test/html.test.ts`

- [ ] **Step 1: Write tests for plain text adapter**

```typescript
// test/plaintext.test.ts
import { describe, it, expect } from "vitest";
import { toPlainText } from "../lib/render/plaintext.js";
import { Frame } from "../lib/frame.js";

describe("toPlainText", () => {
  it("renders content cells as text", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 5, height: 1, style: {},
      content: [[
        { char: "h" }, { char: "i" }, { char: " " }, { char: " " }, { char: " " },
      ]],
    });
    expect(toPlainText(frame)).toContain("hi");
  });

  it("renders nested children", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 80, height: 2, style: {},
      children: [
        new Frame({
          key: "a", x: 0, y: 0, width: 5, height: 1, style: {},
          content: [[{ char: "A" }, { char: "B" }, { char: "C" }, { char: " " }, { char: " " }]],
        }),
      ],
    });
    expect(toPlainText(frame)).toContain("ABC");
  });
});
```

- [ ] **Step 2: Write tests for HTML adapter**

Test that `toHTML` produces valid HTML with monospace font, correct CSS colors for fg/bg/bold cells, and that the output contains the text content.

- [ ] **Step 3: Run tests to verify they fail**

- [ ] **Step 4: Implement shared `flatten.ts` helper**

All three output adapters need to composite a Frame tree into a flat 2D cell grid. Extract this shared logic into `lib/render/flatten.ts`:

```typescript
// lib/render/flatten.ts
import type { Cell } from "../elements.js";
import type { Frame } from "../frame.js";

// Composite a Frame tree into a flat 2D grid of Cells.
// Recursively blits children on top of parents.
export function flatten(frame: Frame, width: number, height: number): Cell[][] { ... }
```

This function creates a `width x height` grid, fills the frame's background, draws borders, writes content cells, then recursively composites children on top. Each output adapter calls `flatten()` and then formats the resulting grid in its own way.

- [ ] **Step 5: Implement `plaintext.ts`**

Call `flatten()` to get the 2D cell grid, then join each row's characters into a string, trim trailing spaces, join rows with newlines.

- [ ] **Step 6: Implement `html.ts`**

Call `flatten()` to get the 2D cell grid, then produce HTML: a `<pre>` block with `<span>` elements for styled runs. Use CSS classes or inline styles mapping named colors via `cssColors` from `colors.ts`.

- [ ] **Step 7: Implement `ansi.ts`**

Call `flatten()` to get the 2D cell grid, then produce ANSI output: for each row, emit escape codes for style changes between adjacent cells, using `ansiColors`/`ansiBgColors` from `colors.ts`. Reset at the end of each row.

- [ ] **Step 8: Run tests to verify they pass**

- [ ] **Step 9: Export from index.ts and commit**

```
feat(tui): add plain text, HTML, and ANSI output adapters
```

---

## Task 8: Input sources (ScriptedInput, TerminalInput)

**Files:**
- Create: `packages/tui/lib/input/types.ts`
- Create: `packages/tui/lib/input/scripted.ts`
- Create: `packages/tui/lib/input/terminal.ts`
- Create: `packages/tui/test/scripted.test.ts`

- [ ] **Step 1: Write tests for ScriptedInput**

```typescript
// test/scripted.test.ts
import { describe, it, expect } from "vitest";
import { ScriptedInput } from "../lib/input/scripted.js";

describe("ScriptedInput", () => {
  it("replays key events in order", async () => {
    const input = new ScriptedInput();
    input.feedKey({ key: "a" });
    input.feedKey({ key: "b" });
    expect(await input.nextKey()).toEqual({ key: "a" });
    expect(await input.nextKey()).toEqual({ key: "b" });
  });

  it("nextKey waits for input when queue is empty", async () => {
    const input = new ScriptedInput();
    const promise = input.nextKey();
    // Feed after a delay
    setTimeout(() => input.feedKey({ key: "x" }), 10);
    const result = await promise;
    expect(result).toEqual({ key: "x" });
  });

  it("nextLine returns fed line", async () => {
    const input = new ScriptedInput();
    input.feedLine("hello world");
    const line = await input.nextLine("prompt>");
    expect(line).toBe("hello world");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement `types.ts`**

```typescript
// lib/input/types.ts
export type KeyEvent = {
  key: string;
  shift?: boolean;
  ctrl?: boolean;
};

export type InputSource = {
  nextKey(): Promise<KeyEvent>;
  nextLine(prompt: string): Promise<string>;
  destroy(): void;
};
```

- [ ] **Step 4: Implement `scripted.ts`**

`ScriptedInput` maintains two queues: one for key events, one for line inputs. `feedKey()` and `feedLine()` push to the queues. `nextKey()` and `nextLine()` pop from the queues, or return a promise that resolves when the next item is fed.

- [ ] **Step 5: Implement `terminal.ts`**

`TerminalInput` puts stdin in raw mode, reads keypresses, and maps escape sequences (arrow keys, Ctrl combos, etc.) to `KeyEvent` objects. `nextLine()` temporarily exits raw mode and uses readline. `destroy()` restores stdin.

Must handle terminal lifecycle signals that blessed currently manages:
- **SIGINT (Ctrl-C):** Clean up terminal state and exit. In raw mode, SIGINT is not generated automatically — must detect Ctrl-C keypress and handle it.
- **SIGTSTP (Ctrl-Z):** Exit raw mode and alternate screen buffer, then send SIGTSTP to suspend. On SIGCONT, re-enter raw mode and alternate buffer, force full repaint.
- **SIGCONT:** Re-enter raw mode and alternate screen buffer, trigger a full repaint.
- **uncaughtException:** Clean up terminal state before crashing (exit alternate buffer, show cursor, restore stdin).

These can be installed in `TerminalInput.init()` or in a shared `TerminalLifecycle` helper used by both `TerminalInput` and `TerminalOutput`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/tui && pnpm vitest run test/scripted.test.ts`

- [ ] **Step 7: Export and commit**

```
feat(tui): add ScriptedInput and TerminalInput
```

---

## Task 9: Output targets (TerminalOutput, FrameRecorder)

**Files:**
- Create: `packages/tui/lib/output/types.ts`
- Create: `packages/tui/lib/output/terminal.ts`
- Create: `packages/tui/lib/output/recorder.ts`
- Create: `packages/tui/test/recorder.test.ts`

- [ ] **Step 1: Write tests for FrameRecorder**

```typescript
// test/recorder.test.ts
import { describe, it, expect } from "vitest";
import { FrameRecorder } from "../lib/output/recorder.js";
import { Frame } from "../lib/frame.js";

describe("FrameRecorder", () => {
  it("records frames with labels", () => {
    const recorder = new FrameRecorder();
    const frame = new Frame({ x: 0, y: 0, width: 80, height: 24, style: {} });
    recorder.write(frame, "press s");
    expect(recorder.frames).toHaveLength(1);
    expect(recorder.frames[0].label).toBe("press s");
  });

  it("writeHTML produces valid HTML with all frames", () => {
    const recorder = new FrameRecorder();
    recorder.write(
      new Frame({ x: 0, y: 0, width: 10, height: 2, style: {},
        content: [[{ char: "h" }, { char: "i" }]] }),
      "step 1"
    );
    recorder.write(
      new Frame({ x: 0, y: 0, width: 10, height: 2, style: {},
        content: [[{ char: "b" }, { char: "y" }]] }),
      "step 2"
    );
    const html = recorder.toHTML();
    expect(html).toContain("step 1");
    expect(html).toContain("step 2");
    expect(html).toContain("<pre");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement `types.ts`, `recorder.ts`, `terminal.ts`**

`OutputTarget` interface (note: adds `label` parameter not in original spec — needed so `FrameRecorder` can label each frame with the command that produced it):
```typescript
export type OutputTarget = {
  write(frame: Frame, label?: string): void;
  flush?(): void;
};
```

`FrameRecorder`: stores `{ frame: Frame, label?: string }[]`. Has `toHTML()` that produces a single HTML file with all frames rendered, each labeled with the command, and prev/next navigation via simple JS.

`TerminalOutput`: takes a Frame, calls `toANSI()`, writes to stdout. On first write, enters alternate screen buffer and hides cursor. On destroy, exits alternate buffer, shows cursor, restores terminal state. Coordinates with `TerminalInput` on signal handling (SIGTSTP/SIGCONT need both input and output to participate).

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Export and commit**

```
feat(tui): add FrameRecorder and TerminalOutput
```

---

## Task 10: Screen class

**Files:**
- Create: `packages/tui/lib/screen.ts`
- Create: `packages/tui/test/screen.test.ts`

- [ ] **Step 1: Write tests**

Test that Screen orchestrates layout -> render -> output in a single `render()` call. Use `ScriptedInput` and `FrameRecorder` so everything is in-process.

```typescript
// test/screen.test.ts
import { describe, it, expect } from "vitest";
import { Screen } from "../lib/screen.js";
import { ScriptedInput } from "../lib/input/scripted.js";
import { FrameRecorder } from "../lib/output/recorder.js";
import { box, text } from "../lib/builders.js";

describe("Screen", () => {
  it("render produces a frame and writes to output", () => {
    const recorder = new FrameRecorder();
    const input = new ScriptedInput();
    const screen = new Screen({ output: recorder, input, width: 40, height: 10 });

    const frame = screen.render(box({ border: true, key: "main" }, text("hello")));
    expect(frame).toBeDefined();
    expect(frame.findByKey("main")).toBeDefined();
    expect(recorder.frames).toHaveLength(1);
  });

  it("nextKey returns events from input source", async () => {
    const recorder = new FrameRecorder();
    const input = new ScriptedInput();
    input.feedKey({ key: "s" });
    const screen = new Screen({ output: recorder, input, width: 40, height: 10 });

    const key = await screen.nextKey();
    expect(key).toEqual({ key: "s" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement `screen.ts`**

```typescript
// lib/screen.ts
import type { Element } from "./elements.js";
import type { InputSource, KeyEvent } from "./input/types.js";
import type { OutputTarget } from "./output/types.js";
import { layout } from "./layout.js";
import { render } from "./render/renderer.js";
import { Frame } from "./frame.js";

export class Screen {
  private output: OutputTarget;
  private input: InputSource;
  private width: number;
  private height: number;

  constructor(opts: { output: OutputTarget; input: InputSource; width: number; height: number }) {
    this.output = opts.output;
    this.input = opts.input;
    this.width = opts.width;
    this.height = opts.height;
  }

  render(root: Element, label?: string): Frame {
    const positioned = layout(root, this.width, this.height);
    const frame = render(positioned);
    this.output.write(frame, label);
    return frame;
  }

  nextKey(): Promise<KeyEvent> {
    return this.input.nextKey();
  }

  nextLine(prompt: string): Promise<string> {
    return this.input.nextLine(prompt);
  }

  size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  destroy(): void {
    this.input.destroy();
    if (this.output.flush) this.output.flush();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Final index.ts exports**

Make sure `lib/index.ts` exports everything:
```typescript
export * from "./elements.js";
export * from "./builders.js";
export * from "./styleParser.js";
export * from "./colors.js";
export * from "./layout.js";
export * from "./frame.js";
export * from "./render/renderer.js";
export * from "./render/plaintext.js";
export * from "./render/html.js";
export * from "./render/ansi.js";
export * from "./input/types.js";
export * from "./input/scripted.js";
export * from "./input/terminal.js";
export * from "./output/types.js";
export * from "./output/terminal.js";
export * from "./output/recorder.js";
export * from "./screen.js";
```

- [ ] **Step 6: Run full test suite**

Run: `cd packages/tui && pnpm vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```
feat(tui): add Screen class — completes TUI library core
```

---

## Task 11: Migrate debugger UI from blessed to @agency-lang/tui

**Files:**
- Modify: `packages/agency-lang/package.json` — add `@agency-lang/tui`, keep `blessed` for now
- Rewrite: `packages/agency-lang/lib/debugger/ui.ts`

The key design decision: `DebuggerUI` is refactored to accept a `Screen` via its constructor instead of creating blessed widgets. In production, it gets a `Screen` wired to `TerminalInput`/`TerminalOutput`. In tests, it gets a `Screen` wired to `ScriptedInput`/`FrameRecorder`. This means the same UI code runs in both contexts — no duplication of rendering logic or key mappings.

- [ ] **Step 1: Add `@agency-lang/tui` dependency to agency-lang**

Add to `packages/agency-lang/package.json` dependencies:
```json
"@agency-lang/tui": "workspace:*"
```

Run: `pnpm install`

- [ ] **Step 2: Rewrite `ui.ts`**

Replace the blessed-based `DebuggerUI` with a new implementation that uses `@agency-lang/tui`. The new class:

1. Implements `DebuggerIO` (same interface as before — driver doesn't change).
2. Constructor accepts a `Screen` instance instead of creating its own blessed widgets. This makes the class testable — production code passes a terminal-backed Screen, tests pass a recorder-backed Screen.
3. In `render()`, builds an element tree from `UIState` data using builder functions. Uses the same layout as the current UI: source (40%), locals+globals+callstack (25%), activity+stdout (remaining), command bar (3 rows), stats bar (1 row). All panes get a `key` prop for frame inspection.
4. In `waitForCommand()`, calls `screen.nextKey()` and maps key events to `DebuggerCommand` objects.
5. `showRewindSelector()` and `showCheckpointsPanel()` switch to overlay element trees and handle their own key loop via `screen.nextKey()`.
6. Focus cycling (tab), zoom (z), thread cycling ([ / ]) are handled as state that affects the element tree built in `render()`.

Port the following from the current `ui.ts`:
- Key mappings from `waitForCommand()`
- Source pane rendering (syntax highlighting, line numbers, current line marker)
- Locals/globals/callstack pane formatting
- Activity and stdout pane rendering
- Rewind selector and checkpoints panel overlay logic
- Spinner (can be simplified — just show "working..." text)
- Text input for command bar

Reference the spec's "Dynamic Layout Examples" for how to handle conditional panes and overlays.

- [ ] **Step 3: Manually test the debugger interactively**

Run: `cd packages/agency-lang && pnpm run agency debug tests/debugger/step-test.agency`
Verify: Debugger launches, stepping works, variable display works, quit works.

- [ ] **Step 4: Commit**

```
feat(debugger): rewrite UI from blessed to @agency-lang/tui
```

---

## Task 12: DebuggerTestSession

**Files:**
- Create: `packages/agency-lang/lib/debugger/testSession.ts`
- Create: `packages/agency-lang/lib/debugger/testSession.test.ts`

`DebuggerTestSession` is a thin wrapper that creates a `DebuggerUI` wired to test infrastructure (`ScriptedInput` + `FrameRecorder`). It does NOT duplicate the UI rendering or key mapping — it reuses `DebuggerUI` from Task 11. The only new code is the step-at-a-time API (`press()`, `frame()`, `writeHTML()`, etc.) that feeds keys into the `ScriptedInput` and inspects the `FrameRecorder`'s captured frames.

- [ ] **Step 1: Write tests**

```typescript
// lib/debugger/testSession.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../cli/commands.js";
import { freshImport, fixtureDir } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";

const stepTestAgency = path.join(fixtureDir, "step-test.agency");
const stepTestCompiled = path.join(fixtureDir, "step-test.ts");

beforeAll(() => {
  compile({ debugger: true }, stepTestAgency, stepTestCompiled, { ts: true });
});

afterAll(() => {
  try { fs.unlinkSync(stepTestCompiled); } catch {}
});

describe("DebuggerTestSession", () => {
  it("steps through and returns correct value", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = new DebuggerTestSession({ mod });

    // step-test.agency: x = 1, y = 2, z = x + y, return z
    await session.press("s"); // past x = 1
    await session.press("s"); // past y = 2
    await session.press("s"); // past z = x + y
    await session.press("c"); // continue to completion

    expect(session.returnValue()).toBe(3);
  });

  it("frame inspection works", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = new DebuggerTestSession({ mod });

    await session.press("s"); // past x = 1
    const frame = session.frame();
    expect(frame).toBeDefined();
    expect(frame.findByKey("locals")).toBeDefined();
    expect(frame.findByKey("locals")!.toPlainText()).toContain("x");
  });

  it("variable override changes return value", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = new DebuggerTestSession({ mod });
    await session.press("s"); // past x = 1
    await session.type(":set x = 10");
    await session.press("c");
    expect(session.returnValue()).toBe(12); // 10 + 2
  });

  it("writeHTML produces output file", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = new DebuggerTestSession({ mod });

    await session.press("s");
    await session.press("c");

    const outPath = path.join(fixtureDir, "__test-output.html");
    session.writeHTML(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
    fs.unlinkSync(outPath);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agency-lang && pnpm vitest run lib/debugger/testSession.test.ts 2>&1 | tee /tmp/test-output.txt`

- [ ] **Step 3: Implement `testSession.ts`**

`DebuggerTestSession` internally:
1. Creates a `ScriptedInput`, `FrameRecorder`, and `Screen` from `@agency-lang/tui`.
2. Creates a `DebuggerUI` with that `Screen` — reusing all the rendering and key mapping logic from Task 11.
3. Creates a `DebuggerDriver` with this `DebuggerUI` as the `DebuggerIO`.
4. Extracts `sourceMap` from `mod.__sourceMap`, computes `rewindSize`.
5. Runs `mod.main()` to get the initial interrupt.
6. Starts the driver loop in the background — it blocks on `waitForCommand()`, which blocks on `screen.nextKey()`, which blocks on `ScriptedInput.nextKey()`.
7. `press(key)` feeds a key to `ScriptedInput` and waits for the driver to pause again.
8. `frame()` returns the last frame from `FrameRecorder`.
9. `writeHTML(path)` calls `recorder.toHTML()` and writes to disk.

Key methods to implement: `press()`, `type()`, `frame()`, `image()`, `writeHTML()`, `returnValue()`.

See spec sections "Integration with the Driver", "API", "Remaining DebuggerIO Methods".

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agency-lang && pnpm vitest run lib/debugger/testSession.test.ts 2>&1 | tee /tmp/test-output.txt`

- [ ] **Step 5: Commit**

```
feat(debugger): add DebuggerTestSession with visual test harness
```

---

## Task 13: Rewrite debugger tests

**Files:**
- Rewrite: `packages/agency-lang/lib/debugger/driver.test.ts`
- Modify: `packages/agency-lang/lib/debugger/testHelpers.ts`

- [ ] **Step 1: Update `testHelpers.ts`**

Keep `freshImport()` and `fixtureDir`. Add any shared helpers needed for the new tests. Do NOT remove `TestDebuggerIO`, `makeDriver`, or `getInitialResult` yet — they will be removed in Task 14 after all tests are migrated.

- [ ] **Step 2: Rewrite `driver.test.ts` — stepping tests**

Replace the skipped `describe.skip("DebuggerDriver stepping")` block with new tests using `DebuggerTestSession`. Un-skip them.

```typescript
describe("Debugger stepping", () => {
  it("steps through each statement and returns correct result", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = new DebuggerTestSession({ mod });
    await session.press("s", { times: 10 });
    expect(session.returnValue()).toBe(3);
  });

  it("continue runs to completion", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = new DebuggerTestSession({ mod });
    await session.press("c");
    expect(session.returnValue()).toBe(3);
  });

  // ... port remaining stepping tests
});
```

- [ ] **Step 3: Rewrite function call tests (stepIn, next, stepOut)**

Port the `describe.skip("DebuggerDriver stepping with function calls")` tests. Use `function-call-test.agency` and `nested-calls-test.agency` fixtures. Assert using `frame().findByKey("source").toPlainText()` to check which file/function is being shown.

- [ ] **Step 4: Rewrite variable override and print tests**

Port the `describe.skip("DebuggerDriver set")` and `describe.skip("DebuggerDriver print and checkpoint")` tests.

- [ ] **Step 5: Rewrite interrupt handling tests**

Port the `describe.skip("DebuggerDriver user interrupt handling")` tests using `interrupt-test.agency`.

- [ ] **Step 6: Rewrite stepBack and rewind tests**

Port the `describe.skip("DebuggerDriver stepBack and rewind")` tests.

- [ ] **Step 7: Rewrite loop and if/else tests**

Port the `describe.skip("DebuggerDriver with loops")` and `describe.skip("DebuggerDriver with if/else")` tests.

- [ ] **Step 8: Rewrite save/load tests**

Port the `describe.skip("DebuggerDriver save and load")` tests.

- [ ] **Step 9: Rewrite nested function call tests**

Port the `describe.skip("DebuggerDriver with nested function calls")` tests using `nested-calls-test.agency`.

- [ ] **Step 10: Rewrite trace checkpoint tests**

Port the `describe.skip("DebuggerDriver with loaded trace checkpoints")` and `describe.skip("DebuggerDriver with loaded single checkpoint")` tests.

- [ ] **Step 11: Rewrite thread tests**

Port the tests in `lib/debugger/thread.test.ts` using `thread-test.agency`.

- [ ] **Step 12: Run full debugger test suite**

Run: `cd packages/agency-lang && pnpm vitest run lib/debugger/ 2>&1 | tee /tmp/test-output.txt`
Expected: All tests pass with no `describe.skip` blocks remaining.

- [ ] **Step 13: Commit**

```
feat(debugger): rewrite all debugger tests using DebuggerTestSession
```

---

## Task 14: Cleanup

**Files:**
- Modify: `packages/agency-lang/package.json` — remove `blessed` dependency
- Modify: `packages/agency-lang/lib/debugger/testHelpers.ts` — remove dead code

- [ ] **Step 1: Remove blessed dependencies**

Remove `blessed` and `@types/blessed` from `packages/agency-lang/package.json`. Run `pnpm install`.

- [ ] **Step 2: Remove dead test helpers**

Remove `TestDebuggerIO`, `makeDriver`, and `getInitialResult` from `testHelpers.ts`. Verify no remaining imports reference them.

- [ ] **Step 3: Add `test-output/` to `.gitignore`**

Ensure test artifacts are not committed.

- [ ] **Step 4: Run full test suite**

Run: `cd packages/agency-lang && pnpm vitest run 2>&1 | tee /tmp/test-output.txt`
Expected: All tests pass. No imports of `blessed` remain.

- [ ] **Step 5: Commit**

```
chore: remove blessed dependency, clean up dead test helpers
```
