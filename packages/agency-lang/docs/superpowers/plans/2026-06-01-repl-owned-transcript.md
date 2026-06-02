# REPL-Owned Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `std::ui.repl()` own transcript rendering so submitted prompts appear immediately, busy spinner/timer appears while the agent works, agent replies are appended when ready, and callers can still append arbitrary styled messages with `pushMessage()`.

**Architecture:** Keep the REPL state machine, state grouping, view composition, and public API in `stdlib/ui.agency`. Use `lib/stdlib/ui.ts` only as the bridge for TTY/test I/O, frame recording, elapsed-time helpers, active REPL message mutation, and fire-and-forget callback scheduling that Agency cannot currently express. Tests cover the public Agency API and the rendered TUI frames.

**Tech Stack:** Agency stdlib, Agency execution tests, Agency-JS integration tests, Vitest, `lib/tui` `Screen`, `ScriptedInput`, and `FrameRecorder`.

---

## Design Boundary

- Agency owns the declarative interface: `repl(...)`, `pushMessage(message: string)`, `clearMessages()`, grouped `ReplState`, reducer behavior, and builder-style view composition.
- The conceptual model is one REPL-owned output buffer: `state.transcript.messages`. Submitted prompts, `pushMessage(...)`, and completed agent replies all append to that buffer. Nothing writes transcript text directly to the terminal; the TUI renderer projects the buffer into frames on each render.
- TypeScript owns the imperative bridge:
  - terminal/screen setup already handled by `_runLoop`;
  - exposing the active REPL state so `pushMessage()` can append to the single transcript buffer outside the key reducer;
  - starting `onSubmit` in the background so the prompt can render before the agent finishes;
  - computing wall-clock elapsed seconds and spinner frame;
  - exposing recorded frame text for tests.
- Agency limitation to call out in docs/comments: there is no current Agency primitive for fire-and-forget task spawning or promise completion callbacks. `_beginSubmit` is therefore the one place where TypeScript calls an Agency callback outside the normal `runLoop` callback path. If Agency gains `spawn`/task handles later, this can move into `stdlib/ui.agency`.
- `pushMessage(message: string)` stays intentionally small. Callers can use `color(...)` or other styling helpers before passing the string; adding role/color/background parameters would make partial application noisier without improving the existing styled-string path.
- `repl(...)` remains named-argument friendly. The public signature removes `output` and keeps independent optional arguments so users can write constrained partials such as `const agentRepl = repl(status: status, paletteCommands: paletteCommands)`.
- Use descriptive variable names in new code and tests. Prefer `state`, `keyEvent`, `status`, `paletteCommands`, `submittedPrompt`, and `nextHistory` over terse names such as `s`, `k`, `stat`, `cmds`, `buf`, or `i`.
- Use Agency syntax where it improves readability: array slice syntax for history trimming, `match` blocks for key dispatch, pattern matching for structured key events or `Result` values, Agency `try` when wrapping throwing TypeScript bridge calls, and Result `catch` for defaults.
- The view uses Agency block/builder style so layout reads as nested UI structure rather than imperative TypeScript rendering.
- The plan avoids the anti-patterns in `docs/dev/anti-patterns.md`: no duplicated render pipeline, no TypeScript mini-REPL, no order-dependent top-level state object, and imperative bridge code hidden behind small declarative stdlib functions.

## File Structure

- Modify: `stdlib/ui.agency`
  - Add module docs for REPL-owned transcript behavior.
  - Add grouped `ReplState` types.
  - Add `pushMessage()` and `clearMessages()` doc-commented public functions.
  - Change `repl()` to own transcript state and remove the `output` parameter.
  - Render transcript, spinner/timer, status, palette, and input via builder blocks.
- Modify: `lib/stdlib/ui.ts`
  - Add active REPL bridge helpers.
  - Add async submit scheduling helper.
  - Add elapsed/spinner helpers.
  - Add recorded-frame introspection for tests.
- Modify: `lib/stdlib/ui.test.ts`
  - Add bridge-level tests for active transcript mutation, recorded frames, elapsed/spinner helpers, and async submit.
- Create: `tests/agency/ui-repl-owned-transcript/main.agency`
- Create: `tests/agency/ui-repl-owned-transcript/main.test.json`
- Create: `tests/agency/ui-repl-push-colored/main.agency`
- Create: `tests/agency/ui-repl-push-colored/main.test.json`
- Create: `tests/agency/ui-repl-clear-messages/main.agency`
- Create: `tests/agency/ui-repl-clear-messages/main.test.json`
- Create: `tests/agency-js/ui-repl-frame-transcript/agent.agency`
- Create: `tests/agency-js/ui-repl-frame-transcript/test.js`
- Create: `tests/agency-js/ui-repl-frame-transcript/fixture.json`
- Modify: existing REPL tests under `tests/agency/ui-repl-*` and `tests/agency-js/agency-agent-smoke`.
- Modify: `lib/agents/agency-agent/agent.agency`.

### Task 1: Add Bridge Red Tests

**Files:**
- Modify: `lib/stdlib/ui.test.ts`

- [ ] **Step 1: Add imports for new bridge helpers**

