# Sticky interrupt prompt for the line-mode agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the line-mode CLI agent, pin the policy approval prompt to the bottom of the terminal so tool-call traces from concurrent branches stream into scrollback above it instead of burying it.

**Architecture:** Generalize the "Thinking" spinner's `process.stdout.write` monkeypatch into a shared bottom-region coordinator that redraws a multi-line footer above every outside write. Split the "what" from the "how" throughout: pure cores decide (`buildFrame` produces the exact terminal bytes; `reduceInterrupt` decides the next widget state and outcome), and thin imperative shells wire them to stdout and `readline`. Route only the policy prompt to the widget through a new `interruptChoice` primitive that falls back to `chooseOption` everywhere else.

**Tech Stack:** TypeScript (`lib/stdlib/cli.ts`, the line-mode bridge), Agency stdlib (`stdlib/ui/cli.agency`, `stdlib/policy.agency`), Vitest, `@/utils/termcolors` for colors, `lib/stdlib/layout/ansi.ts` for ANSI width/wrapping, raw ANSI only for cursor control.

## Global Constraints

Every task implicitly includes these. Values copied from the design spec (`docs/superpowers/specs/2026-07-17-sticky-interrupt-prompt-design.md`).

- **Line mode only.** Do not touch the TUI path (`std::ui`'s render loop / `_openChoicePrompt`) or the non-TTY input-loop fallback.
- **One changed call site.** The only behavioral switch is `askUser` in `stdlib/policy.agency` calling `interruptChoice` instead of `chooseOption`. Do not change `chooseOption` or any other caller of it.
- **Reuse, don't reinvent.** Measure and wrap strings with `visualWidth` / `wrapText` from `lib/stdlib/layout/ansi.ts` (they already handle SGR-aware width and wrapping). Colors via `styles` / `RESET` / `color` from termcolors. Raw ANSI (`\x1b[...`) is allowed ONLY for cursor movement, screen clearing, cursor visibility, and synchronized-output — matching escapes already in `cli.ts`.
- **What vs how.** Business logic lives in pure functions (`buildFrame`, `reduceInterrupt`, `classifyInterruptKey`, `renderInterruptFooter`, `packOptions`). Imperative shells (`installBottomRegion`, `stickyInterruptPrompt`) only do I/O and wiring; they contain no branching business logic beyond dispatching an outcome.
- **Style.** No C-style `for` loops (use `forEach` / `flatMap` / array methods). No one-line `if` statements (always block bodies). No nested ternaries. No single-character variable names. Named constants, not magic numbers.
- **Anti-flicker (hard requirements).** One atomic `process.stdout.write` per repaint frame (built by `buildFrame`); synchronized-output brackets (`\x1b[?2026h`…`\x1b[?2026l`) around each frame; redraw on events, never on a timer (the spinner's own animation timer drives `refresh()`); footer lines wrapped to `columns - 1` so physical rows are counted correctly.
- **Cursor.** Hiding the cursor is scoped to the interrupt widget (via `installBottomRegion`'s `hideCursor` option); the spinner does not hide it. A one-time `process.once("exit")` handler restores the cursor as crash-safety. The widget renders its own caret glyph in the reason line because the real cursor is hidden.
- **Rebuild after stdlib edits.** After editing `.agency` files run `make`. After editing `cli.ts`, `make` (the TS build) is required before the Agency side can import the new bridge functions.

---

## File Structure

- `lib/stdlib/cli.ts` (modify) — the line-mode bridge. Gains: pure ANSI-frame builder (`buildFrame` + `eraseRows`), the coordinator shell (`installBottomRegion`), the spinner refactored onto it, the pure widget core (`classifyInterruptKey`, `reduceInterrupt`, `renderInterruptFooter`, `packOptions`), the widget shell (`stickyInterruptPrompt`), the bridge exports (`_interruptChoice`, `_stickyInterruptAvailable`), and the `__agencyInterruptPrompt` hook in `_runLineRepl`. New pure helpers join the existing `_internal` export for testing.
- `lib/stdlib/cli.test.ts` (modify) — a shared `captureStdout()` helper plus tests for every pure core and thin integration smoke tests.
- `stdlib/ui/cli.agency` (modify) — the `interruptChoice` primitive (gates on `_stickyInterruptAvailable()`, falls back to `chooseOption`).
- `stdlib/policy.agency` (modify) — `askUser` calls `interruptChoice`.

No new files.

---

## Task 1: Pure ANSI-frame builder + bottom-region coordinator

Create the pure frame builder and the thin coordinator shell around it. Reuse `visualWidth`/`wrapText`.

**Files:**
- Modify: `lib/stdlib/cli.ts`
- Test: `lib/stdlib/cli.test.ts`

**Interfaces:**
- Consumes: `wrapText`, `visualWidth` from `./layout/ansi.js`.
- Produces:
  - `eraseRows(rows: number): string`
  - `type FrameCursor = "hide" | "show" | "keep"`
  - `type FrameSpec = { above: string | null; footerLines: string[]; prevRows: number; columns: number; cursor: FrameCursor }`
  - `type FrameResult = { seq: string; rows: number }`
  - `buildFrame(spec: FrameSpec): FrameResult`
  - `export type BottomRegion = { refresh: () => void; teardown: () => void }`
  - `export function installBottomRegion(render: () => string[], useTTY: boolean, options?: { hideCursor: boolean }): BottomRegion`

- [ ] **Step 1: Write failing tests for `eraseRows` and `buildFrame`**

Add to `lib/stdlib/cli.test.ts` (destructure the new names from `_internal`):

```typescript
describe("eraseRows", () => {
  it("returns nothing when there is no footer yet", () => {
    expect(eraseRows(0)).toBe("");
  });
  it("clears a single row with CR + clear-down, no cursor move", () => {
    expect(eraseRows(1)).toBe("\r\x1b[0J");
  });
  it("moves up rows-1 before clearing for a multi-row footer", () => {
    expect(eraseRows(3)).toBe("\x1b[2A\r\x1b[0J");
  });
});

describe("buildFrame", () => {
  it("first frame of a 1-row footer: sync brackets + footer, no erase", () => {
    const result = buildFrame({ above: null, footerLines: ["FOOTER"], prevRows: 0, columns: 80, cursor: "keep" });
    expect(result.rows).toBe(1);
    expect(result.seq).toBe("\x1b[?2026h" + "FOOTER" + "\x1b[?2026l");
  });
  it("erases the previous footer, then emits `above`, then redraws", () => {
    const result = buildFrame({ above: "trace\n", footerLines: ["A", "B"], prevRows: 3, columns: 80, cursor: "keep" });
    expect(result.seq).toBe("\x1b[?2026h" + "\x1b[2A\r\x1b[0J" + "trace\n" + "A\nB" + "\x1b[?2026l");
    expect(result.rows).toBe(2);
  });
  it("appends a newline to `above` when missing so the footer starts fresh", () => {
    const result = buildFrame({ above: "x", footerLines: ["F"], prevRows: 1, columns: 80, cursor: "keep" });
    expect(result.seq).toContain("x\n");
  });
  it("emits hide/show cursor when asked", () => {
    expect(buildFrame({ above: null, footerLines: ["F"], prevRows: 0, columns: 80, cursor: "hide" }).seq).toContain("\x1b[?25l");
    expect(buildFrame({ above: null, footerLines: [], prevRows: 1, columns: 80, cursor: "show" }).seq).toContain("\x1b[?25h");
  });
  it("counts wrapped rows for an over-wide footer line", () => {
    const wide = "w".repeat(50);
    expect(buildFrame({ above: null, footerLines: [wide], prevRows: 0, columns: 20, cursor: "keep" }).rows).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts -t "eraseRows|buildFrame"`
Expected: FAIL — `eraseRows is not a function`.

- [ ] **Step 3: Implement the pure builder**

Add to `lib/stdlib/cli.ts`. Add the import near the other stdlib imports at the top:

```typescript
import { visualWidth, wrapText } from "./layout/ansi.js";
```

Add the constants near the existing ANSI constants (around `cli.ts:191`):

```typescript
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const SYNC_BEGIN = "\x1b[?2026h"; // DEC synchronized-update begin
const SYNC_END = "\x1b[?2026l";   // DEC synchronized-update end
const CLEAR_DOWN = "\x1b[0J";     // clear from cursor to end of screen
const MIN_FOOTER_WIDTH = 20;
```

Add the pure builder:

```typescript
/** Cursor moves that erase a footer of `rows` physical rows, leaving the
 *  cursor at column 0 of where the footer's first row began. Empty when
 *  there is no footer yet. */
function eraseRows(rows: number): string {
  if (rows === 0) {
    return "";
  }
  const moveUp = rows > 1 ? `\x1b[${rows - 1}A` : "";
  return `${moveUp}\r${CLEAR_DOWN}`;
}

type FrameCursor = "hide" | "show" | "keep";

type FrameSpec = {
  above: string | null;
  footerLines: string[];
  prevRows: number;
  columns: number;
  cursor: FrameCursor;
};

type FrameResult = { seq: string; rows: number };

function cursorSequence(cursor: FrameCursor): string {
  if (cursor === "hide") {
    return HIDE_CURSOR;
  }
  if (cursor === "show") {
    return SHOW_CURSOR;
  }
  return "";
}

function withTrailingNewline(text: string): string {
  if (text.endsWith("\n")) {
    return text;
  }
  return `${text}\n`;
}

/** Build ONE atomic terminal frame: erase the previous footer, optionally
 *  emit `above` into scrollback, then redraw the footer wrapped to width.
 *  Pure — the exact bytes and the new physical-row count are a function of
 *  the inputs, so the anti-flicker guarantees are unit-testable. */
function buildFrame(spec: FrameSpec): FrameResult {
  const width = Math.max(MIN_FOOTER_WIDTH, spec.columns - 1);
  const physical = spec.footerLines.flatMap((line) => wrapText(line, width));
  const above = spec.above === null ? "" : withTrailingNewline(spec.above);
  const seq =
    SYNC_BEGIN +
    eraseRows(spec.prevRows) +
    above +
    physical.join("\n") +
    cursorSequence(spec.cursor) +
    SYNC_END;
  return { seq, rows: physical.length };
}
```

Add to the `_internal` export (`cli.ts:1240`):

```typescript
  eraseRows,
  buildFrame,
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts -t "eraseRows|buildFrame"`
Expected: PASS.

- [ ] **Step 5: Write a failing test for `installBottomRegion` (with a shared capture helper)**

Add this helper once, near the top of `lib/stdlib/cli.test.ts` (below the imports), so no describe block repeats stdout plumbing:

```typescript
/** Replace process.stdout.write with a capturing sink and force isTTY on.
 *  installBottomRegion binds this sink as its realWrite, so every frame is
 *  captured. Returns the buffer and a restore fn. */
function captureStdout(): { captured: string[]; restore: () => void } {
  const captured: string[] = [];
  const originalWrite = process.stdout.write;
  const originalIsTTY = (process.stdout as any).isTTY;
  (process.stdout as any).write = (chunk: any) => { captured.push(String(chunk)); return true; };
  (process.stdout as any).isTTY = true;
  return {
    captured,
    restore: () => {
      (process.stdout as any).write = originalWrite;
      (process.stdout as any).isTTY = originalIsTTY;
    },
  };
}
```

Then the tests:

```typescript
describe("installBottomRegion", () => {
  it("no-ops on non-TTY (passes writes straight through)", () => {
    const cap = captureStdout();
    const region = installBottomRegion(() => ["footer"], false);
    process.stdout.write("hello");
    region.teardown();
    cap.restore();
    expect(cap.captured).toEqual(["hello"]);
  });
  it("redraws the footer above an outside write", () => {
    const cap = captureStdout();
    const region = installBottomRegion(() => ["FOOTER"], true);
    cap.captured.length = 0; // drop the initial paint
    process.stdout.write("trace line\n");
    region.teardown();
    cap.restore();
    const text = cap.captured.join("");
    expect(text).toContain("trace line\n");
    expect(text.indexOf("trace line")).toBeLessThan(text.lastIndexOf("FOOTER"));
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts -t "installBottomRegion"`
Expected: FAIL — `installBottomRegion is not a function`.

- [ ] **Step 7: Implement the coordinator shell**

Add to `lib/stdlib/cli.ts`:

```typescript
export type BottomRegion = { refresh: () => void; teardown: () => void };

type RegionOptions = { hideCursor: boolean };

const NOOP_REGION: BottomRegion = { refresh: () => { }, teardown: () => { } };

// At most one bottom region owns process.stdout.write at a time. Folding
// the spinner onto this coordinator (Task 2) makes single-ownership
// structural rather than an ordering discipline.
let activeRegion: BottomRegion | null = null;

// Crash-safety: if the process exits while a region still hides the
// cursor, restore it. Registered once.
let cursorRestoreRegistered = false;
function registerCursorRestore(): void {
  if (cursorRestoreRegistered) {
    return;
  }
  cursorRestoreRegistered = true;
  process.once("exit", () => {
    if (activeRegion) {
      process.stdout.write(SHOW_CURSOR);
    }
  });
}

function chunkToText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  return String(chunk);
}

/** Pin `render()`'s lines to the bottom of the terminal. While installed,
 *  every other write to process.stdout is redrawn ABOVE the footer as one
 *  atomic frame (via buildFrame). No-op on non-TTY. `hideCursor` scopes
 *  cursor-hiding to callers that draw their own caret (the interrupt
 *  widget); the spinner leaves the cursor alone. */
export function installBottomRegion(
  render: () => string[],
  useTTY: boolean,
  options: RegionOptions = { hideCursor: false },
): BottomRegion {
  if (!useTTY) {
    return NOOP_REGION;
  }
  if (activeRegion) {
    activeRegion.teardown();
  }
  registerCursorRestore();

  const stdoutAny = process.stdout as unknown as {
    write: (chunk: any, ...rest: any[]) => any;
  };
  const realWrite = stdoutAny.write.bind(process.stdout);
  let rows = 0;
  let firstPaint = true;

  const paint = (above: string | null): boolean => {
    const hideNow = options.hideCursor && firstPaint;
    const frame = buildFrame({
      above,
      footerLines: render(),
      prevRows: rows,
      columns: process.stdout.columns || 80,
      cursor: hideNow ? "hide" : "keep",
    });
    firstPaint = false;
    rows = frame.rows;
    return realWrite(frame.seq);
  };

  paint(null);
  stdoutAny.write = (chunk: any): boolean => paint(chunkToText(chunk));

  const region: BottomRegion = {
    refresh: () => { paint(null); },
    teardown: () => {
      stdoutAny.write = realWrite;
      const frame = buildFrame({
        above: null,
        footerLines: [],
        prevRows: rows,
        columns: process.stdout.columns || 80,
        cursor: options.hideCursor ? "show" : "keep",
      });
      realWrite(frame.seq);
      rows = 0;
      if (activeRegion === region) {
        activeRegion = null;
      }
    },
  };
  activeRegion = region;
  return region;
}
```

- [ ] **Step 8: Run the coordinator tests and the full file**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts`
Expected: PASS (existing tests plus the new ones). Update the import line in the test file to pull the direct export:

```typescript
import { _internal, _clearHistory, installBottomRegion, type PasteState } from "./cli.js";
```

- [ ] **Step 9: Commit**

```bash
git add lib/stdlib/cli.ts lib/stdlib/cli.test.ts
git commit -m "feat(cli): pure ANSI-frame builder + bottom-region coordinator"
```

---

## Task 2: Fold the spinner onto the coordinator

Replace `startSpinner`'s own monkeypatch with a one-line bottom region. Correctness fix from spec Finding 4, kept as its own reviewable step.

**Files:**
- Modify: `lib/stdlib/cli.ts:330-373` (`startSpinner`)

**Interfaces:**
- Consumes: `installBottomRegion` (Task 1).
- Produces: unchanged `startSpinner(useTTY: boolean): () => void`.

- [ ] **Step 1: Replace the `startSpinner` body**

Replace `startSpinner` (`cli.ts:330-373`) with:

```typescript
/**
 * Start a single-line "Thinking Ns" spinner as a one-line bottom region.
 * Returns a stop function that removes the region. The spinner is now a
 * client of installBottomRegion: outside writes (tool traces) redraw
 * above it automatically, and there is exactly one owner of the bottom of
 * the screen. It does NOT hide the cursor (default RegionOptions). No-op
 * on non-TTY.
 */
function startSpinner(useTTY: boolean): () => void {
  if (!useTTY) {
    return () => { };
  }
  const startedAt = Date.now();
  const render = (): string[] => {
    const elapsedMs = Date.now() - startedAt;
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const frameIndex =
      Math.floor(elapsedMs / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
    return [`${DIM}${SPINNER_FRAMES[frameIndex]} Thinking ${elapsedSec}s${COLOR_RESET}`];
  };
  const region = installBottomRegion(render, useTTY);
  const timer = setInterval(() => region.refresh(), SPINNER_INTERVAL_MS);
  return (): void => {
    clearInterval(timer);
    region.teardown();
  };
}
```

Then check whether the old `CLEAR_LINE` constant (`cli.ts:191`) is now unused:

```bash
grep -n "CLEAR_LINE" lib/stdlib/cli.ts
```

If the only remaining hit is its definition, delete that line.

- [ ] **Step 2: Build the TS**

Run: `make`
Expected: builds without type errors.

- [ ] **Step 3: Add a spinner-coexistence test**

Add `startSpinner` to `_internal` (`cli.ts:1240`), then:

```typescript
describe("startSpinner coexists with outside writes", () => {
  it("redraws the Thinking line after an outside write", () => {
    const cap = captureStdout();
    const stop = _internal.startSpinner(true);
    cap.captured.length = 0;
    process.stdout.write("tool output\n");
    stop();
    cap.restore();
    const text = cap.captured.join("");
    expect(text).toContain("tool output\n");
    expect(text.indexOf("tool output")).toBeLessThan(text.lastIndexOf("Thinking"));
  });
});
```

- [ ] **Step 4: Run the spinner test and the full file**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/cli.ts lib/stdlib/cli.test.ts
git commit -m "refactor(cli): fold the Thinking spinner onto the bottom-region coordinator"
```

---

## Task 3: Pure widget core (classifier, reducer, renderer, option packer)

The decision-making, all pure and exhaustively testable. No terminal I/O.

**Files:**
- Modify: `lib/stdlib/cli.ts`
- Test: `lib/stdlib/cli.test.ts`

**Interfaces:**
- Consumes: `visualWidth` (Task 1 import), `styles`/`RESET`/`color`, `DIM`/`COLOR_RESET`.
- Produces:
  - `type InterruptAction = "submit" | "cancel" | "exit" | "backspace" | { append: string } | null`
  - `type KeyMeta = { name?: string; ctrl?: boolean; meta?: boolean }`
  - `classifyInterruptKey(sequence: unknown, key: KeyMeta | undefined): InterruptAction`
  - `type InterruptState = { buffer: string; notice: string }`
  - `type InterruptOutcome = { kind: "pending" } | { kind: "resolve"; value: string } | { kind: "cancel" } | { kind: "exit" }`
  - `type InterruptConfig = { validKeys: string[]; allowFreeText: boolean; allowCancel: boolean }`
  - `type InterruptStep = { state: InterruptState; outcome: InterruptOutcome }`
  - `const INITIAL_INTERRUPT_STATE: InterruptState`
  - `reduceInterrupt(state, action, config): InterruptStep`
  - `packOptions(items: {key:string;label:string}[], width: number): string[]`
  - `type InterruptFooterInput = { title: string; body: string; items: {key:string;label:string}[]; allowFreeText: boolean; state: InterruptState; columns: number }`
  - `renderInterruptFooter(input: InterruptFooterInput): string[]`

- [ ] **Step 1: Write failing tests for the classifier and reducer**

```typescript
describe("classifyInterruptKey", () => {
  const classify = (sequence: any, key: any) => _internal.classifyInterruptKey(sequence, key);
  it("Ctrl+C is a hard exit (diverges from paste-mode soft cancel)", () => {
    expect(classify(null, { name: "c", ctrl: true })).toBe("exit");
  });
  it("Escape is a soft cancel", () => {
    expect(classify(null, { name: "escape" })).toBe("cancel");
  });
  it("Enter submits", () => {
    expect(classify(null, { name: "return" })).toBe("submit");
    expect(classify(null, { name: "enter" })).toBe("submit");
  });
  it("Backspace deletes", () => {
    expect(classify(null, { name: "backspace" })).toBe("backspace");
  });
  it("a printable char appends; chords and arrows are ignored", () => {
    expect(classify("a", { name: "a" })).toEqual({ append: "a" });
    expect(classify(null, { name: "up" })).toBeNull();
    expect(classify("x", { name: "x", meta: true })).toBeNull();
  });
});

describe("reduceInterrupt", () => {
  const config = { validKeys: ["a", "r", "aa", "ap", "rr"], allowFreeText: true, allowCancel: true };
  const from = (buffer: string) => ({ buffer, notice: "" });
  const reduce = _internal.reduceInterrupt;

  it("exit action yields an exit outcome", () => {
    expect(reduce(from(""), "exit", config).outcome).toEqual({ kind: "exit" });
  });
  it("Escape cancels when allowCancel, pends otherwise", () => {
    expect(reduce(from(""), "cancel", config).outcome).toEqual({ kind: "cancel" });
    expect(reduce(from(""), "cancel", { ...config, allowCancel: false }).outcome).toEqual({ kind: "pending" });
  });
  it("appends a printable char and clears the notice", () => {
    const step = reduce({ buffer: "a", notice: "x" }, { append: "a" }, config);
    expect(step.state).toEqual({ buffer: "aa", notice: "" });
    expect(step.outcome).toEqual({ kind: "pending" });
  });
  it("strips embedded newlines from an appended chunk (single-line reason)", () => {
    expect(reduce(from("a"), { append: "b\nc" }, config).state.buffer).toBe("abc");
  });
  it("backspace deletes the last char and clears the notice", () => {
    expect(reduce({ buffer: "aa", notice: "x" }, "backspace", config).state).toEqual({ buffer: "a", notice: "" });
  });
  it("submit resolves an exact key — 'a' does NOT early-resolve before 'aa'", () => {
    expect(reduce(from("aa"), "submit", config).outcome).toEqual({ kind: "resolve", value: "aa" });
    expect(reduce(from("a"), "submit", config).outcome).toEqual({ kind: "resolve", value: "a" });
  });
  it("submit returns a free-text reason even when it starts with an option letter", () => {
    expect(reduce(from("actually no"), "submit", config).outcome).toEqual({ kind: "resolve", value: "actually no" });
  });
  it("submit on empty pends with no notice (must-answer)", () => {
    const step = reduce(from(""), "submit", config);
    expect(step.outcome).toEqual({ kind: "pending" });
    expect(step.state.notice).toBe("");
  });
  it("submit on invalid input without free text pends with a notice", () => {
    const step = reduce(from("zzz"), "submit", { ...config, allowFreeText: false });
    expect(step.outcome).toEqual({ kind: "pending" });
    expect(step.state.notice).toBe("not a valid option");
  });
  it("an ignored key pends without changing state", () => {
    expect(reduce(from("a"), null, config)).toEqual({ state: { buffer: "a", notice: "" }, outcome: { kind: "pending" } });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts -t "classifyInterruptKey|reduceInterrupt"`
Expected: FAIL — `classifyInterruptKey is not a function`.

- [ ] **Step 3: Implement the classifier and reducer**

```typescript
type InterruptAction =
  | "submit"
  | "cancel"
  | "exit"
  | "backspace"
  | { append: string }
  | null;

type KeyMeta = { name?: string; ctrl?: boolean; meta?: boolean };

/** Map a readline keypress to an interrupt-widget action. DELIBERATELY
 *  DIVERGES from classifyPasteKey: Ctrl+C is a hard "exit" (an approval
 *  prompt must quit, never soft-cancel-and-continue), Escape is a soft
 *  "cancel", and Enter is "submit" (there is no Ctrl+D submit). */
function classifyInterruptKey(sequence: unknown, key: KeyMeta | undefined): InterruptAction {
  const name = key?.name;
  if (key?.ctrl && name === "c") {
    return "exit";
  }
  if (name === "escape") {
    return "cancel";
  }
  if (name === "return" || name === "enter") {
    return "submit";
  }
  if (name === "backspace") {
    return "backspace";
  }
  const printable = typeof sequence === "string" && sequence.length > 0 && !key?.ctrl && !key?.meta;
  if (printable) {
    return { append: sequence as string };
  }
  return null;
}

type InterruptState = { buffer: string; notice: string };

type InterruptOutcome =
  | { kind: "pending" }
  | { kind: "resolve"; value: string }
  | { kind: "cancel" }
  | { kind: "exit" };

type InterruptConfig = { validKeys: string[]; allowFreeText: boolean; allowCancel: boolean };

type InterruptStep = { state: InterruptState; outcome: InterruptOutcome };

const INITIAL_INTERRUPT_STATE: InterruptState = { buffer: "", notice: "" };
const INVALID_NOTICE = "not a valid option";

/** Interpret a committed buffer: exact key match resolves; a non-empty
 *  buffer with free text allowed resolves as a reason; empty re-prompts
 *  silently (must-answer); invalid-without-free-text re-prompts with a
 *  notice. */
function submitInterrupt(state: InterruptState, config: InterruptConfig): InterruptStep {
  const answer = state.buffer.trim();
  if (config.validKeys.includes(answer)) {
    return { state, outcome: { kind: "resolve", value: answer } };
  }
  if (config.allowFreeText && answer !== "") {
    return { state, outcome: { kind: "resolve", value: answer } };
  }
  const notice = answer === "" ? "" : INVALID_NOTICE;
  return { state: { buffer: state.buffer, notice }, outcome: { kind: "pending" } };
}

/** Pure state machine for the sticky interrupt prompt: given the current
 *  state and a key action, return the next state and an outcome. The
 *  imperative shell acts on the outcome; all decisions live here. */
function reduceInterrupt(
  state: InterruptState,
  action: InterruptAction,
  config: InterruptConfig,
): InterruptStep {
  if (action === "exit") {
    return { state, outcome: { kind: "exit" } };
  }
  if (action === "cancel") {
    if (config.allowCancel) {
      return { state, outcome: { kind: "cancel" } };
    }
    return { state, outcome: { kind: "pending" } };
  }
  if (action === "backspace") {
    return { state: { buffer: state.buffer.slice(0, -1), notice: "" }, outcome: { kind: "pending" } };
  }
  if (action === "submit") {
    return submitInterrupt(state, config);
  }
  if (action !== null && typeof action === "object") {
    const cleaned = action.append.replace(/[\r\n]/g, "");
    return { state: { buffer: state.buffer + cleaned, notice: "" }, outcome: { kind: "pending" } };
  }
  return { state, outcome: { kind: "pending" } };
}
```

Add to `_internal`:

```typescript
  classifyInterruptKey,
  reduceInterrupt,
  INITIAL_INTERRUPT_STATE,
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts -t "classifyInterruptKey|reduceInterrupt"`
Expected: PASS.

- [ ] **Step 5: Write failing tests for `packOptions` and `renderInterruptFooter`**

```typescript
describe("packOptions", () => {
  it("packs short tokens onto one line", () => {
    expect(_internal.packOptions([{ key: "a", label: "ok" }, { key: "r", label: "no" }], 40)).toEqual(["a=ok  r=no"]);
  });
  it("wraps when the next token would overflow", () => {
    expect(_internal.packOptions([{ key: "a", label: "approve" }, { key: "r", label: "reject" }], 10)).toEqual(["a=approve", "r=reject"]);
  });
});

describe("renderInterruptFooter", () => {
  const items = [
    { key: "a", label: "approve once" },
    { key: "r", label: "reject once" },
    { key: "rr", label: "reject always" },
  ];
  const base = {
    title: "bash: rm -rf build/ — approve?",
    body: "",
    items,
    allowFreeText: true,
    state: { buffer: "aa", notice: "" },
    columns: 80,
  };
  it("shows divider, title, options, hint, and the input line with a caret", () => {
    const lines = _internal.renderInterruptFooter(base);
    const joined = lines.join("\n");
    expect(joined).toContain("bash: rm -rf build/ — approve?");
    expect(joined).toContain("a=approve once");
    expect(joined).toContain("rr=reject always");
    expect(joined).toContain("Enter to submit");
    expect(lines[lines.length - 1]).toContain("> aa");
    expect(lines[lines.length - 1]).toContain("▏"); // caret glyph
  });
  it("caps a long body to 6 lines with an ellipsis", () => {
    const body = Array.from({ length: 20 }, (_unused, index) => `line${index}`).join("\n");
    const lines = _internal.renderInterruptFooter({ ...base, body });
    expect(lines.filter((line) => /line\d/.test(line)).length).toBe(6);
    expect(lines.some((line) => line.includes("…"))).toBe(true);
  });
  it("shows a notice when present", () => {
    const lines = _internal.renderInterruptFooter({ ...base, state: { buffer: "z", notice: "not a valid option" } });
    expect(lines.join("\n")).toContain("not a valid option");
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts -t "packOptions|renderInterruptFooter"`
Expected: FAIL — `packOptions is not a function`.

- [ ] **Step 7: Implement the packer and renderer**

```typescript
/** Greedily pack `key=label` tokens into lines no wider than `width`
 *  visible columns, joined by two spaces. A token wider than `width` gets
 *  its own line (buildFrame wraps it at render time). */
function packOptions(items: { key: string; label: string }[], width: number): string[] {
  const lines: string[] = [];
  let current = "";
  items.forEach((item) => {
    const token = `${item.key}=${item.label}`;
    if (current === "") {
      current = token;
      return;
    }
    const fits = visualWidth(current) + 2 + visualWidth(token) <= width;
    if (fits) {
      current = `${current}  ${token}`;
      return;
    }
    lines.push(current);
    current = token;
  });
  if (current !== "") {
    lines.push(current);
  }
  return lines;
}

const INTERRUPT_BODY_MAX_LINES = 6;
const INTERRUPT_CARET = "▏";

type InterruptFooterInput = {
  title: string;
  body: string;
  items: { key: string; label: string }[];
  allowFreeText: boolean;
  state: InterruptState;
  columns: number;
};

function bodyLines(body: string): string[] {
  if (body === "") {
    return [];
  }
  const raw = body.split("\n");
  const shown = raw.slice(0, INTERRUPT_BODY_MAX_LINES).map((line) => ` ${DIM}${line}${COLOR_RESET}`);
  if (raw.length > INTERRUPT_BODY_MAX_LINES) {
    shown.push(` ${DIM}…${COLOR_RESET}`);
  }
  return shown;
}

/** Render the sticky approval prompt as footer lines. Pure. The real
 *  cursor is hidden by the widget, so the input line ends with a caret
 *  glyph. buildFrame truncates/wraps each line to width. */
function renderInterruptFooter(input: InterruptFooterInput): string[] {
  const width = Math.max(MIN_FOOTER_WIDTH, input.columns - 1);
  const lines: string[] = [`${DIM}${"─".repeat(width)}${COLOR_RESET}`];
  if (input.title !== "") {
    lines.push(` ${input.title}`);
  }
  bodyLines(input.body).forEach((line) => lines.push(line));
  packOptions(input.items, width - 1).forEach((row) => lines.push(` ${row}`));
  if (input.allowFreeText) {
    lines.push(` ${DIM}or type a reason · Enter to submit${COLOR_RESET}`);
  }
  if (input.state.notice !== "") {
    lines.push(` ${color.yellow(input.state.notice)}`);
  }
  lines.push(` > ${input.state.buffer}${INTERRUPT_CARET}`);
  return lines;
}
```

Add to `_internal`:

```typescript
  packOptions,
  renderInterruptFooter,
```

- [ ] **Step 8: Run the render tests and the full file**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/stdlib/cli.ts lib/stdlib/cli.test.ts
git commit -m "feat(cli): pure widget core — classifier, reducer, renderer, option packer"
```

---

## Task 4: Widget shell + REPL hook + bridge exports

Thin imperative shell wiring keys → `reduceInterrupt` → outcome, plus the `__agencyInterruptPrompt` hook and the two bridge functions.

**Files:**
- Modify: `lib/stdlib/cli.ts` (widget shell, bridge exports, `_runLineRepl` hook)
- Test: `lib/stdlib/cli.test.ts`

**Interfaces:**
- Consumes: `installBottomRegion`, `renderInterruptFooter`, `classifyInterruptKey`, `reduceInterrupt`, `INITIAL_INTERRUPT_STATE`, `AgencyCancelledError` (already imported `cli.ts:17`), `__agencyStopSpinner`.
- Produces:
  - `type InterruptOpts = { title: string; body: string; items: {key:string;label:string}[]; allowFreeText: boolean; allowCancel: boolean }`
  - `stickyInterruptPrompt(rl: readline.Interface, opts: InterruptOpts): Promise<string>`
  - `export async function _interruptChoice(title, body, items, allowFreeText, allowCancel): Promise<string>`
  - `export function _stickyInterruptAvailable(): boolean`
  - global `__agencyInterruptPrompt: (opts: InterruptOpts) => Promise<string>` while a line-mode REPL runs.

- [ ] **Step 1: Implement the shell helpers and widget**

```typescript
type InterruptOpts = {
  title: string;
  body: string;
  items: { key: string; label: string }[];
  allowFreeText: boolean;
  allowCancel: boolean;
};

/** Stop the "Thinking" spinner if the REPL has one running (which also
 *  frees the stdout patch before the widget installs its own region). */
function stopSpinnerIfRunning(): void {
  const stop = (globalThis as any).__agencyStopSpinner;
  if (typeof stop === "function") {
    stop();
  }
}

/** Assert raw mode so `_ttyWrite` receives keystrokes (see readMultiline,
 *  cli.ts:1153, for why). Returns a restore fn. No-op off a TTY. */
function assertRawMode(): () => void {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  if (!stdin.isTTY || !stdin.setRawMode) {
    return () => { };
  }
  const wasRaw = !!stdin.isRaw;
  stdin.setRawMode(true);
  return () => {
    if (stdin.setRawMode && stdin.isRaw !== wasRaw) {
      stdin.setRawMode(wasRaw);
    }
  };
}

/** The line-mode approval prompt. Renders `opts` as a pinned bottom footer
 *  and reads a typed line terminated by Enter. All decisions come from
 *  reduceInterrupt; this shell only wires keys → reducer → outcome and does
 *  the I/O. Resolves with the option key or a free-text reason; rejects
 *  with AgencyCancelledError on Escape (when allowCancel); exits 130 on
 *  Ctrl+C. Reuses the outer REPL's readline via `_ttyWrite`. */
function stickyInterruptPrompt(rl: readline.Interface, opts: InterruptOpts): Promise<string> {
  stopSpinnerIfRunning();
  const restoreRaw = assertRawMode();
  const config: InterruptConfig = {
    validKeys: opts.items.map((item) => item.key),
    allowFreeText: opts.allowFreeText,
    allowCancel: opts.allowCancel,
  };
  let state = INITIAL_INTERRUPT_STATE;

  const region = installBottomRegion(
    () => renderInterruptFooter({
      title: opts.title,
      body: opts.body,
      items: opts.items,
      allowFreeText: opts.allowFreeText,
      state,
      columns: process.stdout.columns || 80,
    }),
    process.stdout.isTTY === true,
    { hideCursor: true },
  );

  const rlAny = rl as unknown as { _ttyWrite: (sequence: unknown, key: unknown) => void };
  const originalTtyWrite = rlAny._ttyWrite;

  return new Promise<string>((resolve, reject) => {
    const settle = (finish: () => void): void => {
      rlAny._ttyWrite = originalTtyWrite;
      region.teardown();
      restoreRaw();
      finish();
    };
    rlAny._ttyWrite = (sequence: unknown, key: unknown): void => {
      const action = classifyInterruptKey(sequence, key as KeyMeta | undefined);
      const step = reduceInterrupt(state, action, config);
      state = step.state;
      const outcome = step.outcome;
      if (outcome.kind === "exit") {
        settle(() => { });
        process.exit(130);
        return;
      }
      if (outcome.kind === "cancel") {
        settle(() => reject(new AgencyCancelledError("cancelled by user")));
        return;
      }
      if (outcome.kind === "resolve") {
        settle(() => resolve(outcome.value));
        return;
      }
      region.refresh();
    };
  });
}

/** Bridge for std::ui/cli's interruptChoice. Delegates to the sticky widget
 *  wired to the running line-mode REPL. The Agency side gates on
 *  _stickyInterruptAvailable first, so a missing hook is a programming
 *  error. */
export async function _interruptChoice(
  title: string,
  body: string,
  items: { key: string; label: string }[],
  allowFreeText: boolean,
  allowCancel: boolean,
): Promise<string> {
  const hook = (globalThis as any).__agencyInterruptPrompt;
  if (typeof hook !== "function") {
    throw new Error("_interruptChoice: no active line-mode REPL");
  }
  return hook({ title, body, items, allowFreeText, allowCancel });
}

/** True when a line-mode REPL is running and can host a pinned prompt. */
export function _stickyInterruptAvailable(): boolean {
  return typeof (globalThis as any).__agencyInterruptPrompt === "function";
}
```

- [ ] **Step 2: Install the `__agencyInterruptPrompt` hook in `_runLineRepl`**

Alongside the existing hook installs (near `__agencyStopSpinner` at `cli.ts:843`):

```typescript
  // Expose the sticky interrupt prompt to std::policy (via std::ui/cli's
  // interruptChoice → _interruptChoice). Bound to THIS readline so the
  // widget reuses it; restored on exit like the hooks above.
  const interruptPromptKey = "__agencyInterruptPrompt";
  const prevInterruptPrompt = (globalThis as any)[interruptPromptKey];
  (globalThis as any)[interruptPromptKey] = (opts: InterruptOpts) => stickyInterruptPrompt(rl, opts);
```

In the `finally` block (around `cli.ts:1028`, with the other restores):

```typescript
    (globalThis as any)[interruptPromptKey] = prevInterruptPrompt;
```

- [ ] **Step 3: Build**

Run: `make`
Expected: builds without type errors.

- [ ] **Step 4: Add integration smoke tests (logic already covered by Task 3)**

Add `stickyInterruptPrompt` to `_internal` (`cli.ts:1240`). These cover the wiring: outcome → resolve/reject and streaming-above. The exhaustive transition coverage lives in the `reduceInterrupt` tests.

```typescript
describe("stickyInterruptPrompt (integration)", () => {
  it("resolves 'aa' typed then Enter, with a trace streamed above", async () => {
    const cap = captureStdout();
    (process.stdin as any).isTTY = false; // skip real raw-mode toggling
    const fakeRl: any = { _ttyWrite: (_s: any, _k: any) => { } };
    const pending = _internal.stickyInterruptPrompt(fakeRl, {
      title: "approve?", body: "", allowFreeText: true, allowCancel: true,
      items: [{ key: "a", label: "approve once" }, { key: "aa", label: "approve always" }],
    });
    process.stdout.write("⏺ read(\"x\")\n"); // concurrent branch output
    fakeRl._ttyWrite("a", { name: "a" });
    fakeRl._ttyWrite("a", { name: "a" });
    fakeRl._ttyWrite(null, { name: "return" });
    const answer = await pending;
    cap.restore();
    expect(answer).toBe("aa");
    expect(cap.captured.join("")).toContain("⏺ read(\"x\")\n");
  });

  it("Escape rejects with AgencyCancelledError", async () => {
    const cap = captureStdout();
    (process.stdin as any).isTTY = false;
    const fakeRl: any = { _ttyWrite: (_s: any, _k: any) => { } };
    const pending = _internal.stickyInterruptPrompt(fakeRl, {
      title: "t", body: "", allowFreeText: true, allowCancel: true,
      items: [{ key: "a", label: "ok" }],
    });
    fakeRl._ttyWrite(null, { name: "escape" });
    await expect(pending).rejects.toThrow(/cancelled/i);
    cap.restore();
  });
});
```

Note: the Ctrl+C path calls `process.exit(130)`, so it is not driven here (it would kill the runner). Its decision is covered by the `reduceInterrupt` "exit" test in Task 3.

- [ ] **Step 5: Run the smoke tests and the full file**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/stdlib/cli.ts lib/stdlib/cli.test.ts
git commit -m "feat(cli): sticky interrupt widget shell + REPL hook + bridge"
```

---

## Task 5: The `interruptChoice` Agency primitive

**Files:**
- Modify: `stdlib/ui/cli.agency`

**Interfaces:**
- Consumes: `_interruptChoice`, `_stickyInterruptAvailable` (Task 4); `chooseOption` from `std::ui`.
- Produces: `interruptChoice(title: string, body: string, items: any[], allowFreeText: boolean = false, allowCancel: boolean = false): string`

Note: `items: any[]` (not `ChoiceItem[]`) sidesteps the documented `ChoiceItem` codegen pitfall in this module (see its header comment). Values flow through unchanged; `chooseOption` accepts `ChoiceItem[]` and `any[]` is assignable.

- [ ] **Step 1: Add the imports**

Extend the `agency-lang/stdlib-lib/cli.js` import block (`cli.agency:1-6`):

```
import {
  _runLineRepl,
  _clearScreen,
  _termWidth,
  _clearHistory,
  _interruptChoice,
  _stickyInterruptAvailable,
 } from "agency-lang/stdlib-lib/cli.js"
```

Add after the existing `export { pushMessage, clearMessages } from "std::ui"` line:

```
import { chooseOption } from "std::ui"
```

- [ ] **Step 2: Add the primitive**

Near the bottom of `stdlib/ui/cli.agency`:

```
export def interruptChoice(
  title: string,
  body: string,
  items: any[],
  allowFreeText: boolean = false,
  allowCancel: boolean = false,
): string {
  """
  Approval prompt for line mode: renders a sticky footer pinned to the
  bottom of the terminal so concurrent tool-call output streams above it
  instead of burying the prompt. Type an option key or a rejection
  reason, then Enter. Falls back to `chooseOption` when no line-mode REPL
  is active (the TUI, a non-TTY, or a headless run), so every
  non-line-mode path keeps its current behavior.

  @param title - Prompt heading (the interrupt message).
  @param body - Multi-line context shown under the title (or "").
  @param items - The {key, label} choices.
  @param allowFreeText - Accept a free-form rejection reason.
  @param allowCancel - When true, Escape cancels the whole request.
  """
  if (_stickyInterruptAvailable()) {
    return _interruptChoice(title, body, items, allowFreeText, allowCancel)
  }
  return chooseOption(title, body, items, allowFreeText: allowFreeText, allowCancel: allowCancel)
}
```

- [ ] **Step 3: Build and verify the module loads**

Run: `make`
Then:

```bash
node -e "const m = require('./dist/stdlib/ui/cli.js'); console.log(typeof m.interruptChoice)"
```

Expected: `function`. If `make` reports a `ChoiceItem` codegen error at load, confirm `items` is `any[]` and `chooseOption` is imported (not re-exported).

- [ ] **Step 4: Commit**

```bash
git add stdlib/ui/cli.agency
git commit -m "feat(ui/cli): add interruptChoice seam (sticky prompt, chooseOption fallback)"
```

---

## Task 6: Route the policy prompt through `interruptChoice`

**Files:**
- Modify: `stdlib/policy.agency:6` (import), `stdlib/policy.agency:711` (the call)

**Interfaces:**
- Consumes: `interruptChoice` (Task 5).

- [ ] **Step 1: Confirm `chooseOption` is used only in `askUser`**

```bash
grep -n "chooseOption" stdlib/policy.agency
```

Expected: the comment at line 664 and the call at line 711 only.

- [ ] **Step 2: Adjust imports**

At `stdlib/policy.agency:6` change:

```
import { chooseOption, ChoiceItem } from "std::ui"
```

to:

```
import { ChoiceItem } from "std::ui"
```

Add after line 8 (with the other `std::ui`-family imports):

```
import { interruptChoice } from "std::ui/cli"
```

- [ ] **Step 3: Change the call in `askUser`**

At `stdlib/policy.agency:710-712` change:

```
  const answer = withLock("std::tty") {
    return chooseOption(title, body, items, allowFreeText: true, allowCancel: true)
  }
```

to:

```
  const answer = withLock("std::tty") {
    return interruptChoice(title, body, items, allowFreeText: true, allowCancel: true)
  }
```

The `withLock("std::tty")` stays: it keeps "one prompt at a time," which the coordinator's single-owner invariant relies on. Cancellation still unwinds correctly: `_interruptChoice` rejects with `AgencyCancelledError` on Escape (`allowCancel: true`), which propagates the same way `_promptsAutocomplete`'s `cancelOnEscape` throw does today (`ui.ts:863`), and `__tryCall` re-raises it (`ui.ts:859`) so the turn unwinds to the REPL rather than becoming a `Result.failure`.

- [ ] **Step 4: Build**

Run: `make`
Expected: builds with no import-cycle or unresolved-import errors. (`std::policy → std::ui/cli → std::ui`; nothing imports `std::policy`, so no cycle.)

- [ ] **Step 5: Run the policy tests**

Find and run the policy tests (stay narrow to keep it fast):

```bash
grep -rl "cliPolicyHandler\|checkPolicy\|parsePolicyFile" lib stdlib --include="*.test.ts"
pnpm exec vitest run lib/stdlib/policy.test.ts
```

Expected: PASS (the change only swaps the interactive prompt UI; auto-approve/reject and file handling are untouched).

- [ ] **Step 6: Manual end-to-end check (line-mode agent)**

From `packages/agency-lang`: `make`, then run the agent and issue a request that runs several tools in parallel where one needs approval. Confirm by eye: the prompt stays pinned at the bottom; `⏺ tool(...)` traces scroll above it; `aa`+Enter approves-always; a typed reason + Enter rejects with that reason; empty Enter re-prompts; Escape cancels the turn; the cursor is hidden during the prompt and restored after; and there is no visible flicker at normal output rates. Record the result in the commit message or PR description.

- [ ] **Step 7: Commit**

```bash
git add stdlib/policy.agency
git commit -m "feat(policy): pin the interactive approval prompt via interruptChoice"
```

---

## Task 7 (OPTIONAL — decide during review): burst coalescing

Ship only if the un-coalesced version shows visible footer "twitch" when several trace lines land in one event-loop tick (spec open question 2). Emit the erase+text immediately; defer the footer redraw to a microtask so N same-tick writes collapse to one redraw. Reuses `buildFrame`.

**Files:**
- Modify: `lib/stdlib/cli.ts` (`installBottomRegion` internals only — no signature change)
- Test: `lib/stdlib/cli.test.ts`

- [ ] **Step 1: Write a failing test asserting one redraw per tick**

```typescript
describe("installBottomRegion coalescing", () => {
  it("redraws the footer once for several same-tick writes", async () => {
    const cap = captureStdout();
    const region = installBottomRegion(() => ["FOOTER"], true);
    cap.captured.length = 0;
    process.stdout.write("a\n");
    process.stdout.write("b\n");
    process.stdout.write("c\n");
    await Promise.resolve(); // let the microtask run
    region.teardown();
    cap.restore();
    const text = cap.captured.join("");
    expect(text.indexOf("a\n")).toBeLessThan(text.indexOf("b\n"));
    expect(text.indexOf("b\n")).toBeLessThan(text.indexOf("c\n"));
    expect(cap.captured.filter((chunk) => chunk.includes("FOOTER")).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts -t "coalescing"`
Expected: FAIL — the un-coalesced version redraws FOOTER three times.

- [ ] **Step 3: Rework the write path in `installBottomRegion`**

Replace the `paint`, the `stdoutAny.write` assignment, and `refresh` with a two-phase version (the outside text is written immediately; only the footer redraw is deferred). `buildFrame` with `footerLines: []` performs the erase+emit with no redraw:

```typescript
  let footerErased = false;
  let redrawScheduled = false;

  const drawFooter = (): void => {
    const frame = buildFrame({
      above: null,
      footerLines: render(),
      prevRows: rows,
      columns: process.stdout.columns || 80,
      cursor: options.hideCursor && firstPaint ? "hide" : "keep",
    });
    firstPaint = false;
    rows = frame.rows;
    footerErased = false;
    realWrite(frame.seq);
  };
  const scheduleFooter = (): void => {
    if (redrawScheduled) {
      return;
    }
    redrawScheduled = true;
    queueMicrotask(() => {
      redrawScheduled = false;
      if (footerErased) {
        drawFooter();
      }
    });
  };

  drawFooter(); // initial paint
  stdoutAny.write = (chunk: any): boolean => {
    const frame = buildFrame({
      above: chunkToText(chunk),
      footerLines: [],
      prevRows: footerErased ? 0 : rows,
      columns: process.stdout.columns || 80,
      cursor: "keep",
    });
    rows = 0;
    footerErased = true;
    const returnValue = realWrite(frame.seq);
    scheduleFooter();
    return returnValue;
  };
```

Update `refresh` and `teardown` for the new flags (typing repaints immediately; teardown cancels a pending redraw):

```typescript
  const region: BottomRegion = {
    refresh: () => { drawFooter(); },
    teardown: () => {
      redrawScheduled = false;
      stdoutAny.write = realWrite;
      const frame = buildFrame({
        above: null,
        footerLines: [],
        prevRows: footerErased ? 0 : rows,
        columns: process.stdout.columns || 80,
        cursor: options.hideCursor ? "show" : "keep",
      });
      realWrite(frame.seq);
      rows = 0;
      footerErased = false;
      if (activeRegion === region) {
        activeRegion = null;
      }
    },
  };
```

- [ ] **Step 4: Run the coalescing test**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts -t "coalescing"`
Expected: PASS.

- [ ] **Step 5: Re-run the full file**

Run: `pnpm exec vitest run lib/stdlib/cli.test.ts`
Expected: PASS. If any earlier test asserted a synchronous footer redraw on an outside write, add `await Promise.resolve()` before its footer assertion (the footer now redraws on a microtask).

- [ ] **Step 6: Commit**

```bash
git add lib/stdlib/cli.ts lib/stdlib/cli.test.ts
git commit -m "perf(cli): coalesce same-tick footer redraws to avoid burst twitch"
```

---

## Self-Review

**1. Spec coverage.**
- Component 1 (coordinator) → Task 1; spinner fold-in (Finding 4) → Task 2.
- Component 2 (widget): type-then-Enter model (Decision 2, Finding 1) → `reduceInterrupt` submit logic (Task 3) + shell (Task 4); empty-Enter re-prompt (Finding 2) → `submitInterrupt` empty branch + reducer test; raw-mode precondition (Finding 5) → `assertRawMode` (Task 4); Ctrl+C divergence (Finding 3) → `classifyInterruptKey` `"exit"` + `reduceInterrupt` exit outcome + shell `process.exit(130)`.
- Component 3 (seam) → Task 5; one call-site change + cancellation-path citation → Task 6; mutual-exclusion of the gates (Finding 6) → `_stickyInterruptAvailable` gate.
- Anti-flicker rules → `buildFrame` (Task 1); burst coalescing → Task 7 (optional).
- Oversized body / width edge cases → `bodyLines` cap + `wrapText` in `buildFrame`.
- Status-footer census (Finding 7) → no code (post-turn render); documented in spec.
- "No second readline" strength → Task 4 reuses `rl` via `_ttyWrite`.
- Cursor findings (hidden whole turn, crash-safety, caret) → `hideCursor` scoped to the widget, `registerCursorRestore`, `INTERRUPT_CARET`.

**2. Placeholder scan.** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N". Every code step is complete; every test has real assertions; every run step gives command + expected result.

**3. Anti-pattern scan (per docs/dev/anti-patterns.md).** No duplicated code (reuses `visualWidth`/`wrapText`; shared `captureStdout` in tests; `buildFrame` is the single frame builder used by every path). What/how split via `buildFrame` + `reduceInterrupt` with thin shells. No C-style loops (only `forEach`/`flatMap`/`map`). No one-line `if`s. No nested ternaries (`cursorSequence`/`withTrailingNewline` replace them). Named constants (`MIN_FOOTER_WIDTH`, `INTERRUPT_BODY_MAX_LINES`, `INVALID_NOTICE`, `INTERRUPT_CARET`). Descriptive names throughout.

**4. Type consistency.** `FrameSpec`/`FrameResult`/`BottomRegion` stable across Tasks 1, 2, 4, 7. `InterruptState`/`InterruptOutcome`/`InterruptConfig`/`InterruptStep` defined in Task 3 and consumed unchanged in Task 4. `renderInterruptFooter` takes `state: InterruptState` in both Task 3 (definition/tests) and Task 4 (call). `InterruptOpts` fields identical across `stickyInterruptPrompt`, `_interruptChoice`, the hook, and the Agency `interruptChoice` call. `interruptChoice(title, body, items, allowFreeText, allowCancel)` matches the `askUser` call and mirrors `chooseOption`'s parameter order.

**5. Test rigor (does a break fail a test?).** `reduceInterrupt` table tests fail on any transition regression (bare-`a` early-resolve, empty-Enter resolving, missing newline-strip, wrong cancel gating). `buildFrame` tests assert exact bytes, so a broken erase (`\x1b[2A\r\x1b[0J`) or row count fails. `installBottomRegion`/`startSpinner`/widget smoke tests assert traces land above the footer. Ctrl+C's decision is covered by the reducer "exit" test (the shell's `process.exit` is intentionally not driven in-process). No catastrophic-failure tests.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-17-sticky-interrupt-prompt.md`.**

Per your standing preference (inline execution in the main session, no subagent-driven development) and your dev loop (plan → review → execute), the next step is your review of this revised plan. On your go, I'll execute inline here, task by task, pausing at the commit checkpoints.
