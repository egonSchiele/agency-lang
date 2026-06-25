import process from "process";
import {
  Screen,
  TerminalInput,
  TerminalOutput,
  FrameRecorder,
  type Element as TuiElement,
  type KeyEvent as TuiKeyEvent,
  type InputSource,
  type OutputTarget,
} from "@/tui/index.js";
import type { Frame } from "@/tui/frame.js";
import { toANSI } from "@/tui/render/ansi.js";
import { withBottomCursor, installRegion, resetRegion } from "./ui-region.js";
import { __call } from "../runtime/call.js";
import { __ctx } from "../runtime/asyncContext.js";
import { isFailure, success, failure } from "../runtime/result.js";
import { AgencyCancelledError } from "../runtime/errors.js";
import prompts from "prompts";
import { color } from "@/utils/termcolors.js";

// ---------------------------------------------------------------------------
// Declarative TS bridge for `std::ui`. Exposes the existing
// `lib/tui/` engine (Screen, builders, input sources) to the Agency
// stdlib wrapper. The Agency side (`stdlib/ui.agency`) wraps these
// `_`-prefixed exports as the public `runLoop`, `repl`, etc.
//
// The bridge holds module-level handles for the input source, output
// target, and viewport size. Tests inject scripted variants via
// `_setInputSource` / `_setOutputTarget` / `_setSize`; production code
// defaults to `TerminalInput` / `TerminalOutput` at the actual TTY size.
// ---------------------------------------------------------------------------


// `bridgeInputSource` / `bridgeOutputTarget` / `bridgeWidth` /
// `bridgeHeight` are intentionally process-wide: there is exactly one
// TTY per process, and the test injection points (`_setInputSource`
// etc.) need a stable target. `bridgeActiveScreen` is also process-
// wide because only one alt-screen can paint at a time. None of these
// are concurrency hazards in practice — concurrent Agency runs that
// each call `repl()` would already serialize on the single TTY.
let bridgeInputSource: InputSource | null = null;
let bridgeOutputTarget: OutputTarget | null = null;
let bridgeWidth = 80;
let bridgeHeight = 24;
let bridgeActiveScreen: Screen | null = null;

// ---------------------------------------------------------------------------
// Per-RuntimeContext UI state.
//
// Anything that's "per-REPL session" (choice prompt awaiting a user
// pick, the exit signal set when onSubmit returns false, the
// transcript array the console capture writes into) lives here instead
// of as a module-level singleton. That way concurrent Agency
// executions in the same process — e.g. an agent orchestrating
// subagents that each spin up their own repl(), or vitest cases
// running in parallel — each get their own slot via ALS lookup and
// don't clobber each other's pending promises / exit signals /
// transcripts.
//
// `fallbackUiState` is used when no ALS frame is active, which only
// happens for the unit-level tests in `ui.test.ts` that drive the
// helpers directly without `runInTestContext`. Production code always
// runs inside an Agency execution frame so `__ctx()` returns the
// per-run RuntimeContext and the WeakMap branch wins.
// ---------------------------------------------------------------------------

type ChoiceItem = { key: string; label: string };
type ChoiceRequest = {
  title: string;
  body: string;
  items: ChoiceItem[];
  // When true, the modal accepts free-form text in addition to the
  // declared item keys: if the user's typed filter matches no items
  // and they press Enter, the prompt resolves with the filter text
  // (instead of being a no-op). Used by std::policy so a typed
  // rejection reason is captured in one step instead of two.
  // Optional: existing internal callers (tests, legacy paths) still
  // construct ChoiceRequest without it, and `false` is the safe default.
  allowFreeText?: boolean;
};

type UiContextState = {
  pendingChoice: {
    resolve: (answer: string) => void;
    reject: (err: Error) => void;
  } | null;
  pendingChoiceRequest: ChoiceRequest | null;
  replExitSignaled: boolean;
  captureTarget: string[] | null;
};

function makeUiContextState(): UiContextState {
  return {
    pendingChoice: null,
    pendingChoiceRequest: null,
    replExitSignaled: false,
    captureTarget: null,
  };
}

const uiStateByCtx = new WeakMap<object, UiContextState>();
const fallbackUiState: UiContextState = makeUiContextState();

function getUiState(): UiContextState {
  const ctx = __ctx();
  if (!ctx) return fallbackUiState;
  let s = uiStateByCtx.get(ctx);
  if (!s) {
    s = makeUiContextState();
    uiStateByCtx.set(ctx, s);
  }
  return s;
}

/** Consume any pending test-mode injection and fall back to real
 *  terminal I/O when production. Sets `bridgeInputSource`,
 *  `bridgeOutputTarget`, `bridgeWidth`, `bridgeHeight`. */
function ensureBridgeState(): void {
  if (!bridgeInputSource) bridgeInputSource = new TerminalInput();
  if (!bridgeOutputTarget) bridgeOutputTarget = new TerminalOutput();
  if (process.stdout.isTTY) {
    bridgeWidth = process.stdout.columns || bridgeWidth;
    bridgeHeight = process.stdout.rows || bridgeHeight;
  }
}

function makeBridgeScreen(): Screen {
  ensureBridgeState();
  return new Screen({
    input: bridgeInputSource!,
    output: bridgeOutputTarget!,
    width: bridgeWidth,
    height: bridgeHeight,
  });
}