Add these names to the existing import from `./ui.js`:

```ts
  _activateReplState,
  _deactivateReplState,
  _pushMessage,
  _clearMessages,
  _recordedFrameTexts,
  _beginSubmit,
  _elapsedSeconds,
  _spinnerFrame,
```

- [ ] **Step 2: Add cleanup around each test**

Extend the existing `afterEach` imports/blocks or add a file-level cleanup block:

```ts
afterEach(() => {
  _deactivateReplState();
  _setInputSource(null);
  _setOutputTarget(null);
});
```

- [ ] **Step 3: Add active transcript mutation tests**

Append this `describe` block to `lib/stdlib/ui.test.ts`:

```ts
describe("std::ui bridge — active REPL transcript", () => {
  it("pushes styled text into the active transcript", () => {
    const state = { transcript: { messages: [] as string[] } };
    _activateReplState(state);

    _pushMessage("{red first}");
    _pushMessage("{bold second}");

    expect(state.transcript.messages).toEqual(["{red first}", "{bold second}"]);
  });

  it("clears the active transcript", () => {
    const state = { transcript: { messages: ["one", "two"] as string[] } };
    _activateReplState(state);

    _clearMessages();

    expect(state.transcript.messages).toEqual([]);
  });

  it("throws a clear error when no REPL is active", () => {
    _deactivateReplState();

    expect(() => _pushMessage("orphan")).toThrow(
      "pushMessage() requires an active repl()",
    );
  });
});
```

- [ ] **Step 4: Add recorded-frame helper test**

Append:

```ts
describe("std::ui bridge — recorded frames", () => {
  it("returns text from an injected FrameRecorder", async () => {
    const input = new ScriptedInput([{ key: "q" }]);
    const output = new FrameRecorder();
    _setInputSource(input);
    _setOutputTarget(output);
    _setSize(24, 4);

    await _runLoop(
      { done: false },
      (_ignoredState: any) => ({ type: "text", content: "hello frame" }),
      (_ignoredState: any, keyEvent: any) => ({ done: keyEvent.key === "q" }),
      (state: any) => state.done,
    );

    expect(_recordedFrameTexts()).toEqual(
      expect.arrayContaining([expect.stringContaining("hello frame")]),
    );
  });
});
```

- [ ] **Step 5: Add submit scheduling and time helper tests**

Append:

```ts
describe("std::ui bridge — async submit helpers", () => {
  it("sets busy before the callback resolves and appends the reply after", async () => {
    const state = {
      submit: { busy: false, label: "", startedAtMs: 0 },
      transcript: { messages: [] as string[] },
    };

    let resolveSubmit: (value: string) => void = () => {};
    const submitPromise = new Promise<string>((resolve) => {
      resolveSubmit = resolve;
    });

    _beginSubmit(state, "hello", () => submitPromise);

    expect(state.transcript.messages).toEqual(["{bright-blue You} hello"]);
    expect(state.submit.busy).toBe(true);
    expect(state.submit.label).toBe("Thinking");

    resolveSubmit("agent reply");
    await submitPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.transcript.messages).toEqual([
      "{bright-blue You} hello",
      "agent reply",
    ]);
    expect(state.submit.busy).toBe(false);
  });

  it("computes elapsed seconds and spinner frames deterministically", () => {
    expect(_elapsedSeconds(1_000, 3_400)).toBe(2);
    expect(_spinnerFrame(1_000, 1_000)).toBe("|");
    expect(_spinnerFrame(1_000, 1_250)).toBe("/");
    expect(_spinnerFrame(1_000, 1_500)).toBe("-");
    expect(_spinnerFrame(1_000, 1_750)).toBe("\\");
    expect(_spinnerFrame(1_000, 2_000)).toBe("|");
  });
});
```

- [ ] **Step 6: Run the red bridge tests and save output**

Run:

```bash
pnpm test:run lib/stdlib/ui.test.ts > /tmp/ui-bridge-red.log 2>&1
```

Expected: FAIL with missing exports for `_activateReplState`, `_pushMessage`, `_clearMessages`, `_recordedFrameTexts`, `_beginSubmit`, `_elapsedSeconds`, and `_spinnerFrame`.

### Task 2: Implement Minimal TypeScript Bridge

**Files:**
- Modify: `lib/stdlib/ui.ts`

- [ ] **Step 1: Add bridge types and active state storage**

Add below the existing bridge globals:

```ts
type ActiveReplState = {
  done?: boolean;
  submit?: {
    busy?: boolean;
    label?: string;
    startedAtMs?: number;
  };
  transcript: {
    messages: string[];
  };
};

let activeReplState: ActiveReplState | null = null;
```

- [ ] **Step 2: Add active REPL helpers**

Add near the other exported bridge helpers:

```ts
export function _activateReplState(state: ActiveReplState): void {
  activeReplState = state;
}

export function _deactivateReplState(): void {
  activeReplState = null;
}

function requireActiveReplState(): ActiveReplState {
  if (!activeReplState) {
    throw new Error("pushMessage() requires an active repl()");
  }
  return activeReplState;
}

export function _pushMessage(message: string): void {
  const state = requireActiveReplState();
  state.transcript.messages.push(message);
}

export function _clearMessages(): void {
  const state = requireActiveReplState();
  state.transcript.messages = [];
}
```

