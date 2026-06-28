import * as readline from "readline";
import process from "process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "fs";
import { dirname } from "path";
import { __call } from "../runtime/call.js";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { modifiers, RESET, styles } from "@/utils/termcolors.js"
import { color, colors, bgColors } from "../utils/termcolors.js";
import { _promptsAutocomplete } from "./ui.js";
import { isFailure } from "../runtime/result.js";
import { isAbortError, makeAbortCause } from "../runtime/errors.js";
import type { AbortCause } from "../runtime/errors.js";
import { normalizeModelUsage } from "../runtime/utils.js";
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

/** One-line summary of a multi-line buffer: its first line + a line count.
 *  Shared by the recall preview stored in history and the submit banner, so a
 *  recalled paste renders identically to when it was first pasted. */
function summarizeMultiline(text: string): string {
  const lines = text.split("\n");
  return `${lines[0]} … (${lines.length} lines)`;
}

/** A history entry on disk: a plain string (ordinary single-line input) or a
 *  collapsed multi-line paste stored as `{ preview, text }` — `preview` is the
 *  one-line form shown in readline recall, `text` the full buffer resubmitted
 *  on Enter. We never store a raw multi-line string in readline's history,
 *  because Node `readline` renders/recalls an embedded-newline line buffer
 *  incorrectly (the banner collides with its half-cleared rows). */
type HistoryRecord = string | { preview: string; text: string };

/** What `loadHistory` returns: the readline display list (newest-first, capped)
 *  plus a map from a collapsed paste's preview line back to its full text. */
type LoadedHistory = { entries: string[]; expansions: Record<string, string> };

/** Read `historyFile` (a JSON array of `HistoryRecord`s, oldest first) into the
 *  shape Node's `readline` expects: display entries newest-first, capped at
 *  `max`, plus the preview→full-text map for collapsed pastes. JSON (rather
 *  than one-entry-per-line) so a paste with embedded newlines round-trips
 *  instead of splitting into bogus entries. Returns empties on any I/O or parse
 *  error (or a non-array file) so a corrupt or missing file never breaks
 *  startup. */
function loadHistory(file: string, max: number): LoadedHistory {
  const empty: LoadedHistory = { entries: [], expansions: {} };
  if (!file || !existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return empty;
    const entries: string[] = [];
    const expansions: Record<string, string> = {};
    for (const rec of parsed) {
      if (typeof rec === "string") {
        entries.push(rec);
      } else if (rec && typeof rec.preview === "string" && typeof rec.text === "string") {
        entries.push(rec.preview);
        expansions[rec.preview] = rec.text;
      }
    }
    // Disk is oldest-first; readline wants newest-first, capped.
    return { entries: entries.reverse().slice(0, max), expansions };
  } catch {
    return empty;
  }
}

/** Persist `history` (readline's newest-first order) to `file` as a JSON array
 *  of `HistoryRecord`s stored oldest-first, so re-loading yields identical
 *  chronology. An entry present in `expansions` is written as `{ preview, text }`
 *  so a collapsed paste round-trips with its full buffer; every other entry is
 *  written as a plain string. Creates parent dirs as needed. Swallows errors so
 *  a read-only HOME doesn't crash the REPL on exit. */
function saveHistory(
  file: string,
  history: string[],
  max: number,
  expansions: Record<string, string> = {},
): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const oldestFirst = history.slice(0, max).slice().reverse();
    const records: HistoryRecord[] = oldestFirst.map((entry) =>
      Object.prototype.hasOwnProperty.call(expansions, entry)
        ? { preview: entry, text: expansions[entry] }
        : entry,
    );
    const data = JSON.stringify(records, null, 2) + "\n";
    // Write to a sibling temp file, then rename into place. The rename is an
    // atomic swap (POSIX, and Windows via libuv's REPLACE_EXISTING), so a crash
    // mid-write can't leave a half-written file — which, as JSON, would parse to
    // empty and silently wipe the user's history on the next load.
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, file);
  } catch {
    // Ignore — best-effort persistence.
  }
}

/** Record a just-submitted `/paste` buffer into readline `history` for recall.
 *  A multi-line buffer is stored as a one-line preview (its full text kept in
 *  `expansions`) so readline never recalls a multi-line line buffer; a
 *  single-line buffer is stored verbatim. */
