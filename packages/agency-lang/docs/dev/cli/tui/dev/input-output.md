# Input and Output

## Architecture

The TUI library uses dependency injection for I/O. The `Screen` constructor takes an options object holding an `InputSource`, an `OutputTarget`, and the terminal `width` and `height`. Production passes terminal-backed implementations. Tests pass scripted and recorded ones.

```
Production:  new Screen({ input: new TerminalInput(), output: new TerminalOutput(), width, height })
Tests:       new Screen({ input: new ScriptedInput(), output: new FrameRecorder(), width, height })
```

This is the core of the testability design. The same UI code runs in both contexts with no code duplication.

## InputSource (`lib/tui/input/types.ts`)

```typescript
type InputSource = {
  nextKey(): Promise<KeyEvent>;
  nextLine(prompt: string): Promise<string>;
  destroy(): void;
};
```

A `KeyEvent` is `{ key, shift?, ctrl?, text? }`. `text` is set only on a `key: "paste"` event, where it carries the whole pasted string.

### ScriptedInput (`lib/tui/input/scripted.ts`)

For tests. It keeps one queue for keys and one for lines, each with a waiter pattern. The constructor optionally takes an initial sequence of keys; a plain string becomes `{ key }`.
- `feedKey(key)` / `feedLine(line)` — push data, or resolve a waiting consumer
- `nextKey()` / `nextLine()` — pop from queue, or register a waiter promise
- `destroy()` — clears all queues and pending waiters

### TerminalInput (`lib/tui/input/terminal.ts`)

For production. Puts stdin into raw mode and parses ANSI escape sequences.

Key implementation details:
- **KEY_MAP**: A single lookup table maps every known sequence to a `KeyEvent`. That covers escape sequences and special keys such as enter, backspace, and tab. Character-code math handles Ctrl+letter combinations separately.
- **Bracketed paste**: `ensureInitialized()` enables bracketed-paste mode with `\x1b[?2004h`, so the terminal wraps pasted text in `\x1b[200~ ... \x1b[201~` markers. `TerminalInput` turns a complete paste into one `{ key: "paste", text }` event, which lets a reducer append the whole payload instead of replaying it keystroke by keystroke. A paste that spans several `data` events accumulates in `pasteBuffer` until the close marker arrives. `destroy()` turns bracketed paste back off, otherwise the shell would show pastes wrapped in the literal markers.
- **Auto-initialization**: `ensureInitialized()` is called on first `nextKey()`. Throws if stdin is not a TTY.
- **nextLine()**: Temporarily exits raw mode, creates a readline interface (per-call, because readline takes ownership of stdin), then re-enters raw mode after the answer. Guarded by `inLineMode` flag to prevent concurrent calls from double-registering the data listener.
- **destroy()**: Removes the data handler, disables bracketed paste, restores the original raw-mode state, and clears queues and waiters.

## OutputTarget (`lib/tui/output/types.ts`)

```typescript
type OutputTarget = {
  write(frame: Frame, label?: string): void;
  destroy?(): void;
};
```

### FrameRecorder (`lib/tui/output/recorder.ts`)

For tests. Collects frames with labels into an array. Has:
- `frames` — the accumulated `{ frame, label }[]`. `write()` deep-clones each frame, so later mutation cannot alter what was recorded.
- `clear()` — releases all accumulated frames. Long-running sessions need this.
- `textAt(i)` / `lastText()` — the plain text of one recorded frame. These are what most assertions read.
- `toHTML()` — produces a single HTML page holding all frames, with prev/next navigation via the arrow keys
- `writeHTML(path)` — writes that HTML to a file

### TerminalOutput (`lib/tui/output/terminal.ts`)

For production. Uses the alternate screen buffer and hides the cursor.

Key implementation details:
- **Alternate screen buffer**: `init()` enters it; `destroy()` exits it
- **Diff rendering**: `write()` flattens the frame to a cell grid and keeps it as `previousGrid`. The next write emits ANSI for only the cells that changed. A size change falls back to a full repaint from `CURSOR_HOME`.
- **Synchronized output**: each write is wrapped in the DCS 2026 begin/end markers (`\x1b[?2026h` / `\x1b[?2026l`) so supporting terminals apply the frame atomically instead of streaming it cell by cell. Terminals without support ignore the sequences. Pass `synchronizedOutput: false` to the constructor to turn this off.
- **Signal handlers**: Installed on `init()`, removed on `destroy()`:
  - `SIGINT` / `SIGTERM`: destroy and exit with appropriate code. Pass `manageInterruptSignals: false` to leave these two to the caller, which lets a host run its own cleanup before exiting. The suspend, resume, and `exit` handlers are unaffected.
  - `SIGTSTP`: suspend (exit alt screen), then re-raise SIGTSTP for the default handler
  - `SIGCONT`: resume (re-enter alt screen)
  - `exit`: destroy as a safety net
- **suspend/resume**: Exit and re-enter the alternate screen buffer. Used by signal handlers and available for manual use.

## Screen (`lib/tui/screen.ts`)

Orchestrates the pipeline:
- `render(root, label?)` — runs `layout() → render() → output.write()`, returns the Frame
- `nextKey()` / `nextLine()` — delegates to input source
- `size()` — returns `{ width, height }`
- `resize(width, height)` — adopts a new terminal size. Layout reads these on every render, so an app watching `SIGWINCH` can stay correct without restarting.
- `runLoop({ initialState, render, handleKey, isDone, label?, tickMs? })` — the standard render/key/re-render loop. All three callbacks may be async, which is what lets Agency callback values drive a TUI. With `tickMs` set, each iteration races `nextKey()` against a timer and re-renders on a tick, so a live status line keeps moving during a long LLM call. The loop reuses one in-flight `nextKey()` promise across tick iterations; a fresh call per tick would queue abandoned waiters and swallow keypresses.
- `destroy()` — calls `input.destroy()` and `output.destroy()`
