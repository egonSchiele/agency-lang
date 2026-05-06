# @agency-lang/tui

Testable TUI library with immediate-mode rendering and flexbox-lite layout. Designed to replace blessed in the Agency debugger.

## Key Commands

```bash
pnpm run build     # TypeScript build
pnpm vitest run    # Run all tests
pnpm test          # Watch mode
```

## Architecture

Immediate-mode rendering: each cycle builds a fresh element tree, runs it through `layout() -> render() -> flatten() -> output adapter`. No mutable widget state.

Testability via DI: `Screen` accepts `InputSource` + `OutputTarget`. Production uses `TerminalInput` + `TerminalOutput`. Tests use `ScriptedInput` + `FrameRecorder`.

## Dev Docs (how the code works)

- `docs/dev/elements-and-builders.md` — Element model, Style type, builder functions (`box`, `row`, `column`, `text`, `list`, `textInput`), PositionedElement, FrameStyle
- `docs/dev/layout.md` — Flexbox-lite layout algorithm: parent-owns-main/child-owns-cross design, 3-pass algorithm, justifyContent, alignItems
- `docs/dev/rendering.md` — Full rendering pipeline: layout -> render -> flatten -> output adapters. Frame/Cell model, scroll propagation, border rendering
- `docs/dev/style-parser.md` — Inline style tag parser (`{bold}`, `{red-fg}`), escaping, closing tag matching, regex safety, color system
- `docs/dev/input-output.md` — Input sources (ScriptedInput, TerminalInput), output targets (FrameRecorder, TerminalOutput), Screen class, signal handling, lifecycle

## Guide Docs (how to use the library)

- `docs/guide/getting-started.md` — Installation, quick example, core concepts (immediate-mode, builders, flexbox, style tags, frame inspection)
- `docs/guide/testing.md` — Writing headless tests with ScriptedInput + FrameRecorder, step-at-a-time testing, visual HTML artifacts
- `docs/guide/terminal-usage.md` — Setting up a terminal screen, main loop pattern, signal handling, key events, cleanup

## File Structure

```
lib/
  index.ts              — public API re-exports
  elements.ts           — Element, Style, Cell, FrameStyle, PositionedElement types
  builders.ts           — box(), row(), column(), text(), list(), textInput()
  layout.ts             — flexbox-lite layout engine
  frame.ts              — Frame class (findByKey, toPlainText, toHTML, image)
  styleParser.ts        — inline style tag parser and escaping
  colors.ts             — ANSI and CSS color mappings
  utils.ts              — shared utilities (resolveEdges, sameStyle, escapeHtml)
  screen.ts             — Screen class (orchestrates layout -> render -> output)
  render/
    renderer.ts         — element tree -> frame tree
    flatten.ts          — composite frame tree into 2D cell grid
    ansi.ts             — ANSI terminal output adapter
    html.ts             — HTML output adapter
    plaintext.ts        — plain text output adapter
  input/
    types.ts            — KeyEvent, InputSource types
    scripted.ts         — ScriptedInput (for tests)
    terminal.ts         — TerminalInput (raw stdin)
  output/
    types.ts            — OutputTarget type
    recorder.ts         — FrameRecorder (test frame collection + HTML export)
    terminal.ts         — TerminalOutput (alternate screen + ANSI)
```