- [ ] **Step 3: Add recorded-frame introspection**

Add after `_setOutputTarget`:

```ts
export function _recordedFrameTexts(): string[] {
  if (!(bridgeOutputTarget instanceof FrameRecorder)) {
    return [];
  }
  return bridgeOutputTarget.frames.map((_entry, index) =>
    bridgeOutputTarget!.textAt(index),
  );
}
```

- [ ] **Step 4: Add elapsed and spinner helpers**

Add near the REPL bridge section:

```ts
export function _nowMs(): number {
  return Date.now();
}

export function _elapsedSeconds(startedAtMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
}

export function _spinnerFrame(startedAtMs: number, nowMs = Date.now()): string {
  const frames = ["|", "/", "-", "\\"];
  const tick = Math.floor(Math.max(0, nowMs - startedAtMs) / 250);
  return frames[tick % frames.length];
}
```

- [ ] **Step 5: Add async submit scheduler**

Add after `_pushMessage`:

```ts
export function _beginSubmit(
  state: ActiveReplState,
  submitted: string,
  onSubmit: unknown,
): void {
  _activateReplState(state);
  state.transcript.messages.push(`{bright-blue You} ${submitted}`);
  if (state.submit) {
    state.submit.busy = true;
    state.submit.label = "Thinking";
    state.submit.startedAtMs = Date.now();
  }

  setTimeout(() => {
    void (async () => {
      try {
        const reply = await callBridgeFn<unknown>(onSubmit, submitted);
        if (reply === false) {
          state.done = true;
          return;
        }
        if (typeof reply === "string" && reply.length > 0) {
          state.transcript.messages.push(reply);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        state.transcript.messages.push(`{red Error} ${message}`);
      } finally {
        if (state.submit) {
          state.submit.busy = false;
          state.submit.label = "";
        }
      }
    })();
  }, 0);
}
```

- [ ] **Step 6: Run the bridge tests and save output**

Run:

```bash
pnpm test:run lib/stdlib/ui.test.ts > /tmp/ui-bridge-green.log 2>&1
```

Expected: PASS.

### Task 3: Move REPL State, View, and API Into Agency

**Files:**
- Modify: `stdlib/ui.agency`

- [ ] **Step 1: Import the new bridge helpers**

Extend the `from "./ui"` import block at the top of `stdlib/ui.agency` with:

```agency
  _activateReplState,
  _deactivateReplState,
  _pushMessage,
  _clearMessages,
  _recordedFrameTexts,
  _beginSubmit,
  _elapsedSeconds,
  _spinnerFrame,
  _nowMs,
```

- [ ] **Step 2: Replace the flat REPL state type with grouped state**

Replace `type ReplState = ...` with:

```agency
type ReplInputState = {
  buffer: string;
  history: string[];
  historyIdx: number;
  prompt: string;
  historyFile: string;
  historyMax: number
}

type ReplPaletteState = {
  open: boolean;
  filter: string;
  cursor: number;
  commands: any
}

type ReplTranscriptState = {
  messages: string[]
}

type ReplSubmitState = {
  busy: boolean;
  label: string;
  startedAtMs: number
}

type ReplConfigState = {
  status: any;
  onSubmit: any
}

type ReplState = {
  input: ReplInputState;
  palette: ReplPaletteState;
  transcript: ReplTranscriptState;
  submit: ReplSubmitState;
  config: ReplConfigState;
  done: boolean
}
```

- [ ] **Step 3: Add public transcript functions with doc comments**

Add above the private REPL helpers:

```agency
/**
 * Append a styled message to the active `repl()` transcript.
 *
 * The message is rendered immediately on the next frame. The string
 * may include `std::ui` style markup or text returned by helpers
 * such as `color(...)`; `pushMessage` stores it unchanged.
 *
 * @param message - Styled or plain text to append to the transcript
 */
export def pushMessage(message: string) {
  _pushMessage(message)
}

/**
 * Remove all messages from the active `repl()` transcript.
 *
 * This is intended for tests and explicit "clear conversation"
 * commands inside interactive agents.
 */
export def clearMessages() {
  _clearMessages()
}

/**
 * Return the text snapshots recorded by scripted TUI tests.
 * Internal test helper used by Agency and agency-js integration
 * tests; real terminals return an empty array.
 */
export def recordedFrameTexts(): string[] {
  return _recordedFrameTexts()
}
```

- [ ] **Step 4: Update palette helpers for grouped state**

Rewrite `_filteredPaletteKeys` to read `state.palette.*`:

```agency
def _filteredPaletteKeys(state: ReplState): string[] {
  const paletteCommands = state.palette.commands
  let allCommandNames: string[] = []
  for (entry in entries(paletteCommands)) {
    allCommandNames.push(entry.key)
  }
  if (state.palette.filter == "") {
    return allCommandNames
  }
  let matchingCommandNames: string[] = []
  const filterText = state.palette.filter.toLowerCase()
  for (commandName in allCommandNames) {
    if (commandName.toLowerCase().includes(filterText)) {
      matchingCommandNames.push(commandName)
    }
  }
  return matchingCommandNames
}
```