// ---------------------------------------------------------------------------
// Test-only injection points
//
// `_setInputSource` / `_setOutputTarget` / `_setSize` /
// `_recordedFrameTexts` are NOT part of the public Agency UI API.
// They exist so vitest suites can stub the declarative bridge with
// a `ScriptedInput` + `FrameRecorder` and drive `_runLoop` directly
// without touching a real terminal. Production code paths never
// import them — `ensureBridgeState` falls back to `TerminalInput` /
// `TerminalOutput` when nothing was injected.
//
// If you find yourself reaching for one of these outside of a
// `*.test.ts` file, prefer adding a new public Agency-side wrapper
// instead so the contract stays inside the stdlib surface.
// ---------------------------------------------------------------------------

/** TEST ONLY — inject an `InputSource` (e.g. `ScriptedInput`) for the
 *  declarative bridge. Pass `null` to clear between tests. */
export function _setInputSource(src: InputSource | null): void {
  bridgeInputSource = src;
}

/** TEST ONLY — inject an `OutputTarget` (e.g. `FrameRecorder`) for the
 *  declarative bridge. Pass `null` to clear between tests. */
export function _setOutputTarget(out: OutputTarget | null): void {
  bridgeOutputTarget = out;
}

/** TEST ONLY — extract the recorded frames from the injected
 *  `FrameRecorder` as plain-text per-frame strings. Returns `[]`
 *  when no recorder is installed (production path). */
export function _recordedFrameTexts(): string[] {
  if (!(bridgeOutputTarget instanceof FrameRecorder)) {
    return [];
  }
  const recorder = bridgeOutputTarget;
  return recorder.frames.map((_entry, index) => recorder.textAt(index));
}

/** TEST ONLY — set the viewport (width / height) the bridge passes
 *  to `Screen`. Production reads `process.stdout.columns` / `.rows`. */
export function _setSize(w: number, h: number): void {
  bridgeWidth = w;
  bridgeHeight = h;
}

/** Returns true while a `_runLoop` (or future `_runLoopHybrid`) call
 *  is in flight. Used by `std::policy.cliPolicyHandler` to probe
 *  whether a REPL owns the screen and route prompts accordingly. */
export function _hasActiveScreen(): boolean {
  return bridgeActiveScreen !== null;
}

// Sentinel key used by `_triggerRender` to wake the active runLoop
// without simulating a real keypress. `_replReduce` (and any well-
// behaved REPL reducer) treats unknown single-character / multi-char
// keys as no-ops and returns the state unchanged, so the loop's
// `nextKey` resolves, `handleKey` runs (and is a no-op), and the
// view repaints with whatever state the caller mutated.
const RENDER_TRIGGER_KEY: TuiKeyEvent = { key: "__render__" };

/**
 * Wake the active runLoop so it repaints immediately. Used by
 * `_beginSubmit` (the async-callback path) and by Agency-side
 * `pushMessage` so transcript updates show up without waiting for
 * the user to press another key. No-op when no input source supports
 * synthetic injection (we keep the check defensive since custom
 * `InputSource`s aren't required to implement `feedKey`).
 */
export function _triggerRender(): void {
  if (!bridgeActiveScreen) return;
  const source = bridgeInputSource as
    | (InputSource & { feedKey?: (key: TuiKeyEvent) => void })
    | null;
  if (source && typeof source.feedKey === "function") {
    source.feedKey(RENDER_TRIGGER_KEY);
  }
}

/** Drives a state-machine loop with the declarative TUI engine.
 *  Renders the initial state, awaits each key, runs `handleKey`,
 *  re-renders, exits when `isDone` returns true. Returns the final
 *  state.
 *
 *  When `tickMs` is set, the loop also re-renders on a timer so
 *  external state (e.g. an LLM call's elapsed time) keeps updating
 *  even with no key input.
 */
/** Adapt either a plain JS function or an AgencyFunction-like callback
 *  passed across the bridge into an async callable. Uses `__call` so
 *  AgencyFunction values dispatch through the runtime's normal call
 *  path (preserving handlers, ALS context, retry semantics) rather
 *  than being invoked as raw JS. */
async function callBridgeFn<T>(fn: unknown, ...args: unknown[]): Promise<T> {
  return (await __call(fn, { type: "positional", args })) as T;
}

/** Shape of the `state` arg `_beginSubmit` mutates while the async
 *  onSubmit settles. Defined locally because the Agency `ReplState`
 *  is record-typed and the bridge only cares about these two fields.
 *  The exit-on-`false`-return path uses the `_signalReplExit` bridge
 *  flag rather than mutating `state.done` here — see that function's
 *  comment for why. */
type SubmitTargetState = {
  submit?: {
    busy?: boolean;
    label?: string;
    startedAtMs?: number;
  };
  transcript: {
    messages: string[];
  };
};

// ---------------------------------------------------------------------------
// Console capture
//
// While a `repl()` is running it owns the alt-screen; any `console.log`
// / `console.error` / raw `process.stdout.write` from underlying code
// would otherwise be invisible. `_installConsoleCapture` overrides
// those sinks so the text is appended to the REPL transcript instead.
// The Agency-side `repl()` passes its `transcript.messages` array
// straight in — since records share by reference, pushing to that
// array is observable to the next render.
// ---------------------------------------------------------------------------

type ConsoleSinks = {
  log: typeof console.log;
  warn: typeof console.warn;
  error: typeof console.error;
  info: typeof console.info;
  debug: typeof console.debug;
};

