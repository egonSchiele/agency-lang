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
import type { DebuggerCommand, DebuggerIO, DebuggerMode, UiCommand } from "./types.js";
import type { Hello } from "./attach/protocol.js";
import { UIState } from "./uiState.js";
import { coerceArg, formatValue, parseCommandInput } from "./util.js";
import { syntaxHighlight } from "@/stdlib/syntax.js";
import {
  showRewindSelector,
  showBranchPicker,
  showCheckpointsPanel,
  showGuardTripForm,
  showThreadPicker,
  type OverlayContext,
} from "./overlays.js";
import type { GuardTripData } from "./guardAnswer.js";
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

const COMMAND_BAR_CONTENT = Object.entries({
  s: "step",
  n: "next",
  i: "in",
  o: "out",
  c: "continue",
  r: "rewind",
  d: "checkpoints",
  k: "checkpoint",
  p: "print",
  q: "quit",
  ["(:)"]: "cmd",
})
  .map(([key, action]) => `{bold}(${key}){/bold}${action}`)
  .join(" ");

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

  lastFrame: Frame | null = null;

  constructor(screen: Screen) {
    this.screen = screen;
    this.state = new UIState();
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

    const windowSize = 20;
    const center = currentLine ? currentLine - 1 : 0;
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
        return currentLine !== null && lineNum === currentLine
          ? `{magenta-bg}{bold}> ${numStr}  ${lineText}{/bold}{/magenta-bg}`
          : `  ${numStr}  ${lineText}`;
      })
      .join("\n");
  }

  private buildThreadsContent(): string {
    const threadData = this.state.getThreadMessages(this.threadDisplayId);
    if (!threadData) return "";
    const isZoomed = this.zoomedPane === "threads";
    return threadData.messages
      .map((m) => {
        const display =
          isZoomed || m.content.length <= 200 ? m.content : m.content.slice(0, 197) + "...";
        return `  {bold}[${escapeStyleTags(m.role)}]{/bold} ${escapeStyleTags(display)}`;
      })
      .join("\n");
  }

  private buildLocalsContent(): string {
    return [...this.state.getArgs(), ...this.state.getLocals()]
      .map((e) =>
        this.formatKeyVal(e.key, e.override ?? e.value, {
          highlight: e.override !== undefined,
        }),
      )
      .join("\n");
  }

  private buildGlobalsContent(): string {
    return this.state
      .getGlobals()
      .map((g) =>
        this.formatKeyVal(g.key, g.override ?? g.value, {
          highlight: g.override !== undefined,
        }),
      )
      .join("\n");
  }

  private buildCallStackContent(): string {
    const callStack = this.state.getCallStack();
    return callStack
      .map((entry, i) => {
        const prefix = i === callStack.length - 1 ? " > " : "   ";
        const fileName = entry.moduleId.split("/").pop() || entry.moduleId;
        const where = fileName ? ` (${escapeStyleTags(fileName)})` : "";
        return `${prefix}${escapeStyleTags(entry.functionName)}${where}`;
      })
      .join("\n");
  }

  /** One line per branch: its status, its label, and the owner it runs
   *  under; the branch being viewed is marked. */
  private buildBranchesContent(): string {
    const viewed = this.state.getLocation()?.branchPath ?? [];
    return this.state
      .listBranches()
      .map((branch) => {
        const marker = branch.path.join("/") === viewed.join("/") ? ">" : " ";
        const indent = "  ".repeat(branch.path.length - 1);
        return `${marker} ${indent}${escapeStyleTags(branch.label)} [${branch.status}] under ${escapeStyleTags(branch.owner)}`;
      })
      .join("\n");
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
    return lines.join("\n");
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
    return `{gray-fg}  tokens: ${stats.totalTokens.toLocaleString()} | cost: ${cost}${where}{/gray-fg}`;
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
      content = this.commandBarOverride || this.spinnerText || COMMAND_BAR_CONTENT;
    }
    return box({ height: 3, border: true, borderColor: "white", key: "commandBar" }, text(content));
  }

  private buildStatsBar(): Element {
    return box({ height: 1, key: "stats" }, text(this.buildStatsContent()));
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

  // --- DebuggerIO implementation ---

  log(line: string): void {
    this.state.log(line);
  }

  setMode(mode: DebuggerMode): void {
    this.state.setMode(mode);
  }

  setOverrides(overrides: Record<string, unknown>): void {
    this.state.setOverrides(overrides);
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
  private static SPINNER_PHRASES = [
    "thinking",
    "pondering",
    "reasoning",
    "working",
    "executing",
    "processing",
    "contemplating",
    "computing",
  ];

  startSpinner(): void {
    if (this.spinnerInterval) return;
    let frameIdx = 0;
    let phraseIdx = Math.floor(Math.random() * DebuggerUI.SPINNER_PHRASES.length);
    let ticksSincePhrase = 0;

    const update = () => {
      const frame = DebuggerUI.SPINNER_FRAMES[frameIdx % DebuggerUI.SPINNER_FRAMES.length];
      const phrase = DebuggerUI.SPINNER_PHRASES[phraseIdx % DebuggerUI.SPINNER_PHRASES.length];
      this.spinnerText = `{cyan-fg}${frame}{/cyan-fg} ${phrase}...`;
      this.renderUI();
      frameIdx++;
      ticksSincePhrase++;
      if (ticksSincePhrase >= 30) {
        phraseIdx++;
        ticksSincePhrase = 0;
      }
    };

    update();
    this.spinnerInterval = setInterval(update, 80);
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
    while (true) {
      const keyEvent = await this.screen.nextKey();
      if (keyEvent.key === "c" && keyEvent.ctrl) this.cleanup();

      const simple = SIMPLE_KEYS[keyEvent.key];
      if (simple !== undefined && this.attached !== null && keyEvent.key === "escape") continue;
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
        if (focusedName === "source") {
          return { type: "stepBack", preserveOverrides: keyEvent.shift === true };
        }
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
    const paneFrame = this.lastFrame?.findByKey(paneName);
    // Inner viewport height = frame height minus the border (1 row top + 1 bottom).
    const viewportHeight = paneFrame ? Math.max(0, paneFrame.height - 2) : 0;
    const maxOffset = Math.max(0, totalLines - viewportHeight);
    const next = Math.max(0, Math.min(current + direction, maxOffset));
    if (next !== current) {
      this.scrollOffsets[paneName] = next;
      this.renderUI();
    }
  }

  // --- Text input ---

  private async enterTextInput(prompt: string): Promise<string | null> {
    this.inputPrompt = prompt;
    this.inputValue = "";
    this.renderUI();

    while (true) {
      const keyEvent = await this.screen.nextKey();

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
      if (keyEvent.key === "c" && keyEvent.ctrl) {
        this.cleanup();
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

  promptForInput(prompt: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const tryInput = async () => {
        const value = await this.enterTextInput(prompt);
        if (value !== null) {
          resolve(value);
        } else {
          await tryInput();
        }
      };
      tryInput();
    });
  }

  async promptForNodeArgs(parameters: FunctionParameter[]): Promise<unknown[]> {
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
    this.prevState = this.state.clone();
    const result = await showRewindSelector(this.overlayContext(), checkpoints);
    this.state = this.prevState!.clone();
    this.prevState = null;
    await this.render();
    return result;
  }

  async answerGuardTrip(data: GuardTripData): Promise<InterruptResponse> {
    const response = await showGuardTripForm(this.overlayContext(), data);
    await this.render();
    return response;
  }

  async showCheckpointsPanel(checkpoints: Checkpoint[]): Promise<void> {
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

/** A duration for the guards pane: `4m10s`, `30s`, `250ms`. */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m${seconds > 0 ? `${seconds}s` : ""}`;
  return `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ""}`;
}
