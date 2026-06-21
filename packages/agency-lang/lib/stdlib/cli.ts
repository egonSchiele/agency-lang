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
import { modifiers, RESET, styles } from "@/utils/termcolors.js"
import { color, colors, bgColors } from "../utils/termcolors.js";
import { _promptsAutocomplete } from "./ui.js";
import { isFailure } from "../runtime/result.js";
import { isAbortError } from "../runtime/errors.js";
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
const USER_INPUT_COLOR = styles.cyan
const COLOR_RESET = RESET;
const DIM = styles.dim;
const CLEAR_LINE = "\r\x1b[K";

const SPINNERS = {
  "line": {
    "interval": 130,
    "frames": [
      "-",
      "\\",
      "|",
      "/"
    ]
  },
  "rollingLine": {
    "interval": 80,
    "frames": [
      "/  ",
      " - ",
      " \\ ",
      "  |",
      "  |",
      " \\ ",
      " - ",
      "/  "
    ]
  },

  "star": {
    "interval": 70,
    "frames": [
      "✶",
      "✸",
      "✹",
      "✺",
      "✹",
      "✷"
    ]
  },
  "star2": {
    "interval": 80,
    "frames": [
      "+",
      "x",
      "*"
    ]
  },
  "bouncingBar": {
    "interval": 80,
    "frames": [
      "[    ]",
      "[=   ]",
      "[==  ]",
      "[=== ]",
      "[====]",
      "[ ===]",
      "[  ==]",
      "[   =]",
      "[    ]",
      "[   =]",
      "[  ==]",
      "[ ===]",
      "[====]",
      "[=== ]",
      "[==  ]",
      "[=   ]"
    ]
  },
  "bouncingBall": {
    "interval": 80,
    "frames": [
      "( ●    )",
      "(  ●   )",
      "(   ●  )",
      "(    ● )",
      "(     ●)",
      "(    ● )",
      "(   ●  )",
      "(  ●   )",
      "( ●    )",
      "(●     )"
    ]
  },
  "pong": {
    "interval": 80,
    "frames": [
      "▐⠂       ▌",
      "▐⠈       ▌",
      "▐ ⠂      ▌",
      "▐ ⠠      ▌",
      "▐  ⡀     ▌",
      "▐  ⠠     ▌",
      "▐   ⠂    ▌",
      "▐   ⠈    ▌",
      "▐    ⠂   ▌",
      "▐    ⠠   ▌",
      "▐     ⡀  ▌",
      "▐     ⠠  ▌",
      "▐      ⠂ ▌",
      "▐      ⠈ ▌",
      "▐       ⠂▌",
      "▐       ⠠▌",
      "▐       ⡀▌",
      "▐      ⠠ ▌",
      "▐      ⠂ ▌",
      "▐     ⠈  ▌",
      "▐     ⠂  ▌",
      "▐    ⠠   ▌",
      "▐    ⡀   ▌",
      "▐   ⠠    ▌",
      "▐   ⠂    ▌",
      "▐  ⠈     ▌",
      "▐  ⠂     ▌",
      "▐ ⠠      ▌",
      "▐ ⡀      ▌",
      "▐⠠       ▌"
    ]
  },
}

// Same braille frames the TUI's `_spinnerFrame` uses. Kept inline
// (not imported) so the line-mode bridge doesn't depend on the TUI
// bridge module.
const SPINNER_FRAMES = SPINNERS.line.frames;
const SPINNER_INTERVAL_MS = SPINNERS.line.interval;

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
  if (!useTTY) return () => { };
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
 * Open the `prompts.autocomplete` modal preloaded with the slash
 * palette. Returns the picked command key (e.g. `/cost`) on success,
 * or `null` if the user cancelled (Ctrl+C / Escape).
 *
 * Replaces the old inline `installSlashHints` popup. Triggered when
 * the user presses `/` at an empty prompt (see `installSlashTrigger`)
 * — we hand off to the same `prompts` machinery the interrupt UI
 * uses, so the palette and the policy interrupt picker look and feel
 * identical.
 *
 * No-op (returns null) when the palette is empty.
 */