function recordPasteEntry(
  history: string[],
  buffer: string,
  expansions: Record<string, string>,
): void {
  if (buffer.includes("\n")) {
    const preview = summarizeMultiline(buffer);
    recordHistoryEntry(history, preview, "/paste");
    expansions[preview] = buffer;
  } else {
    recordHistoryEntry(history, buffer, "/paste");
  }
}

/** Make `entry` the most-recent item in `history` (readline's newest-first
 *  array), removing the `command` readline added for it (e.g. `/paste`, which
 *  triggered the multi-line editor) and any earlier duplicate of `entry`. This
 *  is how a pasted buffer reaches up-arrow recall and persistence — readline
 *  never sees the buffer itself, only the `/paste` keystrokes. */
function recordHistoryEntry(history: string[], entry: string, command: string): void {
  for (let i = history.length - 1; i >= 0; i--) {
    // `command` is matched after trimming because readline stores the raw line
    // (`"/paste   "`), while the command itself is the trimmed form. `entry`
    // (the pasted buffer) is matched exactly — its surrounding whitespace is
    // content.
    if (history[i] === entry || history[i].trim() === command) history.splice(i, 1);
  }
  history.unshift(entry);
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

/** Open the slash palette and repair readline history around it. Selecting a
 *  command via the palette otherwise litters history with junk: the `/` trigger
 *  commits `"/"`, and the modal's filter keystrokes leak through the shared
 *  stdin so the confirming Enter commits a fragment like `"pa"` too. `mark` is
 *  where history stood the instant `/` was pressed (captured by the trigger);
 *  everything added since is rolled back, and on a pick the chosen command
 *  (e.g. `"/paste"`) is recorded instead — one clean entry. Returns the picked
 *  command, or null if cancelled. */
async function pickFromSlashPalette(
  rl: readline.Interface,
  palette: [string, string][],
  mark: number,
): Promise<string | null> {
  const picked = await openSlashPalette(palette);
  const history = (rl as unknown as { history?: string[] }).history;
  if (history) repairSlashHistory(history, mark, picked);
  return picked;
}

/** Roll back the entries the slash palette polluted — `"/"` plus any leaked
 *  filter keystrokes, i.e. everything added since `mark` — and, when a command
 *  was picked, record it as one clean entry. `history` is readline's
 *  newest-first array, mutated in place. A `mark` of -1 (no trigger fired)
 *  skips the rollback. */
function repairSlashHistory(history: string[], mark: number, picked: string | null): void {
  if (mark >= 0) {
    // Newest-first array, so entries added since `mark` sit at the front.
    history.splice(0, Math.max(0, history.length - mark));
  }
  if (picked != null) recordHistoryEntry(history, picked, picked);
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
  onTrigger: () => void,
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
      // Mark where history stands *before* the synthesized submit commits "/",
      // so the bare-`/` branch can roll back that "/" plus any palette-filter
      // keystrokes that leak in while the modal is open.
      onTrigger();
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
  cancel: (r?: string, cause?: AbortCause) => void;
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
  // Distinct models that did work during the turn, ordered by spend
  // descending (most expensive first). Empty when no model is known.
  models: string[];
};

/** Cumulative per-model token+cost totals, keyed by model name. */
type ModelTotals = Record<string, { tokens: number; cost: number }>;

type TokenSnapshot = {
  inputTokens: number;
  outputTokens: number;
  models: ModelTotals;
};

/** Read the cumulative input/output token counts (and per-model
 *  breakdown) from the active RuntimeContext's GlobalStore. Returns
 *  zeros when no context is active or the token-stats slot is missing
 *  (defensive — `_runLineRepl` always runs inside a context, but tests
 *  sometimes don't). */
function readTokenSnapshot(): TokenSnapshot {
  const empty: TokenSnapshot = { inputTokens: 0, outputTokens: 0, models: {} };
  try {
    const { ctx } = getRuntimeContext();
    const stats = ctx?.globals?.getTokenStats?.();
    if (!stats || typeof stats !== "object") return empty;
    // Per-model breakdown (updateTokenStats). Snapshotted so the footer
    // can diff before/after and list the models used *this turn*. Shares
    // the defensive field-narrowing in `normalizeModelUsage`.
    const models: ModelTotals = {};
    for (const m of normalizeModelUsage((stats as { models?: unknown }).models)) {
      models[m.model] = { tokens: m.inputTokens + m.outputTokens, cost: m.cost };
    }
    const usage = (stats as { usage?: Record<string, unknown> }).usage;
    if (!usage || typeof usage !== "object") {
      return { inputTokens: 0, outputTokens: 0, models };
    }
    return {
      inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
      outputTokens:
        typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
      models,
    };
  } catch {
    return empty;
  }
}

/** Distinct models whose token count grew between two snapshots, ordered
 *  by cost spent during the turn (descending), name as tiebreak. This is
 *  what the footer lists after the per-turn token/time stats. */
function modelsUsedThisTurn(before: TokenSnapshot, after: TokenSnapshot): string[] {
  const used: { name: string; cost: number }[] = [];
  for (const [name, a] of Object.entries(after.models)) {
    const b = before.models[name];
    const tokenDelta = a.tokens - (b?.tokens ?? 0);
    const costDelta = a.cost - (b?.cost ?? 0);
    // A model "did work this turn" if its tokens OR cost grew. With
    // current providers every call adds tokens, so the cost check is a
    // belt-and-suspenders guard against a (hypothetical) zero-token but
    // non-zero-cost call being silently dropped from the footer.
    if (tokenDelta > 0 || costDelta > 0) used.push({ name, cost: costDelta });
  }
  used.sort((x, y) => y.cost - x.cost || (x.name < y.name ? -1 : 1));
  return used.map((u) => u.name);
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

/** Render the per-turn model list for the footer. The list is already
 *  ordered by spend descending; we show at most `FOOTER_MODEL_CAP` and
 *  collapse the rest to `+N more` so a turn that touched many models
 *  can't blow out the single-line footer. (Use `/cost` for the full
 *  per-model breakdown.) */
const FOOTER_MODEL_CAP = 3;
// Known GGUF quantization suffixes (e.g. `.Q4_K_M`, `.Q8_0`, `.IQ4_XS`, `.F16`).
// Conservative on purpose: only strip a trailing segment that clearly names a
// quant, so a real model-name segment (e.g. `…-v1.5`, `…-7B`) is left intact.
const QUANT_SUFFIX = /\.(?:I?Q\d[\w]*|F16|F32|BF16)$/i;

/** A readable footer label for a model. Hosted model IDs pass through
 *  unchanged; a local GGUF path/filename is reduced to its model name —
 *  `…/hf_unsloth_SmolLM2-135M-Instruct.Q4_K_M.gguf` → `SmolLM2-135M-Instruct` —
 *  by taking the basename and dropping node-llama-cpp's `hf_<user>_` prefix,
 *  the `.gguf` extension, and the quant suffix. */
function prettyModel(name: string): string {
  if (!name.endsWith(".gguf")) return name;
  const base = (name.split(/[\\/]/).pop() ?? name).replace(/\.gguf$/, "");
  return base.replace(/^hf_[^_]+_/, "").replace(QUANT_SUFFIX, "");
}

function fmtModels(models: string[]): string {
  const pretty = models.map(prettyModel);
  if (pretty.length <= FOOTER_MODEL_CAP) return pretty.join(", ");
  const shown = pretty.slice(0, FOOTER_MODEL_CAP).join(", ");
  return `${shown} +${pretty.length - FOOTER_MODEL_CAP} more`;
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
    if (turn.models.length > 0) stats += ` · ${fmtModels(turn.models)}`;
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
  const { entries: initialHistory, expansions } = loadHistory(historyFile, historyMax);
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

  // Register a "clear history" hook so a command handler (e.g. the agent's
  // `/clear-history`) can wipe this session's *live* recall. The hook only
  // touches `rl.history` — a Node object owned by this running readline, which
  // can't live anywhere but TS. The persisted *file* is cleared separately by
  // `_clearHistory`, using a path Agency holds as a module global (so the file
  // identity lives in the execution model, not in this closure). Same
  // install/restore lifecycle as the hooks above.
  const clearHistoryKey = "__agencyClearHistory";
  const prevClearHistory = (globalThis as any)[clearHistoryKey];
  (globalThis as any)[clearHistoryKey] = () => {
    const h = (rl as unknown as { history?: string[] }).history;
    if (h) h.length = 0;
    // Drop the collapsed-paste expansions too, so a cleared history can't
    // resurrect a paste's full text on the next recall.
    for (const k of Object.keys(expansions)) delete expansions[k];
  };

  // `/` at an empty prompt synthesizes Enter so the bare-`/` branch
  // in the loop body fires immediately and opens the palette modal. The
  // trigger records where history stood the instant `/` was pressed, so the
  // branch can roll back the junk entries the palette would otherwise leave.
  let slashHistoryMark = -1;
  const teardownSlashTrigger = installSlashTrigger(rl, palette, useTTY, () => {
    const h = (rl as unknown as { history?: string[] }).history;
    slashHistoryMark = h ? h.length : 0;
  });
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
      // A recalled multi-line paste comes back as its one-line preview (that's
      // all readline ever held for it); expand it to the full buffer so the
      // turn and the banner see the original text. Storing the preview rather
      // than the raw buffer is what keeps readline from ever recalling a
      // multi-line line buffer — which it renders incorrectly, colliding with
      // the banner.
      if (Object.prototype.hasOwnProperty.call(expansions, line)) {
        line = expansions[line];
        trimmed = line.trim();
      }
      // Bare `/` opens the slash-command palette via
      // `prompts.autocomplete` — the same modal the interrupt UI
      // uses, so palette and policy menus look and feel identical.
      // The `/` key fires this branch immediately (no Enter needed)
      // via `installSlashTrigger`'s `_ttyWrite` hook above; users can
      // also type `/` + Enter manually. The picked command is fed
      // back through the normal onSubmit path; cancel just reprompts.
      if (trimmed === "/" && palette.length > 0) {
        const picked = await pickFromSlashPalette(rl, palette, slashHistoryMark);
        slashHistoryMark = -1;
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
        // readline only saw the `/paste` keystrokes, not the buffer the editor
        // produced — so add it to history ourselves (replacing the `/paste`
        // command entry) for up-arrow recall and persistence. A multi-line
        // buffer goes in as a one-line *preview*, with the full text kept in
        // `expansions`, so readline never recalls a multi-line line buffer.
        const rlHistory = (rl as unknown as { history?: string[] }).history;
        if (rlHistory) recordPasteEntry(rlHistory, buffer, expansions);
      }

      const banner = line.includes("\n")
        ? ` User: ${summarizeMultiline(line)} \n`
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
        // Esc is a recoverable interrupt: stop this turn's work and hand
        // control back, but keep the REPL session alive (vs a terminal
        // userKill from TS `cancel()`).
        turnCtx?.cancel(
          "cancelled by user",
          makeAbortCause({ kind: "userInterrupt" }),
        );
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
          models: modelsUsedThisTurn(tokensBefore, tokensAfter),
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
        models: modelsUsedThisTurn(tokensBefore, tokensAfter),
      });
    }
  } finally {
    teardownSlashTrigger();
    (globalThis as any)[overrideKey] = prevOverride;
    (globalThis as any)[stopSpinnerKey] = prevStopSpinner;
    (globalThis as any)[clearHistoryKey] = prevClearHistory;
    // Persist whatever entries readline accumulated. `rl.history` is
    // newest-first and already contains the history we loaded at startup
    // PLUS everything added this session (including any `/paste` buffer we
    // recorded above) — so saving it preserves prior sessions instead of
    // overwriting the file with just this run's input. The `history` property
    // is undocumented-ish but stable across the Node versions we support, and
    // is the only way to read it back. Collapsed pastes are fine: their full
    // text rides along in `expansions` and is written as `{ preview, text }`.
    const accumulated = (rl as unknown as { history?: string[] }).history ?? [];
    saveHistory(historyFile, accumulated, historyMax, expansions);
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
  modelsUsedThisTurn,
  fmtModels,
  prettyModel,
  loadHistory,
  saveHistory,
  recordHistoryEntry,
  recordPasteEntry,
  repairSlashHistory,
  summarizeMultiline,
};

export function _clearScreen(): void {
  // ANSI escape code to clear the screen and move the cursor to the top-left.
  //  process.stdout.write("\033[H\033[2J");
  process.stdout.write('\x1B[2J\x1B[H');
}

/** Clear `repl()` input history. Splits cleanly along the state boundary:
 *
 *  - The persisted *file* is cleared at `path`, which the caller supplies.
 *    Agency holds the path as a module global (`_historyFile`), so the file's
 *    identity lives in the execution model rather than in a TS closure. Works
 *    even with no active REPL; `saveHistory` no-ops on an empty path.
 *  - The *live* in-session recall (`rl.history`) is a Node object owned by the
 *    running readline, so that wipe goes through the `__agencyClearHistory`
 *    hook `_runLineRepl` installs. A no-op outside an interactive REPL. */
export function _clearHistory(path: string): void {
  saveHistory(path, [], 0);
  const fn = (globalThis as any).__agencyClearHistory;
  if (typeof fn === "function") fn();
}

export function _termWidth(): number {
  return process.stdout.columns || 80;
}