// `savedConsoleSinks` is process-wide because `console.*` itself is a
// process-wide singleton — we can only save/restore the originals
// once. The actual capture *target* (the transcript array we push
// rows into) lives in the per-context `UiContextState` so concurrent
// REPLs each write into their own transcript. The installed
// overrides route to `getUiState().captureTarget`, so dispatch
// follows the active ALS frame automatically.
//
// Install / uninstall is reference-counted because multiple concurrent
// contexts may each call `repl()` (and therefore _installConsoleCapture)
// on the same process. Without a refcount, the first uninstall would
// restore `console.*` to its originals and any still-active context
// would silently lose its capture (the overrides are gone but its
// `captureTarget` is still set). The counter is process-wide for the
// same reason `savedConsoleSinks` is.
let savedConsoleSinks: ConsoleSinks | null = null;
let captureInstallCount = 0;

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) =>
      typeof arg === "string"
        ? arg
        : arg instanceof Error
          ? arg.stack ?? arg.message
          : (() => {
              try {
                return JSON.stringify(arg);
              } catch {
                return String(arg);
              }
            })(),
    )
    .join(" ");
}

/**
 * Cap a captured `warn` / `error` payload at a small number of lines.
 * The runtime's catch-and-convert path logs the underlying exception's
 * full stack as a second `__log.error(...)` call, which is great for
 * headless debugging but a wall of red lines inside a TUI. Two visible
 * lines keep the message and one stack frame; everything past that
 * collapses to an ellipsis placeholder the user can ignore. Plain
 * `log` / `info` / `debug` capture is left alone — those are caller-
 * authored output that's meant to be shown in full.
 */
const TUI_LOG_MAX_LINES = 5;
export function truncateForTui(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= TUI_LOG_MAX_LINES) return text;
  const omitted = lines.length - TUI_LOG_MAX_LINES;
  return (
    lines.slice(0, TUI_LOG_MAX_LINES).join("\n") +
    `\n{gray-fg}… ${omitted} more line${omitted === 1 ? "" : "s"} omitted{/gray-fg}`
  );
}

function pushCaptured(prefix: string, text: string): void {
  const target = getUiState().captureTarget;
  if (!target) return;
  // Split on newlines so multi-line writes become one transcript row
  // per line. Trailing empty strings from a final `\n` are dropped so
  // we don't render blank rows.
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return;
  for (const line of lines) {
    target.push(prefix ? `${prefix} ${line}` : line);
  }
  // Kick the event loop so the captured line shows up immediately
  // instead of after the next keypress (REPL defaults to no tickMs).
  _triggerRender();
}

export function _installConsoleCapture(messages: string[]): void {
  // The capture target is per-context — set it whether or not we're
  // the first installer. (Re-install in a nested REPL inside the same
  // ALS frame is a no-op; a nested REPL in a *different* ALS frame
  // gets its own slot.) The console overrides themselves are a
  // process singleton, installed once and routed to whichever
  // context is currently active.
  getUiState().captureTarget = messages;
  captureInstallCount += 1;
  if (savedConsoleSinks) return;
  savedConsoleSinks = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };

  console.log = (...args: unknown[]) =>
    pushCaptured("", formatConsoleArgs(args));
  console.info = (...args: unknown[]) =>
    pushCaptured("", formatConsoleArgs(args));
  console.debug = (...args: unknown[]) =>
    pushCaptured("", formatConsoleArgs(args));
  console.warn = (...args: unknown[]) =>
    pushCaptured("{yellow-fg}warn{/yellow-fg}", truncateForTui(formatConsoleArgs(args)));
  console.error = (...args: unknown[]) =>
    pushCaptured("{red-fg}error{/red-fg}", truncateForTui(formatConsoleArgs(args)));

  // Deliberately NOT overriding `process.stdout.write` / `process.stderr.write`.
  // An earlier revision did, but `lib/tui/output/terminal.ts`'s renderer
  // also writes ANSI frames through `process.stdout.write` — capturing
  // those would swallow rendering output and spam ANSI escapes into the
  // transcript. The stdlib's own `print()` already routes through
  // `console.log`, so all Agency-side output still gets captured. Raw
  // `process.stdout.write` callers (if any) will be silenced behind the
  // alt screen, which is the same behavior any TUI app gives them.
}

export function _uninstallConsoleCapture(): void {
  // Clear the per-context target first so a stale ALS frame can't keep
  // routing captured writes into a buffer the caller has dropped.
  getUiState().captureTarget = null;
  if (captureInstallCount > 0) captureInstallCount -= 1;
  // Keep the overrides installed while any other context is still
  // capturing. Restoring the originals here would silently blank that
  // other context's transcript.
  if (captureInstallCount > 0) return;
  if (!savedConsoleSinks) return;
  console.log = savedConsoleSinks.log;
  console.warn = savedConsoleSinks.warn;
  console.error = savedConsoleSinks.error;
  console.info = savedConsoleSinks.info;
  console.debug = savedConsoleSinks.debug;
  savedConsoleSinks = null;
}

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

// Per-context "exit signaled" flag for `repl()`. `_beginSubmit`
// flips this when `onSubmit` returns `false`; the Agency
// `_replIsDone` reads it via `_peekReplExitSignal()`. We cannot
// mutate `state.done = true` directly because `done` is a primitive
// boolean — `{...state, ...}` in subsequent reducer calls copies it
// at the time of spread, so a later mutation on the stale record is
// invisible to the current loop state. Lives on `UiContextState` so
// concurrent REPLs in different ALS frames don't trip each other's
// exit flag.

/** Signal that the active `repl()` should exit on its next isDone
 *  check. Called from `_beginSubmit` when `onSubmit` returns `false`,
 *  and from any future "force exit" plumbing. Wakes the loop so
 *  `_replIsDone` runs immediately. */