async function openSlashPalette(
  entries: [string, string][],
): Promise<string | null> {
  if (entries.length === 0) return null;
  const items = entries.map(([key, label]) => ({ key, label }));
  const result = await _promptsAutocomplete(
    "Slash command:",
    items,
    false,
    "press Esc to close",
  );
  if (isFailure(result)) return null;
  return String(result.value);
}

/**
 * Intercept `/` at an empty readline buffer and synthesize a submit
 * so the loop's slash-trigger fires immediately — no Enter required.
 * When the buffer is non-empty (e.g. typing `/etc/foo` after some
 * other text), the keystroke passes through normally. Returns a
 * teardown that restores the original `_ttyWrite`.
 *
 * Overriding `_ttyWrite` is the standard pattern for layered key
 * handling on top of readline (used by inquirer, enquirer, etc.).
 * No-op on non-TTY or empty palette.
 */
function installSlashTrigger(
  rl: readline.Interface,
  entries: [string, string][],
  useTTY: boolean,
): () => void {
  if (!useTTY || entries.length === 0) return () => { };
  const rlAny = rl as unknown as {
    _ttyWrite: (s: unknown, key: { name?: string; sequence?: string }) => void;
    line: string;
    cursor: number;
  };
  const originalTtyWrite = rlAny._ttyWrite;
  rlAny._ttyWrite = function (
    this: typeof rlAny,
    s: unknown,
    key: { name?: string; sequence?: string },
  ): void {
    const isSlash = key && (key.sequence === "/" || key.name === "slash");
    if (isSlash && (this.line ?? "") === "") {
      // Substitute `/` into the buffer and synthesize Enter so the
      // pending `rl.question` resolves with "/". The main loop sees
      // it, opens `openSlashPalette`, and we never echo the `/`
      // ourselves — readline's Enter handler does its normal line
      // termination, which writes the trailing newline.
      this.line = "/";
      this.cursor = 1;
      originalTtyWrite.call(this, "\r", { name: "return" });
      return;
    }
    originalTtyWrite.call(this, s, key);
  };
  return (): void => {
    rlAny._ttyWrite = originalTtyWrite;
  };
}

/**
 * While a turn is in flight, intercept a bare Esc keypress and invoke
 * `onEscape` (which cancels the current request). Other keys pass through
 * to readline as usual, so type-ahead still works. Returns a teardown that
 * restores the original `_ttyWrite`; the caller MUST call it once the turn
 * settles so idle-prompt Esc behaves normally again. No-op on non-TTY.
 *
 * Only a bare Esc fires: readline parses Esc to `key.name === "escape"`,
 * while arrow keys and other escape sequences parse to their own names
 * (`up`, `down`, ...), so they don't trip the cancel.
 */
function installCancelKey(
  rl: readline.Interface,
  useTTY: boolean,
  onEscape: () => void,
): () => void {
  if (!useTTY) return () => { };
  const rlAny = rl as unknown as {
    _ttyWrite: (s: unknown, key: { name?: string; sequence?: string }) => void;
  };
  const originalTtyWrite = rlAny._ttyWrite;
  rlAny._ttyWrite = function (
    this: typeof rlAny,
    s: unknown,
    key: { name?: string; sequence?: string },
  ): void {
    if (key && key.name === "escape") {
      onEscape();
      return;
    }
    originalTtyWrite.call(this, s, key);
  };
  return (): void => {
    rlAny._ttyWrite = originalTtyWrite;
  };
}

/** Safely fetch the active RuntimeContext, or null when none is bound
 *  (e.g. tests drive `_runLineRepl` without a runtime). */
function activeCtxOrNull(): {
  cancel: (r?: string) => void;
  resetCancel: () => void;
  readonly aborted: boolean;
} | null {
  try {
    const { ctx } = getRuntimeContext();
    return (ctx as any) ?? null;
  } catch {
    return null;
  }
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
  model: string;
};

/** Read the cumulative input/output token counts from the active
 *  RuntimeContext's GlobalStore. Returns zeros when no context is
 *  active or the token-stats slot is missing (defensive — `_runLineRepl`
 *  always runs inside a context, but tests sometimes don't). */
