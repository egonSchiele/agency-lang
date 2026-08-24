# Debugger & TUI: Future Work

## Old test helpers still present

`TestDebuggerIO`, `makeDriver`, and `getInitialResult` in `testHelpers.ts` are
still exported because `thread.test.ts` and `trace.test.ts` import them. Those
two files test runtime behavior (LLM thread tracking, trace file I/O) rather
than UI. Port them to `DebuggerTestSession` and the old helpers can go.

## UI improvements

### Text input improvements

`enterTextInput()` implements a minimal key-by-key text input: type characters, backspace, enter, escape. It is missing three things the old blessed textbox had:
- No cursor movement within text (left/right arrow keys)
- No history (up arrow for previous commands)
- No tab completion

These are nice-to-haves, not blockers.

### Spinner re-renders the full element tree

`startSpinner()` calls `renderUI()` every 80ms. That rebuilds and re-renders the entire element tree, every pane and all its content, just to update one line of spinner text. Immediate-mode rendering causes this. Options:
1. Partial updates: give the TUI library a way to update a single element without rebuilding the full tree
2. Coalesce: only run the full render on a slower cadence, update just the command bar text in between
3. Accept it: for a terminal debugger at 80ms intervals, the perf cost is likely negligible