- [ ] **Step 5: Add the busy line helper in Agency**

Add:

```agency
def _busyLine(state: ReplState): string {
  if (!state.submit.busy) {
    return ""
  }
  const nowMs = _nowMs()
  const elapsedSeconds = _elapsedSeconds(state.submit.startedAtMs, nowMs)
  const spinnerFrame = _spinnerFrame(state.submit.startedAtMs, nowMs)
  return "{bright-yellow ${spinnerFrame}} ${state.submit.label} ${elapsedSeconds}s"
}
```

- [ ] **Step 6: Rewrite `_replView` using builder blocks and grouped state**

Replace `_replView` with:

```agency
def _replView(state: ReplState): Element {
  const status = state.config.status()
  const paletteKeys = _filteredPaletteKeys(state)
  let paletteItems: string[] = []
  for (commandName in paletteKeys) {
    const description = state.palette.commands[commandName]
    paletteItems.push("${commandName}  - ${description}")
  }

  let visibleMessages = state.transcript.messages
  if (state.submit.busy) {
    visibleMessages = [...visibleMessages, _busyLine(state)]
  }

  const followIndex = visibleMessages.length
  const promptWidth = state.input.prompt.length
  const leftStatusWidth = status.left.length
  const rightStatusWidth = status.right.length

  return column(visible: true) as mainCol {
    mainCol.list(items: visibleMessages, selectedIndex: followIndex, flex: 1)
    mainCol.list(
      items: paletteItems,
      selectedIndex: state.palette.cursor,
      visible: state.palette.open,
      height: _PALETTE_ROWS,
      border: true,
    )
    mainCol.row(bg: "#ffffff", fg: "#000000", height: 1) as statusLine {
      statusLine.line(
        status.left, width: leftStatusWidth, bg: "#ffffff", fg: "#000000", bold: true
      )
      statusLine.box(flex: 1, bg: "#ffffff") as _ {}
      statusLine.line(
        status.right, width: rightStatusWidth, bg: "#ffffff", fg: "#000000", bold: true
      )
    }
    mainCol.row(height: 1) as inputRow {
      inputRow.line(state.input.prompt, width: promptWidth)
      inputRow.textInput(value: state.input.buffer, flex: 1)
    }
  }
}
```

- [ ] **Step 7: Extract prompt submission and use match-based key dispatch**

Add this helper below `_replView`. It uses Agency slice syntax for history trimming:

```agency
def _submitPrompt(state: ReplState): ReplState {
  const submittedPrompt = state.input.buffer
  let nextHistory = state.input.history
  if (submittedPrompt != "") {
    nextHistory = [...state.input.history, submittedPrompt]
    if (nextHistory.length > state.input.historyMax) {
      nextHistory = nextHistory[nextHistory.length - state.input.historyMax:]
    }
  }
  const nextState: ReplState = {
    ...state,
    input: {
      ...state.input,
      buffer: "",
      history: nextHistory,
      historyIdx: nextHistory.length
    },
    submit: {
      ...state.submit,
      busy: true,
      label: "Thinking",
      startedAtMs: _nowMs()
    }
  }
  _beginSubmit(nextState, submittedPrompt, state.config.onSubmit)
  return nextState
}
```

Then rewrite `_replReduce` to use descriptive parameters and a `match` block for top-level key dispatch:

```agency
def _replReduce(state: ReplState, keyEvent: KeyEvent): ReplState {
  if (state.palette.open) {
    return _replReducePaletteOpen(state, keyEvent)
  }

  match (keyEvent) {
    { ctrl: true, key: "c" } => return { ...state, done: true }
    { key: "/" } if (state.input.buffer == "") => return {
      ...state,
      palette: {
        ...state.palette,
        open: true,
        filter: "",
        cursor: 0
      }
    }
    { key: "up" } if (state.input.historyIdx > 0) => return _recallPreviousHistory(state)
    { key: "down" } if (state.input.historyIdx < state.input.history.length) => return _recallNextHistory(state)
    { key: "backspace" } if (state.input.buffer != "") => return {
      ...state,
      input: {
        ...state.input,
        buffer: state.input.buffer[:state.input.buffer.length - 1]
      }
    }
    { key: "enter" } => return _submitPrompt(state)
    { key } if (key.length == 1) => return {
      ...state,
      input: {
        ...state.input,
        buffer: state.input.buffer + key
      }
    }
    _ => return state
  }
  return state
}
```

Add the focused helpers used by the reducer:

```agency
def _recallPreviousHistory(state: ReplState): ReplState {
  const nextHistoryIndex = state.input.historyIdx - 1
  return {
    ...state,
    input: {
      ...state.input,
      historyIdx: nextHistoryIndex,
      buffer: state.input.history[nextHistoryIndex]
    }
  }
}

def _recallNextHistory(state: ReplState): ReplState {
  const nextHistoryIndex = state.input.historyIdx + 1
  let nextBuffer = ""
  if (nextHistoryIndex < state.input.history.length) {
    nextBuffer = state.input.history[nextHistoryIndex]
  }
  return {
    ...state,
    input: {
      ...state.input,
      historyIdx: nextHistoryIndex,
      buffer: nextBuffer
    }
  }
}

def _closePalette(state: ReplState): ReplState {
  return {
    ...state,
    palette: {
      ...state.palette,
      open: false,
      filter: "",
      cursor: 0
    }
  }
}

def _selectPaletteCommand(state: ReplState, paletteKeys: string[]): ReplState {
  if (paletteKeys.length == 0) {
    return _closePalette(state)
  }
  return {
    ...state,
    input: {
      ...state.input,
      buffer: paletteKeys[state.palette.cursor]
    },
    palette: {
      ...state.palette,
      open: false,
      filter: "",
      cursor: 0
    }
  }
}

def _movePaletteCursor(state: ReplState, paletteKeys: string[], delta: number): ReplState {
  let nextCursor = state.palette.cursor + delta
  const maxCursor = paletteKeys.length - 1
  if (nextCursor > maxCursor) {
    nextCursor = maxCursor
  }
  if (nextCursor < 0) {
    nextCursor = 0
  }
  return {
    ...state,
    palette: {
      ...state.palette,
      cursor: nextCursor
    }
  }
}

def _removePaletteFilterCharacter(state: ReplState): ReplState {
  return {
    ...state,
    palette: {
      ...state.palette,
      filter: state.palette.filter[:state.palette.filter.length - 1],
      cursor: 0
    }
  }
}

def _appendPaletteFilterCharacter(state: ReplState, character: string): ReplState {
  return {
    ...state,
    palette: {
      ...state.palette,
      filter: state.palette.filter + character,
      cursor: 0
    }
  }
}

def _replReducePaletteOpen(state: ReplState, keyEvent: KeyEvent): ReplState {
  const paletteKeys = _filteredPaletteKeys(state)
  match (keyEvent) {
    { key: "escape" } => return _closePalette(state)
    { key: "up" } => return _movePaletteCursor(state, paletteKeys, -1)
    { key: "down" } => return _movePaletteCursor(state, paletteKeys, 1)
    { key: "enter" } => return _selectPaletteCommand(state, paletteKeys)
    { key: "tab" } => return _selectPaletteCommand(state, paletteKeys)
    { key: "backspace" } if (state.palette.filter == "") => return _closePalette(state)
    { key: "backspace" } => return _removePaletteFilterCharacter(state)
    { key } if (key.length == 1) => return _appendPaletteFilterCharacter(state, key)
    _ => return state
  }
  return state
}
```

- [ ] **Step 8: Update `repl()` signature and lifecycle**

Replace the public `repl` signature and initial state with:

```agency
export def repl(
  status: any,
  onSubmit: any,
  prompt: string = "> ",
  historyFile: string = "",
  historyMax: number = 1000,
  paletteCommands: any = null,
  tickMs: number = null,
) {
  let paletteCommandMap = paletteCommands
  if (paletteCommandMap == null) {
    paletteCommandMap = {}
  }
  let cadence = tickMs
  if (cadence == null) {
    cadence = 100
  }
  const initial: ReplState = {
    input: {
      buffer: "",
      history: [],
      historyIdx: 0,
      prompt: prompt,
      historyFile: historyFile,
      historyMax: historyMax
    },
    palette: {
      open: false,
      filter: "",
      cursor: 0,
      commands: paletteCommandMap
    },
    transcript: {
      messages: []
    },
    submit: {
      busy: false,
      label: "",
      startedAtMs: 0
    },
    config: {
      status: status,
      onSubmit: onSubmit
    },
    done: false
  }
  _activateReplState(initial)
  _runLoop(initial, _replView, _replReduce, _replIsDone, cadence)
  _deactivateReplState()
}
```

- [ ] **Step 9: Update doc comments and examples**

In the module-level docs near the top of `stdlib/ui.agency`, replace the old `output` array example with:

```agency
/**
 * `std::ui` provides declarative terminal UI builders plus a
 * drop-in `repl()` for interactive agents.
 *
 * The REPL owns one output buffer. Submitted prompts,
 * `pushMessage(...)`, and completed agent replies all append to
 * that transcript buffer; rendering projects the buffer into the
 * output pane. `onSubmit` runs in the background, a spinner/timer is
 * shown while work is in flight, string replies from `onSubmit`
 * are appended when complete, and `false` exits the REPL.
 */
```

- [ ] **Step 10: Parse the Agency file**

Run:

```bash
pnpm run ast stdlib/ui.agency > /tmp/ui-stdlib-ast.log 2>&1
```

Expected: PASS.

### Task 4: Add Agency Integration Tests

**Files:**
- Create: `tests/agency/ui-repl-owned-transcript/main.agency`
- Create: `tests/agency/ui-repl-owned-transcript/main.test.json`
- Create: `tests/agency/ui-repl-push-colored/main.agency`
- Create: `tests/agency/ui-repl-push-colored/main.test.json`
- Create: `tests/agency/ui-repl-clear-messages/main.agency`
- Create: `tests/agency/ui-repl-clear-messages/main.test.json`

