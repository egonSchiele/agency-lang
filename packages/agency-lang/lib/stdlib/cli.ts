import * as readline from "readline";
import process from "process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";
import { __call } from "../runtime/call.js";
import { getRuntimeContext } from "../runtime/asyncContext.js";

// ---------------------------------------------------------------------------
// TS bridge for `std::cli` — the line-mode REPL.
//
// Counterpart to `lib/stdlib/ui.ts` but builds on Node's `readline`
// instead of the alt-screen TUI engine. The user-facing tradeoff is
// documented in the spec at
// docs/superpowers/ideas/2026-06-02-line-mode-agent.md — line mode
// gives up the TUI's pinned status, modal prompts, and live spinner
// in exchange for native terminal scrollback / search / copy-paste /
// link-clicking.
//
// `std::cli.repl()` calls `_runLineRepl(...)` here.  Everything else
// the agent uses (`chooseOption`, `pushMessage`, `clearMessages`) is
// re-exported from `std::ui` whose existing `_activeRepl == null`
// fallback paths already do the line-mode thing (print + input loop,
// straight `print`, silent no-op).
// ---------------------------------------------------------------------------

/** Adapt either a plain JS function or an AgencyFunction-like callback
 *  passed across the bridge into an async callable. Mirrors the
 *  helper of the same name in `ui.ts` — uses `__call` so
 *  AgencyFunction values dispatch through the runtime's normal call
 *  path (handlers, ALS context, retries) rather than being invoked as
 *  raw JS. */
async function callBridgeFn<T>(fn: unknown, ...args: unknown[]): Promise<T> {
  return (await __call(fn, { type: "positional", args })) as T;
}

/** Read `historyFile` (one entry per line, oldest first) and return
 *  the entries in the order Node's `readline` expects them: newest
 *  first, capped at `max`. Returns `[]` on any I/O error so a
 *  corrupt or missing history file never breaks startup. */
function loadHistory(file: string, max: number): string[] {
  if (!file || !existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    return lines.reverse().slice(0, max);
  } catch {
    return [];
  }
}

/** Persist `history` (in readline's newest-first order) to `file`,
 *  storing it oldest-first one entry per line so re-loading yields
 *  identical chronology. Creates parent dirs as needed. Swallows
 *  errors so a read-only HOME doesn't crash the REPL on exit. */
function saveHistory(file: string, history: string[], max: number): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const trimmed = history.slice(0, max);
    const lines = trimmed.slice().reverse();
    writeFileSync(file, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  } catch {
    // Ignore — best-effort persistence.
  }
}

/** Drives the line-mode REPL loop. Per iteration: prompt → await
 *  user input → call `onSubmit` → print any non-empty string return
 *  → exit when `onSubmit` returns `false` or the user hits Ctrl+D /
 *  Ctrl+C at an idle prompt.
 *
 *  `status` is accepted for signature parity with `std::ui.repl`;
 *  WL1 doesn't render it yet (per-turn footer is WL2). It's not
 *  invoked here so AgencyFunction callbacks that have side effects
 *  don't fire unexpectedly.
 *
 *  Cancellation note: while `onSubmit` is awaited, the outer
 *  readline interface is idle, so nested `input()` calls (e.g. from
 *  `chooseOption`'s fallback path) can safely create their own
 *  readline interface on the same stdin. The `__agencyInputOverride`
 *  hook routes them through *this* `rl` instead, which keeps history
 *  and line editing consistent across nested prompts.
 */
// ANSI SGR sequences for coloring user input. Bright blue (94)
// matches the `{bright-blue-fg}You{/bright-blue-fg}` styling the TUI
// uses for user messages in `lib/stdlib/ui.ts`, so line mode and TUI
// mode look like the same agent. Only applied when stdout is a TTY
// so piped output (e.g. `agency ... | tee log.txt`) stays clean.
const USER_INPUT_COLOR = "\x1b[94m";
const COLOR_RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CLEAR_LINE = "\r\x1b[K";

// Same braille frames the TUI's `_spinnerFrame` uses. Kept inline
// (not imported) so the line-mode bridge doesn't depend on the TUI
// bridge module.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

/**
 * Start a single-line "Thinking Ns" spinner. Returns a stop function
 * that clears the spinner row and restores `process.stdout.write`.
 *
 * While the spinner is active, every external write to stdout
 * (`console.log`, `process.stdout.write`, etc.) is wrapped to emit
 * a `\r\x1b[K` clear-line first, then the original content. The
 * spinner redraws on the next interval tick. This is the
 * "unconditional clear-on-write" approach the spec endorses for WL4
 * — ~15 lines, handles every tool that logs without needing each
 * tool to coordinate with the spinner.
 *
 * No-op on non-TTY: returns an immediate stop function so piped
 * runs don't get spinner frames in their logs.
 */
