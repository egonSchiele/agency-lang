# Input and Output

## Architecture

The TUI library uses dependency injection for I/O. The `Screen` class accepts an `InputSource` and `OutputTarget` via its constructor. In production these are terminal-backed; in tests they are scripted/recorded.

```
Production:  Screen(TerminalInput, TerminalOutput)
Tests:       Screen(ScriptedInput, FrameRecorder)
```

This is the core of the testability design — the same UI code runs in both contexts with no code duplication.

## InputSource (`lib/input/types.ts`)

```typescript
type InputSource = {
  nextKey(): Promise<KeyEvent>;
  nextLine(prompt: string): Promise<string>;
  destroy(): void;
};
```

### ScriptedInput (`lib/input/scripted.ts`)

For tests. Maintains two queues (keys and lines) with a waiter pattern:
- `feedKey(key)` / `feedLine(line)` — push data, or resolve a waiting consumer
- `nextKey()` / `nextLine()` — pop from queue, or register a waiter promise
- `destroy()` — clears all queues and pending waiters

### TerminalInput (`lib/input/terminal.ts`)

For production. Puts stdin into raw mode and parses ANSI escape sequences.

Key implementation details:
- **KEY_MAP**: A single lookup table maps all known sequences (escape sequences, special keys like enter/backspace/tab) to `KeyEvent` objects. Ctrl+letter combinations are handled separately via character code math.
- **Auto-initialization**: `ensureInitialized()` is called on first `nextKey()`. Throws if stdin is not a TTY.
- **nextLine()**: Temporarily exits raw mode, creates a readline interface (per-call, because readline takes ownership of stdin), then re-enters raw mode after the answer. Guarded by `inLineMode` flag to prevent concurrent calls from double-registering the data listener.
- **destroy()**: Removes the data handler, restores original raw mode state, clears queues and waiters.

## OutputTarget (`lib/output/types.ts`)

```typescript
type OutputTarget = {
  write(frame: Frame, label?: string): void;
  destroy?(): void;
};
```

### FrameRecorder (`lib/output/recorder.ts`)

For tests. Collects frames with labels into an array. Has:
- `frames` — the accumulated `{ frame, label }[]`
- `clear()` — releases all accumulated frames (important for long-running sessions)
- `toHTML()` — produces a single HTML file with all frames, prev/next navigation via arrow keys
- `writeHTML(path)` — writes the HTML to a file

### TerminalOutput (`lib/output/terminal.ts`)

For production. Uses the alternate screen buffer and hides the cursor.

Key implementation details:
- **Alternate screen buffer**: `init()` enters it; `destroy()` exits it
- **Signal handlers**: Installed on `init()`, removed on `destroy()`:
  - `SIGINT` / `SIGTERM`: destroy and exit with appropriate code
  - `SIGTSTP`: suspend (exit alt screen), then re-raise SIGTSTP for the default handler
  - `SIGCONT`: resume (re-enter alt screen)
  - `exit`: destroy as a safety net
- **suspend/resume**: Exit and re-enter the alternate screen buffer. Used by signal handlers and available for manual use.

## Screen (`lib/screen.ts`)

Orchestrates the pipeline:
- `render(root, label?)` — runs `layout() → render() → output.write()`, returns the Frame
- `nextKey()` / `nextLine()` — delegates to input source
- `size()` — returns `{ width, height }`
- `destroy()` — calls `input.destroy()` and `output.destroy()`