- [ ] **Step 1: Add owned transcript test**

Create `tests/agency/ui-repl-owned-transcript/main.agency`:

```agency
import { pushMessage, repl, recordedFrameTexts, setScriptedKeys } from "std::ui"

def status(): { left: string; right: string } {
  return { left: "ready", right: "" }
}

def onSubmitPrompt(submittedPrompt: string): any {
  pushMessage("{green Agent} reply to ${submittedPrompt}")
  return false
}

def containsLine(frameTexts: string[], expectedText: string): boolean {
  for (frameText in frameTexts) {
    if (frameText.includes(expectedText)) {
      return true
    }
  }
  return false
}

node main(): string {
  setScriptedKeys([
    { key: "h" },
    { key: "i" },
    { key: "enter" }
  ])
  repl(status: status, onSubmit: onSubmitPrompt, paletteCommands: {})
  const frames = recordedFrameTexts()
  if (!containsLine(frames, "You hi")) {
    return "FAIL: submitted prompt was not rendered"
  }
  if (!containsLine(frames, "Agent reply to hi")) {
    return "FAIL: agent reply was not rendered"
  }
  return "pass"
}
```

Create `tests/agency/ui-repl-owned-transcript/main.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"pass\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "repl owns the transcript and renders submitted prompts plus replies"
    }
  ]
}
```

- [ ] **Step 2: Add styled pushMessage test**

Create `tests/agency/ui-repl-push-colored/main.agency`:

```agency
import { repl, pushMessage, recordedFrameTexts, setScriptedKeys } from "std::ui"

def status(): { left: string; right: string } {
  return { left: "ready", right: "" }
}

def onSubmitPrompt(submittedPrompt: string): any {
  pushMessage("{red Tool} ${submittedPrompt}")
  pushMessage("{green Agent} done")
  return false
}

def containsLine(frameTexts: string[], expectedText: string): boolean {
  for (frameText in frameTexts) {
    if (frameText.includes(expectedText)) {
      return true
    }
  }
  return false
}

node main(): string {
  setScriptedKeys([
    { key: "x" },
    { key: "enter" }
  ])
  repl(status: status, onSubmit: onSubmitPrompt, paletteCommands: {})
  const frames = recordedFrameTexts()
  if (!containsLine(frames, "Tool x")) {
    return "FAIL: pushed styled message not rendered"
  }
  if (!containsLine(frames, "Agent done")) {
    return "FAIL: pushed agent message not rendered"
  }
  return "pass"
}
```

Create `tests/agency/ui-repl-push-colored/main.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"pass\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "pushMessage preserves styled transcript text in the REPL-owned output buffer"
    }
  ]
}
```

- [ ] **Step 3: Add clearMessages test**

Create `tests/agency/ui-repl-clear-messages/main.agency`:

```agency
import { clearMessages, pushMessage, recordedFrameTexts, repl, setScriptedKeys } from "std::ui"

def status(): { left: string; right: string } {
  return { left: "ready", right: "" }
}

def onSubmitPrompt(submittedPrompt: string): any {
  pushMessage("before clear")
  clearMessages()
  pushMessage("after clear")
  return false
}

def containsLine(frameTexts: string[], expectedText: string): boolean {
  for (frameText in frameTexts) {
    if (frameText.includes(expectedText)) {
      return true
    }
  }
  return false
}

node main(): string {
  setScriptedKeys([
    { key: "x" },
    { key: "enter" }
  ])
  repl(status: status, onSubmit: onSubmitPrompt, paletteCommands: {})
  const frames = recordedFrameTexts()
  if (containsLine(frames, "before clear")) {
    return "FAIL: cleared message still visible"
  }
  if (!containsLine(frames, "after clear")) {
    return "FAIL: message after clear missing"
  }
  return "pass"
}
```

Create `tests/agency/ui-repl-clear-messages/main.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"pass\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "clearMessages clears the REPL-owned transcript"
    }
  ]
}
```

- [ ] **Step 4: Run the new Agency tests and save output**

Run:

```bash
pnpm run agency test tests/agency/ui-repl-owned-transcript > /tmp/ui-repl-owned-transcript.log 2>&1
pnpm run agency test tests/agency/ui-repl-push-colored > /tmp/ui-repl-push-colored.log 2>&1
pnpm run agency test tests/agency/ui-repl-clear-messages > /tmp/ui-repl-clear-messages.log 2>&1
```

Expected: all PASS.

### Task 5: Add Debugger-Style Frame Integration Test

**Files:**
- Create: `tests/agency-js/ui-repl-frame-transcript/agent.agency`
- Create: `tests/agency-js/ui-repl-frame-transcript/test.js`
- Create: `tests/agency-js/ui-repl-frame-transcript/fixture.json`

- [ ] **Step 1: Create the Agency program**

Create `tests/agency-js/ui-repl-frame-transcript/agent.agency`:

```agency
import { pushMessage, recordedFrameTexts, repl, setScriptedKeys } from "std::ui"

def status(): { left: string; right: string } {
  return { left: "agent", right: "test" }
}

def onSubmitPrompt(submittedPrompt: string): any {
  pushMessage("{green Agent} finished ${submittedPrompt}")
  return false
}

node main(): string[] {
  setScriptedKeys([
    { key: "p" },
    { key: "i" },
    { key: "n" },
    { key: "g" },
    { key: "enter" }
  ])
  repl(status: status, onSubmit: onSubmitPrompt, paletteCommands: {})
  return recordedFrameTexts()
}
```

- [ ] **Step 2: Create the JS assertion harness**

Create `tests/agency-js/ui-repl-frame-transcript/test.js`:

```js
import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
const frames = result.data;

const firstPromptFrame = frames.findIndex((frame) => frame.includes("You ping"));
const replyFrame = frames.findIndex((frame) => frame.includes("Agent finished ping"));

const sawPromptBeforeReply =
  firstPromptFrame >= 0 && replyFrame >= 0 && firstPromptFrame <= replyFrame;
const sawBusy =
  frames.some((frame) => frame.includes("Thinking") && frame.includes("0s"));

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      sawPromptBeforeReply,
      sawBusy,
      sawReply: replyFrame >= 0,
    },
    null,
    2,
  ),
);
```

- [ ] **Step 3: Create the fixture**

Create `tests/agency-js/ui-repl-frame-transcript/fixture.json`:

```json
{
  "sawPromptBeforeReply": true,
  "sawBusy": true,
  "sawReply": true
}
```

- [ ] **Step 4: Run the Agency-JS frame test and save output**

Run:

```bash
pnpm run agency test js tests/agency-js/ui-repl-frame-transcript > /tmp/ui-repl-frame-transcript.log 2>&1
```

Expected: PASS.

### Task 6: Migrate Existing REPL Fixtures

**Files:**
- Modify: `tests/agency/ui-repl-history/main.agency`
- Modify: `tests/agency/ui-repl-palette-open/main.agency`
- Modify: `tests/agency/ui-repl-onsubmit-false-exits/main.agency`
- Modify: `tests/agency/ui-repl-status-tick/main.agency`
- Modify: `tests/agency-js/agency-agent-smoke/agent.agency`

- [ ] **Step 1: Remove local output arrays from existing REPL tests**

For each existing REPL test, remove the old `output: ...` argument from the `repl(...)` call and delete any zero-argument `string[]` output callback that was only there for `repl`.

Example replacement:

```agency
repl(prompt: "> ", status: status, paletteCommands: {}, onSubmit: onSubmitPrompt)
```

- [ ] **Step 2: Keep behavioral assertions unchanged**

The history, palette, exit, and status tests should keep their existing assertions about submissions, palette-selected commands, and status call counts. These tests verify the clean breaking API change did not regress core REPL behavior.

- [ ] **Step 3: Run migrated tests and save output**

Run:

```bash
pnpm run agency test tests/agency/ui-repl-history > /tmp/ui-repl-history.log 2>&1
pnpm run agency test tests/agency/ui-repl-palette-open > /tmp/ui-repl-palette-open.log 2>&1
pnpm run agency test tests/agency/ui-repl-onsubmit-false-exits > /tmp/ui-repl-onsubmit-false-exits.log 2>&1
pnpm run agency test tests/agency/ui-repl-status-tick > /tmp/ui-repl-status-tick.log 2>&1
pnpm run agency test js tests/agency-js/agency-agent-smoke > /tmp/agency-agent-smoke.log 2>&1
```

Expected: all PASS.

### Task 7: Optional LLM-Backed Smoke Test

**Files:**
- Create: `tests/agency/ui-repl-llm-smoke/main.agency`
- Create: `tests/agency/ui-repl-llm-smoke/main.test.json`

- [ ] **Step 1: Add an LLM-backed smoke test only if credentials are already configured**

Create `tests/agency/ui-repl-llm-smoke/main.agency`:

```agency
import { llm } from "std::agent"
import { pushMessage, recordedFrameTexts, repl, setScriptedKeys } from "std::ui"

def status(): { left: string; right: string } {
  return { left: "llm", right: "" }
}

def onSubmitPrompt(submittedPrompt: string): any {
  const reply = llm("Reply with exactly: pong")
  pushMessage("{green Agent} ${reply}")
  return false
}

def containsLine(frameTexts: string[], expectedText: string): boolean {
  for (frameText in frameTexts) {
    if (frameText.includes(expectedText)) {
      return true
    }
  }
  return false
}

node main(): string {
  setScriptedKeys([
    { key: "p" },
    { key: "i" },
    { key: "n" },
    { key: "g" },
    { key: "enter" }
  ])
  repl(status: status, onSubmit: onSubmitPrompt, paletteCommands: {})
  const frames = recordedFrameTexts()
  if (!containsLine(frames, "You ping")) {
    return "FAIL: prompt missing"
  }
  if (!containsLine(frames, "pong")) {
    return "FAIL: llm reply missing"
  }
  return "pass"
}
```

Create `tests/agency/ui-repl-llm-smoke/main.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"pass\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "LLM-backed repl appends prompt immediately and appends final reply"
    }
  ]
}
```