export function _signalReplExit(): void {
  getUiState().replExitSignaled = true;
  _triggerRender();
}

/** Read the exit signal without clearing it. The Agency `_replIsDone`
 *  calls this on every tick; once true the loop terminates and the
 *  flag is reset by `_runReplLoop` in its finally block so the next
 *  REPL invocation starts fresh. */
export function _peekReplExitSignal(): boolean {
  return getUiState().replExitSignaled;
}

/** Reset the exit signal. Called by `_runReplLoop` before and after
 *  the loop runs, so a leftover signal from a prior REPL session
 *  doesn't cause the next one to exit on first frame. */
export function _resetReplExitSignal(): void {
  getUiState().replExitSignaled = false;
}

export function _beginSubmit(
  state: SubmitTargetState,
  submitted: string,
  onSubmit: unknown,
): void {
  state.transcript.messages.push(`{bright-blue-fg}You{/bright-blue-fg} ${submitted}`);
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
          // Signal exit via the bridge instead of mutating
          // `state.done`. The reducer can't see mutations on this
          // stale `state` record once subsequent keys have produced
          // new states (e.g. a modal that opened and closed during
          // onSubmit). See `_signalReplExit` comment above.
          _signalReplExit();
          return;
        }
        // Surface Failure-typed returns explicitly. Agency functions
        // catch JS exceptions in `safe` mode and return a Failure
        // value instead of throwing; without this branch the failure
        // would fall through the `typeof === "string"` guard and
        // silently disappear behind the alt screen — exactly the
        // class of bug that hid the early `spec.tools` spread error.
        if (isFailure(reply)) {
          const err = (reply as any).error;
          const message =
            err instanceof Error
              ? err.message
              : typeof err === "string"
                ? err
                : (() => {
                    try {
                      return JSON.stringify(err);
                    } catch {
                      return String(err);
                    }
                  })();
          state.transcript.messages.push(`{red-fg}Error{/red-fg} ${message}`);
          return;
        }
        if (typeof reply === "string" && reply.length > 0) {
          state.transcript.messages.push(reply);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        state.transcript.messages.push(`{red-fg}Error{/red-fg} ${message}`);
      } finally {
        if (state.submit) {
          state.submit.busy = false;
          state.submit.label = "";
        }
        // Repaint so the reply / cleared spinner / cleared busy flag
        // are visible immediately. The REPL defaults to no tickMs to
        // avoid the per-render checkpoint leak; without this kick the
        // user would have to press a key to see the response.
        _triggerRender();
      }
    })();
  }, 0);
}

export async function _runLoop(
  initialState: any,
  renderFn: unknown,
  handleKeyFn: unknown,
  isDoneFn: unknown,
  tickMs?: number | null,
): Promise<any> {
  // Coerce `null` / `0` / negative to undefined so Screen.runLoop's
  // `if (opts.tickMs !== undefined)` guard treats them as "no tick".
  // The Agency wrapper passes a default of `null` to mean "off" — JS
  // `null !== undefined` is true, which would otherwise enter the
  // tick branch and call `setTimeout(..., null)` (effectively 0ms,
  // a tight loop). See runLoop default in stdlib/ui.agency.
  const effectiveTickMs =
    tickMs !== undefined && tickMs !== null && tickMs > 0 ? tickMs : undefined;
  const screen = makeBridgeScreen();
  bridgeActiveScreen = screen;
  try {
    return await screen.runLoop({
      initialState,
      render: async (s) => await callBridgeFn<TuiElement>(renderFn, s),
      handleKey: async (s, ev) => await callBridgeFn(handleKeyFn, s, ev),
      isDone: async (s) => await callBridgeFn<boolean>(isDoneFn, s),
      tickMs: effectiveTickMs,
    });
  } finally {
    bridgeActiveScreen = null;
    screen.destroy();
  }
}

/**
 * REPL-only wrapper around `_runLoop` that guarantees the
 * console-capture install is reversed even if the loop (or any
 * Agency callback it invokes) throws. Agency has no `finally`, so
 * the cleanup pair `_installConsoleCapture` / `_uninstallConsoleCapture`
 * has to live on the TS side of the bridge to keep stdout / console
 * from staying monkeypatched after a failed REPL.
 *
 * `transcriptMessages` is the same array `repl()` renders from; we
 * pass it through to `_installConsoleCapture` so console / print
 * output appends to the live transcript.
 */
export async function _runReplLoop(
  initialState: any,
  renderFn: unknown,
  handleKeyFn: unknown,
  isDoneFn: unknown,
  tickMs: number | null | undefined,
  transcriptMessages: string[],
): Promise<any> {
  // Reset the exit signal so a leftover flag from a previous REPL
  // doesn't immediately terminate this one.
  _resetReplExitSignal();
  _installConsoleCapture(transcriptMessages);
  try {
    return await _runLoop(initialState, renderFn, handleKeyFn, isDoneFn, tickMs);
  } finally {
    _uninstallConsoleCapture();
    // Clear the exit signal so it can't leak across REPL invocations
    // in the same process (e.g. nested test runs).
    _resetReplExitSignal();
    // Cancel any choice prompt left dangling by an exception path so
    // the awaiting Agency caller sees a rejection instead of a hang.
    // No-op when no prompt is open.
    _cancelChoice("REPL loop exited before choice was made");
  }
}

/** Single-shot render of an element tree. Useful for non-interactive
 *  output or for tests that want to inspect a rendered frame
 *  without entering a loop. */
