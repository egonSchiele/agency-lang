import process from "process";
import {
  Screen,
  TerminalInput,
  TerminalOutput,
  ScriptedInput,
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

// Test-mode injection points. Agency tests call `_setScriptedKeys` (and
// optionally `_setQuitAfterMs`) before entering a loop, and the next
// `makeBridgeScreen` call consumes them — installing a `ScriptedInput`
// seeded with the keys and a `FrameRecorder` output, then clearing the
// pending values so subsequent loops fall back to defaults.
let pendingScriptedKeys: TuiKeyEvent[] | null = null;
let pendingQuitAfterMs: number | null = null;

export function _setScriptedKeys(keys: TuiKeyEvent[]): void {
  pendingScriptedKeys = keys;
}

export function _setQuitAfterMs(ms: number): void {
  pendingQuitAfterMs = ms;
}

/** Consume any pending test-mode injection and fall back to real
 *  terminal I/O when production. Sets `bridgeInputSource`,
 *  `bridgeOutputTarget`, `bridgeWidth`, `bridgeHeight`. Shared by
 *  `makeBridgeScreen` and `_runLoopHybrid` so both paths see the
 *  same scripted-input behavior. */
function ensureBridgeState(): void {
  if (pendingScriptedKeys) {
    const scriptedInput = new ScriptedInput(pendingScriptedKeys);
    bridgeInputSource = scriptedInput;
    bridgeOutputTarget = new FrameRecorder();
    bridgeWidth = 80;
    bridgeHeight = 24;
    pendingScriptedKeys = null;

    // Optional: feed a `q` key after N ms to break out of a tickMs loop
    // that scripted keys alone wouldn't terminate. Tests for runLoop's
    // tick behavior set this so the loop ends without needing a
    // scripted-keys timeline that matches the tick cadence.
    if (pendingQuitAfterMs !== null) {
      const ms = pendingQuitAfterMs;
      setTimeout(() => scriptedInput.feedKey({ key: "q" }), ms);
      pendingQuitAfterMs = null;
    }
  }
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
 *    injected by `_setScriptedKeys` -> `ensureBridgeState`):
 *    frames go straight into the recorder so tests can inspect them.
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