function readTokenSnapshot(): {
  inputTokens: number;
  outputTokens: number;
  model: string;
} {
  try {
    const { ctx } = getRuntimeContext();
    const stats = ctx?.globals?.getTokenStats?.();
    if (!stats || typeof stats !== "object") {
      return { inputTokens: 0, outputTokens: 0, model: "" };
    }
    const usage = (stats as { usage?: Record<string, unknown> }).usage;
    // `lastModel` is the model of the most recent LLM call (set in
    // updateTokenStats). It's cumulative, not a delta — the footer uses
    // the post-turn value to label which model produced the reply.
    const lastModel = (stats as { lastModel?: unknown }).lastModel;
    const model = typeof lastModel === "string" ? lastModel : "";
    if (!usage || typeof usage !== "object") {
      return { inputTokens: 0, outputTokens: 0, model };
    }
    return {
      inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
      outputTokens:
        typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
      model,
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0, model: "" };
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
  // up, tokens down, elapsed, then the model that produced the turn.
  // `↑` / `↓` are universal arrow glyphs (no terminal font tantrums).
  // Skipped when `turn` is omitted (e.g. older callers / tests); the
  // model is appended only when known.
  if (turn) {
    let stats = `↑${fmtTokens(turn.inputTokens)} ↓${fmtTokens(turn.outputTokens)} ${fmtElapsed(turn.elapsedMs)}`;
    if (turn.model.length > 0) stats += ` · ${turn.model}`;
    parts.unshift(stats);
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
    // A lone Esc is ambiguous (it's also the lead byte of escape sequences
    // like arrow keys), so readline waits `escapeCodeTimeout` ms before
    // delivering it as the `escape` key. The 500ms default made Esc-to-
    // cancel feel laggy (~1s). 50ms keeps cancellation snappy while still
    // leaving ample time for a real escape sequence's bytes — which arrive
    // in one burst on a local TTY — to be parsed as a sequence.
    escapeCodeTimeout: 50,
    // Tab completion fallback for the slash-command palette.
    // Submitting a bare `/` opens the `prompts.autocomplete` picker
    // (see `openSlashPalette`); the completer is the "Tab to fill"
    // mechanism for users who prefer the shell idiom.
    completer: buildCompleter(palette),
  });

  // Color the prompt + everything the user types in bright blue. The
  // SGR state set by the prompt persists through readline's
  // character-by-character echo of typed input, and we emit
  // `COLOR_RESET` immediately after `rl.question` resolves so the
  // agent's reply (and any tool-call output) prints in the default
  // color. No-op on non-TTY so logs / pipes stay free of escape codes.
  // Split the two: `useTTY` gates terminal-interactive features (the
  // `/` slash-trigger override on readline, the "Thinking" spinner)
  // and must NOT depend on `NO_COLOR`. `useColor` additionally
  // suppresses SGR sequences when the user has opted out of color.
  const useTTY = process.stdout.isTTY === true;
  const useColor = useTTY && process.env.NO_COLOR !== "1";
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

  // Register a global "stop spinner" hook for the line-mode prompt
  // bridges in `lib/stdlib/ui.ts` (select / autocomplete / prompt /
  // confirm). They bypass `__agencyInputOverride` (they don't use
  // readline) but still need to pause the "Thinking" timer while the
  // user is being asked something — otherwise the timer keeps ticking
  // over an open policy interrupt menu. Same lifecycle as
  // `__agencyInputOverride`: install on entry, restore on exit.
  const stopSpinnerKey = "__agencyStopSpinner";
  const prevStopSpinner = (globalThis as any)[stopSpinnerKey];
  (globalThis as any)[stopSpinnerKey] = stopActiveSpinner;

  // `/` at an empty prompt synthesizes Enter so the bare-`/` branch
  // in the loop body fires immediately and opens the palette modal.
  const teardownSlashTrigger = installSlashTrigger(rl, palette, useTTY);
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
      let trimmed = line.trim();
      if (trimmed.length === 0) continue;
      // Bare `/` opens the slash-command palette via
      // `prompts.autocomplete` — the same modal the interrupt UI
      // uses, so palette and policy menus look and feel identical.
      // The `/` key fires this branch immediately (no Enter needed)
      // via `installSlashTrigger`'s `_ttyWrite` hook above; users can
      // also type `/` + Enter manually. The picked command is fed
      // back through the normal onSubmit path; cancel just reprompts.
      if (trimmed === "/" && palette.length > 0) {
        const picked = await openSlashPalette(palette);
        if (picked == null) continue;
        line = picked;
        trimmed = picked;
      }

      // `/paste` (built-in, à la Node's `.editor`): open the multi-line
      // editor and submit the whole buffer as one message. Requires an
      // interactive TTY on BOTH ends: stdout so we can draw the editor,
      // and **stdin** so there are keystrokes to drive it. If stdin is
      // piped (even when stdout is still a TTY, as in a Unix pipeline),
      // entering the editor would hang waiting for keys that never come,
      // so fall through and let `/paste` reach the agent verbatim.
      if (trimmed === "/paste" && useTTY && process.stdin.isTTY) {
        const buffer = await readMultiline(rl, useColor);
        if (buffer === null || buffer.trim().length === 0) continue;
        line = buffer;
        trimmed = buffer;
      }

      const banner = line.includes("\n")
        ? ` User: ${line.split("\n")[0]} … (${line.split("\n").length} lines) \n`
        : ` User: ${line} \n`;
      process.stdout.write(color.bgBrightBlack.darkBlack(banner));

      let reply: unknown;
      // Snapshot wall-clock and the cumulative token counters before
      // the turn so we can render input/output token deltas + elapsed
      // in the footer. `readTokenSnapshot` is safe under failure —
      // it returns zeros if the runtime context or token-stats slot
      // is missing, so the footer never breaks a working turn.
      const turnStartMs = Date.now();
      const tokensBefore = readTokenSnapshot();
      activeStopSpinner = startSpinner(useTTY);

      // Esc cancels the in-flight request. The watcher calls `ctx.cancel`,
      // which aborts the active LLM fetch; an AgencyCancelledError then
      // propagates out of `onSubmit` and is caught below. Torn down in the
      // `finally` so idle-prompt Esc is unaffected.
      const turnCtx = activeCtxOrNull();
      const teardownCancelKey = installCancelKey(rl, useTTY, () => {
        // Stop the spinner the instant Esc is pressed so the user gets
        // immediate feedback, then abort the in-flight request. The
        // AgencyCancelledError propagates out and the catch below prints
        // "cancelled".
        stopActiveSpinner();
        turnCtx?.cancel("cancelled by user");
      });

      try {
        reply = await callBridgeFn(onSubmit, line);
      } catch (err: any) {
        stopActiveSpinner();
        const tokensAfter = readTokenSnapshot();
        if (isAbortError(err)) {
          // User pressed Esc: the turn was cancelled, not a real failure.
          // The thread was already repaired in runPrompt; the abort
          // controller is reset in the `finally` below. Just print a
          // notice and reprompt.
          process.stdout.write(`${DIM}cancelled${COLOR_RESET}\n`);
        } else {
          const msg = err?.message ?? String(err);
          process.stdout.write(`Error: ${msg}\n`);
        }
        // Still print the footer so the user sees how long the turn ran
        // and whether tokens flowed (useful on both cancel and error).
        await printFooter(status, useColor, {
          elapsedMs: Date.now() - turnStartMs,
          inputTokens: tokensAfter.inputTokens - tokensBefore.inputTokens,
          outputTokens: tokensAfter.outputTokens - tokensBefore.outputTokens,
          model: tokensAfter.model,
        });
        continue;
      } finally {
        teardownCancelKey();
        // Reset the abort controller whenever this turn left it aborted —
        // covers both the cancelled-with-error path above AND the race
        // where Esc fired but the turn finished before hitting a
        // cancellation checkpoint. Without this, the next turn's first LLM
        // call would see an already-aborted signal and fail immediately.
        if (turnCtx?.aborted) turnCtx.resetCancel();
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
        model: tokensAfter.model,
      });
    }
  } finally {
    teardownSlashTrigger();
    (globalThis as any)[overrideKey] = prevOverride;
    (globalThis as any)[stopSpinnerKey] = prevStopSpinner;
    // Persist whatever entries readline accumulated. `rl.history` is
    // newest-first and already contains the history we loaded at startup
    // PLUS everything added this session — so saving it preserves prior
    // sessions instead of overwriting the file with just this run's input.
    // The `history` property is undocumented-ish but stable across the Node
    // versions we support, and is the only way to read it back. Drop
    // multi-line entries (a `/paste` buffer) — the on-disk format is one
    // entry per line, so a multi-line entry would reload as several bogus
    // ones.
    const accumulated = (
      (rl as unknown as { history?: string[] }).history ?? []
    ).filter((entry) => !entry.includes("\n"));
    saveHistory(historyFile, accumulated, historyMax);
    rl.close();
  }
}