export function _renderOnce(element: any): void {
  const screen = makeBridgeScreen();
  screen.render(element as TuiElement);
}

/** Read one key from the active screen's input source if a loop is
 *  running, else construct a one-off screen for the read. Blocks
 *  until a key arrives. */
export async function _readKey(): Promise<TuiKeyEvent> {
  const screen = bridgeActiveScreen ?? makeBridgeScreen();
  return screen.nextKey();
}

/**
 * `OutputTarget` for `repl()`'s hybrid rendering. Renders each frame
 * directly inside the terminal's reserved bottom region:
 * `withBottomCursor` saves the cursor, positions it at the start of
 * the bottom region, writes the frame ANSI (no `CURSOR_HOME` prefix,
 * no alt-screen entry — both would defeat the hybrid scrollback
 * goal), and restores the cursor so subsequent plain stdout writes
 * still scroll inside the top region.
 *
 * Does NOT wrap an inner OutputTarget. The bridge's default
 * `TerminalOutput` enters the alt-screen and prepends `CURSOR_HOME`
 * to every write, which is exactly what hybrid mode must avoid; this
 * target sidesteps both by talking to `process.stdout` itself via
 * `toANSI`. `destroy()` is a no-op: this target owns no resources
 * (the scroll region itself is torn down by `_resetScrollRegion`).
 */
export class BottomRegionOutputTarget implements OutputTarget {
  write(frame: Frame, _label?: string): void {
    withBottomCursor(() => {
      process.stdout.write(toANSI(frame));
    });
  }

  destroy(): void {
    // No-op: nothing owned. Region teardown is handled by
    // `_resetScrollRegion` in the Agency-side `repl()` finally block.
  }
}

/**
 * Append a raw text line to the scroll region. Plain
 * `process.stdout.write` — no ANSI; the scroll region installed by
 * `installRegion` in `./ui-region.ts` does the scrolling. Used by
 * `repl()` to stream `output()` lines into the terminal's native
 * scrollback as new tail elements appear.
 */
export function _writeScrollLine(text: string): void {
  process.stdout.write(text + "\n");
}

// ---------------------------------------------------------------------------
// Line-mode prompt bridges (backed by the `prompts` package).
// Used by chooseOption's line-mode branch and exposed as Agency
// primitives (select / autocomplete / prompt / confirm — note the
// Agency wrapper renames `_promptsText` to `prompt` to avoid colliding
// with the Layer 1 `text` element builder). Each raises if invoked
// while a `repl()` owns the screen, or when stdout is not a TTY —
// there is no non-TTY fallback by design.
// ---------------------------------------------------------------------------

type PromptsChoiceItem = { key: string; label: string };

function _assertLineModeAvailable(name: string): void {
  if (_hasActiveScreen()) {
    throw new Error(
      `${name} cannot be used inside an active repl(); use chooseOption for in-TUI prompts`,
    );
  }
  if (!process.stdout.isTTY) {
    throw new Error(`${name} requires a TTY (stdout is not a TTY)`);
  }
}

// `__FREETEXT__:` is `_promptsAutocomplete`'s private wire format for
// smuggling user-typed free-text values out of the autocomplete UI.
// `_promptsSelect` uses a different mechanism (sentinel value +
// follow-up text prompt) since `prompts.select` has no `suggest` hook.
const AUTOCOMPLETE_FREE_TEXT_PREFIX = "__FREETEXT__:";