function startSpinner(useTTY: boolean): () => void {
  if (!useTTY) return () => {};
  const startedAt = Date.now();
  let stopped = false;
  // Capture the *real* write before patching so the spinner itself
  // can draw without recursing through the patched version.
  const stdoutAny = process.stdout as unknown as {
    write: (chunk: any, ...rest: any[]) => any;
  };
  const realWrite = stdoutAny.write.bind(process.stdout);

  const render = (): void => {
    if (stopped) return;
    const elapsedMs = Date.now() - startedAt;
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const idx = Math.floor(elapsedMs / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
    const frame = SPINNER_FRAMES[idx];
    realWrite(`\r${DIM}${frame} Thinking ${elapsedSec}s${COLOR_RESET}\x1b[K`);
  };
  render();
  const id = setInterval(render, SPINNER_INTERVAL_MS);

  // Patch stdout so any external write clears the spinner row first.
  // The patched function uses `realWrite`, never `stdoutAny.write`,
  // so there's no recursion. Preserves the original return value so
  // backpressure semantics (the boolean Writable.write returns) stay
  // correct.
  stdoutAny.write = function patchedWrite(
    this: unknown,
    chunk: any,
    ...rest: any[]
  ): any {
    realWrite(CLEAR_LINE);
    return realWrite(chunk, ...rest);
  };

  return (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(id);
    stdoutAny.write = realWrite;
    realWrite(CLEAR_LINE);
  };
}

/**
 * After each successful turn, project the agent's `status` callback
 * into a single-line dim footer:
 *
 *     ─── agency-agent · $0.0143 · /help for commands ───
 *
 * The callback returns `{left, right, context}` (same shape the TUI
 * uses for its status bar). Non-empty parts are joined with `·`.
 * No-op on non-TTY so piped logs stay free of decoration. A failure
 * inside the callback is swallowed — the footer is informational and
 * must never break a successful turn.
 */
/**
 * Convert the `paletteCommands` map the agent passes (e.g.
 * `{"/exit": "Exit", "/clear": "Clear", ...}`) into a stable
 * `[key, description][]` list, filtering anything that doesn't
 * look like a slash command. Returns `[]` for nullish / non-object
 * inputs so callers don't have to null-check.
 */
function paletteEntries(paletteCommands: unknown): [string, string][] {
  if (!paletteCommands || typeof paletteCommands !== "object") return [];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(
    paletteCommands as Record<string, unknown>,
  )) {
    if (typeof k !== "string" || !k.startsWith("/")) continue;
    out.push([k, typeof v === "string" ? v : ""]);
  }
  return out;
}

/**
 * Build a Node `readline` completer over the slash-command palette.
 * Activates only when the buffer starts with `/`; outside of that
 * we don't want Tab to suggest filenames or anything else. Standard
 * readline behavior: a single hit auto-completes inline; multiple
 * hits display the list. Pairs with the live popup below — the
 * popup is the discovery aid, Tab is the "do it now" mechanism.
 */
function buildCompleter(
  entries: [string, string][],
): (line: string) => [string[], string] {
  const keys = entries.map(([k]) => k);
  return (line: string): [string[], string] => {
    if (!line.startsWith("/")) return [[], line];
    const hits = keys.filter((k) => k.startsWith(line));
    return [hits.length > 0 ? hits : keys, line];
  };
}

/**
 * Strip the most common ANSI CSI sequences (SGR, cursor movement,
 * line clears) to compute the visible width of a styled string.
 * Used so the slash-hint renderer can put the cursor back at the
 * correct *display* column even when the prompt itself carries
 * color codes like `\x1b[94m`.
 */
