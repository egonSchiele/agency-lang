import type { DebugStopData } from "../runtime/debugger.js";
import {
  Screen,
  box,
  row,
  column,
  text,
  escapeStyleTags,
  type Element,
  type Frame,
  type KeyEvent,
} from "@/tui/index.js";
import { readFileSync } from "fs";
import { formatTypeHint } from "../utils/formatType.js";
import type { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { FunctionParameter } from "../types.js";
import {
  RequestWithdrawn,
  type BusyEntry,
  type DebuggerCommand,
  type DebuggerIO,
  type DebuggerMode,
  type Parties,
  type UiCommand,
} from "./types.js";
import type { Hello } from "./attach/protocol.js";
import { UIState } from "./uiState.js";
import { busyText, formatElapsed, type BusyShown } from "./busy.js";
import { coerceArg, formatValue, parseCommandInput } from "./util.js";
import { uniq } from "@/utils.js";
import { syntaxHighlight } from "@/stdlib/syntax.js";
import {
  showRewindSelector,
  showBranchPicker,
  showCheckpointsPanel,
  showGuardTripForm,
  showPalette,
  showThreadPicker,
  type OverlayContext,
} from "./overlays.js";
import { paletteEntries } from "./edits/palette.js";
import type { GuardTripData } from "./guardAnswer.js";
import type { PendingPreview } from "./edits/rows.js";
import { rowsFor, type PaneName, type StopView } from "./edits/rows.js";
import { askLabel, type EditAction } from "./edits/actions.js";
import { parseAmount } from "./guardAnswer.js";
import type { PaneRow } from "./edits/rows.js";
import { bindingsFor, footerHints, type KeyContext, type UiAction } from "./edits/keys.js";
import { findBinding } from "../tui/keymap.js";
import { applyLineEdit, lineEditAction } from "../tui/lineEditor.js";
import type { ThreadMessage } from "../runtime/state/checkpointStore.js";

const LIST_PANES: PaneName[] = ["threads", "locals", "globals", "callStack", "branches", "guards"];

/** The rows of `pane`, or none for a pane that lists no rows. */
function rowsForPane(pane: string, view: StopView) {
  return LIST_PANES.includes(pane as PaneName) ? rowsFor(pane as PaneName, view) : [];
}

/** The words for a guard amount that did not parse. */
function amountHint(dimension: "cost" | "time"): string {
  return dimension === "cost"
    ? "type an amount in dollars, such as 0.5."
    : "type a duration, such as 30s, 2m, or 500 for milliseconds.";
}

/** A typed value as JSON when it parses, else the text as typed. */
function parseJsonOrText(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
import type { InterruptResponse } from "../runtime/interrupts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const fileCache: Record<string, string> = {};
// Caches highlighted source as an array of lines so we don't re-run the
// (relatively expensive) syntax highlighter on every keypress.
const highlightedLineCache: Record<string, string[]> = {};

function readSourceFile(filePath: string): string {
  if (fileCache[filePath]) return fileCache[filePath];
  try {
    const content = readFileSync(filePath, "utf-8");
    fileCache[filePath] = content;
    return content;
  } catch {
    const fallback = "(source file not found)";
    fileCache[filePath] = fallback;
    return fallback;
  }
}

function readHighlightedSourceLines(filePath: string): string[] {
  const cached = highlightedLineCache[filePath];
  if (cached) return cached;
  const content = readSourceFile(filePath);
  // syntaxHighlight returns ANSI-styled text. Split into lines first so
  // that downstream per-line formatting (line numbers, current-line marker)
  // is straightforward; the renderer's ANSI passthrough handles the styling.
  const highlighted = syntaxHighlight(content, "agency").split("\n");
  highlightedLineCache[filePath] = highlighted;
  return highlighted;
}

function commandBarContent(quit: "quit" | "detach"): string {
  return Object.entries({
    s: "step",
    n: "next",
    i: "in",
    o: "out",
    c: "continue",
    r: "rewind",
    d: "checkpoints",
    k: "checkpoint",
    p: "print",
    q: quit,
    ["(:)"]: "cmd",
  })
    .map(([key, action]) => `{bold}(${key}){/bold}${action}`)
    .join(" ");
}

const COMMAND_BAR_CONTENT = commandBarContent("quit");
/** Attached, `q` leaves the program running, and the bar says so. */
const ATTACHED_COMMAND_BAR_CONTENT = commandBarContent("detach");

/** The keys that pause a running program at its next statement. Space
 *  is `continue` at a stop, so it is the one key that toggles: space to
 *  let the program run, space to stop it. `s` and `n` pause too, so a
 *  step typed a moment before the program stops means the same thing. */
const PAUSE_KEYS = [" ", "s", "n"];

/** Keys that map directly to a command with no additional logic. */
const SIMPLE_KEYS: Record<string, DebuggerCommand> = {
  s: { type: "step" },
  right: { type: "step" },
  n: { type: "next" },
  i: { type: "stepIn" },
  o: { type: "stepOut" },
  " ": { type: "continue" },
  c: { type: "continue" },
  r: { type: "rewind" },
  d: { type: "showCheckpoints" },
  escape: { type: "quit" },
  q: { type: "quit" },
};

// ---------------------------------------------------------------------------
// Pane definition
// ---------------------------------------------------------------------------

type PaneSlot = {
  name: string;
  color: string;
  label: string;
  content: () => string;
};

// ---------------------------------------------------------------------------
// DebuggerUI
// ---------------------------------------------------------------------------

export class DebuggerUI implements DebuggerIO {
  private screen: Screen;
  public state: UIState;
  public prevState: UIState | null = null;

  private focusIndex = 0;
  private zoomedPane: string | null = null;
  /** The thread the threads pane shows; the active one when unset. */
  private threadDisplayId: string | undefined = undefined;
  private scrollOffsets: Record<string, number> = {};
  /** The row under the cursor in each pane that lists rows. */
  private cursor: Record<string, number> = {};
  /** The composer under the thread: open takes typing; the draft stays
   *  when it is closed. */
  private composer = { open: false, draft: "" };

  // Spinner
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerText = "";

  // Command bar overrides
  private commandBarOverride: string | null = null;
  private inputPrompt: string | null = null;
  private inputValue = "";

  /** Set when this UI drives a program in another process
   *  (`agency debug --attach`): what the run said about itself, for the
   *  status line. */
  private attached: Hello | null = null;
  private quitListeners: (() => void)[] = [];
  private pauseListeners: (() => void)[] = [];
  /** Set from the pause key until the next stop, for the bar. */
  private pausing = false;

  // One reader of the key stream. `TerminalInput.nextKey()` queues its
  // waiters, so two readers, one for the person at a stop and one for
  // the pause key while the program runs, would hand a key to a stale
  // waiter. So there is one in-flight `nextKey()` (`pendingKey`), and
  // `dispatch` gives each key to whoever is current: the person waiting
  // in `readKey`, else, while the program runs, the pause listeners for
  // a stepping key and the quit listeners for `q`, else the held list,
  // which the person's next read drains first, so `c` pressed while
  // running is acted on at the next stop, in order.
  private pendingKey: Promise<void> | null = null;
  private personWaiter: {
    resolve: (key: KeyEvent) => void;
    reject: (error: Error) => void;
  } | null = null;
  /** Set by `withdraw` while the request it is for is between reads. */
  private withdrawn = false;
  /** Who else is on the run, attached; shown on the stats line. */
  private parties: Parties | null = null;
  private heldKeys: KeyEvent[] = [];
  private waitingListeners: (() => void)[] = [];

  lastFrame: Frame | null = null;
  /** The clock the elapsed figures count on; a test injects its own. */
  private readonly now: () => number;

  constructor(screen: Screen, opts: { now?: () => number } = {}) {
    this.screen = screen;
    this.state = new UIState();
    this.now = opts.now ?? (() => Date.now());
  }

  // --- Formatting helpers ---

  private formatKeyVal(key: string, value: unknown, opts: { highlight?: boolean } = {}): string {
    const formatted = `${escapeStyleTags(key)} = ${escapeStyleTags(formatValue(value))}`;
    return opts.highlight ? `{yellow-fg}${formatted}{/yellow-fg}` : formatted;
  }

  // --- Pane definitions ---

  private getPanes(): PaneSlot[] {
    const moduleId = this.state.getModuleId();
    const threadData = this.state.getThreadMessages(this.threadDisplayId);

    const panes: PaneSlot[] = [
      {
        name: "source",
        color: "cyan",
        label: ` source: ${escapeStyleTags(moduleId)} `,
        content: () => this.buildSourceContent(),
      },
    ];

    if (threadData && threadData.messages.length > 0) {
      const countLabel =
        threadData.threadCount > 1
          ? ` [${threadData.threadIndex + 1}/${threadData.threadCount}]`
          : "";
      const name = threadData.label ?? `id: ${threadData.threadId}`;
      panes.push({
        name: "threads",
        color: "cyan",
        label: ` threads: ${escapeStyleTags(name)}${countLabel} `,
        content: () => this.buildThreadsContent(),
      });
    }

    panes.push(
      {
        name: "locals",
        color: "green",
        label: " locals ",
        content: () => this.buildLocalsContent(),
      },
      {
        name: "globals",
        color: "green",
        label: ` globals: ${escapeStyleTags(this.state.getGlobalsModuleId())} `,
        content: () => this.buildGlobalsContent(),
      },
      {
        name: "callStack",
        color: "magenta",
        label: " call stack ",
        content: () => this.buildCallStackContent(),
      },
    );
    if (this.state.listBranches().length > 0) {
      panes.push({
        name: "branches",
        color: "magenta",
        label: " branches ",
        content: () => this.buildBranchesContent(),
      });
    }
    if (this.state.listGuards().length > 0 || this.state.loopState() !== null) {
      panes.push({
        name: "guards",
        color: "magenta",
        label: " guards ",
        content: () => this.buildGuardsContent(),
      });
    }
    panes.push(
      {
        name: "activity",
        color: "yellow",
        label: " activity ",
        content: () => this.buildActivityContent(),
      },
      {
        name: "stdout",
        color: "blue",
        label: " stdout ",
        content: () => this.buildStdoutContent(),
      },
    );

    return panes;
  }

  // --- Content builders ---

  private buildSourceContent(): string {
    const moduleId = this.state.getModuleId();
    const currentLine = this.state.getCurrentLine();
    const filePath = this.state.resolveModulePath(moduleId, [".agency"]) ?? moduleId;
    const lines = readHighlightedSourceLines(filePath);
    // The lines the program is waiting on in this module, and the one
    // the bar names, which carries the elapsed figure.
    const waits = this.busyLines(moduleId);
    const named = waits.at(-1);

    const windowSize = 20;
    const focus = currentLine > 0 ? currentLine : (named?.line ?? 1);
    const center = focus - 1;
    const start = Math.max(0, center - Math.floor(windowSize / 2));
    const end = Math.min(lines.length, start + windowSize);

    return lines
      .slice(start, end)
      .map((line, i) => {
        const lineNum = start + i + 1;
        const numStr = String(lineNum).padStart(4, " ");
        // The highlighted line already contains ANSI escapes for styling.
        // escapeStyleTags only escapes literal `{` / `}` characters; ANSI
        // sequences (which contain `[` and `m`, not braces) pass through
        // unchanged and are picked up by the renderer's ANSI parser.
        const lineText = escapeStyleTags(line);
        // The stop's line first: the next statement to run is here, and
        // the person can act on it. A wait's line is where execution is
        // somewhere inside the statement.
        if (currentLine !== null && lineNum === currentLine) {
          return `{magenta-bg}{bold}> ${numStr}  ${lineText}{/bold}{/magenta-bg}`;
        }
        if (waits.some((wait) => wait.line === lineNum)) {
          const figure =
            named?.line === lineNum
              ? `  {bold}${formatElapsed(this.now() - named.shown.since)}{/bold}`
              : "";
          return `{blue-bg}▶ ${numStr}  ${lineText}${figure}{/blue-bg}`;
        }
        return `  ${numStr}  ${lineText}`;
      })
      .join("\n");
  }

  /** The open waits in `moduleId` whose line the UI knows, the one that
   *  began last at the end. */
  private busyLines(moduleId: string): { shown: BusyShown; line: number }[] {
    const lines: { shown: BusyShown; line: number }[] = [];
    for (const shown of this.state.getBusy()) {
      if (shown.entry.location.moduleId !== moduleId) continue;
      const line = this.state.lineFor(shown.entry.location);
      if (line !== undefined) lines.push({ shown, line });
    }
    return lines;
  }

  /** What the program is waiting on, as one line: the wait that began
   *  last, and how many others are open. Empty when nothing is. */
  private busyBarText(): string {
    const busy = this.state.getBusy();
    const last = busy.at(-1);
    if (last === undefined) return "";
    const line = this.state.lineFor(last.entry.location);
    const more = busy.length > 1 ? ` · +${busy.length - 1} more` : "";
    return `${escapeStyleTags(busyText(last, line, this.now()))}${more}`;
  }

  private buildThreadsContent(): string {
    const threadData = this.state.getThreadMessages(this.threadDisplayId);
    if (!threadData) return "";
    const isZoomed = this.zoomedPane === "threads";
    const line = (m: ThreadMessage, role: string) => {
      const display =
        isZoomed || m.content.length <= 200 ? m.content : m.content.slice(0, 197) + "...";
      const mark = m.pending ? " {yellow-fg}(pending){/yellow-fg}" : "";
      return `  {bold}[${escapeStyleTags(role)}]{/bold} ${escapeStyleTags(display)}${mark}`;
    };
    const lines = [
      ...threadData.messages.map((m) => line(m, m.role)),
      ...threadData.queued.map((m) => line(m, `queued ${m.role}`)),
    ];
    const composer = this.composerLine();
    if (composer !== null) lines.push(composer);
    return lines.join("\n");
  }

  /** The composer, under the thread's messages: the draft with a
   *  cursor while open, the draft or an invitation while closed; none
   *  before a stop. */
  private composerLine(): string | null {
    if (this.state.getStopView() === null) return null;
    const draft = escapeStyleTags(this.composer.draft);
    if (this.composer.open) return `> ${draft}\u2588`;
    if (this.composer.draft !== "") return `{gray-fg}> ${draft}{/gray-fg}`;
    return "{gray-fg}> say something to the model\u2026{/gray-fg}";
  }

  /** The pane's lines with the cursor's row marked, while the pane is
   *  focused and has a stop to act on. */
  private withCursor(pane: string, lines: string[]): string {
    if (this.focusedPaneName() !== pane || this.state.getStopView() === null) {
      return lines.join("\n");
    }
    const at = this.cursorIndex(pane);
    return lines
      .map((text, index) => (index === at ? `{cyan-fg}\u25b8{/cyan-fg}${text.slice(1)}` : text))
      .join("\n");
  }

  private cursorIndex(pane: string): number {
    const view = this.state.getStopView();
    const count = view === null ? 0 : rowsForPane(pane, view).length;
    return Math.max(0, Math.min(this.cursor[pane] ?? 0, count - 1));
  }

  /** The pane under focus, by name. */
  focusedPaneName(): string | undefined {
    return this.getPanes()[this.focusIndex]?.name;
  }

  private buildLocalsContent(): string {
    const lines = [...this.state.getArgs(), ...this.state.getLocals()].map(
      (e) =>
        " " +
        this.formatKeyVal(e.key, e.override ?? e.value, {
          highlight: e.override !== undefined,
        }),
    );
    return this.withCursor("locals", lines);
  }

  private buildGlobalsContent(): string {
    const lines = this.state.getGlobals().map(
      (g) =>
        " " +
        this.formatKeyVal(g.key, g.override ?? g.value, {
          highlight: g.override !== undefined,
        }),
    );
    return this.withCursor("globals", lines);
  }

  private buildCallStackContent(): string {
    const view = this.state.getStopView();
    const rows = view === null ? [] : rowsFor("callStack", view);
    const frames = rows.filter((row) => row.kind === "frame");
    const lines = rows.map((row) => {
      if (row.kind === "tool") {
        const note = row.removed ? " (removed)" : "";
        return `       ${escapeStyleTags(row.name)}${note}`;
      }
      if (row.kind !== "frame") return "";
      const prefix = row === frames.at(-1) ? " > " : "   ";
      const fileName = row.moduleId.split("/").pop() || row.moduleId;
      const where = fileName ? ` (${escapeStyleTags(fileName)})` : "";
      return `${prefix}${escapeStyleTags(row.scopeName)}${where}`;
    });
    return this.withCursor("callStack", lines);
  }

  /** One line per branch: its status, its label, and the owner it runs
   *  under; the branch being viewed is marked. */
  private buildBranchesContent(): string {
    const viewed = this.state.getLocation()?.branchPath ?? [];
    const lines = this.state.listBranches().map((branch) => {
      const marker = branch.path.join("/") === viewed.join("/") ? ">" : " ";
      const indent = "  ".repeat(branch.path.length - 1);
      return ` ${marker} ${indent}${escapeStyleTags(branch.label)} [${branch.status}] under ${escapeStyleTags(branch.owner)}`;
    });
    return this.withCursor("branches", lines);
  }

  /** The tool loop's round and removed tools, then one line per guard:
   *  `research · cost $0.42 of $0.50`. */
  private buildGuardsContent(): string {
    const lines: string[] = [];
    const loop = this.state.loopState();
    if (loop) {
      const removed =
        loop.removedTools.length > 0 ? `; removed: ${loop.removedTools.join(", ")}` : "";
      lines.push(`  tool loop: round ${loop.round}${removed}`);
    }
    for (const guard of this.state.listGuards()) {
      const name = guard.label ?? (guard.root ? "root budget" : "guard");
      const amount =
        guard.dimension === "cost"
          ? `$${Number(guard.spent.toFixed(6))} of $${guard.limit}`
          : `${formatElapsed(guard.spent)} of ${formatElapsed(guard.limit)}`;
      const notes: string[] = [];
      if (guard.disarmed) notes.push("disarmed");
      if (guard.root && guard.label) notes.push("root budget");
      if (guard.inherited) notes.push("this branch");
      const note = notes.length > 0 ? ` (${notes.join(", ")})` : "";
      lines.push(`  ${escapeStyleTags(name)} · ${guard.dimension} ${amount}${note}`);
    }
    return this.withCursor("guards", lines);
  }

  private buildActivityContent(): string {
    return this.state
      .getActivityLog()
      .map((entry) => `  ${escapeStyleTags(entry)}`)
      .join("\n");
  }

  private buildStdoutContent(): string {
    return this.state
      .getStdout()
      .map((line) => `  ${escapeStyleTags(line)}`)
      .join("\n");
  }

  private buildStatsContent(): string {
    const stats = this.state.getTokenStats();
    const cost =
      stats.totalCost === 0
        ? "$0.00"
        : stats.totalCost < 0.0001
          ? "<$0.0001"
          : `$${stats.totalCost.toFixed(4)}`;
    const where =
      this.attached === null
        ? ""
        : ` | attached to ${this.attached.pid} ${escapeStyleTags(this.attached.program)}`;
    const beside =
      this.attached !== null && this.parties?.cli ? " | with agency debug session" : "";
    return `{gray-fg}  tokens: ${stats.totalTokens.toLocaleString()} | cost: ${cost}${where}${beside}{/gray-fg}`;
  }

  /** What the program is waiting on, while it runs and at a stop with a
   *  wait still open (an `async` call in a model request, for one), as
   *  a row of its own under the figures: beside them it was clipped at
   *  80 columns, and the renderer clips a row rather than wrapping it.
   *  The command bar keeps the keys, so the person can see how to
   *  pause. Empty when nothing is open. */
  private buildWaitingContent(): string {
    const busy = this.busyBarText();
    return busy === "" ? "" : `{gray-fg}  waiting: ${busy}{/gray-fg}`;
  }

  // --- Element tree builders ---

  private renderPane(
    pane: PaneSlot,
    focusedName: string | undefined,
    style: Record<string, unknown> = {},
  ): Element {
    const isFocused = focusedName === pane.name;
    return box(
      {
        key: pane.name,
        border: true,
        borderColor: isFocused ? "white" : pane.color,
        label: ` ${escapeStyleTags(pane.label.trim())} `,
        labelColor: isFocused ? "cyan" : pane.color,
        fg: isFocused ? undefined : "gray",
        scrollable: true,
        scrollOffset: this.scrollOffsets[pane.name] || 0,
        ...style,
      },
      text(pane.content()),
    );
  }

  private buildCommandBar(): Element {
    let content: string;
    if (this.inputPrompt !== null) {
      content = `${this.inputPrompt} ${escapeStyleTags(this.inputValue)}\u2588`;
    } else {
      content =
        this.commandBarOverride ||
        this.spinnerText ||
        (this.attached === null ? COMMAND_BAR_CONTENT : ATTACHED_COMMAND_BAR_CONTENT);
    }
    return box({ height: 3, border: true, borderColor: "white", key: "commandBar" }, text(content));
  }

  private buildStatsBar(): Element {
    const lines = [
      this.buildStatsContent(),
      this.buildWaitingContent(),
      this.buildEditsLine(),
    ].filter((line) => line !== "");
    return box({ height: lines.length, key: "stats" }, text(lines.join("\n")));
  }

  /** The edits waiting at the stop, and the keys the focused row takes,
   *  from the same tables that handle them. Empty before a stop. */
  private buildEditsLine(): string {
    const ctx = this.keyContext();
    if (ctx.view === null) return "";
    const count = ctx.pendingCount;
    const pending = count === 0 ? "" : `${count} edit${count === 1 ? "" : "s"} pending`;
    const hints = footerHints(bindingsFor(ctx));
    const parts = [pending, hints].filter((part) => part !== "");
    return parts.length === 0 ? "" : `{gray-fg}  ${parts.join("   ")}{/gray-fg}`;
  }

  /** The one value `action` asks for on `row`, typed in the command bar:
   *  JSON or text, text, or a guard amount, which is parsed with the
   *  row's dimension and asked again with the reason when it does not
   *  parse. Null when the person escapes. */
  private async askValue(action: EditAction, row: PaneRow): Promise<{ value: unknown } | null> {
    if (action.asks === undefined) return { value: undefined };
    let prompt = askLabel(action, row);
    while (true) {
      const raw = await this.enterTextInput(prompt);
      if (raw === null) return null;
      if (action.asks.kind === "json") return { value: parseJsonOrText(raw) };
      if (action.asks.kind === "text") return { value: raw };
      const dimension = row.kind === "guard" ? row.dimension : "cost";
      const amount = parseAmount(dimension, raw);
      if (amount !== null) return { value: amount };
      prompt = `Not "${raw}": ${amountHint(dimension)} ${askLabel(action, row)}`;
    }
  }

  /** The palette: every edit every row offers, filtered by typing. The
   *  entry picked is run the way its key would be, after the cursor has
   *  moved to its row, so the panes show what is being changed. */
  private async openPalette(): Promise<UiCommand | null> {
    const view = this.state.getStopView();
    if (view === null) return null;
    const picked = await showPalette(this.overlayContext(), paletteEntries(view));
    this.renderUI();
    if (picked === null) return null;
    const paneIndex = this.getPanes().findIndex((pane) => pane.name === picked.pane);
    if (paneIndex >= 0) this.focusIndex = paneIndex;
    this.cursor[picked.pane] = picked.rowIndex;
    this.scrollToCursor(picked.pane);
    this.renderUI();
    return await this.carryOut(
      { kind: "runAction", action: picked.action, row: picked.row },
      this.keyContext(),
    );
  }

  /** What the key tables need to know right now. */
  private keyContext(): KeyContext {
    const view = this.state.getStopView();
    const focused = this.focusedPaneName();
    const rows = view === null || focused === undefined ? [] : rowsForPane(focused, view);
    return {
      view,
      focused,
      cursorRow: rows[this.cursorIndex(focused ?? "")],
      composer: this.composer,
      pendingCount: this.state.getPending().edits.length,
    };
  }

  /** Carry out what a key table said, returning the command to send
   *  when there is one. */
  private async carryOut(action: UiAction, ctx: KeyContext): Promise<UiCommand | null> {
    switch (action.kind) {
      case "moveCursor": {
        const pane = ctx.focused ?? "";
        this.cursor[pane] = this.cursorIndex(pane) + action.by;
        this.cursor[pane] = this.cursorIndex(pane);
        this.scrollToCursor(pane);
        this.renderUI();
        return null;
      }
      case "runAction": {
        const { action: edit, row } = action;
        const value = await this.askValue(edit, row);
        if (value === null) return null;
        return { type: "edit", edits: edit.toEdits(row, value.value, ctx.view!) };
      }
      case "openComposer":
        this.composer.open = true;
        this.renderUI();
        return null;
      case "closeComposer":
        this.composer.open = false;
        this.renderUI();
        return null;
      case "sendComposer": {
        const text = this.composer.draft.trim();
        this.composer = { open: false, draft: "" };
        this.renderUI();
        const shown = this.state.getThreadMessages(this.threadDisplayId);
        if (text === "" || !shown) return null;
        return {
          type: "edit",
          edits: [{ op: "appendMessage", thread: { id: shown.threadId }, text }],
        };
      }
      case "dropEdits":
        return { type: "dropEdits" };
    }
  }

  /**
   * Build the top two rows of the standard layout:
   * row 1: source (+ threads if present)
   * row 2: locals, globals, call stack
   */
  buildTopRows(panes: PaneSlot[], focusedName: string | undefined): Element[] {
    const source = panes.find((p) => p.name === "source")!;
    const threads = panes.find((p) => p.name === "threads");

    return [
      row(
        { height: "40%" },
        this.renderPane(source, focusedName, threads ? { width: "65%" } : { flex: 1 }),
        ...(threads ? [this.renderPane(threads, focusedName, { width: "35%" })] : []),
      ),
      row(
        { height: "25%" },
        this.renderPane(
          panes.find((p) => p.name === "locals")!,
          focusedName,
          { width: "40%" },
        ),
        this.renderPane(
          panes.find((p) => p.name === "globals")!,
          focusedName,
          { width: "40%" },
        ),
        this.renderPane(
          panes.find((p) => p.name === "callStack")!,
          focusedName,
          { flex: 1 },
        ),
      ),
    ];
  }

  /** Branches and guards get a row of their own when present, so the
   *  second row keeps its widths and each gets room for a line like
   *  `> search [interrupted] under llm()`. The activity and stdout row
   *  gives up the height. Not part of `buildTopRows`, which the overlays
   *  draw above themselves: a third row there would leave a form no
   *  room on a short terminal. */
  private buildExtrasRow(panes: PaneSlot[], focusedName: string | undefined): Element[] {
    const extras = ["branches", "guards"]
      .map((name) => panes.find((p) => p.name === name))
      .filter((pane) => pane !== undefined);
    if (extras.length === 0) return [];
    return [
      row(
        // A small fixed height, so the activity log keeps its room on a
        // short terminal; `z` zooms a pane that needs more.
        { height: 6 },
        ...extras.map((pane) => this.renderPane(pane, focusedName, { flex: 1 })),
      ),
    ];
  }

  private buildElementTree(): Element {
    const panes = this.getPanes();
    if (this.focusIndex >= panes.length) this.focusIndex = 0;
    const focusedName = panes[this.focusIndex]?.name;

    if (this.zoomedPane) {
      const pane = panes.find((p) => p.name === this.zoomedPane);
      if (pane) {
        return column(
          this.renderPane(pane, focusedName, { flex: 1 }),
          this.buildStatsBar(),
          this.buildCommandBar(),
        );
      }
    }

    return column(
      ...this.buildTopRows(panes, focusedName),
      ...this.buildExtrasRow(panes, focusedName),
      row(
        { flex: 1 },
        this.renderPane(
          panes.find((p) => p.name === "activity")!,
          focusedName,
          { width: "50%" },
        ),
        this.renderPane(
          panes.find((p) => p.name === "stdout")!,
          focusedName,
          { flex: 1 },
        ),
      ),
      this.buildStatsBar(),
      this.buildCommandBar(),
    );
  }

  private renderUI(): Frame {
    const tree = this.buildElementTree();
    const frame = this.screen.render(tree);
    this.lastFrame = frame;
    return frame;
  }

  /** Show thread `id`. Picking the active thread means following it,
   *  so the pane moves with the program again. */
  private showThread(id: string): void {
    const active = this.state.listThreads().find((thread) => thread.active)?.id;
    this.threadDisplayId = id === active ? undefined : id;
  }

  /** This UI now drives the program the run described. While attached,
   *  only `q` quits (`escape` would detach by accident), and quitting
   *  tells `onQuit` listeners first. */
  attachedTo(hello: Hello): void {
    this.attached = hello;
    this.renderUI();
  }

  onQuit(listener: () => void): void {
    this.quitListeners.push(listener);
  }

  onPause(listener: () => void): void {
    this.pauseListeners.push(listener);
  }

  /** Another party answered the request this UI is answering: the read
   *  the person is in rejects, which closes an open picker or form and
   *  ends the command loop's wait, and the activity line already says
   *  who. A request can be between reads for a moment (the rewind
   *  picker loads a checkpoint before its first read and between
   *  moves), so with no read in progress the withdrawal is kept for the
   *  request's next read, and each request starts with it cleared. */
  withdraw(): void {
    const waiter = this.personWaiter;
    if (waiter === null) {
      this.withdrawn = true;
      return;
    }
    this.personWaiter = null;
    this.inputPrompt = null;
    this.inputValue = "";
    waiter.reject(new RequestWithdrawn());
    this.renderUI();
  }

  /** The start of a request that reads keys: a withdrawal left over from
   *  the one before does not apply to it. */
  private beginRequest(): void {
    this.withdrawn = false;
  }

  setParties(parties: Parties): void {
    this.parties = parties;
    this.renderUI();
  }

  /** Resolves the next time this UI waits on the person for a key: a
   *  command at a stop, a text input, or an overlay. A test feeds a key
   *  and waits on this to know the UI has taken it and come back for
   *  the next; the reader that runs while the program runs does not
   *  count, since the person is not asked for anything then. */
  waitForPerson(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waitingListeners.push(resolve);
    });
  }

  /** The next key for the person: a held one first, else the next the
   *  screen gives. The one place the UI reads a key for someone. */
  private readKey(): Promise<KeyEvent> {
    if (this.withdrawn) {
      this.withdrawn = false;
      this.inputPrompt = null;
      this.inputValue = "";
      return Promise.reject(new RequestWithdrawn());
    }
    const held = this.heldKeys.shift();
    if (held !== undefined) {
      return Promise.resolve(held);
    }
    return new Promise<KeyEvent>((resolve, reject) => {
      this.personWaiter = { resolve, reject };
      const waiting = this.waitingListeners;
      this.waitingListeners = [];
      for (const listener of waiting) listener();
      this.armReader();
    });
  }

  /** Make sure one `nextKey()` is in flight whenever someone wants a
   *  key: the person, or the pause key while the program runs. */
  private armReader(): void {
    if (this.pendingKey !== null) return;
    this.pendingKey = this.screen.nextKey().then(
      (key) => {
        this.pendingKey = null;
        this.dispatch(key);
      },
      () => {
        // `TerminalInput.nextKey` rejects its waiters when `nextLine` takes
        // the terminal. The read is simply gone: the spinner arms another
        // on its next tick, and the person's next read arms its own.
        this.pendingKey = null;
      },
    );
  }

  private dispatch(key: KeyEvent): void {
    if (key.key === "c" && key.ctrl) this.cleanup();
    const waiter = this.personWaiter;
    if (waiter !== null) {
      this.personWaiter = null;
      waiter.resolve(key);
    } else if (this.spinnerInterval !== null && PAUSE_KEYS.includes(key.key)) {
      this.pausing = true;
      for (const listener of this.pauseListeners) listener();
      this.renderUI();
    } else if (this.spinnerInterval !== null && key.key === "q") {
      // A program in a long model call may not stop for minutes, so `q`
      // acts now rather than at the next stop. Attached, the listener
      // closes the channel, which is the detach, and the program runs
      // on; with no listener this process is the program's, and leaving
      // ends it, as Ctrl-C does.
      if (this.quitListeners.length === 0) {
        this.cleanup();
      }
      for (const listener of this.quitListeners) listener();
    } else {
      this.heldKeys.push(key);
    }
    if (this.spinnerInterval !== null || this.personWaiter !== null) {
      this.armReader();
    }
  }

  // --- DebuggerIO implementation ---

  log(line: string): void {
    this.state.log(line);
  }

  setMode(mode: DebuggerMode): void {
    this.state.setMode(mode);
  }

  setPending(preview: PendingPreview): void {
    this.state.setPending(preview);
    this.renderUI();
  }

  setBusy(entries: BusyEntry[]): void {
    this.state.setBusy(entries, this.now());
    // A wait in a module whose source map is not loaded yet has no line
    // until it is; the load redraws.
    for (const moduleId of uniq(entries.map((entry) => entry.location.moduleId))) {
      if (!this.state.hasSourceMap(moduleId)) {
        void this.state.loadSourceMap(moduleId).then(() => this.renderUI());
      }
    }
    this.renderUI();
  }

  async render(checkpoint?: Checkpoint, stop?: DebugStopData, interruptId?: string): Promise<void> {
    if (checkpoint) {
      await this.state.setCheckpoint(checkpoint, stop, interruptId);
      // A picked thread stays shown while it is still listed, so a
      // person can follow one that is not the active one while stepping.
      const listed = this.state.listThreads().some((thread) => thread.id === this.threadDisplayId);
      if (!listed) this.threadDisplayId = undefined;
    }
    this.renderUI();
  }

  // --- Spinner ---

  private static SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  /** While the program runs, the bar says so and names the keys that
   *  work then: space to pause, `q` to quit or detach. It is redrawn every
   *  80ms, which also ticks the wait's time in the stats bar; the frame
   *  character is the sign that the screen is alive. */
  startSpinner(): void {
    if (this.spinnerInterval) return;
    let frameIdx = 0;

    const update = () => {
      const frame = DebuggerUI.SPINNER_FRAMES[frameIdx % DebuggerUI.SPINNER_FRAMES.length];
      const quit = this.attached === null ? "quit" : "detach";
      const keys = this.pausing
        ? `{bold}(q){/bold}${quit}`
        : `{bold}(space){/bold}pause {bold}(q){/bold}${quit}`;
      const state = this.pausing ? "pausing at the next statement" : "running";
      this.spinnerText = `{cyan-fg}${frame}{/cyan-fg} ▶ ${state} · ${keys}`;
      this.renderUI();
      frameIdx++;
      // The pause key is read while the program runs; a read the input
      // cancelled is armed again here.
      this.armReader();
    };

    update();
    this.spinnerInterval = setInterval(update, 80);
    // The pause key is read while the program runs.
    this.armReader();
  }

  stopSpinner(): void {
    if (!this.spinnerInterval) return;
    clearInterval(this.spinnerInterval);
    this.spinnerInterval = null;
    this.spinnerText = "";
    this.renderUI();
  }

  cleanup(error?: string): void {
    this.stopSpinner();
    this.destroy();
    if (error) console.error(error);
    process.exit(error ? 1 : 0);
  }

  // --- Key handling ---

  async waitForCommand(): Promise<DebuggerCommand> {
    this.beginRequest();
    this.pausing = false;
    while (true) {
      const keyEvent = await this.readKey();

      // Attached, escape does nothing: it would detach by accident. The
      // open composer still takes it, to close and keep the draft.
      if (this.attached !== null && keyEvent.key === "escape" && !this.composer.open) {
        continue;
      }
      const simple = this.composer.open ? undefined : SIMPLE_KEYS[keyEvent.key];
      if (simple?.type === "quit") {
        for (const listener of this.quitListeners) listener();
      }
      if (simple) return simple;

      const command = await this.handleInteractiveKey(keyEvent);
      if (!command) continue;
      if (command.type === "print") {
        this.printVariable(command.varName);
        continue;
      }
      return command;
    }
  }

  /** The viewed frame's value, so print agrees with the locals pane
   *  after `b`. Answered here, not by the driver: the frame being shown
   *  is the UI's, and a driver in another process could not see it. */
  private printVariable(varName: string): void {
    const value = this.state.lookupVariable(varName);
    if (value !== undefined) {
      this.state.log(`${varName} = ${JSON.stringify(value)}`);
    } else {
      this.state.log(`${varName} = (not found)`);
    }
    this.renderUI();
  }

  private async handleInteractiveKey(keyEvent: KeyEvent): Promise<UiCommand | null> {
    const panes = this.getPanes();
    const focusedName = panes[this.focusIndex]?.name;

    // The pane's own table first, so a row's edit key and the composer
    // win over the keys below; then the composer's line editor.
    const ctx = this.keyContext();
    const binding = findBinding(bindingsFor(ctx), keyEvent.key);
    if (binding !== undefined) {
      const action = binding.run();
      return action === undefined ? null : await this.carryOut(action, ctx);
    }
    if (this.composer.open) {
      const edit = lineEditAction(keyEvent);
      if (edit !== null) this.composer.draft = applyLineEdit(this.composer.draft, edit);
      this.renderUI();
      return null;
    }
    if (keyEvent.key === "k" && keyEvent.ctrl) return await this.openPalette();

    switch (keyEvent.key) {
      case "k": {
        const label = await this.enterTextInput("checkpoint label (enter to skip)>");
        return { type: "checkpoint", label: label?.trim() || undefined };
      }
      case "p": {
        const input = await this.enterTextInput("print>");
        return input?.trim() ? { type: "print", varName: input.trim() } : null;
      }
      case ":": {
        const input = await this.enterTextInput(":");
        return parseCommandInput(input || "");
      }
      case "up":
        if (focusedName === "source") return { type: "stepBack" };
        this.scrollPane(focusedName, -1);
        return null;
      case "down":
        if (focusedName === "source") return { type: "step" };
        this.scrollPane(focusedName, 1);
        return null;
      case "tab":
        this.focusIndex = keyEvent.shift
          ? (this.focusIndex - 1 + panes.length) % panes.length
          : (this.focusIndex + 1) % panes.length;
        this.renderUI();
        return null;
      case "z":
        this.zoomedPane = this.zoomedPane ? null : focusedName || null;
        this.renderUI();
        return null;
      case "b": {
        const branches = this.state.listBranches();
        if (branches.length === 0) return null;
        const picked = await showBranchPicker(this.overlayContext(), branches);
        if (picked !== null) {
          this.state.viewBranch(picked);
          this.state.log(
            picked.length === 0
              ? "Viewing the stopped frame"
              : `Viewing branch ${picked.join("/")}`,
          );
        }
        this.renderUI();
        return null;
      }
      case "t": {
        const threads = this.state.listThreads();
        if (threads.length === 0) return null;
        const shown = this.state.getThreadMessages(this.threadDisplayId)?.threadId;
        const picked = await showThreadPicker(this.overlayContext(), threads, shown);
        if (picked !== null) this.showThread(picked);
        this.renderUI();
        return null;
      }
      case "[":
      case "]": {
        // Cycle through the store's threads from the one shown.
        const threads = this.state.listThreads();
        const shown = this.state.getThreadMessages(this.threadDisplayId);
        if (threads.length === 0 || !shown) return null;
        const next =
          (shown.threadIndex + (keyEvent.key === "]" ? 1 : -1) + threads.length) % threads.length;
        this.showThread(threads[next].id);
        this.renderUI();
        return null;
      }
      default:
        if (keyEvent.key >= "1" && keyEvent.key <= "9") {
          const idx = parseInt(keyEvent.key, 10) - 1;
          if (idx < panes.length) {
            this.focusIndex = idx;
            this.renderUI();
          }
        }
        return null;
    }
  }

  private scrollPane(paneName: string | undefined, direction: number): void {
    if (!paneName) return;
    const current = this.scrollOffsets[paneName] || 0;

    // Clamp by the pane's actual viewport so the stored offset stays
    // in lockstep with the renderer's visual cap. We get the viewport
    // height from the most recently rendered frame for this pane, and
    // the total line count from the pane's content function.
    const pane = this.getPanes().find((p) => p.name === paneName);
    const totalLines = pane ? pane.content().split("\n").length : 0;
    const maxOffset = Math.max(0, totalLines - this.viewportHeight(paneName));
    const next = Math.max(0, Math.min(current + direction, maxOffset));
    if (next !== current) {
      this.scrollOffsets[paneName] = next;
      this.renderUI();
    }
  }

  /** Scroll `paneName` just enough that the cursor's row is in view: a
   *  row above the viewport becomes its first line, one below it its
   *  last. The rows are the pane's lines in order, so the row index is
   *  the line index. */
  private scrollToCursor(paneName: string): void {
    const height = this.viewportHeight(paneName);
    if (height === 0) return;
    const row = this.cursorIndex(paneName);
    const current = this.scrollOffsets[paneName] || 0;
    if (row < current) {
      this.scrollOffsets[paneName] = row;
    } else if (row >= current + height) {
      this.scrollOffsets[paneName] = row - height + 1;
    }
  }

  /** The lines `paneName` can show, from its most recently rendered
   *  frame: the frame's height less the border's two rows. Zero before
   *  the first render. */
  private viewportHeight(paneName: string): number {
    const paneFrame = this.lastFrame?.findByKey(paneName);
    return paneFrame ? Math.max(0, paneFrame.height - 2) : 0;
  }

  // --- Text input ---

  private async enterTextInput(prompt: string): Promise<string | null> {
    this.inputPrompt = prompt;
    this.inputValue = "";
    this.renderUI();

    while (true) {
      const keyEvent = await this.readKey();

      if (keyEvent.key === "enter") {
        const value = this.inputValue;
        this.inputPrompt = null;
        this.inputValue = "";
        this.renderUI();
        return value;
      }
      if (keyEvent.key === "escape") {
        this.inputPrompt = null;
        this.inputValue = "";
        this.renderUI();
        return null;
      }
      if (keyEvent.key === "backspace") {
        this.inputValue = this.inputValue.slice(0, -1);
        this.renderUI();
        continue;
      }
      if (keyEvent.key.length === 1 && !keyEvent.ctrl) {
        this.inputValue += keyEvent.key;
        this.renderUI();
      }
    }
  }

  /** Ask until the person answers: escape clears the prompt and asks
   *  again. A withdrawn read rejects out of here like any other. */
  async promptForInput(prompt: string): Promise<string> {
    this.beginRequest();
    while (true) {
      const value = await this.enterTextInput(prompt);
      if (value !== null) {
        return value;
      }
    }
  }

  async promptForNodeArgs(parameters: FunctionParameter[]): Promise<unknown[]> {
    this.beginRequest();
    const args: unknown[] = [];
    for (const param of parameters) {
      const typeLabel = param.typeHint ? ` (${formatTypeHint(param.typeHint)})` : "";
      const raw = await this.promptForInput(`${param.name}${typeLabel}:`);
      args.push(coerceArg(raw, param));
    }
    return args;
  }

  appendStdout(text: string): void {
    this.state.addToStdout(text);
  }

  renderActivityOnly(): void {
    this.renderUI();
  }

  // --- Overlays ---

  private overlayContext(): OverlayContext {
    return {
      screen: this.screen,
      nextKey: () => this.readKey(),
      state: this.state,
      buildTopRows: () => {
        const panes = this.getPanes();
        const focusedName = panes[this.focusIndex]?.name;
        return this.buildTopRows(panes, focusedName);
      },
      buildStatsBar: () => this.buildStatsBar(),
      commandBarContent: COMMAND_BAR_CONTENT,
      cleanup: () => this.cleanup(),
    };
  }

  async showRewindSelector(checkpoints: Checkpoint[]): Promise<number | null> {
    this.beginRequest();
    this.prevState = this.state.clone();
    const result = await showRewindSelector(this.overlayContext(), checkpoints);
    this.state = this.prevState!.clone();
    this.prevState = null;
    await this.render();
    return result;
  }

  async answerGuardTrip(data: GuardTripData): Promise<InterruptResponse> {
    this.beginRequest();
    const response = await showGuardTripForm(this.overlayContext(), data);
    await this.render();
    return response;
  }

  async showCheckpointsPanel(checkpoints: Checkpoint[]): Promise<void> {
    this.beginRequest();
    const selected = await showCheckpointsPanel(this.overlayContext(), checkpoints);
    if (selected) {
      await this.render(selected);
    } else {
      await this.render();
    }
  }

  destroy(): void {
    this.stopSpinner();
    this.screen.destroy();
  }
}