/** Promise-wrap `rl.question` + a one-shot `close` listener so a
 *  Ctrl+D / Ctrl+C while idle rejects (loop exit) instead of leaving
 *  the question pending forever. */
function askLine(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Start from an empty buffer. While a turn was running, a nested
    // prompt/menu (the policy approval autocomplete) runs its own readline
    // on the shared stdin, but the outer `rl` stays attached too — so
    // keystrokes that drove the menu (e.g. arrow keys → history recall)
    // can leave `rl.line` holding the previous prompt. Clearing it here
    // guarantees each REPL prompt opens blank. (`rl.question` renders the
    // current `rl.line`; it does not reset it.)
    const rlAny = rl as unknown as { line: string; cursor: number };
    rlAny.line = "";
    rlAny.cursor = 0;
    const onClose = () => reject(new Error("closed"));
    rl.once("close", onClose);
    rl.question(prompt, (answer) => {
      rl.off("close", onClose);
      resolve(answer);
    });
  });
}

// ────────────────────────────────────────────────────────────────────
// `/paste` — multi-line input mode (modeled on Node's REPL `.editor`).
//
// Node `readline` is single-line: Enter always submits, and a pasted
// block's interior newlines each fire a `line` event, so a multi-line
// paste splits into several premature turns. `/paste` sidesteps this by
// hijacking readline's `_ttyWrite` for the duration of the entry:
// Enter inserts a newline into our own buffer, Ctrl+D submits, Ctrl+C /
// Esc cancels. Because Enter no longer submits while in this mode, a
// multi-line paste "just works" — its newlines land in the buffer like
// any other Enter, with no bracketed-paste machinery needed.
//
// v1 is intentionally append-only: backspace edits the current line but
// does not cross a newline back into an already-entered line (matches
// the "no cross-line cursor" non-goal). The pure buffer ops below are
// kept module-private and surfaced for tests via the `_internal` export
// at the end (the convention other stdlib-lib modules use), so the edge
// cases (paste with `\r\n`, backspace at line start) are unit-testable
// without committing them to the public `agency-lang/stdlib-lib` API.

