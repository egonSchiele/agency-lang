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
import { isFailure } from "../runtime/result.js";

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


let bridgeInputSource: InputSource | null = null;
let bridgeOutputTarget: OutputTarget | null = null;
let bridgeWidth = 80;
let bridgeHeight = 24;
let bridgeActiveScreen: Screen | null = null;

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

/** Test/runtime injection point for the input source used by the
 *  declarative bridge. */
export function _setInputSource(src: InputSource | null): void {
  bridgeInputSource = src;
}

/** Test/runtime injection point for the output target. */
export function _setOutputTarget(out: OutputTarget | null): void {
  bridgeOutputTarget = out;
}

export function _recordedFrameTexts(): string[] {
  if (!(bridgeOutputTarget instanceof FrameRecorder)) {
    return [];
  }
  const recorder = bridgeOutputTarget;
  return recorder.frames.map((_entry, index) => recorder.textAt(index));
}

/** Test/runtime injection point for the viewport size. */
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
 *  is record-typed and the bridge only cares about these three
 *  fields. */
type SubmitTargetState = {
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

let captureTarget: string[] | null = null;
let savedConsoleSinks: ConsoleSinks | null = null;

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

function pushCaptured(prefix: string, text: string): void {
  if (!captureTarget) return;
  // Split on newlines so multi-line writes become one transcript row
  // per line. Trailing empty strings from a final `\n` are dropped so
  // we don't render blank rows.
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return;
  for (const line of lines) {
    captureTarget.push(prefix ? `${prefix} ${line}` : line);
  }
  // Kick the event loop so the captured line shows up immediately
  // instead of after the next keypress (REPL defaults to no tickMs).
  _triggerRender();
}

export function _installConsoleCapture(messages: string[]): void {
  if (savedConsoleSinks) return; // idempotent: nested installs leave the outer one in place
  captureTarget = messages;
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
    pushCaptured("{yellow warn}", formatConsoleArgs(args));
  console.error = (...args: unknown[]) =>
    pushCaptured("{red error}", formatConsoleArgs(args));

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
  if (!savedConsoleSinks) return;
  console.log = savedConsoleSinks.log;
  console.warn = savedConsoleSinks.warn;
  console.error = savedConsoleSinks.error;
  console.info = savedConsoleSinks.info;
  console.debug = savedConsoleSinks.debug;
  savedConsoleSinks = null;
  captureTarget = null;
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

export function _beginSubmit(
  state: SubmitTargetState,
  submitted: string,
  onSubmit: unknown,
): void {
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
          // Wake the loop so isDone() runs and it exits — otherwise
          // the user sees a hung REPL after `/exit`.
          _triggerRender();
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
          state.transcript.messages.push(`{red Error} ${message}`);
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
  _installConsoleCapture(transcriptMessages);
  try {
    return await _runLoop(initialState, renderFn, handleKeyFn, isDoneFn, tickMs);
  } finally {
    _uninstallConsoleCapture();
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

/**
 * Prompt the user for one of `choices` while a REPL owns the screen.
 * Writes `text` (multi-line) to the scroll region, then reads keys
 * from the active screen's input source — accumulating printable
 * characters into a buffer that's committed on Enter. Loops until
 * the typed answer is one of `choices`. Backspace edits the buffer.
 *
 * Caller must verify `_hasActiveScreen()` first; this throws if no
 * REPL is active because the fallback path (raw stdin) lives in the
 * Agency-side wrapper `_routePrompt`.
 *
 * NB: when the REPL is running with `tickMs`, its `runLoop` may have
 * a leaked `nextKey()` promise registered from the most recent tick.
 * Since this function is called synchronously from inside `onSubmit`
 * (between `nextKey` awaits), the leaked waiter only matters if a
 * key is typed *while* a tick was racing, in which case that key
 * may be claimed by the loop instead of the prompt. Acceptable for
 * v1; production use should pause the loop while prompting.
 */
export async function _promptFromChoices(
  text: string,
  choices: string[],
): Promise<string> {
  const screen = bridgeActiveScreen;
  if (!screen) {
    throw new Error(
      "_promptFromChoices: no active screen — callers must guard with _hasActiveScreen()",
    );
  }
  for (const ln of text.split("\n")) {
    process.stdout.write(ln + "\n");
  }
  while (true) {
    let buf = "";
    // Show what the user has typed so far on its own scroll-region line.
    process.stdout.write("> ");
    while (true) {
      const ev = await screen.nextKey();
      if (ev.key === "enter") break;
      if (ev.key === "backspace") {
        buf = buf.slice(0, -1);
        continue;
      }
      if (ev.key.length === 1) {
        buf += ev.key;
      }
    }
    process.stdout.write(buf + "\n");
    const answer = buf.trim();
    if (choices.includes(answer)) return answer;
    process.stdout.write(`(one of ${choices.join("/")})\n`);
  }
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
