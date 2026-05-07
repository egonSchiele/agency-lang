# Debugger & TUI: Future Work

## Skipped tests

### `reject` interrupt test hangs

`driver.test.ts` > "Debugger user interrupt handling" > "reject causes the function to return a failure" is `it.skip`.

The test hangs during `type("reject")`. The root cause is a timing issue with how `DebuggerTestSession`'s idle detection interacts with the driver's `promptForInput` flow for user interrupts. The `resolve` test (same flow, different response) works fine, so the issue is specific to how the reject response propagates back through the driver loop.

To investigate: add logging to `TestInput.nextKey()` and `DebuggerUI.enterTextInput()` to trace the exact point where the idle/key handoff stalls after typing "reject" + enter.

### `save/load` test

`driver.test.ts` > "Debugger save and load" is `describe.skip`. This was already skipped before the TUI migration. The test requires typing file paths via `:save <path>` and `:load <path>` commands, which works in principle but wasn't tested in the old system either.

### `thread.test.ts` and `trace.test.ts`

Both files are `describe.skip` with the note "pending interrupt template migration to ctx.getInterruptResponse()". These predate the TUI migration and test runtime behavior (LLM thread tracking, trace file I/O) rather than UI. They still use the old `TestDebuggerIO` helper. When the interrupt template migration is done, these should be ported to `DebuggerTestSession`.

## UI improvements

### Threads pane shows when empty

The threads pane currently appears whenever `getThreadMessages()` returns a non-null value, even if the thread has zero messages. The pane should be hidden when there are no messages to display. Fix in `DebuggerUI.buildPaneList()` — check `threadData.messages.length > 0` in addition to `threadData !== null`.

### Syntax highlighting in source pane

The old blessed-based UI used `cli-highlight` to syntax-highlight source code. The output was ANSI escape codes, which blessed rendered natively. The new TUI library's text renderer understands `{red-fg}` style tags, not ANSI codes.

Options:
1. Write an ANSI-to-style-tags converter (parse ANSI escape sequences, map to `{color-fg}` tags)
2. Write a simple Agency syntax highlighter that produces style tags directly (keywords, strings, numbers, comments)
3. Use `cli-highlight` and strip the ANSI codes, showing plain text (current behavior)

Option 2 is probably the best balance of effort and result since Agency's syntax is simple.

### Scroll position tracking

The current scroll implementation tracks offsets per pane name, but doesn't clamp to content bounds. Scrolling down past the end of content is a no-op visually but the offset keeps incrementing. Could add content-length tracking to cap the offset.

### Text input improvements

`enterTextInput()` implements a minimal key-by-key text input (type characters, backspace, enter, escape). Missing features vs the old blessed textbox:
- No cursor movement within text (left/right arrow keys)
- No history (up arrow for previous commands)
- No tab completion

These are nice-to-haves, not blockers.

### Layout duplication in overlay methods

`showRewindSelector()` and `showCheckpointsPanel()` each rebuild the top/middle pane layout inline, duplicating the logic in `buildElementTree()`. If the layout changes (e.g., new panes, different proportions), all three must be updated. Extract a shared helper like `buildStandardTopRows()` that both `buildElementTree` and the overlay renderers compose on top of.

### Spinner re-renders the full element tree

`startSpinner()` calls `renderUI()` every 80ms, which rebuilds and re-renders the entire element tree — all panes, all content — just to update one line of spinner text. This is a consequence of immediate-mode rendering. Options:
1. Partial updates — give the TUI library a way to update a single element without rebuilding the full tree
2. Coalesce — only run the full render on a slower cadence, update just the command bar text in between
3. Accept it — for a terminal debugger at 80ms intervals, the perf cost is likely negligible

### Old test helpers still present

`TestDebuggerIO`, `makeDriver`, and `getInitialResult` in `testHelpers.ts` are still exported because `thread.test.ts` and `trace.test.ts` import them (both `describe.skip`). Once those tests are ported to `DebuggerTestSession`, these helpers should be removed.

## TUI library improvements

### ANSI code support in text elements

Adding ANSI escape code parsing to `renderTextContent()` would enable syntax highlighting and any other tool that produces ANSI output. This would be a change to `packages/tui/lib/render/renderer.ts`.

### Shift+Tab key mapping

`TerminalInput` doesn't map Shift+Tab (`\x1b[Z` / CSI Z). The debugger uses Shift+Tab for reverse focus cycling. This works in tests via `ScriptedInput` but not in the real terminal. Add `"\x1b[Z": { key: "tab", shift: true }` to `KEY_MAP` in `packages/tui/lib/input/terminal.ts`.