// Shared cancellation+Result wrapper for every `prompts(...)` call.
// All four bridges call this; the only differences between them are
// the question they build and the post-processing they apply to the
// successful value.
//
// Three side-effects beyond just calling prompts:
//
//   1. `onCancel` returns `false` to suppress prompts' default
//      `process.exit(0)` on Ctrl+C, so we can return a Result.failure
//      instead. (Callers loop on cancel to preserve `chooseOption`'s
//      must-answer contract.)
//
//   2. `onState` on the question detects Escape on `autocomplete` /
//      `select`. Those prompts treat Escape as "exit" — the promise
//      resolves with the currently-highlighted value rather than
//      firing onCancel. Without this hook, pressing Escape in the
//      slash palette or interrupt menu silently submits whatever's
//      under the cursor (see prompts/lib/elements/autocomplete.js
//      `exit()` and util/action.js `key.name === 'escape'` → 'exit').
//      `state.exited === true && state.aborted === false` ⇒ Escape;
//      flip our local `cancelled` flag so the resolve path below
//      returns `failure("cancelled")`.
//
//   3. Before opening the prompt, we call `globalThis.__agencyStopSpinner`
//      if the line-mode REPL (`lib/stdlib/cli.ts`) has registered one.
//      This pauses the "Thinking" timer while the user is being asked
//      something — otherwise the timer keeps ticking over an open
//      policy interrupt menu. No-op outside line-mode REPL.
//
//   4. We attach a stdin `data` listener that detects the Ctrl+C byte
//      (`0x03`) and calls `process.exit(130)` immediately after the
//      prompt resolves. Without this, `prompts` swallows Ctrl+C as an
//      abort and our caller's retry loop reprompts forever, leaving
//      the user with no way to quit. 130 = 128 + SIGINT, the standard
//      shell convention for "killed by Ctrl+C".
async function _runPrompt(question: prompts.PromptObject): Promise<any> {
  const stopSpinner = (globalThis as any).__agencyStopSpinner;
  if (typeof stopSpinner === "function") {
    stopSpinner();
  }

  let cancelled = false;
  let ctrlC = false;
  const onStdinData = (chunk: Buffer): void => {
    // 0x03 = Ctrl+C. Any chunk containing it counts (pastes can't
    // legitimately include 0x03 in raw mode, so this is unambiguous).
    if (chunk && chunk.includes(0x03)) ctrlC = true;
  };
  process.stdin.on("data", onStdinData);

  // `prompts` creates its own readline interface on `process.stdin`
  // and calls `rl.close()` when the prompt resolves. Node's
  // `readline.Interface.close()` calls `input.pause()`, which pauses
  // *the shared* `process.stdin` — silently killing the outer
  // readline interface in `_runLineRepl` (its `rl.question()` will
  // never fire another keypress, the await hangs, Node sees an empty
  // event loop, and the agent exits with code 13 / "unsettled
  // top-level await"). Snapshot the paused state on entry and
  // restore it on exit so we don't leave the outer REPL dead.
  // (If stdin was already paused — e.g. running standalone with no
  // REPL — we leave it paused so the process can still exit cleanly.)
  const wasPaused = process.stdin.isPaused();

  // `prompts` leaves `process.stdin` in cooked (canonical) mode when it
  // closes its readline. The line-mode REPL runs in raw mode and renders
  // input itself, so a cooked stdin makes the terminal ALSO echo every
  // line — the user sees their next prompt printed twice, and it persists
  // because nothing re-asserts raw afterward. Snapshot the raw state on
  // entry and restore it on exit (mirrors `wasPaused` above) so the modal
  // leaves the terminal exactly as it found it.
  const wasRaw = !!(process.stdin.isTTY && process.stdin.isRaw);

  // Wrap any caller-supplied `onState` so we always get a shot at
  // detecting Escape, without clobbering custom state hooks.
  const userOnState = (question as any).onState;
  (question as any).onState = (state: {
    value: unknown;
    aborted: boolean;
    exited: boolean;
  }) => {
    // `exited` = Escape; `aborted` = Ctrl+C / Ctrl+D. Either way the
    // user said "back out", so don't return the currently-highlighted
    // choice.
    if (state.exited || state.aborted) cancelled = true;
    if (typeof userOnState === "function") userOnState(state);
  };

  try {
    const answer = await prompts(question, {
      onCancel: () => {
        cancelled = true;
        // Returning false here keeps `prompts` from exiting the
        // process so we can surface failure("cancelled") to the
        // caller's retry loop.
        return false;
      },
    });

    if (ctrlC) {
      // Ctrl+C escapes the entire prompt session. Drop straight out
      // of the process — even if the surrounding agency code has a
      // retry loop, the user has signalled "quit, not retry."
      process.exit(130);
    }

    // Cancellation paths:
    //  - `cancelled` flag set by onState (Escape) or onCancel (Ctrl+C/D).
    //  - Missing/null value (defensive — covers `prompts.inject([null])`
    //    and any future edge case where the prompt resolves with no
    //    answer).
    if (cancelled || !("value" in answer) || answer.value == null) {
      return failure("cancelled");
    }
    return success(answer.value);
  } finally {
    process.stdin.off("data", onStdinData);
    if (!wasPaused && process.stdin.isPaused()) {
      process.stdin.resume();
    }
    // Restore the raw-mode state `prompts` clobbered (see `wasRaw` above).
    if (
      process.stdin.isTTY &&
      typeof process.stdin.setRawMode === "function" &&
      process.stdin.isRaw !== wasRaw
    ) {
      process.stdin.setRawMode(wasRaw);
    }
  }
}

// Exported for unit tests; do not call from production code.
export function __suggestForTest(
  input: string,
  items: PromptsChoiceItem[],
  allowFreeText: boolean,
): Promise<{ title: string; value: string }[]> {
  return _buildSuggest(items, allowFreeText)(input, []);
}

function _buildSuggest(
  items: PromptsChoiceItem[],
  allowFreeText: boolean,
): (input: string, choices: any[]) => Promise<{ title: string; value: string }[]> {
  return async (input: string, _choices: any[]) => {
    const q = (input ?? "").toLowerCase();
    // Match against `key` only (substring, case-insensitive), not
    // against `label`. Policy interrupt labels routinely contain "r"
    // (in "approve" and "reject") and "a" (in "always"), so a label
    // substring match would never narrow anything — typing `r` would
    // still show every row. Key-only matching produces the expected
    // behavior: `r` shows just the `r` row, `ap` narrows to `ap` /
    // `approve`-prefixed keys, etc. Users still see the label in the
    // rendered title, so they're not flying blind.
    const matched = items
      .filter((it) => it.key.toLowerCase().includes(q))
      .map((it) => ({ title: `${color.cyan(it.key)} - ${it.label}`, value: it.key }));
    if (allowFreeText && input !== "" && matched.length === 0) {
      matched.push({
        title: `→ use as reason: "${input}"`,
        value: `${AUTOCOMPLETE_FREE_TEXT_PREFIX}${input}`,
      });
    }
    return matched;
  };
}

