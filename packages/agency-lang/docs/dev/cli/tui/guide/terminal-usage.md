# Terminal Usage

## Setting Up a Terminal Screen

```typescript
import {
  Screen, TerminalInput, TerminalOutput,
  box, text, column,
} from "@/tui/index.js";

const input = new TerminalInput();
const output = new TerminalOutput();
const screen = new Screen({
  output,
  input,
  width: process.stdout.columns,
  height: process.stdout.rows,
});
```

`TerminalInput` initializes itself on the first `nextKey()` call. It puts stdin in raw mode, enables bracketed paste, and starts listening for keypresses. It throws if stdin is not a TTY. `TerminalOutput` enters the alternate screen buffer and hides the cursor on the first `write()`.

## Main Loop

```typescript
let running = true;
let count = 0;

while (running) {
  screen.render(
    column(
      box({ border: true, label: " Counter " },
        text(`Count: {bold}${count}{/bold}`)
      ),
      box({ height: 1, fg: "gray" },
        text(" (up) increment  (down) decrement  (q) quit")
      ),
    )
  );

  const key = await screen.nextKey();
  if (key.key === "up") count++;
  else if (key.key === "down") count--;
  else if (key.key === "q") running = false;
}

screen.destroy();
```

## Signal Handling

`TerminalOutput` installs signal handlers on init:

- **Ctrl+C (SIGINT)**: Restores terminal and exits with code 130
- **SIGTERM**: Restores terminal and exits with code 143
- **Ctrl+Z (SIGTSTP)**: Exits alternate screen, suspends the process
- **SIGCONT**, on resume after Ctrl+Z: Re-enters alternate screen

There is also an `exit` handler as a safety net.

`destroy()` removes all of them.

Pass `manageInterruptSignals: false` to the constructor when the caller wants
to own SIGINT and SIGTERM itself, so it can run its own cleanup before
exiting. The suspend, resume, and `exit` handlers are still installed.

## Line Input

For text input that needs a readline prompt (e.g., a command input):

```typescript
const answer = await screen.nextLine("Enter command: ");
```

This temporarily exits raw mode, shows a readline prompt, then re-enters raw mode after the user presses Enter. It cancels any pending `nextKey()` waiters, which reject with "nextKey() cancelled by nextLine()", and it rejects if a `nextLine()` is already in progress.

## Key Events

`nextKey()` returns `KeyEvent` objects:

```typescript
type KeyEvent = {
  key: string;      // "a", "up", "enter", "escape", etc.
  shift?: boolean;
  ctrl?: boolean;
  text?: string;    // the pasted text, on a `key: "paste"` event
};
```

The type lives in `lib/tui/input/types.ts`.

Special keys: `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `delete`, `insert`, `enter`, `escape`, `backspace`, `tab`.

A bracketed paste arrives as one event with `key: "paste"` and the pasted text in `text`.

Ctrl combinations: `{ key: "c", ctrl: true }` for Ctrl+C (if you handle it before the signal handler).

## Cleanup

Always call `screen.destroy()` when done. `Screen.destroy()` calls
`input.destroy()` and `output.destroy()`, which:
- Restore stdin to its original raw mode state
- Exit the alternate screen buffer
- Show the cursor
- Remove all signal handlers

## Resizing

`screen.resize(width, height)` adopts a new terminal size. Layout reads the
size on every render, so an app that listens for SIGWINCH can keep its panes
correct without restarting.

## `runLoop`

`screen.runLoop({ initialState, render, handleKey, isDone })` is the built-in
version of the main loop above. Pass `tickMs` to re-render on a timer while no
keys arrive, which is how `repl()` keeps a live status line moving during a
long LLM call.