export type PasteState = { lines: string[]; current: string };

const EMPTY_PASTE: PasteState = { lines: [], current: "" };

/** Apply one input character. `\n` / `\r` commit the current line and
 *  start a new one; anything else appends to the current line. */
function pasteChar(state: PasteState, ch: string): PasteState {
  if (ch === "\n" || ch === "\r") {
    return { lines: [...state.lines, state.current], current: "" };
  }
  return { lines: state.lines, current: state.current + ch };
}

/** Append a (possibly multi-line) chunk of text — e.g. a pasted block.
 *  Normalizes `\r\n` / `\r` to `\n` first so a pasted line ending lands
 *  as a single break rather than doubling up. */
function pasteText(state: PasteState, text: string): PasteState {
  let s = state;
  for (const ch of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")) {
    s = pasteChar(s, ch);
  }
  return s;
}

/** Delete the last character of the current line. No-op at the start of
 *  a line (v1 does not merge back into the previous line). */
function pasteBackspace(state: PasteState): PasteState {
  if (state.current.length === 0) return state;
  return { lines: state.lines, current: state.current.slice(0, -1) };
}

/** Join the buffer into the final `\n`-separated string. */
function pasteJoin(state: PasteState): string {
  return [...state.lines, state.current].join("\n");
}

type PasteAction =
  | "submit"
  | "cancel"
  | "newline"
  | "backspace"
  | { append: string }
  | null;

/** Map a readline keypress to a paste-mode action. Returns `null` for
 *  keys we ignore in this mode (arrows, function keys, other chords). */
function classifyPasteKey(
  s: unknown,
  key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined,
): PasteAction {
  const name = key?.name;
  if (key?.ctrl && name === "d") return "submit";
  if ((key?.ctrl && name === "c") || name === "escape") return "cancel";
  if (name === "return" || name === "enter") return "newline";
  if (name === "backspace") return "backspace";
  if (typeof s === "string" && s.length > 0 && !key?.ctrl && !key?.meta) {
    return { append: s };
  }
  return null;
}