export async function _promptsAutocomplete(
  message: string,
  items: PromptsChoiceItem[],
  allowFreeText: boolean,
  hint: string = "",
  cancelOnEscape: boolean = false,
): Promise<any> {
  _assertLineModeAvailable("autocomplete");
  const result = await _runPrompt({
    type: "autocomplete",
    name: "value",
    message,
    hint: hint || undefined,
    choices: items.map((it) => ({ title: `${color.cyan(it.key)} - ${it.label}`, value: it.key })),
    suggest: _buildSuggest(items, allowFreeText),
  });
  if (isFailure(result)) {
    // When the caller opts in (e.g. a policy approval menu), Escape means
    // "cancel the whole request" rather than "re-prompt". Escalate the
    // cancellation to AgencyCancelledError: __tryCall and the generated
    // function catches both re-throw it, so it unwinds to the REPL exactly
    // like an Esc during the thinking phase. (Ctrl+C still exits the
    // process inside _runPrompt before we get here.)
    if (cancelOnEscape) {
      throw new AgencyCancelledError("cancelled by user");
    }
    return result;
  }

  const raw = String(result.value);
  if (raw.startsWith(AUTOCOMPLETE_FREE_TEXT_PREFIX)) {
    return success(raw.slice(AUTOCOMPLETE_FREE_TEXT_PREFIX.length));
  }
  return success(raw);
}

// `_promptsSelect`'s free-text mechanism is intentionally different
// from `_promptsAutocomplete`'s: `prompts.select` has no `suggest`
// hook to inject a synthetic row's *value*, so we append a marker
// row and then run a follow-up `prompts.text` call when the user
// picks it. The two helpers (`SELECT_FREE_TEXT_SENTINEL` and
// `AUTOCOMPLETE_FREE_TEXT_PREFIX`) are deliberately named differently
// to make the divergence obvious in greps.
const SELECT_FREE_TEXT_SENTINEL = "__FREETEXT__";

export async function _promptsSelect(
  message: string,
  items: PromptsChoiceItem[],
  allowFreeText: boolean,
  hint: string = "",
): Promise<any> {
  _assertLineModeAvailable("select");
  const choices = items.map((it) => ({
    title: `${it.key}  ${it.label}`,
    value: it.key,
  }));
  if (allowFreeText) {
    choices.push({ title: "→ enter free text…", value: SELECT_FREE_TEXT_SENTINEL });
  }
  const result = await _runPrompt({
    type: "select",
    name: "value",
    message,
    hint: hint || undefined,
    choices,
  });
  if (isFailure(result)) return result;
  if (result.value === SELECT_FREE_TEXT_SENTINEL) {
    // Already Result-shaped; cancel of the follow-up cancels the whole pick.
    return _promptsText("free text:", "");
  }
  return success(String(result.value));
}

// Backs the Agency-side `prompt(...)` primitive (renamed from `text`
// to avoid colliding with the Layer 1 `text` element builder; see the
// banner comment above this section).
//
// `validate` is forwarded straight to `prompts`. Per the prompts
// docs: return `true` for valid; return a string to reject and show
// the string as the error message. The PFA story: a user binds
// `validate` via `.partial(validate: myValidator)` before handing
// `prompt` to an LLM as a tool, and the LLM cannot override it.
export async function _promptsText(
  message: string,
  initial: string,
  hint: string = "",
  validate: ((value: string) => boolean | string) | null = null,
): Promise<any> {
  // "prompt" (the user-facing Agency primitive) rather than "text"
  // (the internal `_promptsText` name) so thrown error messages
  // match what the user typed: `prompt requires a TTY ...`.
  _assertLineModeAvailable("prompt");
  const result = await _runPrompt({
    type: "text",
    name: "value",
    message,
    initial: initial || undefined,
    hint: hint || undefined,
    validate: validate ?? undefined,
  });
  if (isFailure(result)) return result;
  return success(String(result.value));
}

export async function _promptsConfirm(
  message: string,
  initial: boolean,
): Promise<any> {
  _assertLineModeAvailable("confirm");
  const result = await _runPrompt({
    type: "toggle",
    name: "value",
    message,
    initial,
    active: "yes",
    inactive: "no",
  });
  if (isFailure(result)) return result;
  return success(Boolean(result.value));
}

// ---------------------------------------------------------------------------
// Choice prompts (modal-style overlay inside an active `repl()`)
//
// `_openChoicePrompt` mutates the live REPL state record so the
// renderer paints the modal on the next frame, then returns a Promise
// that resolves when the Agency-side reducer calls back via
// `_resolveChoice` (Enter pressed) or rejects via `_cancelChoice`
// (Escape pressed / loop torn down). This sidesteps every problem the
// old raw-stdout version had: keys come through `Screen.runLoop` (no
// race with the REPL's `nextKey()` waiter), and we never write outside
// the alt-screen.
//
// The slot lives on the per-context `UiContextState` (see top of
// file). At most one prompt is open per context at a time;
// concurrent REPLs in different ALS frames each get their own slot.
// ---------------------------------------------------------------------------

/**
 * Open a modal choice prompt over the currently-running REPL. Stores
 * the request in the active context's UI-state slot that the Agency
 * reducer reads via `_peekPendingChoiceRequest()` on every tick (so a
 * fresh frame sees the modal even though reducers return new state
 * records), then returns a Promise that the Agency reducer resolves
 * via `_resolveChoice(answer)` (Enter) or rejects via `_cancelChoice`
 * (Escape, or REPL torn down).
 *
 * Rejects if another prompt is already open in this context — the
 * caller should serialize.
 */
export function _openChoicePrompt(request: ChoiceRequest): Promise<string> {
  const ui = getUiState();
  if (ui.pendingChoice) {
    return Promise.reject(
      new Error(
        "_openChoicePrompt: a choice prompt is already open; serialize callers",
      ),
    );
  }
  ui.pendingChoiceRequest = {
    title: request.title,
    body: request.body,
    items: request.items,
    allowFreeText: request.allowFreeText === true,
  };
  return new Promise<string>((resolve, reject) => {
    ui.pendingChoice = { resolve, reject };
    // Wake the loop so the modal paints immediately rather than
    // waiting for the next user keypress. The reducer's TS-sync step
    // runs on this synthetic key event and initializes state.choice.
    _triggerRender();
  });
}