function visibleLength(s: string): number {
  // CSI = ESC `[` then any digits/semicolons then one final byte.
  // Covers SGR (`m`), cursor moves (`A`-`G`), and clears (`J`, `K`).
  return s.replace(/\x1b\[[\d;]*[A-Za-z]/g, "").length;
}

/**
 * Live slash-command popup. After every keystroke (via the
 * `keypress` event), if the current input buffer starts with `/`,
 * renders matching commands as dim hint rows *below* the prompt
 * row, then explicitly repositions the cursor back to the input row
 * + column so readline keeps drawing the next keystroke at the
 * right spot.
 *
 * Earlier versions used `\x1b[s` / `\x1b[u` (DECSC / DECRC) for
 * save/restore but several terminals (notably macOS Terminal.app
 * and certain iTerm2 setups) either ignore the sequences, restore
 * to stale absolute coordinates after scroll, or have them
 * intercepted by readline's own redraw. The result was hints
 * stacking below each other and the cursor drifting onto a hint
 * row. We now compute the target column from `visibleLength(prompt)
 * + rl.cursor` and emit explicit `\r` + `\x1b[<n>C` to land on it.
 *
 * Capped at `MAX_HINT_ROWS` so very long palettes can't push the
 * prompt off-screen. No-op on non-TTY or empty palette.
 *
 * Old hints aren't actively cleared when the user submits a line:
 * they become part of scrollback as a "what you could have typed"
 * trail, and the next prompt iteration starts fresh below them.
 */
const MAX_HINT_ROWS = 8;

// High-contrast style for the currently selected hint row. ANSI 44 =
// blue background; 97 = bright white foreground; 1 = bold. Combined
// with the `▶ ` prefix this stands out clearly even on terminals
// that render dim text faintly.
const SELECTED_HINT_BG = "\x1b[44m";
const SELECTED_HINT_FG = "\x1b[97m";
const BOLD = "\x1b[1m";

/**
 * Live slash-command popup with arrow-key navigation.
 *
 * **Rendering** (after every keystroke, via `setImmediate` over the
 * `keypress` event): if the input buffer starts with `/`, draws the
 * matching commands as hint rows below the prompt and explicitly
 * repositions the cursor back to `visibleLength(prompt) + rl.cursor`
 * so readline keeps drawing at the right column on the next keypress.
 *
 * **Selection** (Up / Down / Enter): we override `rl._ttyWrite`,
 * readline's per-key dispatcher, so when the popup is open Up/Down
 * scroll through the visible matches (highlighting one with a blue
 * background + bold white text + `▶ ` prefix) instead of triggering
 * readline's history navigation. Enter with an active selection
 * substitutes the selected command into the readline buffer and
 * submits — equivalent to the user having typed it then pressed
 * Enter. Without a selection, Enter behaves normally (submits the
 * typed buffer as-is).
 *
 * Overriding `_ttyWrite` is a private API but the standard pattern
 * used by `inquirer`, `enquirer`, etc. for layered key handling on
 * top of readline.
 *
 * Capped at `MAX_HINT_ROWS`. No-op on non-TTY or empty palette.
 */
function installSlashHints(
  rl: readline.Interface,
  entries: [string, string][],
  prompt: string,
  useTTY: boolean,
): () => void {
  if (!useTTY || entries.length === 0) return () => {};
  const visiblePromptLen = visibleLength(prompt);

  let renderedRows = 0;
  // The list of matches currently displayed in the popup. Updated
  // by `recomputeMatches()` whenever the input buffer changes.
  let currentMatches: [string, string][] = [];
  // Index into `currentMatches`. `-1` means no selection (Enter
  // submits the typed buffer as-is); `>= 0` means a hint is
  // highlighted and Enter will substitute it.
  let selectedIdx = -1;

  // Put the cursor at the input row, column `col`. `\r` snaps to
  // col 0; `\x1b[<n>C` then moves right.
  const repositionTo = (col: number): void => {
    const out = process.stdout;
    out.write("\r");
    if (col > 0) out.write(`\x1b[${col}C`);
  };

  const clearAndReposition = (inputCol: number): void => {
    if (renderedRows === 0) {
      repositionTo(inputCol);
      return;
    }
    const out = process.stdout;
    for (let i = 0; i < renderedRows; i++) {
      out.write("\x1b[1B\r\x1b[K");
    }
    out.write(`\x1b[${renderedRows}A`);
    repositionTo(inputCol);
    renderedRows = 0;
  };

  // Refresh `currentMatches` for the current buffer. Always resets
  // `selectedIdx` to -1 — typing or backspacing should drop any
  // arrow-key selection, since the visible list just changed.
  const recomputeMatches = (): void => {
    const buf = (rl as unknown as { line?: string }).line ?? "";
    if (!buf.startsWith("/")) {
      currentMatches = [];
      selectedIdx = -1;
      return;
    }
    const filter = buf.toLowerCase();
    currentMatches = entries
      .filter(([k]) => k.toLowerCase().startsWith(filter))
      .slice(0, MAX_HINT_ROWS);
    selectedIdx = -1;
  };

  const formatHintRow = (
    key: string,
    desc: string,
    selected: boolean,
    maxKey: number,
  ): string => {
    const padded = key.padEnd(maxKey, " ");
    const descPart = desc ? `  ${desc}` : "";
    if (selected) {
      // Bracket the row with a space on each side so the blue
      // background extends past the text instead of hugging the
      // letters. Trailing `\x1b[K` would also fill to EOL but we
      // skip it here so the highlight stops at the description's
      // end — cleaner against the terminal background.
      return `${SELECTED_HINT_BG}${SELECTED_HINT_FG}${BOLD} ▶ ${padded}${descPart} ${COLOR_RESET}`;
    }
    return `${DIM}   ${padded}${descPart}${COLOR_RESET}`;
  };

  const renderHints = (): void => {
    const rlAny = rl as unknown as { line?: string; cursor?: number };
    const buf = rlAny.line ?? "";
    const cursorPos = rlAny.cursor ?? buf.length;
    const inputCol = visiblePromptLen + cursorPos;

    clearAndReposition(inputCol);

    if (currentMatches.length === 0) return;

    const maxKey = currentMatches.reduce(
      (m, [k]) => Math.max(m, k.length),
      0,
    );
    const out = process.stdout;
    for (let i = 0; i < currentMatches.length; i++) {
      const [key, desc] = currentMatches[i];
      const row = formatHintRow(key, desc, i === selectedIdx, maxKey);
      out.write(`\n\r\x1b[K${row}`);
    }
    out.write(`\x1b[${currentMatches.length}A`);
    repositionTo(inputCol);
    renderedRows = currentMatches.length;
  };

  // ---- _ttyWrite override: arrow-key navigation + Enter substitution
  // Wraps readline's per-keystroke dispatcher. When the popup is
  // active we own Up/Down/Enter; for everything else we delegate to
  // the original, then re-render hints once readline has updated
  // its buffer.
  const rlAny = rl as unknown as {
    _ttyWrite: (s: unknown, key: { name?: string }) => void;
    line: string;
    cursor: number;
    _refreshLine?: () => void;
  };
  const originalTtyWrite = rlAny._ttyWrite;

  rlAny._ttyWrite = function (
    this: typeof rlAny,
    s: unknown,
    key: { name?: string },
  ): void {
    const popupActive = (this.line ?? "").startsWith("/");

    if (popupActive && key && currentMatches.length > 0) {
      if (key.name === "up") {
        selectedIdx =
          selectedIdx <= 0 ? currentMatches.length - 1 : selectedIdx - 1;
        renderHints();
        return;
      }
      if (key.name === "down") {
        selectedIdx =
          selectedIdx < 0 || selectedIdx >= currentMatches.length - 1
            ? 0
            : selectedIdx + 1;
        renderHints();
        return;
      }
      if (
        key.name === "return" &&
        selectedIdx >= 0 &&
        selectedIdx < currentMatches.length
      ) {
        // Substitute the selected command into the buffer, clear
        // the popup, and let readline's Enter handler submit.
        const selectedCmd = currentMatches[selectedIdx][0];
        currentMatches = [];
        selectedIdx = -1;
        renderHints(); // clears hints from screen
        this.line = selectedCmd;
        this.cursor = selectedCmd.length;
        if (typeof this._refreshLine === "function") this._refreshLine();
        originalTtyWrite.call(this, s, key);
        return;
      }
    }

    // Default path: hand off to readline, then re-render hints once
    // readline has updated its buffer.
    originalTtyWrite.call(this, s, key);
    setImmediate(() => {
      recomputeMatches();
      renderHints();
    });
  };

  return (): void => {
    // Restore original _ttyWrite so the readline interface behaves
    // normally if anything else still uses it after this REPL exits.
    rlAny._ttyWrite = originalTtyWrite;
    clearAndReposition(visiblePromptLen);
  };
}

/**
 * Snapshot of the per-turn stats `_runLineRepl` collects before
 * calling `onSubmit` and after it returns. `printFooter` projects the
 * delta into the footer so the user can see at a glance how many
 * tokens flowed and how long it took.
 *
 * `inputTokens` / `outputTokens` are read from the `GlobalStore`'s
 * `__tokenStats` slot — the same place `getTokens()` ultimately reads
 * from, but with the input/output breakdown the single
 * `localTokens` counter doesn't surface. `elapsedMs` is plain
 * wall-clock from `Date.now()` deltas.
 *
 * Originally added so a future "agent stopped mid-sentence" bug shows
 * a non-zero `↓0` output-token count next to the cut-off reply — that
 * makes a "real LLM truncation" vs. "our render pipeline ate it"
 * diagnosis a one-second glance instead of a 30-minute log dive.
 */
type TurnStats = {
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
};

/** Read the cumulative input/output token counts from the active
 *  RuntimeContext's GlobalStore. Returns zeros when no context is
 *  active or the token-stats slot is missing (defensive — `_runLineRepl`
 *  always runs inside a context, but tests sometimes don't). */
function readTokenSnapshot(): { inputTokens: number; outputTokens: number } {
  try {
    const { ctx } = getRuntimeContext();
    const stats = ctx?.globals?.getTokenStats?.();
    if (!stats || typeof stats !== "object") {
      return { inputTokens: 0, outputTokens: 0 };
    }
    const usage = (stats as { usage?: Record<string, unknown> }).usage;
    if (!usage || typeof usage !== "object") {
      return { inputTokens: 0, outputTokens: 0 };
    }
    return {
      inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
      outputTokens:
        typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0 };
  }
}

/** Format a token count as a short, human-readable string. Below 1000
 *  we show the exact count; at 1k+ we drop to a one-decimal `1.2k` so
 *  the footer doesn't fight for column space on long turns. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/** Format an elapsed wall-clock duration. Under a minute we show
 *  fractional seconds (`3.2s`); past that we drop to whole minutes +
 *  seconds (`1m 45s`). */
function fmtElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${secs}s`;
}

async function printFooter(
  status: unknown,
  useTTY: boolean,
  turn: TurnStats | null = null,
): Promise<void> {
  if (!useTTY || status == null) return;
  let info: { left?: unknown; right?: unknown; context?: unknown } | null;
  try {
    info = (await callBridgeFn(status)) as typeof info;
  } catch {
    return;
  }
  if (!info || typeof info !== "object") return;
  const parts: string[] = [];
  for (const key of ["left", "right", "context"] as const) {
    const v = info[key];
    if (typeof v === "string" && v.length > 0) parts.push(v);
  }
  // Prepend the per-turn stats so they read left-to-right: tokens
  // up, tokens down, then elapsed. `↑` / `↓` are universal arrow
  // glyphs (no terminal font tantrums). Skipped when `turn` is
  // omitted (e.g. older callers / tests).
  if (turn) {
    parts.unshift(
      `↑${fmtTokens(turn.inputTokens)} ↓${fmtTokens(turn.outputTokens)} ${fmtElapsed(turn.elapsedMs)}`,
    );
  }
  if (parts.length === 0) return;
  const text = parts.join(" · ");
  process.stdout.write(`${DIM}─── ${text} ───${COLOR_RESET}\n`);
}

export async function _runLineRepl(
  status: unknown,
  onSubmit: unknown,
  prompt: string,
  historyFile: string,
  historyMax: number,
  paletteCommands: unknown,
): Promise<void> {
  const initialHistory = loadHistory(historyFile, historyMax);
  const palette = paletteEntries(paletteCommands);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    history: initialHistory,
    historySize: historyMax,
    removeHistoryDuplicates: true,
    // Tab completion fallback for the slash-command palette. The
    // live popup (`installSlashHints`) is the discovery surface; the
    // completer is the "Tab to fill" mechanism for users who prefer
    // the shell idiom.
    completer: buildCompleter(palette),
  });

  // Color the prompt + everything the user types in bright blue. The
  // SGR state set by the prompt persists through readline's
  // character-by-character echo of typed input, and we emit
  // `COLOR_RESET` immediately after `rl.question` resolves so the
  // agent's reply (and any tool-call output) prints in the default
  // color. No-op on non-TTY so logs / pipes stay free of escape codes.
  const useColor = process.stdout.isTTY === true;
  const coloredPrompt = useColor
    ? `${USER_INPUT_COLOR}${prompt}`
    : prompt;

  // Tracks the spinner that's currently running for an in-flight
  // turn, if any. Lifted out of the loop so the
  // `__agencyInputOverride` callback (fired by nested `input()` /
  // `chooseOption` fallback) can stop the spinner the moment the
  // agent needs the user — "Thinking" is wrong while we're waiting
  // on a human, and the spinner would otherwise overdraw the policy
  // prompt block.
  let activeStopSpinner: (() => void) | null = null;
  const stopActiveSpinner = (): void => {
    if (activeStopSpinner) {
      activeStopSpinner();
      activeStopSpinner = null;
    }
  };

  // Route nested `input()` calls through the same readline. The
  // `_input` impl in `builtins.ts` checks `globalThis.__agencyInputOverride`
  // before creating its own interface; routing through `rl` here
  // means `chooseOption`'s fallback prompts share line-edit + history
  // with the main REPL instead of contending for stdin with a second
  // readline. Stops any running spinner first (see comment above).
  const overrideKey = "__agencyInputOverride";
  const prevOverride = (globalThis as any)[overrideKey];
  (globalThis as any)[overrideKey] = (p: string): Promise<string> => {
    stopActiveSpinner();
    return new Promise<string>((resolve) => {
      rl.question(p, (answer) => resolve(answer));
    });
  };

  // Live slash-command popup. Renders matching commands below the
  // prompt as the user types `/...`, with cursor save/restore so
  // readline keeps drawing in the right column. Teardown happens in
  // the outer `finally` so we don't leave a stray `keypress` handler
  // on stdin if the loop throws.
  const teardownHints = installSlashHints(rl, palette, coloredPrompt, useColor);

  try {
    while (true) {
      let line: string;
      try {
        line = await askLine(rl, coloredPrompt);
      } catch {
        // Ctrl+D (EOT) or Ctrl+C at idle: readline emits `close`,
        // we treat that as a clean exit. The color reset guards
        // against leaving the user's shell in bright blue if we
        // exited mid-prompt.
        if (useColor) process.stdout.write(COLOR_RESET);
        process.stdout.write("\n");
        break;
      }
      // Reset SGR so the agent's reply prints in the default color;
      // see comment on `USER_INPUT_COLOR` above for why.
      if (useColor) process.stdout.write(COLOR_RESET);
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let reply: unknown;
      // Snapshot wall-clock and the cumulative token counters before
      // the turn so we can render input/output token deltas + elapsed
      // in the footer. `readTokenSnapshot` is safe under failure —
      // it returns zeros if the runtime context or token-stats slot
      // is missing, so the footer never breaks a working turn.
      const turnStartMs = Date.now();
      const tokensBefore = readTokenSnapshot();
      activeStopSpinner = startSpinner(useColor);
      try {
        reply = await callBridgeFn(onSubmit, line);
      } catch (err: any) {
        stopActiveSpinner();
        const msg = err?.message ?? String(err);
        process.stdout.write(`Error: ${msg}\n`);
        // Still print the footer on error so the user sees how long
        // the failed turn ran and whether tokens flowed. Useful when
        // the turn died after a partial LLM response.
        const tokensAfter = readTokenSnapshot();
        await printFooter(status, useColor, {
          elapsedMs: Date.now() - turnStartMs,
          inputTokens: tokensAfter.inputTokens - tokensBefore.inputTokens,
          outputTokens: tokensAfter.outputTokens - tokensBefore.outputTokens,
        });
        continue;
      }
      stopActiveSpinner();
      if (reply === false) break;
      if (typeof reply === "string" && reply.length > 0) {
        process.stdout.write(reply + "\n");
      }
      const tokensAfter = readTokenSnapshot();
      // Per-turn footer (WL2). Reads the same `status` callback the
      // TUI's status bar uses, plus our locally-tracked turn stats
      // (elapsed + tokens up/down), so a future "the agent stopped
      // mid-sentence" report can be diagnosed at a glance: `↓0`
      // means our render pipeline ate it, non-zero means the LLM
      // actually streamed nothing further.
      await printFooter(status, useColor, {
        elapsedMs: Date.now() - turnStartMs,
        inputTokens: tokensAfter.inputTokens - tokensBefore.inputTokens,
        outputTokens: tokensAfter.outputTokens - tokensBefore.outputTokens,
      });
    }
  } finally {
    teardownHints();
    (globalThis as any)[overrideKey] = prevOverride;
    // Persist whatever entries readline accumulated. The `history`
    // property is undocumented-ish but stable across Node versions
    // we support and is the only way to read it back.
    const hist: string[] = ((rl as unknown) as { history?: string[] })
      .history ?? [];
    saveHistory(historyFile, hist, historyMax);
    rl.close();
  }
}

/** Promise-wrap `rl.question` + a one-shot `close` listener so a
 *  Ctrl+D / Ctrl+C while idle rejects (loop exit) instead of leaving
 *  the question pending forever. */
function askLine(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onClose = () => reject(new Error("closed"));
    rl.once("close", onClose);
    rl.question(prompt, (answer) => {
      rl.off("close", onClose);
      resolve(answer);
    });
  });
}