/** Drive an inline multi-line editor by hijacking `rl._ttyWrite`.
 *  Resolves with the joined buffer on Ctrl+D, or `null` on Ctrl+C /
 *  Esc. Restores the previous `_ttyWrite` (e.g. the slash-trigger
 *  wrapper) on exit. */
function readMultiline(
  rl: readline.Interface,
  useColor: boolean,
): Promise<string | null> {
  const out = process.stdout;
  const rlAny = rl as unknown as {
    _ttyWrite: (s: unknown, key: unknown) => void;
  };
  const dim = useColor ? DIM : "";
  const reset = useColor ? COLOR_RESET : "";
  const CONT = `${dim}… ${reset}`;
  let state: PasteState = EMPTY_PASTE;

  // We are usually entered straight after the `/` slash palette, which
  // runs `prompts.autocomplete` and leaves the TTY in *canonical* mode
  // (raw mode off) — and there is no `rl.question` between it and us to
  // re-assert raw. In canonical mode Ctrl+D is an EOF, not a keystroke:
  // it would close stdin instead of reaching our handler, leaving this
  // promise unsettled (the agent then dies with "unsettled top-level
  // await"). Force raw mode on for the duration so Ctrl+D is delivered
  // as a key. `rl.question` re-asserts raw on the next prompt, and
  // `rl.close()` restores the terminal on exit, so we leave it on.
  const stdin = process.stdin as NodeJS.ReadStream & {
    setRawMode?: (mode: boolean) => void;
  };
  if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);

  out.write(
    `${dim}── paste mode · Enter: newline · Ctrl+D: submit · Ctrl+C: cancel ──${reset}\n`,
  );
  out.write(CONT);

  return new Promise<string | null>((resolve) => {
    const original = rlAny._ttyWrite;
    // Defense in depth: if the interface closes while we're editing
    // (e.g. a real stdin EOF), settle rather than hang forever.
    const onClose = (): void => finish(pasteJoin(state));
    const finish = (val: string | null): void => {
      rlAny._ttyWrite = original;
      rl.off("close", onClose);
      out.write("\n");
      resolve(val);
    };
    rl.once("close", onClose);
    rlAny._ttyWrite = (s: unknown, key: unknown): void => {
      const action = classifyPasteKey(
        s,
        key as { name?: string; ctrl?: boolean; meta?: boolean } | undefined,
      );
      if (action === "submit") return finish(pasteJoin(state));
      if (action === "cancel") return finish(null);
      if (action === "newline") {
        state = pasteChar(state, "\n");
        out.write(`\n${CONT}`);
        return;
      }
      if (action === "backspace") {
        if (state.current.length > 0) {
          state = pasteBackspace(state);
          out.write("\b \b");
        }
        return;
      }
      if (action && typeof action === "object") {
        // A pasted chunk can arrive as one event with embedded newlines;
        // normalize line endings so `\r\n` doesn't double-break (matches
        // `pasteText`), then echo char-by-char to keep screen + buffer
        // in sync.
        const normalized = action.append.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        for (const ch of normalized) {
          if (ch === "\n") {
            state = pasteChar(state, "\n");
            out.write(`\n${CONT}`);
          } else {
            state = pasteChar(state, ch);
            out.write(ch);
          }
        }
      }
    };
  });
}

/** Test-only surface for the `/paste` editor. Mirrors the `_internal`
 *  convention used by other stdlib-lib modules (e.g. `layout.ts`) so
 *  these helpers stay out of the supported `agency-lang/stdlib-lib` API
 *  while remaining unit-testable. Not for production use. */
export const _internal = {
  EMPTY_PASTE,
  pasteChar,
  pasteText,
  pasteBackspace,
  pasteJoin,
  classifyPasteKey,
  readMultiline,
};

export function _clearScreen(): void {
  // ANSI escape code to clear the screen and move the cursor to the top-left.
  //  process.stdout.write("\033[H\033[2J");
  process.stdout.write('\x1B[2J\x1B[H');
}

export function _termWidth(): number {
  return process.stdout.columns || 80;
}