/**
 * Read the pending choice request without consuming it. Returns
 * `null` when no prompt is open. The Agency reducer calls this on
 * every keystroke to sync `state.choice` with the TS-side request:
 * if TS has a request but state.choice is null, the reducer
 * initializes it; if TS has no request but state.choice is set,
 * the reducer clears it.
 */
export function _peekPendingChoiceRequest(): ChoiceRequest | null {
  return getUiState().pendingChoiceRequest;
}

/** Resolve the pending choice promise with `answer` and clear both
 *  the promise slot and the request slot. Called by the Agency
 *  reducer when Enter is pressed on a filtered, non-empty list.
 *  No-op when no prompt is open. */
export function _resolveChoice(answer: string): void {
  const ui = getUiState();
  if (!ui.pendingChoice) return;
  const { resolve } = ui.pendingChoice;
  ui.pendingChoice = null;
  ui.pendingChoiceRequest = null;
  resolve(answer);
}

/** Reject the pending choice promise with `reason` and clear both
 *  the promise slot and the request slot. Called by the Agency
 *  reducer on Escape, or by `_runReplLoop` in its finally block to
 *  break out of any prompt left hanging by an exception. No-op when
 *  no prompt is open. */
export function _cancelChoice(reason: string): void {
  const ui = getUiState();
  if (!ui.pendingChoice) return;
  const { reject } = ui.pendingChoice;
  ui.pendingChoice = null;
  ui.pendingChoiceRequest = null;
  reject(new Error(reason || "choice prompt cancelled"));
}

/** Test/debug hook. Returns true while a choice prompt is awaiting a
 *  reducer callback. */
export function _hasPendingChoice(): boolean {
  return getUiState().pendingChoice !== null;
}

// ---------------------------------------------------------------------------
// Hybrid mode — bridge primitives for `repl()`.
//
// `repl()` installs a terminal scroll region so the top of the screen
// keeps native scrollback + mouse-select + copy/paste, and only the
// bottom N rows are owned by the bounded TUI. The Agency-side widget
// composes these primitives into a lifecycle that survives exceptions.
// ---------------------------------------------------------------------------

/** Install a `bottomRows`-row reserved region at the bottom of the
 *  terminal. The top `H - bottomRows` rows scroll natively. No-op on
 *  non-TTY. Idempotent — call again to resize the region. */
export function _installScrollRegion(bottomRows: number): void {
  installRegion(bottomRows);
}

/** Tear down the reserved region. Restores the default scroll region
 *  (the whole terminal) and prints a trailing newline so the next
 *  shell prompt lands below the bottom region. */
export function _resetScrollRegion(): void {
  resetRegion();
}

/** Hybrid-mode variant of `_runLoop`. Drives the `repl()` widget's
 *  bounded `Screen` (bottom `bottomRows` rows only); frames render
 *  into the terminal's reserved bottom region while plain stdout
 *  writes keep scrolling in the top region. The scroll region itself
 *  is installed by `repl()` via `_installScrollRegion` before this
 *  call and torn down via `_resetScrollRegion` afterwards (including
 *  on exception paths via the Agency `handle` block).
 *
 *  Output target selection:
 *  - **Test mode** (`bridgeOutputTarget` is a `FrameRecorder`,
 *    injected by `_setOutputTarget`): frames go straight into the
 *    recorder so tests can inspect them.
 *  - **Real terminal mode**: a fresh `BottomRegionOutputTarget`
 *    writes ANSI to stdout via `withBottomCursor`, bypassing the
 *    default `TerminalOutput` (which would enter the alt screen and
 *    prepend `CURSOR_HOME` — both fatal to hybrid scrollback).
 */
export async function _runLoopHybrid(
  initialState: any,
  renderFn: unknown,
  handleKeyFn: unknown,
  isDoneFn: unknown,
  tickMs: number,
  bottomRows: number,
): Promise<any> {
  ensureBridgeState();
  const hybridOutput: OutputTarget =
    bridgeOutputTarget instanceof FrameRecorder
      ? bridgeOutputTarget
      : new BottomRegionOutputTarget();
  const hybridScreen = new Screen({
    input: bridgeInputSource!,
    output: hybridOutput,
    width: bridgeWidth,
    height: bottomRows,
  });
  bridgeActiveScreen = hybridScreen;
  try {
    return await hybridScreen.runLoop({
      initialState,
      render: async (s) => await callBridgeFn<TuiElement>(renderFn, s),
      handleKey: async (s, ev) => await callBridgeFn(handleKeyFn, s, ev),
      isDone: async (s) => await callBridgeFn<boolean>(isDoneFn, s),
      tickMs,
    });
  } finally {
    bridgeActiveScreen = null;
    // Deliberately NOT calling `Screen.destroy` or any
    // `bridgeOutputTarget.destroy`: the bridge's input/output must
    // survive across loop entries so multi-turn REPL sessions and
    // test harnesses can re-enter `_runLoop` / `_runLoopHybrid`
    // without re-initializing terminal state. `BottomRegionOutputTarget`
    // owns no resources; the scroll region is torn down by
    // `_resetScrollRegion` in the Agency-side `repl()`.
  }
}
