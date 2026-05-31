import * as readline from "readline";
import process from "process";
import { color } from "../utils/termcolors.js";
import { syntaxHighlight } from "./syntax.js";
import { __internal_input } from "./builtins.js";
import { AgencyCancelledError } from "../runtime/errors.js";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";
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

// Evaluated once at load time — the env var is set by the debugger CLI
// before any compiled agency code runs and never changes.
const isDebuggerMode = !!process.env.AGENCY_DEBUGGER;

/* CSI stands for Control Sequence Introducer — it's the escape sequence \x1B[ (ESC followed by [)
used in ANSI terminal control codes. It's the prefix for commands that control cursor position,
text color, clearing the screen, and other terminal formatting operations.
*/

const ESC = "\x1b";
const CSI = `${ESC}[`;

function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}

function clearLine(): string {
  return `${CSI}2K`;
}

// These let you move the cursor around to draw/update part of the screen,
// then jump back to where you were.
function saveCursor(): string {
  return `${CSI}s`;
}

function restoreCursor(): string {
  return `${CSI}u`;
}

function setScrollRegion(top: number, bottom: number): string {
  return `${CSI}${top};${bottom}r`;
}

function resetScrollRegion(): string {
  return `${CSI}r`;
}

export function _emptyLine(): void {
  if (isDebuggerMode) {
    console.log("");
    return;
  }
  if (!initialized) return;
  writeInScrollRegion("");
  renderFixedArea();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let initialized = false;
let cols = 80;
let rows = 24;

let appTitle = "";

// Status bar content
let statusLeft = "";
let statusRight = "";

// Input bar content
let inputContent = "";
let hintContent = "";

// Spinner
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerIdx = 0;

// Readline
let activeRl: readline.Interface | null = null;

// Event handlers (stored for cleanup)
let resizeHandler: (() => void) | null = null;
let exitHandler: (() => void) | null = null;
let sigintHandler: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Fixed area — the single place that defines the bottom of the screen
// ---------------------------------------------------------------------------

// The index (within the fixed lines array) where the input prompt lives.
// Set by buildFixedLines() so _prompt() can position the cursor correctly.
let inputLineIndex = 0;

// Returns an array of strings, one per line. The length of this array
// determines how many rows are reserved at the bottom. Change this function
// to add, remove, or restyle lines without touching anything else.
function buildFixedLines(): string[] {
  const lines: string[] = [];

  lines.push("");
  lines.push("");
  // prompt
  lines.push(color.dim("─".repeat(cols)));
  inputLineIndex = lines.length;
  lines.push(`${color.bold("❯")} ${inputContent}`);
  lines.push(color.dim("─".repeat(cols)));

  // status bar
  const left = truncate(
    statusLeft || hintContent,
    Math.floor(((cols - 4) * 2) / 3),
  );
  const right = truncate(statusRight, Math.floor((cols - 4) / 3));
  const padding = Math.max(0, cols - left.length - right.length - 2);
  lines.push(color.cyan(`${left} ${" ".repeat(padding)} ${right}`));
  lines.push("");

  return lines;
}

function fixedLineCount(): number {
  return buildFixedLines().length;
}

// The row where the fixed area starts (1-indexed)
function fixedAreaStart(): number {
  return rows - fixedLineCount() + 1;
}

// The last row of the scroll region (one above the fixed area)
function scrollBottom(): number {
  return fixedAreaStart() - 1;
}

// Renders the entire fixed area at the bottom of the screen.
// This is the ONLY function that writes to the fixed rows.
function renderFixedArea() {
  const lines = buildFixedLines();
  const startRow = fixedAreaStart();
  let out = saveCursor();
  for (let i = 0; i < lines.length; i++) {
    out += moveTo(startRow + i, 1) + clearLine() + lines[i];
  }
  out += restoreCursor();
  process.stdout.write(out);
}

function clearFixedArea() {
  const startRow = fixedAreaStart();
  const count = fixedLineCount();
  let out = saveCursor();
  for (let i = 0; i < count; i++) {
    out += moveTo(startRow + i, 1) + clearLine();
  }
  out += restoreCursor();
  process.stdout.write(out);
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

function updateSize() {
  cols = process.stdout.columns || 80;
  // Ensure at least enough rows for the fixed area plus one scroll line
  const minRows = fixedLineCount() + 1;
  rows = Math.max(process.stdout.rows || 24, minRows);
}

function truncate(str: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function applyScrollRegion() {
  process.stdout.write(setScrollRegion(1, scrollBottom()));
}

function writeInScrollRegion(text: string) {
  process.stdout.write(
    saveCursor() + moveTo(scrollBottom(), 1) + "\n" + text + restoreCursor(),
  );
}

function writeBox(
  filename: string,
  lines: string[],
  renderLine: (line: string, index: number) => string,
): void {
  writeInScrollRegion(
    color.dim(
      `┌─ ${filename} ${"─".repeat(Math.max(0, cols - filename.length - 6))}`,
    ),
  );
  for (let i = 0; i < lines.length; i++) {
    writeInScrollRegion(renderLine(lines[i], i));
  }
  writeInScrollRegion(color.dim(`└${"─".repeat(Math.max(0, cols - 2))}`));
  renderFixedArea();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function _initUI(title: string): void {
  if (isDebuggerMode) return;
  if (initialized) return;
  initialized = true;

  appTitle = title;
  statusLeft = "";
  statusRight = "";
  inputContent = "";
  hintContent = "";

  updateSize();
  applyScrollRegion();
  process.stdout.write(moveTo(1, 1));
  renderFixedArea();
  _separator(appTitle);

  resizeHandler = () => {
    updateSize();
    applyScrollRegion();
    renderFixedArea();
  };
  exitHandler = () => {
    if (initialized) _destroyUI();
  };
  sigintHandler = () => {
    if (initialized) _destroyUI();
    process.exit(0);
  };

  process.stdout.on("resize", resizeHandler);
  process.on("exit", exitHandler);
  process.on("SIGINT", sigintHandler);
}

export function _destroyUI(): void {
  if (isDebuggerMode) return;
  if (!initialized) return;
  initialized = false;

  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
  if (activeRl) {
    activeRl.close();
    activeRl = null;
  }
  if (resizeHandler) {
    process.stdout.removeListener("resize", resizeHandler);
    resizeHandler = null;
  }
  if (exitHandler) {
    process.removeListener("exit", exitHandler);
    exitHandler = null;
  }
  if (sigintHandler) {
    process.removeListener("SIGINT", sigintHandler);
    sigintHandler = null;
  }

  process.stdout.write(resetScrollRegion());
  clearFixedArea();
  process.stdout.write(moveTo(rows, 1) + "\n");

  statusLeft = "";
  statusRight = "";
  inputContent = "";
  hintContent = "";
}

// ---------------------------------------------------------------------------
// Public API — scrollable output
// ---------------------------------------------------------------------------

export function _log(message: string): void {
  if (isDebuggerMode) {
    console.log(message);
    return;
  }
  if (!initialized) return;
  writeInScrollRegion(message);
  renderFixedArea();
}

export function _chat(role: string, message: string): void {
  if (isDebuggerMode) {
    console.log(`${role}: ${message}`);
    return;
  }
  if (!initialized) return;
  const colorFn =
    role === "user"
      ? color.cyan.bold
      : role === "agent"
        ? color.white.bold
        : color.dim;
  const prefix = colorFn(role);
  const lines = message.split("\n");
  writeInScrollRegion(`${prefix}: ${lines[0]}`);
  for (let i = 1; i < lines.length; i++) {
    writeInScrollRegion(`  ${lines[i]}`);
  }
  renderFixedArea();
}

export function _code(filename: string, content: string): void {
  if (isDebuggerMode) {
    console.log(`[${filename}]\n${content}`);
    return;
  }
  if (!initialized) return;
  writeBox(filename, content.split("\n"), (line, i) => {
    const lineNum = String(i + 1).padStart(4, " ");
    return `${color.dim(`│${lineNum}`)} ${line}`;
  });
}

const languageMap: Record<string, string> = {
  agency: "typescript",
  ts: "typescript",
  js: "javascript",
  py: "python",
  java: "java",
  rb: "ruby",
  go: "go",
  rs: "rust",
};

export function _diff(filename: string, _content: string): void {
  if (isDebuggerMode) {
    console.log(`[${filename}]\n${_content}`);
    return;
  }
  if (!initialized) return;
  const ext = filename.split(".").slice(-1)[0];
  const language = languageMap[ext];
  let content = _content;
  if (language) {
    content = syntaxHighlight(content, language);
  }
  writeBox(filename, content.split("\n"), (line) => {
    if (line.startsWith("+")) {
      return color.bgGreen(`│ ${line}`);
    } else if (line.startsWith("-")) {
      return color.bgRed(`│ ${line}`);
    }
    return `│ ${line}`;
  });
}

export function _separator(label: string): void {
  if (isDebuggerMode) {
    console.log(label ? `── ${label} ──` : "────");
    return;
  }
  if (!initialized) return;
  if (label) {
    const padding = Math.max(0, cols - label.length - 4);
    writeInScrollRegion(color.dim(`── ${label} ${"─".repeat(padding)}`));
  } else {
    writeInScrollRegion(color.dim("─".repeat(cols)));
  }
  renderFixedArea();
}

// ---------------------------------------------------------------------------
// Public API — fixed area updates
// ---------------------------------------------------------------------------

export function _status(left: string, right: string): void {
  if (isDebuggerMode) return;
  if (!initialized) return;
  statusLeft = left;
  statusRight = right;
  renderFixedArea();
}

export function _startSpinner(text: string): void {
  if (isDebuggerMode) return;
  if (!initialized || spinnerInterval) return;
  spinnerIdx = 0;
  const update = () => {
    const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
    inputContent = `${color.cyan(frame)} ${text}`;
    renderFixedArea();
    spinnerIdx++;
  };
  update();
  spinnerInterval = setInterval(update, 80);
}

export function _stopSpinner(): void {
  if (isDebuggerMode) return;
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
  if (initialized) {
    inputContent = "";
    renderFixedArea();
  }
}

/**
 * Show the readline prompt and close it on abort. Without abort
 * handling, a blocked `prompt("?")` after Ctrl-C or a race-loser
 * abort would hold stdin until the user hits Enter. On abort we
 * close the active readline interface (releasing stdin), reset the
 * input/hint state, and reject with `AgencyCancelledError`.
 *
 * In debugger mode delegates to the builtin `_input` (which supports
 * the `__agencyInputOverride` hook and works inside handler bodies
 * where interrupts are forbidden).
 */
function promptImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  threads: ThreadStore,
  question: string,
): Promise<string> {
  if (isDebuggerMode) return __internal_input(ctx, stack, threads, question);
  if (!initialized) {
    return Promise.resolve("");
  }
  _stopSpinner();

  const signal = ctx.getAbortSignal(stack);
  if (signal.aborted) {
    return Promise.reject(new AgencyCancelledError("prompt cancelled"));
  }

  return new Promise<string>((resolve, reject) => {
    // Update hint, clear input, position cursor on the input row
    hintContent = question;
    inputContent = "";
    renderFixedArea();

    // Position cursor after the prompt character for typing
    process.stdout.write(moveTo(fixedAreaStart() + inputLineIndex, 4));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      prompt: "",
    });
    activeRl = rl;

    const onAbort = () => {
      try { rl.close(); } catch {}
      activeRl = null;
      inputContent = "";
      hintContent = "";
      if (initialized) renderFixedArea();
      reject(new AgencyCancelledError("prompt cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    rl.on("line", (answer: string) => {
      signal.removeEventListener("abort", onAbort);
      rl.close();
      activeRl = null;
      inputContent = "";
      hintContent = "";
      renderFixedArea();
      resolve(answer);
    });
  });
}

/** Deprecated context-injected wrapper kept during the ALS migration;
 *  see `_prompt`. */
export function __internal_prompt(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  threads: ThreadStore,
  question: string,
): Promise<string> {
  return promptImpl(ctx, stack, threads, question);
}

/** ALS-reading replacement for `__internal_prompt`. */
export function _prompt(question: string): Promise<string> {
  const { ctx, stack, threads } = getRuntimeContext();
  return promptImpl(ctx, stack, threads, question);
}

// ---------------------------------------------------------------------------
// New declarative bridge — exposes lib/tui/ to the rewritten std::ui in
// Agency. The old imperative API above is kept in place during the
// migration (PR #3 removes it).
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
  tickMs?: number,
): Promise<any> {
  const screen = makeBridgeScreen();
  bridgeActiveScreen = screen;
  try {
    return await screen.runLoop({
      initialState,
      render: async (s) => await callBridgeFn<TuiElement>(renderFn, s),
      handleKey: async (s, ev) => await callBridgeFn(handleKeyFn, s, ev),
      isDone: async (s) => await callBridgeFn<boolean>(isDoneFn, s),
      tickMs,
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
