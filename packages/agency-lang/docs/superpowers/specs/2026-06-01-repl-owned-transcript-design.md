# REPL-Owned Transcript and Busy State

## Goal

Make `std::ui.repl()` the low-effort path for building interactive Agency agents. Callers should not need to own an output array, write an `output()` callback, or manually coordinate repaint timing after appending transcript lines.

When a user submits a prompt:

1. The prompt appears in the transcript immediately.
2. A spinner and elapsed-seconds timer appear above the status bar while the submit handler runs.
3. Messages pushed during or after the submit handler appear promptly.
4. The spinner/timer disappear when the submit handler finishes.

This is a breaking API change. Existing callers should migrate from `output: myOutputCallback` to `pushMessage(...)`.

## Public API

`repl()` owns an active transcript for the duration of the running REPL.

```agency
import { repl, pushMessage } from "std::ui"

def onSubmit(msg: string): boolean {
  const reply = route(config, msg)
  pushMessage(highlight("\n${reply}\n", language: "markdown"))
  return true
}

node main() {
  repl(
    status: buildStatus,
    onSubmit: onSubmit,
    prompt: "> ",
    paletteCommands: { "/exit": "Exit" },
  )
}
```

`pushMessage(message: string)` appends a string to the active REPL transcript.

The string is rendered as-is by the existing TUI styled-text pipeline, so callers may keep using `color.*(...)`, `highlight(...)`, or explicit style tags before passing text to `pushMessage`.

`pushMessage` is only valid while a REPL is active. If called outside an active REPL, it should throw a clear error instead of silently dropping output.

## Submit Lifecycle

The current reducer awaits `onSubmit` inside the Enter-key branch. That prevents a repaint until long-running agent work finishes.

The new flow should be:

1. User presses Enter.
2. REPL captures `submitted = s.buffer`.
3. REPL appends the user line to its owned transcript immediately, using the exact default format `you: ${submitted}`.
4. REPL clears the input buffer, updates history, sets `submit.busy: true`, records `submit.startedAtMs`, and returns.
5. The render loop repaints with the prompt visible and the busy row active.
6. The submit handler runs asynchronously from the UI loop's perspective.
7. While busy, ticks update the spinner frame and elapsed seconds.
8. When the submit handler resolves, REPL clears `busy`, removes the busy row, and applies the handler's continue/exit result.

The handler still returns `boolean`: `false` exits the REPL, anything else keeps it running. If the handler throws, the REPL should clear busy state before the error propagates.

## Rendering

The REPL view should render, top to bottom:

1. Transcript list, auto-following the newest line.
2. Command palette when open.
3. Busy row when `busy == true`.
4. Status row.
5. Input row.

The busy row should be a single line above the status bar, using this shape:

```text
⠋ thinking 3s
```

Use the existing spinner frames if available in the codebase; otherwise use a short ASCII-safe fallback. The elapsed timer is whole seconds since `busyStartedAtMs`.

When not busy, the busy row is not visible and should not consume layout height.

## State Model

Avoid turning `ReplState` into a flat god object. Keep the top-level state grouped by responsibility so each chunk can be understood, tested, and eventually moved behind a helper without touching unrelated behavior.

```agency
type ReplState = {
  input: ReplInputState;
  palette: ReplPaletteState;
  transcript: ReplTranscriptState;
  submit: ReplSubmitState;
  config: ReplConfig;
}

type ReplInputState = {
  buffer: string;
  history: string[];
  historyIdx: number;
}

type ReplPaletteState = {
  open: boolean;
  filter: string;
  cursor: number;
}

type ReplTranscriptState = {
  messages: string[];
}

type ReplSubmitState = {
  busy: boolean;
  startedAtMs: number;
  label: string;
  resultReady: boolean;
  keepGoing: boolean;
  error: any;
}

type ReplConfig = {
  prompt: string;
  paletteCommands: any;
  historyFile: string;
  historyMax: number;
  status: any;
  onSubmit: any;
}
```

The exact field names can change during implementation if Agency's runtime constraints make another shape simpler, but the grouping should remain. Input editing, palette filtering, transcript storage, submit/busy lifecycle, and configuration are separate concepts and should not be mixed in one flat record.

The TypeScript bridge may hold module-level active REPL state for operations that must be triggered outside the reducer, such as `pushMessage()` and completion notifications.

## Scheduling

`pushMessage()` must request a repaint when possible. Because the current `Screen.runLoop` only renders after key events or ticks, `repl()` should opt into a modest tick interval while active, even when the caller does not pass one.

Use a default tick cadence around 100ms while a REPL is running. The renderer now diffs terminal output, so redundant frames are cheap. If the runtime checkpoint leak described in `stdlib/ui.agency` still applies to Agency callback renders, prefer moving the REPL run loop to TypeScript for this widget so periodic repaint does not call Agency render callbacks on every tick.

The submit handler must not block the repaint that shows the submitted prompt. If Agency callbacks cannot be safely launched without awaiting them inside the reducer, implement a REPL-specific TypeScript loop that owns the UI state and invokes `onSubmit` as a background promise through `__call`.

## Agent Migration

`lib/agents/agency-agent/agent.agency` should stop owning `_outputLines`, `_push`, and `_listOutput`.

Instead:

- Import `pushMessage` from `std::ui`.
- Replace `_push(...)` calls with `pushMessage(...)`.
- Remove `output: _listOutput` from the `repl()` call.
- Keep `color.cyan(...)` and `highlight(...)` at call sites; the styled string remains the payload.
- Let `repl()` add the submitted user prompt automatically. `_runTurn` should not separately push `you: ${msg}` for normal user messages.

Slash commands can still push their own text via `pushMessage`.

## Testing

Add Agency execution tests for the REPL lifecycle:

1. Submitting a prompt causes the prompt text to appear before a delayed `onSubmit` completes.
2. While a delayed `onSubmit` is pending, the busy row shows a spinner and elapsed seconds.
3. After `onSubmit` completes and calls `pushMessage`, the assistant message appears and the busy row disappears.
4. `pushMessage(color.cyan("..."))` preserves style markup in the rendered output path.
5. Returning `false` from `onSubmit` still exits cleanly.

Prefer Agency tests because they exercise the real stdlib surface and compiler/runtime integration. Pure fake-submit tests are useful for deterministic timing behavior, but LLM-backed Agency tests are allowed when they materially increase confidence in the real agent workflow. Keep them focused so they do not make routine runs needlessly slow or expensive.

Add TypeScript bridge tests where useful for repaint notifications and active-REPL error handling that is awkward to observe from Agency.

When running tests, save output to files as required by `AGENTS.md`.

## Non-Goals

- Persisting transcript history across sessions.
- Providing structured message roles in the public API.
- Backwards compatibility for `repl(output: ...)`.
- Tool-call streaming UI beyond ordinary `pushMessage(...)` calls.
