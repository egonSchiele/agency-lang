# Terminal Usage

## Setting Up a Terminal Screen

```typescript
import {
  Screen, TerminalInput, TerminalOutput,
  box, text, column,
} from "@agency-lang/tui";

const input = new TerminalInput();
const output = new TerminalOutput();
const screen = new Screen({
  output,
  input,
  width: process.stdout.columns,
  height: process.stdout.rows,
});
```

`TerminalInput` auto-initializes on first `nextKey()` call: it puts stdin in raw mode and starts listening for keypresses. `TerminalOutput` enters the alternate screen buffer and hides the cursor on first `write()`.

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

`TerminalOutput` automatically installs signal handlers on init:

- **Ctrl+C (SIGINT)**: Restores terminal and exits with code 130
- **SIGTERM**: Restores terminal and exits with code 143
- **Ctrl+Z (SIGTSTP)**: Exits alternate screen, suspends the process
- **SIGCONT** (resume after Ctrl+Z): Re-enters alternate screen

All handlers are removed when `destroy()` is called.

## Line Input

For text input that needs a readline prompt (e.g., a command input):

```typescript
const answer = await screen.nextLine("Enter command: ");
```

This temporarily exits raw mode, shows a readline prompt, then re-enters raw mode after the user presses Enter.

## Key Events

`nextKey()` returns `KeyEvent` objects:

```typescript
type KeyEvent = {
  key: string;      // "a", "up", "enter", "escape", etc.
  shift?: boolean;
  ctrl?: boolean;
};
```

Special keys: `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `delete`, `insert`, `enter`, `escape`, `backspace`, `tab`.

Ctrl combinations: `{ key: "c", ctrl: true }` for Ctrl+C (if you handle it before the signal handler).

## Cleanup

Always call `screen.destroy()` when done. This:
- Restores stdin to its original raw mode state
- Exits the alternate screen buffer
- Shows the cursor
- Removes all signal handlers
