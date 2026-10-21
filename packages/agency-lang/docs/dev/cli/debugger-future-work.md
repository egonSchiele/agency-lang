# Debugger & TUI: Future Work

## Old test helpers still present

`TestDebuggerIO`, `makeDriver`, and `getInitialResult` in `testHelpers.ts` are
still exported because `thread.test.ts` and `trace.test.ts` import them. Those
two files test runtime behavior (LLM thread tracking, trace file I/O) rather
than UI. Port them to `DebuggerTestSession` and the old helpers can go.

## Attach

### The status line while the rewind window is short

After an attach the rolling checkpoint window holds only what the program has done since, so `stepBack` and `rewind` reach back to the attach and no further. The spec wanted the status line to say so while the window is shorter than the configured size. The window's size is known only on the run side (`DebuggerState`), and the UI learns nothing about it today; a notice with the count on each stop would do.

### Debugging two runs at once

While attached, the first run to stop owns the debugger and every other run goes on without stopping (`lib/runtime/debugRun.ts`). A served agent with two requests at the same breakpoint is a real case for debugging both. That needs every per-stop field, the pending overrides, the stepping depth and mode, the checkpoint shown, and the rolling window, on one session object per run, keyed by the run key the runtime mints, and a UI that shows which run a prompt belongs to.

### The record does not say which machine wrote it

The sessions directory can be shared between machines or pid namespaces (a home on NFS, a container that mounts `~/.agency`). A record from another host then names a pid that is some other process here. `checkedRecord` refuses a live process that started long before its record, which keeps such a record from being signalled, but the listing still shows it and the stale sweep removes it when no process here has its pid. Recording `os.hostname()` in `registerAttach`, and treating a record from another host as not this machine's (never signalled, never removed, left out of the listing), would close that.

### The attached UI imports the program's compiled module for its source map

`UIState.setSourceMap` imports the compiled module to read `__sourceMap`, as `agency debug` does in the program's own process. Attached, that import runs in the debugger's process: the program's JavaScript dependencies are initialised a second time, with whatever top-level side effects they have, and an import that fails is reported to the run as an ordinary error, which now ends the session. Module ids are also resolved against the debugger's working directory rather than the compilation directory, so attaching from elsewhere can lose the source pane or show a same-named file. The fix is to send source locations or the source text from the run, which has the map, instead of loading anything on the UI side.

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