- [ ] **Step 2: Run the LLM smoke only when credentials are present**

Run:

```bash
pnpm run agency test tests/agency/ui-repl-llm-smoke > /tmp/ui-repl-llm-smoke.log 2>&1
```

Expected with credentials: PASS. If credentials are absent, keep the files but record the credential failure from `/tmp/ui-repl-llm-smoke.log` in the final implementation notes.

### Task 8: Migrate the Agent

**Files:**
- Modify: `lib/agents/agency-agent/agent.agency`

- [ ] **Step 1: Update imports**

Replace the `std::ui` import with:

```agency
import { repl, pushMessage } from "std::ui"
```

Keep any existing color helper imports used to build styled strings.

- [ ] **Step 2: Remove local transcript plumbing**

Delete local transcript arrays and helper functions that only existed to feed the old `repl(output: ...)` argument.

- [ ] **Step 3: Return agent text from `onSubmit` and use `pushMessage` for extra lines**

Shape the submit handler like this:

```agency
def onSubmitPrompt(prompt: string): any {
  if (prompt == "/exit") {
    return false
  }
  pushMessage(color("system: routing request", fg: "bright-black"))
  const reply = runAgent(prompt)
  return color("agent: ${reply}", fg: "green")
}
```

If the existing agent uses different function names, keep its current routing logic and only replace transcript mutation with `pushMessage(...)` and string returns.

- [ ] **Step 4: Update the `repl` call**

Use named arguments:

```agency
repl(
  status: status,
  onSubmit: onSubmitPrompt,
  prompt: "> ",
  paletteCommands: { "/exit": "Exit" },
)
```

- [ ] **Step 5: Parse the agent**

Run:

```bash
pnpm run ast lib/agents/agency-agent/agent.agency > /tmp/agency-agent-ast.log 2>&1
```

Expected: PASS.

### Task 9: Full Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run focused TypeScript tests**

Run:

```bash
pnpm test:run lib/stdlib/ui.test.ts lib/tui/test/runLoop.test.ts lib/tui/screen.test.ts > /tmp/ui-focused-tests.log 2>&1
```

Expected: PASS.

- [ ] **Step 2: Run focused Agency tests**

Run:

```bash
pnpm run agency test tests/agency/ui-runloop-basic > /tmp/ui-runloop-basic.log 2>&1
pnpm run agency test tests/agency/ui-runloop-tick > /tmp/ui-runloop-tick.log 2>&1
pnpm run agency test tests/agency/ui-repl-history > /tmp/ui-repl-history-final.log 2>&1
pnpm run agency test tests/agency/ui-repl-palette-open > /tmp/ui-repl-palette-open-final.log 2>&1
pnpm run agency test tests/agency/ui-repl-onsubmit-false-exits > /tmp/ui-repl-onsubmit-false-exits-final.log 2>&1
pnpm run agency test tests/agency/ui-repl-status-tick > /tmp/ui-repl-status-tick-final.log 2>&1
pnpm run agency test tests/agency/ui-repl-owned-transcript > /tmp/ui-repl-owned-transcript-final.log 2>&1
pnpm run agency test tests/agency/ui-repl-push-colored > /tmp/ui-repl-push-colored-final.log 2>&1
pnpm run agency test tests/agency/ui-repl-clear-messages > /tmp/ui-repl-clear-messages-final.log 2>&1
pnpm run agency test js tests/agency-js/ui-repl-frame-transcript > /tmp/ui-repl-frame-transcript-final.log 2>&1
pnpm run agency test js tests/agency-js/agency-agent-smoke > /tmp/agency-agent-smoke-final.log 2>&1
```

Expected: all PASS.

- [ ] **Step 3: Build because stdlib changed**

Run:

```bash
make > /tmp/ui-make.log 2>&1
```

Expected: PASS.

- [ ] **Step 4: Run structure lint**

Run:

```bash
pnpm run lint:structure > /tmp/ui-structure.log 2>&1
```

Expected: PASS.

- [ ] **Step 5: Inspect generated docs surface**

Run:

```bash
pnpm run agency doc stdlib/ui.agency > /tmp/ui-doc.log 2>&1
```

Expected: PASS, and the generated stdlib docs include `repl`, `pushMessage`, and `clearMessages` with doc comments.

## Notes for Implementation

- Do not preserve the old `repl(output: ...)` API; this is a clean breaking change.
- Keep TypeScript additions under `lib/stdlib/ui.ts` as bridge primitives only. Do not move REPL view composition or transcript policy into TypeScript.
- Keep all new TypeScript object shapes as `type`, not `interface`.
- Do not use dynamic imports.
- Save every expensive test run to a `/tmp/*.log` file as shown above.
- If Agency cannot parse one of the snippets, first check `docs/site/guide/basic-syntax.md` and nearby `tests/agency/ui-*` fixtures, then fix the Agency syntax rather than moving behavior to TypeScript.
- For Agency syntax used in this plan, cross-check `docs/site/guide/basic-syntax.md`, `docs/site/guide/pattern-matching.md`, `docs/site/guide/error-handling.md`, and `docs/site/guide/testing.md`.
