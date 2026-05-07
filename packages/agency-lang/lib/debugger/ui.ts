import {
  Screen,
  box,
  row,
  column,
  text,
  escapeStyleTags,
  type Element,
  type Frame,
} from "@agency-lang/tui";
import { readFileSync } from "fs";
import { formatTypeHint } from "../cli/util.js";
import type { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { FunctionParameter } from "../types.js";
import type { DebuggerCommand, DebuggerIO } from "./types.js";
import { UIState } from "./uiState.js";
import { coerceArg, formatValue, parseCommandInput } from "./util.js";

// Cache for file contents so we don't re-read on every render
const fileCache: Record<string, string> = {};

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

type PaneInfo = {
  name: string;
  color: string;
  label: string;
};

export class DebuggerUI implements DebuggerIO {
  private screen: Screen;
  public state: UIState;
  public prevState: UIState | null = null;

  // Focus
  private focusIndex = 0;
  private focusablePanes: PaneInfo[] = [];

  // Zoom
  private zoomedPane: string | null = null;

  // Threads
  private threadDisplayIndex: number | undefined = undefined;

  // Scroll offsets per pane
  private scrollOffsets: Record<string, number> = {};

  // Spinner
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerText = "";

  // Command bar
  private commandBarContent: string;
  private commandBarOverride: string | null = null;

  // Text input state
  private inputPrompt: string | null = null;
  private inputValue = "";

  // Last rendered frame for inspection
  lastFrame: Frame | null = null;

  constructor(screen: Screen) {
    this.screen = screen;
    this.state = new UIState();

    const commands: Record<string, string> = {
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
    };
    this.commandBarContent = Object.entries(commands)
      .map(([key, action]) => `{bold}(${key}){/bold}${action}`)
      .join(" ");
  }

  // --- Formatting helpers ---

  private fmt(str: string): string {
    return escapeStyleTags(str);
  }

  private bold(str: string): string {
    return `{bold}${str}{/bold}`;
  }

  private highlight(str: string): string {
    return `{yellow-fg}${escapeStyleTags(str)}{/yellow-fg}`;
  }

  private formatKeyVal(
    key: string,
    value: unknown,
    { highlight }: { highlight?: boolean } = {},
  ): string {
    const formatted = `${escapeStyleTags(key)} = ${escapeStyleTags(formatValue(value))}`;
    return highlight ? this.highlight(formatted) : formatted;
  }

  // --- Pane management ---

  private buildPaneList(): PaneInfo[] {
    const panes: PaneInfo[] = [
      { name: "source", color: "cyan", label: " source " },
    ];

    const threadData = this.state.getThreadMessages(this.threadDisplayIndex);
    if (threadData) {
      const countLabel =
        threadData.threadCount > 1
          ? ` [${threadData.threadIndex + 1}/${threadData.threadCount}]`
          : "";
      panes.push({
        name: "threads",
        color: "cyan",
        label: ` threads: (id: ${threadData.threadId})${countLabel} `,
      });
    }

    panes.push(
      { name: "locals", color: "green", label: " locals " },
      { name: "globals", color: "green", label: " globals " },
      { name: "callStack", color: "magenta", label: " call stack " },
      { name: "activity", color: "yellow", label: " activity " },
      { name: "stdout", color: "blue", label: " stdout " },
    );

    return panes;
  }

  // --- Content builders ---

  private buildSourceContent(): string {
    const moduleId = this.state.getModuleId();
    const currentLine = this.state.getCurrentLine();
    const filePath =
      this.state.resolveModulePath(moduleId, [".agency"]) ?? moduleId;
    const fileContent = readSourceFile(filePath);
    const lines = fileContent.split("\n");

    const windowSize = 20;
    const center = currentLine ? currentLine - 1 : 0;
    const start = Math.max(0, center - Math.floor(windowSize / 2));
    const end = Math.min(lines.length, start + windowSize);

    const content: string[] = [];
    for (let i = start; i < end; i++) {
      const lineNum = i + 1;
      const numStr = String(lineNum).padStart(4, " ");
      const lineText = this.fmt(lines[i]);

      if (currentLine !== null && lineNum === currentLine) {
        content.push(
          `{magenta-bg}{bold}> ${numStr}  ${lineText}{/bold}{/magenta-bg}`,
        );
      } else {
        content.push(`  ${numStr}  ${lineText}`);
      }
    }

    return content.join("\n");
  }

  private buildThreadsContent(): string {
    const threadData = this.state.getThreadMessages(this.threadDisplayIndex);
    if (!threadData) return "";

    const isZoomed = this.zoomedPane === "threads";
    return threadData.messages
      .map((m) => {
        const display = isZoomed
          ? m.content
          : m.content.length > 200
            ? m.content.slice(0, 197) + "..."
            : m.content;
        return `  ${this.bold(`[${this.fmt(m.role)}]`)} ${this.fmt(display)}`;
      })
      .join("\n");
  }

  private buildLocalsContent(): string {
    const content: string[] = [];
    this.state.getArgs().forEach((arg) => {
      const val = arg.override || arg.value;
      content.push(
        this.formatKeyVal(arg.key, val, {
          highlight: arg.override !== undefined,
        }),
      );
    });
    this.state.getLocals().forEach((local) => {
      const val = local.override || local.value;
      content.push(
        this.formatKeyVal(local.key, val, {
          highlight: local.override !== undefined,
        }),
      );
    });
    return content.join("\n");
  }

  private buildGlobalsContent(): string {
    const content: string[] = [];
    this.state.getGlobals().forEach((global) => {
      const val = global.override || global.value;
      content.push(
        this.formatKeyVal(global.key, val, {
          highlight: global.override !== undefined,
        }),
      );
    });
    return content.join("\n");
  }

  private buildCallStackContent(): string {
    const callStack = this.state.getCallStack();
    return callStack
      .map((entry, i) => {
        const prefix = i === callStack.length - 1 ? " > " : "   ";
        const fileName = entry.moduleId.split("/").pop() || entry.moduleId;
        return `${prefix}${this.fmt(entry.functionName)} (${this.fmt(fileName)}:${entry.line})`;
      })
      .join("\n");
  }

  private buildActivityContent(): string {
    return this.state
      .getActivityLog()
      .map((entry) => `  ${this.fmt(entry)}`)
      .join("\n");
  }

  private buildStdoutContent(): string {
    return this.state
      .getStdout()
      .map((line) => `  ${this.fmt(line)}`)
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
    return `{gray-fg}  tokens: ${stats.totalTokens.toLocaleString()} | cost: ${cost}{/gray-fg}`;
  }

  private getContentForPane(name: string): string {
    switch (name) {
      case "source":
        return this.buildSourceContent();
      case "threads":
        return this.buildThreadsContent();
      case "locals":
        return this.buildLocalsContent();
      case "globals":
        return this.buildGlobalsContent();
      case "callStack":
        return this.buildCallStackContent();
      case "activity":
        return this.buildActivityContent();
      case "stdout":
        return this.buildStdoutContent();
      default:
        return "";
    }
  }

  // --- Element tree builders ---

  private buildPane(
    paneName: string,
    label: string,
    baseColor: string,
    content: string,
    extraStyle: Record<string, unknown> = {},
  ): Element {
    const isFocused = this.focusablePanes[this.focusIndex]?.name === paneName;
    const borderColor = isFocused ? "white" : baseColor;
    const labelColor = isFocused ? "cyan" : baseColor;
    const fg = isFocused ? undefined : "gray";

    return box(
      {
        key: paneName,
        border: true,
        borderColor,
        label: ` ${this.fmt(label.trim())} `,
        labelColor,
        fg,
        scrollable: true,
        scrollOffset: this.scrollOffsets[paneName] || 0,
        ...extraStyle,
      },
      text(content),
    );
  }

  private buildCommandBar(): Element {
    let content: string;
    if (this.inputPrompt !== null) {
      content = `${this.inputPrompt} ${this.inputValue}\u2588`;
    } else {
      content =
        this.commandBarOverride ||
        this.spinnerText ||
        this.commandBarContent;
    }
    return box(
      { height: 3, border: true, borderColor: "white", key: "commandBar" },
      text(content),
    );
  }

  private buildElementTree(): Element {
    this.focusablePanes = this.buildPaneList();
    if (this.focusIndex >= this.focusablePanes.length) {
      this.focusIndex = 0;
    }

    const moduleId = this.state.getModuleId();
    const threadData = this.state.getThreadMessages(this.threadDisplayIndex);
    const hasThreads = threadData !== null;

    // If zoomed, show only the zoomed pane
    if (this.zoomedPane) {
      const pane = this.focusablePanes.find((p) => p.name === this.zoomedPane);
      if (pane) {
        return column(
          this.buildPane(pane.name, pane.label, pane.color, this.getContentForPane(pane.name), { flex: 1 }),
          box({ height: 1, key: "stats" }, text(this.buildStatsContent())),
          this.buildCommandBar(),
        );
      }
    }

    // Normal layout
    const sourceLabel = ` source: ${this.fmt(moduleId)} `;
    const topChildren: Element[] = [
      this.buildPane(
        "source",
        sourceLabel,
        "cyan",
        this.buildSourceContent(),
        hasThreads ? { width: "65%" } : { flex: 1 },
      ),
    ];
    if (hasThreads) {
      const threadPane = this.focusablePanes.find(
        (p) => p.name === "threads",
      )!;
      topChildren.push(
        this.buildPane(
          "threads",
          threadPane.label,
          "cyan",
          this.buildThreadsContent(),
          { width: "35%" },
        ),
      );
    }

    return column(
      row({ height: "40%" }, ...topChildren),
      row(
        { height: "25%" },
        this.buildPane("locals", " locals ", "green", this.buildLocalsContent(), { width: "40%" }),
        this.buildPane("globals", " globals ", "green", this.buildGlobalsContent(), { width: "40%" }),
        this.buildPane("callStack", " call stack ", "magenta", this.buildCallStackContent(), { flex: 1 }),
      ),
      row(
        { flex: 1 },
        this.buildPane("activity", " activity ", "yellow", this.buildActivityContent(), { width: "50%" }),
        this.buildPane("stdout", " stdout ", "blue", this.buildStdoutContent(), { flex: 1 }),
      ),
      box({ height: 1, key: "stats" }, text(this.buildStatsContent())),
      this.buildCommandBar(),
    );
  }

  private renderUI(label?: string): Frame {
    const tree = this.buildElementTree();
    const frame = this.screen.render(tree, label);
    this.lastFrame = frame;
    return frame;
  }

  // --- DebuggerIO implementation ---

  async render(checkpoint?: Checkpoint, _full = true): Promise<void> {
    if (checkpoint) {
      await this.state.setCheckpoint(checkpoint);
      this.threadDisplayIndex = undefined;
    }
    this.renderUI();
  }

  // Spinner

  private static SPINNER_FRAMES = [
    "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
  ];
  private static SPINNER_PHRASES = [
    "thinking", "pondering", "reasoning", "working",
    "executing", "processing", "contemplating", "computing",
  ];
  private static SPINNER_INTERVAL_MS = 80;
  private static SPINNER_PHRASE_TICKS = 30;

  startSpinner(): void {
    if (this.spinnerInterval) return;
    let frameIdx = 0;
    let phraseIdx = Math.floor(
      Math.random() * DebuggerUI.SPINNER_PHRASES.length,
    );
    let ticksSincePhrase = 0;

    const update = () => {
      const frame =
        DebuggerUI.SPINNER_FRAMES[
          frameIdx % DebuggerUI.SPINNER_FRAMES.length
        ];
      const phrase =
        DebuggerUI.SPINNER_PHRASES[
          phraseIdx % DebuggerUI.SPINNER_PHRASES.length
        ];
      this.spinnerText = `{cyan-fg}${frame}{/cyan-fg} ${phrase}...`;
      this.renderUI();
      frameIdx++;
      ticksSincePhrase++;
      if (ticksSincePhrase >= DebuggerUI.SPINNER_PHRASE_TICKS) {
        phraseIdx++;
        ticksSincePhrase = 0;
      }
    };

    update();
    this.spinnerInterval = setInterval(update, DebuggerUI.SPINNER_INTERVAL_MS);
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
    if (error) {
      console.error(error);
    }
    process.exit(error ? 1 : 0);
  }

  async waitForCommand(): Promise<DebuggerCommand> {
    while (true) {
      const keyEvent = await this.screen.nextKey();
      const { key } = keyEvent;

      // Ctrl-C to quit
      if (key === "c" && keyEvent.ctrl) {
        this.cleanup();
      }

      switch (key) {
        case "s":
        case "right":
          return { type: "step" };
        case "n":
          return { type: "next" };
        case "i":
          return { type: "stepIn" };
        case "o":
          return { type: "stepOut" };
        case " ":
        case "c":
          return { type: "continue" };
        case "r":
          return { type: "rewind" };
        case "d":
          return { type: "showCheckpoints" };
        case "k": {
          const label = await this.enterTextInput(
            "checkpoint label (enter to skip)>",
          );
          return { type: "checkpoint", label: label?.trim() || undefined };
        }
        case "p": {
          const input = await this.enterTextInput("print>");
          if (input && input.trim()) {
            return { type: "print", varName: input.trim() };
          }
          continue;
        }
        case "escape":
        case "q":
          return { type: "quit" };
        case "tab":
          if (keyEvent.shift) {
            this.focusIndex =
              (this.focusIndex - 1 + this.focusablePanes.length) %
              this.focusablePanes.length;
          } else {
            this.focusIndex =
              (this.focusIndex + 1) % this.focusablePanes.length;
          }
          this.renderUI();
          continue;
        case "up": {
          const focusedPane = this.focusablePanes[this.focusIndex];
          if (focusedPane?.name === "source") {
            return {
              type: "stepBack",
              preserveOverrides: keyEvent.shift === true,
            };
          }
          const offset = this.scrollOffsets[focusedPane?.name] || 0;
          if (offset > 0) {
            this.scrollOffsets[focusedPane.name] = offset - 1;
            this.renderUI();
          }
          continue;
        }
        case "down": {
          const focusedPane = this.focusablePanes[this.focusIndex];
          if (focusedPane?.name === "source") {
            return { type: "step" };
          }
          const name = focusedPane?.name;
          if (name) {
            this.scrollOffsets[name] = (this.scrollOffsets[name] || 0) + 1;
            this.renderUI();
          }
          continue;
        }
        case "z":
          if (this.zoomedPane) {
            this.zoomedPane = null;
          } else {
            this.zoomedPane =
              this.focusablePanes[this.focusIndex]?.name || null;
          }
          this.renderUI();
          continue;
        case ":": {
          const input = await this.enterTextInput(":");
          const cmd = parseCommandInput(input || "");
          if (cmd) return cmd;
          continue;
        }
        case "[":
        case "]": {
          const current = this.threadDisplayIndex ?? 0;
          this.threadDisplayIndex = current + (key === "]" ? 1 : -1);
          this.renderUI();
          continue;
        }
        default: {
          // Number keys for panel focus
          if (key >= "1" && key <= "9") {
            const panelIndex = parseInt(key, 10) - 1;
            if (panelIndex < this.focusablePanes.length) {
              this.focusIndex = panelIndex;
              this.renderUI();
            }
          }
          continue;
        }
      }
    }
  }

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
      // Regular character input
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
          // Escape pressed — re-prompt since the program needs a value
          await tryInput();
        }
      };
      tryInput();
    });
  }

  async promptForNodeArgs(
    parameters: FunctionParameter[],
  ): Promise<unknown[]> {
    const args: unknown[] = [];
    for (const param of parameters) {
      const typeLabel = param.typeHint
        ? ` (${formatTypeHint(param.typeHint)})`
        : "";
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

  showRewindSelector(checkpoints: Checkpoint[]): Promise<number | null> {
    return new Promise<number | null>(async (resolve) => {
      this.prevState = this.state.clone();

      if (checkpoints.length === 0) {
        this.state.log("No checkpoints available for rewind.");
        this.renderUI();
        resolve(null);
        return;
      }

      let selectedIndex = checkpoints.length - 1;

      const renderSelector = () => {
        const items = checkpoints
          .map((cp, i) => {
            let tag = "[auto]";
            if (cp.pinned) {
              tag = cp.label ? `[manual: ${cp.label}]` : "[code]";
            }
            const fileName = cp.getFilename();
            const line = `${tag} #${cp.id} - ${fileName}:${cp.scopeName} step ${cp.stepPath}`;
            if (i === selectedIndex) {
              return `{blue-bg}{white-fg} > ${this.fmt(line)} {/white-fg}{/blue-bg}`;
            }
            return `   ${this.fmt(line)}`;
          })
          .join("\n");

        const threadData = this.state.getThreadMessages(this.threadDisplayIndex);
        const hasThreads = threadData !== null;
        const moduleId = this.state.getModuleId();
        const sourceLabel = ` source: ${this.fmt(moduleId)} `;

        const topChildren: Element[] = [
          this.buildPane(
            "source", sourceLabel, "cyan", this.buildSourceContent(),
            hasThreads ? { width: "65%" } : { flex: 1 },
          ),
        ];
        if (hasThreads) {
          const threadPane = this.focusablePanes.find((p) => p.name === "threads")!;
          topChildren.push(
            this.buildPane("threads", threadPane.label, "cyan", this.buildThreadsContent(), { width: "35%" }),
          );
        }

        const tree = column(
          row({ height: "40%" }, ...topChildren),
          row(
            { height: "25%" },
            this.buildPane("locals", " locals ", "green", this.buildLocalsContent(), { width: "40%" }),
            this.buildPane("globals", " globals ", "green", this.buildGlobalsContent(), { width: "40%" }),
            this.buildPane("callStack", " call stack ", "magenta", this.buildCallStackContent(), { flex: 1 }),
          ),
          box(
            {
              flex: 1,
              border: true,
              borderColor: "yellow",
              label: " select checkpoint (Enter=select, Esc=cancel) ",
              scrollable: true,
              scrollOffset: Math.max(0, selectedIndex - 10),
            },
            text(items),
          ),
          box({ height: 1, key: "stats" }, text(this.buildStatsContent())),
          box(
            { height: 3, border: true, borderColor: "white" },
            text(this.commandBarContent),
          ),
        );

        this.screen.render(tree);
      };

      // Preview the initially selected checkpoint
      await this.state.setCheckpoint(checkpoints[selectedIndex]);
      renderSelector();

      while (true) {
        const keyEvent = await this.screen.nextKey();

        if (keyEvent.key === "c" && keyEvent.ctrl) {
          this.cleanup();
          return;
        }

        switch (keyEvent.key) {
          case "up":
          case "k":
            if (selectedIndex > 0) {
              selectedIndex--;
              await this.state.setCheckpoint(checkpoints[selectedIndex]);
              renderSelector();
            }
            break;
          case "down":
          case "j":
            if (selectedIndex < checkpoints.length - 1) {
              selectedIndex++;
              await this.state.setCheckpoint(checkpoints[selectedIndex]);
              renderSelector();
            }
            break;
          case "enter":
            if (this.prevState) {
              this.state = this.prevState.clone();
            }
            await this.render();
            resolve(checkpoints[selectedIndex].id);
            return;
          case "escape":
          case "q":
            if (this.prevState) {
              this.state = this.prevState.clone();
            }
            await this.render();
            resolve(null);
            return;
        }
      }
    });
  }

  showCheckpointsPanel(checkpoints: Checkpoint[]): Promise<void> {
    return new Promise<void>(async (resolve) => {
      if (checkpoints.length === 0) {
        this.state.log("No checkpoints available.");
        this.renderUI();
        resolve();
        return;
      }

      let selectedIndex = checkpoints.length - 1;
      let rawMode = false;
      let detailScrollOffset = 0;

      const renderFormattedDetail = (cp: Checkpoint): string => {
        const lines: string[] = [];
        lines.push(`{bold}{cyan-fg}Checkpoint #${cp.id}{/cyan-fg}{/bold}`);
        lines.push("");
        lines.push(
          `{bold}Location:{/bold}  ${this.fmt(cp.getFilename())}:${this.fmt(cp.scopeName)}`,
        );
        lines.push(`{bold}Step:{/bold}      ${this.fmt(cp.stepPath)}`);
        lines.push(
          `{bold}Node:{/bold}      ${this.fmt(cp.nodeId || "(none)")}`,
        );
        lines.push(`{bold}Pinned:{/bold}    ${cp.pinned ? "yes" : "no"}`);
        if (cp.label) {
          lines.push(`{bold}Label:{/bold}     ${this.fmt(cp.label)}`);
        }

        const frame = cp.getCurrentFrame();
        if (frame) {
          lines.push("");
          lines.push("{bold}{yellow-fg}Arguments:{/yellow-fg}{/bold}");
          if (frame.args && Object.keys(frame.args).length > 0) {
            for (const [key, value] of Object.entries(frame.args)) {
              if (!key.startsWith("__")) {
                lines.push(
                  `  ${this.fmt(key)} = ${this.fmt(formatValue(value))}`,
                );
              }
            }
          } else {
            lines.push("  (none)");
          }

          lines.push("");
          lines.push("{bold}{yellow-fg}Locals:{/yellow-fg}{/bold}");
          if (frame.locals && Object.keys(frame.locals).length > 0) {
            for (const [key, value] of Object.entries(frame.locals)) {
              if (!key.startsWith("__")) {
                lines.push(
                  `  ${this.fmt(key)} = ${this.fmt(formatValue(value))}`,
                );
              }
            }
          } else {
            lines.push("  (none)");
          }
        }

        const globals = cp.getGlobalsForModule();
        if (globals) {
          lines.push("");
          lines.push("{bold}{green-fg}Globals:{/green-fg}{/bold}");
          for (const [key, value] of Object.entries(globals)) {
            if (!key.startsWith("__")) {
              lines.push(
                `  ${this.fmt(key)} = ${this.fmt(formatValue(value))}`,
              );
            }
          }
        }

        const frames = cp.stack?.stack;
        if (frames && frames.length > 0) {
          lines.push("");
          lines.push(
            `{bold}{magenta-fg}Call Stack:{/magenta-fg}{/bold} (${frames.length} frame${frames.length === 1 ? "" : "s"})`,
          );
          for (let i = 0; i < frames.length; i++) {
            const entry = frames[i];
            const prefix = i === frames.length - 1 ? " > " : "   ";
            const argKeys = Object.keys(entry.args).filter(
              (k) => !k.startsWith("__"),
            );
            const argStr =
              argKeys.length > 0 ? `(${argKeys.join(", ")})` : "()";
            lines.push(
              `${prefix}frame ${i} ${argStr} at step ${entry.step}`,
            );
          }
        }

        return lines.join("\n");
      };

      const renderRawDetail = (cp: Checkpoint): string => {
        return this.fmt(JSON.stringify(cp.toJSON(), null, 2));
      };

      const renderPanel = () => {
        const cp = checkpoints[selectedIndex];
        const modeLabel = rawMode ? "raw" : "formatted";
        const detailContent = rawMode
          ? renderRawDetail(cp)
          : renderFormattedDetail(cp);

        const listLines = checkpoints
          .map((cp, i) => {
            let tag = "{gray-fg}[auto]{/gray-fg}";
            if (cp.pinned) {
              tag = cp.label
                ? `{yellow-fg}[manual: ${this.fmt(cp.label)}]{/yellow-fg}`
                : "{magenta-fg}[code]{/magenta-fg}";
            }
            const fileName = cp.getFilename();
            const line = `${tag} {bold}#${cp.id}{/bold} ${this.fmt(fileName)}:${this.fmt(cp.scopeName)}`;
            if (i === selectedIndex) {
              return `{blue-bg}{white-fg} > ${line} {/white-fg}{/blue-bg}`;
            }
            return `   ${line}`;
          })
          .join("\n");

        const helpContent = `${this.bold("(↑/↓)")}navigate  ${this.bold("(^F/^B)")}scroll detail  ${this.bold("(t)")}toggle raw  ${this.bold("(enter)")}go to checkpoint  ${this.bold("(esc/q)")}close`;

        const tree = column(
          row(
            { flex: 1 },
            box(
              {
                width: "35%",
                border: true,
                borderColor: "cyan",
                label: ` checkpoints (${selectedIndex + 1}/${checkpoints.length}) `,
                scrollable: true,
                scrollOffset: Math.max(0, selectedIndex - 10),
              },
              text(listLines),
            ),
            box(
              {
                flex: 1,
                border: true,
                borderColor: "green",
                label: ` checkpoint #${cp.id} detail (${modeLabel}) `,
                scrollable: true,
                scrollOffset: detailScrollOffset,
              },
              text(detailContent),
            ),
          ),
          box(
            { height: 3, border: true, borderColor: "white" },
            text(helpContent),
          ),
        );

        this.screen.render(tree);
      };

      renderPanel();

      while (true) {
        const keyEvent = await this.screen.nextKey();

        if (keyEvent.key === "c" && keyEvent.ctrl) {
          this.cleanup();
          return;
        }

        switch (keyEvent.key) {
          case "up":
          case "k":
            if (selectedIndex > 0) {
              selectedIndex--;
              detailScrollOffset = 0;
              renderPanel();
            }
            break;
          case "down":
          case "j":
            if (selectedIndex < checkpoints.length - 1) {
              selectedIndex++;
              detailScrollOffset = 0;
              renderPanel();
            }
            break;
          case "f":
            if (keyEvent.ctrl) {
              detailScrollOffset += 20;
              renderPanel();
            }
            break;
          case "b":
            if (keyEvent.ctrl) {
              detailScrollOffset = Math.max(0, detailScrollOffset - 20);
              renderPanel();
            }
            break;
          case "t":
            rawMode = !rawMode;
            detailScrollOffset = 0;
            renderPanel();
            break;
          case "enter":
            await this.render(checkpoints[selectedIndex]);
            resolve();
            return;
          case "escape":
          case "q":
            await this.render();
            resolve();
            return;
        }
      }
    });
  }

  destroy(): void {
    this.stopSpinner();
    this.screen.destroy();
  }
}
