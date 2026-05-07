# How to Write Debugger Tests

Debugger tests use `DebuggerTestSession` (`lib/debugger/testSession.ts`) to drive the debugger headlessly. The session creates a real `DebuggerUI` wired to test infrastructure — the same rendering and key mapping code that runs in production, but with a `TestInput` (custom input with idle detection) + `FrameRecorder` (via `LabelingOutput` wrapper) instead of terminal I/O. `TestInput` is similar to `@agency-lang/tui`'s `ScriptedInput` but adds `waitForIdle()` so `press()` can synchronize with the driver's async processing.

## Quick example

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "../cli/commands.js";
import { freshImport, fixtureDir } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";

const myTestAgency = path.join(fixtureDir, "my-test.agency");
const myTestCompiled = path.join(fixtureDir, "my-test.ts");

beforeAll(() => {
  compile({ debugger: true }, myTestAgency, myTestCompiled, { ts: true });
});

describe("My debugger test", () => {
  it("steps through and returns correct result", async () => {
    const mod = await freshImport(myTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // step
    await session.press("c"); // continue
    const result = await session.quit();
    expect(result).toBe(expectedValue);
  });
});
```

## Setup

### 1. Create an Agency fixture

Put your `.agency` file in `tests/debugger/`. Keep it minimal — a few lines that exercise the behavior you're testing.

```
// tests/debugger/my-test.agency
node main() {
  x = 1
  y = 2
  z = x + y
  return z
}
```

### 2. Compile in `beforeAll`

```typescript
const myTestAgency = path.join(fixtureDir, "my-test.agency");
const myTestCompiled = path.join(fixtureDir, "my-test.ts");

beforeAll(() => {
  compile({ debugger: true }, myTestAgency, myTestCompiled, { ts: true });
});
```

The `{ debugger: true }` flag inserts debug pause points at every statement. The `{ ts: true }` flag outputs `.ts` instead of `.js` so vitest can import it directly.

**Important**: `fixtureDir` is exported from `testHelpers.ts` and points to `tests/debugger/`.

### 3. Use `freshImport` for each test

```typescript
const mod = await freshImport(myTestCompiled);
```

`freshImport` appends a cache-busting query parameter and resets the global checkpoint counter, so each test gets a clean module with fresh state.

### 4. Create a session

```typescript
const session = await DebuggerTestSession.create({ mod });
```

This:
- Creates a `Screen` backed by `TestInput` + `FrameRecorder` (120x40 by default)
- Creates a `DebuggerUI` and `DebuggerDriver`
- Runs `mod.main()` to get the first debug interrupt
- Starts the driver loop in the background
- Waits for the driver to reach its first `waitForCommand()` — the session is now idle and ready for input

## DebuggerTestSession API

### `press(key, opts?)`

Feed a single key and wait for the driver to become idle again.

```typescript
await session.press("s");              // step
await session.press("s", { times: 5 }); // step 5 times
await session.press("up");            // stepBack (when source pane is focused)
await session.press("up", { shift: true }); // stepBack with preserveOverrides
```

Key names match what `TerminalInput` produces:
- Letters: `"s"`, `"n"`, `"i"`, `"o"`, `"c"`, `"r"`, `"d"`, `"k"`, `"p"`, `"q"`, `"z"`
- Arrows: `"up"`, `"down"`, `"left"`, `"right"`
- Special: `"enter"`, `"escape"`, `"tab"`, `" "` (space)

Key-to-command mapping (when source pane is focused):

| Key | Command | Description |
|-----|---------|-------------|
| `s` or `right` | step | Execute next statement |
| `n` | next | Step over function calls |
| `i` | stepIn | Step into function call |
| `o` | stepOut | Step out of current function |
| `c` or `space` | continue | Run to completion |
| `r` | rewind | Open rewind selector |
| `d` | showCheckpoints | Open checkpoints panel |
| `k` | checkpoint | Pin a checkpoint (opens text input for label) |
| `p` | print | Print a variable (opens text input for name) |
| `q` or `escape` | quit | Exit the debugger |
| `up` | stepBack | Go to previous debug pause |
| `down` | step | Same as `s` when source pane focused |
| `up` + shift | stepBack (preserveOverrides) | Go back but keep variable overrides |
| `z` | zoom | Toggle zoom on focused pane |
| `tab` | focus next | Cycle focus to next pane |
| `1`-`9` | focus pane N | Jump to Nth pane |
| `[` / `]` | cycle threads | Navigate between thread messages |
| `:` | command mode | Open text input for `:` commands |

### `type(str)`

Type a string character by character, then press Enter. Use this for text input prompts (print variable name, checkpoint label, `:` commands).

```typescript
await session.press("p");        // opens "print>" text input
await session.type("myVar");     // types "myVar" + Enter
```

`type()` handles the full sequence: each character is fed as a key, then `enter` is pressed at the end. All intermediate renders (one per keystroke) are recorded with a single label like `#3 type("myVar")`.

### `quit()`

Press `q` to exit the driver and return the program's return value.

```typescript
const result = await session.quit();
expect(result).toBe(3);
```

The driver's `run()` method only returns when the user quits. `quit()` feeds the `q` key and awaits the run promise. The return value is the program's final result (unwrapped from the interrupt data structure).

**Always call `quit()` when you need the return value.** If you just need to check UI state or activity logs, you don't need to call it.

### `frame()`

Returns the last rendered `Frame` from the TUI library. You can inspect pane contents:

```typescript
const frame = session.frame();

// Find a pane by key and check its text content
const locals = frame.findByKey("locals");
expect(locals.toPlainText()).toContain("x = 1");

const source = frame.findByKey("source");
expect(source.toPlainText()).toContain("my-test.agency");
```

Pane keys: `"source"`, `"threads"`, `"locals"`, `"globals"`, `"callStack"`, `"activity"`, `"stdout"`, `"stats"`, `"commandBar"`.

### `writeHTML(path)`

Export all recorded frames as a navigable HTML file. Use arrow keys in the browser to step through frames.

```typescript
session.writeHTML("/tmp/debug-frames.html");
```

Each frame is labeled with what action produced it (e.g., `#1 press("s — step")`). This is invaluable for debugging test failures — you can see exactly what the debugger UI looked like at each step.

### Other properties

- `session.ui.state` — access the `UIState` directly for checking activity logs, overrides, etc.
- `session.driver.debuggerState` — access the `DebuggerState` for checking checkpoints
- `session.recorder.frames` — raw array of recorded frames with labels
- `session.isFinished` — true if the driver's run loop has exited

## Common test patterns

### Testing return values

Step through or continue, then quit:

```typescript
await session.press("s", { times: 10 });
const result = await session.quit();
expect(result).toBe(expectedValue);
```

### Testing activity log messages

The driver logs messages (like "Already at end of execution." or "x = 1") to the UIState's activity log:

```typescript
await session.press("c"); // continue to completion
await session.press("s"); // try to step past end

const log = session.ui.state.getActivityLog();
expect(log).toContainEqual("Already at end of execution.");
```

### Testing variable overrides via `:set`

Use `:` to enter command mode, then type the set command. The format is `set <varName> = <value>`:

```typescript
await session.press("s"); // past x = 1
await session.press(":"); // command mode
await session.type("set x = 10");
await session.press("c"); // continue with override
const result = await session.quit();
expect(result).toBe(12); // 10 + 2
```

### Testing user interrupts

When the program hits an `interrupt()`, the driver calls `ui.promptForInput("approve / reject / resolve <value>")`. This opens a text input directly (NOT through `:`). Just `type()` the response:

```typescript
await session.press("s"); // step to the interrupt
await session.press("s"); // the interrupt fires
// promptForInput is now waiting — type the response directly
await session.type("resolve 5");
```

Valid responses: `approve` (or `a` or empty), `reject` (or `r`), `resolve <value>`.

### Testing print

```typescript
await session.press("s"); // step past x = 1
await session.press("p"); // opens "print>" text input
await session.type("x");  // types "x" + Enter

const log = session.ui.state.getActivityLog();
expect(log).toContainEqual("x = 1");
```

### Testing checkpoints

```typescript
await session.press("s"); // step
await session.press("k"); // opens checkpoint label input
await session.type("my-label"); // label + Enter

const checkpoints = session.driver.debuggerState.getCheckpoints();
const pinned = checkpoints.filter(cp => cp.pinned);
expect(pinned.some(cp => cp.label === "my-label")).toBe(true);
```

For a checkpoint without a label, press Enter immediately:

```typescript
await session.press("k");
await session.press("enter");
```

### Testing stepBack

The `up` arrow key triggers stepBack when the source pane is focused (which is the default):

```typescript
await session.press("up"); // stepBack
await session.press("up", { shift: true }); // stepBack with preserveOverrides
```

### Testing rewind selector

Press `r` to open the rewind overlay, then navigate with arrow keys:

```typescript
await session.press("r");       // open rewind selector
await session.press("up");      // select previous checkpoint
await session.press("enter");   // confirm selection
// or:
await session.press("escape");  // cancel
```

### Testing with function arguments

If your node takes parameters:

```typescript
// node main(x: number) { ... }
const session = await DebuggerTestSession.create({ mod, args: [5] });
```

### Testing with loaded trace checkpoints

To simulate loading a trace file (starting from pre-collected checkpoints):

```typescript
// Collect checkpoints by running through the program
async function collectCheckpoints() {
  const mod = await freshImport(stepTestCompiled);
  const session = await DebuggerTestSession.create({ mod });
  await session.press("s", { times: 20 });
  return session.driver.debuggerState.getCheckpoints();
}

// Use collected checkpoints to create a trace-mode session
const checkpoints = await collectCheckpoints();
const mod = await freshImport(stepTestCompiled);
const session = await DebuggerTestSession.create({ mod, checkpoints });
// Session starts at the last checkpoint, program already "finished"
```

### Visual debugging with HTML export

When a test fails and you can't figure out why, export the frames:

```typescript
it("my failing test", async () => {
  const mod = await freshImport(myTestCompiled);
  const session = await DebuggerTestSession.create({ mod });

  await session.press("s");
  await session.press("s");
  // ... steps that fail

  // Dump frames for inspection
  session.writeHTML("/tmp/debug-frames.html");
  // Open in browser: each frame shows what key produced it
});
```

Run the test, then `open /tmp/debug-frames.html` in a browser. Use left/right arrow keys to step through frames. Each frame header shows which `press()` or `type()` call produced it.

## File reference

| File | Purpose |
|------|---------|
| `lib/debugger/testSession.ts` | `DebuggerTestSession` class |
| `lib/debugger/testHelpers.ts` | `freshImport`, `fixtureDir` |
| `lib/debugger/driver.test.ts` | Main debugger test suite (30 tests) |
| `lib/debugger/testSession.test.ts` | Smoke tests for `DebuggerTestSession` itself |
| `lib/debugger/exportFrames.test.ts` | Generates HTML frame exports for visual inspection |
| `tests/debugger/*.agency` | Test fixture programs |

## Command syntax reference (for `:` commands)

These are typed via `await session.press(":"); await session.type("...")`:

| Command | Format | Example |
|---------|--------|---------|
| set | `set <var> = <value>` | `set x = 10` |
| print | `print <var>` | `print x` |
| checkpoint | `checkpoint` or `checkpoint "<label>"` | `checkpoint "before-loop"` |
| save | `save <path>` | `save /tmp/cp.json` |
| load | `load <path>` | `load /tmp/cp.json` |
| resolve | `resolve <value>` | `resolve 5` |
| reject | `reject` | `reject` |
| modify | `modify <key>=<value> ...` | `modify x=10 y=20` |

Note: `resolve` and `reject` for user interrupts are typed directly into the `promptForInput` text input — NOT through `:` command mode. The driver opens `promptForInput` automatically when it encounters a user interrupt.
