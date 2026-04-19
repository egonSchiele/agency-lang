import { syntaxHighlight } from "@/utils/agentUtils.js";
import blessed from "blessed";
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

const baseStyle = {
  border: { type: "line" as any },
  scrollable: true,
  alwaysScroll: true,
  keys: true,
  vi: true,
  tags: true,
  style: {
    border: { fg: "green" },
    label: { fg: "green" },
  },
};

export class DebuggerUI implements DebuggerIO {
  private screen: blessed.Widgets.Screen;
  private sourceBox: blessed.Widgets.BoxElement;
  private localsBox: blessed.Widgets.BoxElement;
  private globalsBox: blessed.Widgets.BoxElement;
  private callStackBox: blessed.Widgets.BoxElement;
  private activityBox: blessed.Widgets.BoxElement;
  private stdoutBox: blessed.Widgets.BoxElement;
  private threadsBox: blessed.Widgets.BoxElement;
  private commandBar: blessed.Widgets.BoxElement;
  private commandInput: blessed.Widgets.TextboxElement;
  private statsBar: blessed.Widgets.BoxElement;

  private focusIndex = 0;
  private focusablePanes: {
    box: blessed.Widgets.BoxElement;
    name: string;
    color: string;
    label: string;
  }[];
  public state: UIState;
  public prevState: UIState | null = null;
  private commandBarContent = "";

  // Zoom: stores original position/size so we can restore on un-zoom
  private zoomedPane: { name: string; original: Record<string, any> } | null = null;

  // Thread cycling: index into the list of thread IDs for the current checkpoint.
  // undefined = show the active thread (default); number = explicit user selection.
  private threadDisplayIndex: number | undefined = undefined;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.state = new UIState();

    /* 
    /*   1. What: removes existing data listeners and the readline keypress decoder guard from stdin
  2. Why: the prompts library (used by pickANode) calls readline.emitKeypressEvents(stdin), and blessed has its
  own keys.emitKeypressEvents(stdin) with a different guard — so both install data handlers, causing every key
  to fire twice
  3. How: clearing data listeners before blessed creates its screen ensures only blessed's handler is active
  */
    // Remove any existing keypress data handlers on stdin left behind by
    // readline/prompts. Blessed installs its own keypress parser via
    // keys.emitKeypressEvents, but Node's readline.emitKeypressEvents uses
    // a different guard, so both can install — causing every key to register
    // twice. Clearing data listeners before blessed takes over prevents this.
    process.stdin.removeAllListeners("data");
    // Also clear the readline guard so blessed's guard is the only one.
    delete (process.stdin as any)[
      Symbol.for("nodejs.readline.KEYPRESS_DECODER")
    ];

    this.screen = blessed.screen({
      smartCSR: true,
      title: "Agency Debugger",
      fullUnicode: true,
      terminal: "xterm",
      warnings: false,
    });

    // Source pane (~40% height)
    this.sourceBox = blessed.box({
      ...baseStyle,
      top: 0,
      left: 0,
      width: "100%",
      height: "40%",
      label: " source ",
      style: {
        border: { fg: "cyan" },
        label: { fg: "cyan" },
      },
    });

    // Threads pane (top right, initially hidden)
    this.threadsBox = blessed.box({
      ...baseStyle,
      top: 0,
      left: "65%+1",
      width: "35%-1",
      height: "40%",
      label: " threads ",
      hidden: true,
      style: {
        border: { fg: "cyan" },
        label: { fg: "cyan" },
      },
    });

    // Locals pane (~25% height, left half)
    this.localsBox = blessed.box({
      ...baseStyle,
      top: "40%",
      left: 0,
      width: "40%",
      height: "25%",
      label: " locals ",
      style: {
        border: { fg: "green" },
        label: { fg: "green" },
      },
    });

    this.globalsBox = blessed.box({
      ...baseStyle,
      top: "40%",
      left: "40%+1",
      width: "40%",
      height: "25%",
      label: " globals ",
      style: {
        border: { fg: "green" },
        label: { fg: "green" },
      },
    });

    // Call stack pane (~25% height, right half)
    this.callStackBox = blessed.box({
      ...baseStyle,
      top: "40%",
      right: 0,
      width: "20%",
      height: "25%",
      label: " call stack ",
      style: {
        border: { fg: "magenta" },
        label: { fg: "magenta" },
      },
    });

    // Activity pane
    this.activityBox = blessed.box({
      ...baseStyle,
      top: "65%",
      left: 0,
      width: "50%",
      height: "35%-4",
      label: " activity ",
      style: {
        border: { fg: "yellow" },
        label: { fg: "yellow" },
      },
    });

    // Stdout pane
    this.stdoutBox = blessed.box({
      ...baseStyle,
      top: "65%",
      right: 0,
      width: "50%",
      height: "35%-4",
      label: " stdout ",
      style: {
        border: { fg: "blue" },
        label: { fg: "blue" },
      },
    });

    const commands = {
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

    // Build command bar content
    const commandParts = Object.entries(commands).map(
      ([key, action]) => `${this.bold(`(${key})`)}${action}`,
    );
    const commandContent = commandParts.join(" ");
    this.commandBarContent = commandContent;

    // Command bar (bottom, fixed 3 rows)
    this.commandBar = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      border: { type: "line" },
      tags: true,
      style: {
        border: { fg: "white" },
      },
      content: commandContent,
    });

    // Hidden textbox for command input
    this.commandInput = blessed.textbox({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      border: { type: "line" },
      style: {
        border: { fg: "white" },
        fg: "white",
      },
      hidden: true,
    });

    // Stats bar (thin, borderless, above command bar)
    this.statsBar = blessed.box({
      bottom: 3,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      style: {
        fg: "gray",
      },
    });

    this.screen.append(this.sourceBox);
    this.screen.append(this.threadsBox);
    this.screen.append(this.localsBox);
    this.screen.append(this.globalsBox);
    this.screen.append(this.callStackBox);
    this.screen.append(this.activityBox);
    this.screen.append(this.stdoutBox);
    this.screen.append(this.statsBar);
    this.screen.append(this.commandBar);
    this.screen.append(this.commandInput);

    this.focusablePanes = [
      { box: this.sourceBox, name: "sourceBox", color: "cyan", label: " source " },
      { box: this.localsBox, name: "localsBox", color: "green", label: " locals " },
      { box: this.globalsBox, name: "globalsBox", color: "green", label: " globals " },
      { box: this.callStackBox, name: "callStackBox", color: "magenta", label: " call stack " },
      { box: this.activityBox, name: "activityBox", color: "yellow", label: " activity " },
      { box: this.stdoutBox, name: "stdoutBox", color: "blue", label: " stdout " },
    ];

    // Ctrl-C to quit — blessed puts the terminal in raw mode so SIGINT
    // is not generated; we must catch the keypress directly.
    this.screen.key(["C-c"], () => this.cleanup());

    // Ctrl-Z to suspend — blessed puts the terminal in raw mode so SIGTSTP
    // is not generated; we must catch the keypress, restore the terminal,
    // and send SIGTSTP manually. We defer the signal to the next tick so
    // the terminal escape sequences flush first.
    this.screen.key(["C-z"], () => {
      process.stdin.setRawMode?.(false);
      process.stdout.write(
        "\x1b[?1049l" + // exit alternate screen buffer
        "\x1b[2J" +     // clear entire screen
        "\x1b[H" +      // move cursor to top-left
        "\x1b[?25h",    // show cursor
      );
      // Node suppresses the default OS suspend action when any SIGTSTP
      // listener is registered (blessed installs one). Remove them so the
      // kernel's default suspend behavior is restored, then signal the
      // entire process group so shell job control works.
      process.removeAllListeners("SIGTSTP");
      process.kill(0, "SIGTSTP");
    });

    // Terminal cleanup handlers
    process.on("SIGINT", () => this.cleanup());
    process.on("SIGTERM", () => this.cleanup());
    process.on("SIGCONT", () => {
      process.stdin.setRawMode?.(true);
      this.screen.program.alternateBuffer();
      this.screen.program.hideCursor();
      // Force a full repaint: clear blessed's internal line cache so it
      // redraws every cell instead of diffing against stale state.
      this.screen.alloc();
      this.screen.render();
    });
    process.on("uncaughtException", (err) => {
      this.cleanup(`Uncaught exception: ${err.stack || err}`);
    });
  }

  private static SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private static SPINNER_PHRASES = [
    "thinking", "pondering", "reasoning", "working",
    "executing", "processing", "contemplating", "computing",
  ];
  private static SPINNER_INTERVAL_MS = 80;
  private static SPINNER_PHRASE_TICKS = 30; // ~2.4s at 80ms interval

  startSpinner(): void {
    if (this.spinnerInterval) return;
    let frameIdx = 0;
    let phraseIdx = Math.floor(Math.random() * DebuggerUI.SPINNER_PHRASES.length);
    let ticksSincePhrase = 0;

    const update = () => {
      const frame = DebuggerUI.SPINNER_FRAMES[frameIdx % DebuggerUI.SPINNER_FRAMES.length];
      const phrase = DebuggerUI.SPINNER_PHRASES[phraseIdx % DebuggerUI.SPINNER_PHRASES.length];
      this.commandBar.setContent(`{cyan-fg}${frame}{/cyan-fg} ${phrase}...`);
      this.screen.render();
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
    this.commandBar.setContent(this.commandBarContent);
    this.screen.render();
  }

  cleanup(error?: string): void {
    this.stopSpinner();
    this.destroy();
    if (error) {
      console.error(error);
    }
    process.exit(error ? 1 : 0);
  }

  async render(checkpoint?: Checkpoint, full = true): Promise<void> {
    if (checkpoint) {
      await this.state.setCheckpoint(checkpoint);
      // Reset to default (active thread) so the pane tracks the most recent thread.
      // User can still override with [ / ] cycling.
      this.threadDisplayIndex = undefined;
    }

    // this.state.setSourceMap(sourceMap);
    //console.log(JSON.stringify(sourceMap));

    // Update source pane
    this.renderSourcePane();
    this.renderThreadsPane();
    //if (!full) return;

    // Update locals pane
    this.renderLocalsPane();

    // Update call stack pane
    this.renderCallStackPane();

    // Update activity pane
    this.renderActivityPane();

    this.renderStdoutPane();
    this.renderStatsBar();

    this.screen.render();
  }

  private renderSourcePane(): void {
    const moduleId = this.state.getModuleId();
    const currentLine = this.state.getCurrentLine();
    const filePath = moduleId;
    const fileContent = readSourceFile(filePath);
    const highlighted = syntaxHighlight(fileContent, "ts");
    const lines = highlighted.split("\n");
    this.sourceBox.setLabel(` source: ${moduleId} `);

    const content: string[] = [];
    const windowSize = 20;
    const center = currentLine ? currentLine - 1 : 0; // 0-indexed
    const start = Math.max(0, center - Math.floor(windowSize / 2));
    const end = Math.min(lines.length, start + windowSize);

    for (let i = start; i < end; i++) {
      const lineNum = i + 1; // 1-indexed display
      const numStr = String(lineNum).padStart(4, " ");
      const lineText = lines[i];

      if (currentLine !== null && lineNum === currentLine) {
        content.push(
          `{magenta-bg}{bold}> ${numStr}  ${blessed.escape(lineText)}{/bold}{/magenta-bg}`,
        );
      } else {
        content.push(`  ${numStr}  ${blessed.escape(lineText)}`);
      }
    }

    this.sourceBox.setContent(content.join("\n"));

    // Scroll to make the current line visible
    if (currentLine !== null) {
      const scrollTarget = Math.max(0, center - start - 3);
      this.sourceBox.scrollTo(scrollTarget);
    }
  }

  private bold(str: string): string {
    return `{bold}${str}{/bold}`;
  }

  private highlight(str: string): string {
    return `{yellow-fg}${blessed.escape(str)}{/yellow-fg}`;
  }

  private formatKeyVal(
    key: string,
    value: unknown,
    { highlight }: { highlight?: boolean } = {},
  ): string {
    const formatted = `${blessed.escape(key)} = ${blessed.escape(formatValue(value))}`;
    return highlight ? this.highlight(formatted) : formatted;
  }

  private restoreFocusByName(focusedName: string | undefined): void {
    const newIndex = this.focusablePanes.findIndex((p) => p.name === focusedName);
    this.focusIndex = newIndex >= 0 ? newIndex : 0;
  }

  private renderThreadsPane(): void {
    const threadData = this.state.getThreadMessages(this.threadDisplayIndex);
    const focusedName = this.focusablePanes[this.focusIndex]?.name;
    if (!threadData) {
      this.threadsBox.hide();
      this.sourceBox.width = "100%";
      this.focusablePanes = this.focusablePanes.filter(
        (p) => p.name !== "threadsBox",
      );
      this.restoreFocusByName(focusedName);
      this.threadDisplayIndex = undefined;
      return;
    }

    // Resize source and show threads
    this.sourceBox.width = "65%";
    this.threadsBox.show();

    const countLabel = threadData.threadCount > 1
      ? ` [${threadData.threadIndex + 1}/${threadData.threadCount}]`
      : "";
    const threadLabel = ` threads: (id: ${threadData.threadId})${countLabel} `;

    // Add to focusable panes if not already there
    const existingPane = this.focusablePanes.find((p) => p.name === "threadsBox");
    if (existingPane) {
      existingPane.label = threadLabel;
    } else {
      this.focusablePanes.splice(1, 0, {
        box: this.threadsBox,
        name: "threadsBox",
        color: "cyan",
        label: threadLabel,
      });
      this.restoreFocusByName(focusedName);
    }

    this.threadsBox.setLabel(` ${this.fmt(threadLabel)} `);

    // Format messages
    const isZoomed = this.zoomedPane?.name === "threadsBox";
    const content = threadData.messages
      .map((m) => {
        const display = isZoomed
          ? m.content
          : m.content.length > 200 ? m.content.slice(0, 197) + "..." : m.content;
        return `  ${this.bold(`[${this.fmt(m.role)}]`)} ${this.fmt(display)}`;
      })
      .join("\n");

    this.threadsBox.setContent(content);
    this.threadsBox.setScrollPerc(100);
  }

  private renderLocalsPane(): void {
    const content: string[] = [];

    this.state.getArgs().forEach((arg) => {
      const val = arg.override || arg.value;
      let display = this.formatKeyVal(arg.key, val, {
        highlight: arg.override !== undefined,
      });
      content.push(display);
    });

    this.state.getLocals().forEach((local) => {
      const val = local.override || local.value;
      let display = this.formatKeyVal(local.key, val, {
        highlight: local.override !== undefined,
      });
      content.push(display);
    });

    const globalsContent: string[] = [];
    this.state.getGlobals().forEach((global) => {
      const val = global.override || global.value;
      let display = this.formatKeyVal(global.key, val, {
        highlight: global.override !== undefined,
      });
      globalsContent.push(display);
    });

    this.localsBox.setContent(content.join("\n"));
    this.globalsBox.setContent(globalsContent.join("\n"));
  }

  private fmt(str: string): string {
    return blessed.escape(str);
  }

  private renderCallStackPane(): void {
    const content: string[] = [];
    const callStack = this.state.getCallStack();
    for (let i = 0; i < callStack.length; i++) {
      const entry = callStack[i];
      const prefix = i === callStack.length - 1 ? " > " : "   ";
      const fileName = entry.moduleId.split("/").pop() || entry.moduleId;
      content.push(
        `${prefix}${this.fmt(entry.functionName)} (${this.fmt(fileName)}:${entry.line})`,
      );
    }
    this.callStackBox.setContent(content.join("\n"));
  }

  private renderActivityPane(): void {
    const content = this.state
      .getActivityLog()
      .map((entry) => `  ${this.fmt(entry)}`)
      .join("\n");
    this.activityBox.setContent(content);
    // Scroll to bottom
    this.activityBox.setScrollPerc(100);
  }

  private renderStdoutPane(): void {
    const content = this.state
      .getStdout()
      .map((line) => `  ${this.fmt(line)}`)
      .join("\n");
    this.stdoutBox.setContent(content);
    // Scroll to bottom
    this.stdoutBox.setScrollPerc(100);
  }

  private renderStatsBar(): void {
    const stats = this.state.getTokenStats();
    const cost = stats.totalCost === 0
      ? "$0.00"
      : stats.totalCost < 0.0001
        ? "<$0.0001"
        : `$${stats.totalCost.toFixed(4)}`;
    const content = `  tokens: ${stats.totalTokens.toLocaleString()} | cost: ${cost}`;
    this.statsBar.setContent(`{gray-fg}${content}{/gray-fg}`);
  }

  waitForCommand(): Promise<DebuggerCommand> {
    return new Promise((resolve) => {
      const handleKey = (
        _ch: string,
        key: blessed.Widgets.Events.IKeyEventArg,
      ) => {
        switch (key.name) {
          case "s":
          case "space":
          case "right":
            cleanup();
            resolve({ type: "step" });
            break;
          case "n":
            cleanup();
            resolve({ type: "next" });
            break;
          case "i":
            cleanup();
            resolve({ type: "stepIn" });
            break;
          case "o":
            cleanup();
            resolve({ type: "stepOut" });
            break;
          case "c":
            cleanup();
            resolve({ type: "continue" });
            break;
          case "r":
            cleanup();
            // Rewind mode is handled externally via showRewindSelector
            // Here we just signal intent; the driver will call showRewindSelector
            resolve({ type: "rewind" });
            break;
          case "d":
            cleanup();
            resolve({ type: "showCheckpoints" });
            break;
          case "k":
            cleanup();
            this.enterTextInput("checkpoint label (enter to skip)> ").then(
              (input) => {
                const label = input?.trim() || undefined;
                resolve({ type: "checkpoint", label });
              },
            );
            break;
          case "p":
            cleanup();
            this.enterTextInput("print> ").then((input) => {
              if (input && input.trim()) {
                resolve({ type: "print", varName: input.trim() });
              } else {
                // Re-prompt if empty
                this.waitForCommand().then(resolve);
              }
            });
            break;
          case "escape":
          case "q":
            cleanup();
            resolve({ type: "quit" });
            break;
          case "tab":
            if (key.shift) {
              this.focusPane((this.focusIndex - 1 + this.focusablePanes.length) % this.focusablePanes.length);
            } else {
              this.cycleFocus();
            }
            this.screen.render();
            break;
          case "up": {
            const currentFocusUp = this.focusablePanes[this.focusIndex];
            if (currentFocusUp.name === "sourceBox") {
              cleanup();
              resolve({
                type: "stepBack",
                preserveOverrides: key.shift === true,
              });
              break;
            }
            currentFocusUp.box.scroll(-1);
            this.screen.render();
            break;
          }

          case "down": {
            const currentFocus = this.focusablePanes[this.focusIndex];
            if (currentFocus.name === "sourceBox") {
              cleanup();
              resolve({ type: "step" });
              break;
            }
            currentFocus.box.scroll(1);
            this.screen.render();
            break;
          }
          case "z":
            this.toggleZoom();
            break;
          default:
            // Number keys: jump directly to a panel (1-indexed)
            if (key.full >= "1" && key.full <= "9") {
              const panelIndex = parseInt(key.full, 10) - 1;
              if (panelIndex < this.focusablePanes.length) {
                this.focusPane(panelIndex);
                this.screen.render();
              }
              break;
            }
            // Thread cycling: [ and ] to navigate between threads
            if (key.full === "[" || key.full === "]") {
              const current = this.threadDisplayIndex ?? 0;
              this.threadDisplayIndex = current + (key.full === "]" ? 1 : -1);
              this.renderThreadsPane();
              this.screen.render();
              break;
            }
            if (key.full === ":") {
              cleanup();
              this.enterTextInput(":").then((input) => {
                const cmd = parseCommandInput(input || "");
                if (cmd) {
                  resolve(cmd);
                } else {
                  this.waitForCommand().then(resolve);
                }
              });
            }
            break;
        }
      };

      /* waitForCommand is a one-shot promise — it resolves with a single command,
      then the driver processes that command and calls waitForCommand() again
      for the next one. The cleanup removes the listener so keys pressed
      during command processing (like during resume() or enterTextInput())
      don't accidentally resolve a stale promise.

      Without cleanup, if a key arrived while the driver was mid-processing, the
      old handler would try to resolve an already-resolved promise. It's essentially
      treating each waitForCommand() call as a single "wait for one keypress" operation.

      An alternative would be a persistent listener that pushes commands into a queue,
      but the one-shot approach is simpler and avoids buffering issues.
      */
      const cleanup = () => {
        this.screen.removeListener("keypress", handleKey);
      };

      this.screen.on("keypress", handleKey);
    });
  }

  private enterTextInput(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.commandBar.hide();
      this.commandInput.setLabel(` ${prompt} `);
      this.commandInput.setValue("");
      this.commandInput.show();
      this.screen.saveFocus();
      this.commandInput.focus();
      this.screen.render();

      // Handle escape to cancel, Ctrl-C to quit
      const onKeypress = (
        _ch: string,
        key: blessed.Widgets.Events.IKeyEventArg,
      ) => {
        if (key.full === "C-c") {
          this.cleanup();
        } else if (key.name === "escape") {
          done(null);
        }
      };

      const done = (value: string | null) => {
        this.commandInput.removeListener("keypress", onKeypress);
        this.commandInput.hide();
        this.commandBar.show();
        this.screen.restoreFocus();
        this.screen.render();
        resolve(value);
      };

      this.commandInput.readInput((_err: any, value: string | undefined) => {
        done(value || null);
      });

      this.commandInput.on("keypress", onKeypress);
    });
  }

  private focusPane(index: number): void {
    for (let i = 0; i < this.focusablePanes.length; i++) {
      const pane = this.focusablePanes[i];
      if (i === index) {
        pane.box.style.border.fg = "white";
        pane.box.style.label.fg = "cyan";
        pane.box.style.label.bold = true;
        pane.box.setLabel(pane.label);
        pane.box.style.fg = "white";
      } else {
        pane.box.style.border.fg = pane.color;
        pane.box.style.label.fg = pane.color;
        pane.box.style.label.bold = false;
        pane.box.setLabel(pane.label);
        pane.box.style.fg = "gray";
      }
    }
    this.focusIndex = index;
    this.focusablePanes[index].box.focus();
  }

  private cycleFocus(): void {
    this.focusPane((this.focusIndex + 1) % this.focusablePanes.length);
  }

  private toggleZoom(): void {
    const pane = this.focusablePanes[this.focusIndex];
    if (this.zoomedPane) {
      // Restore original position/size
      const { original } = this.zoomedPane;
      pane.box.top = original.top;
      pane.box.left = original.left;
      pane.box.width = original.width;
      pane.box.height = original.height;
      // Show all other panes
      for (const p of this.focusablePanes) {
        p.box.show();
      }
      this.zoomedPane = null;
    } else {
      // Save original geometry and maximize
      this.zoomedPane = {
        name: pane.name,
        original: {
          top: pane.box.top,
          left: pane.box.left,
          width: pane.box.width,
          height: pane.box.height,
        },
      };
      // Hide all other panes
      for (const p of this.focusablePanes) {
        if (p.name !== pane.name) p.box.hide();
      }
      pane.box.top = 0;
      pane.box.left = 0;
      pane.box.width = "100%";
      pane.box.height = "100%-4";
    }
    this.screen.render();
  }

  promptForInput(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const tryInput = () => {
        this.enterTextInput(prompt).then((value) => {
          if (value !== null) {
            resolve(value);
          } else {
            // Escape pressed — re-prompt since the program needs a value
            tryInput();
          }
        });
      };
      tryInput();
    });
  }

  async promptForNodeArgs(parameters: FunctionParameter[]): Promise<unknown[]> {
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
    this.renderActivityPane();
    this.screen.render();
  }

  showResult(result: unknown): void {
    this.activityBox.setContent(
      `{green-fg}${this.bold("Program result:")}{/green-fg}\n  ${blessed.escape(formatValue(result))}`,
    );
    this.commandBar.setContent(" Press any key to exit.");
    this.screen.render();
  }

  showRewindSelector(checkpoints: Checkpoint[]): Promise<number | null> {
    return new Promise((resolve) => {
      this.prevState = this.state.clone();

      if (checkpoints.length === 0) {
        // No checkpoints available
        this.activityBox.setContent(
          "{red-fg}No checkpoints available for rewind.{/red-fg}",
        );
        this.screen.render();
        resolve(null);
        return;
      }

      // Build list items
      const items = checkpoints.map((cp) => {
        let tag = "[auto]";
        if (cp.pinned) {
          tag = cp.label ? `[manual: ${cp.label}]` : "[code]";
        }
        const fileName = cp.getFilename();
        return `${tag} #${cp.id} - ${fileName}:${cp.scopeName} step ${cp.stepPath}`;
      });

      // Create a list overlay in place of the activity pane
      const list = blessed.list({
        top: "65%",
        left: 0,
        width: "100%",
        height: "35%-3",
        border: { type: "line" },
        label: " select checkpoint (Enter=select, Esc=cancel) ",
        items,
        keys: true,
        vi: true,
        tags: true,

        // setting true disable text selection
        mouse: false,
        style: {
          border: { fg: "yellow" },
          selected: {
            bg: "blue",
            fg: "white",
            bold: true,
          },
          item: {
            fg: "white",
          },
        },
      });

      this.screen.append(list);
      list.focus();
      this.screen.render();

      const cleanup = () => {
        if (!this.prevState) {
          throw new Error(
            "No previous state to restore to after rewind selection",
          );
        }
        this.state = this.prevState.clone();
        list.destroy();
        this.screen.render();
      };

      list.on("select item", async (_item: any, index: number) => {
        const checkpoint = checkpoints[index];
        await this.render(checkpoint, false);
      });

      list.on("select", (_item: any, index: number) => {
        cleanup();
        this.render();
        resolve(checkpoints[index].id);
      });

      list.key(["C-c"], () => {
        this.cleanup();
      });

      list.key(["escape", "q"], () => {
        cleanup();
        this.render();
        resolve(null);
      });
    });
  }

  showCheckpointsPanel(checkpoints: Checkpoint[]): Promise<void> {
    return new Promise((resolve) => {
      if (checkpoints.length === 0) {
        this.state.log("No checkpoints available.");
        this.renderActivityPane();
        this.screen.render();
        resolve();
        return;
      }

      let selectedIndex = checkpoints.length - 1; // start at most recent
      let rawMode = false;

      // Full-screen container
      const container = blessed.box({
        top: 0,
        left: 0,
        width: "100%",
        height: "100%-3",
        style: { bg: "black" },
      });

      // Left panel: checkpoint list
      const listBox = blessed.box({
        ...baseStyle,
        parent: container,
        top: 0,
        left: 0,
        width: "35%",
        height: "100%",
        label: " checkpoints ",
        style: {
          border: { fg: "cyan" },
          label: { fg: "cyan" },
        },
      });

      // Right panel: checkpoint detail
      const detailBox = blessed.box({
        ...baseStyle,
        parent: container,
        top: 0,
        left: "35%+1",
        width: "65%-1",
        height: "100%",
        label: " checkpoint detail ",
        style: {
          border: { fg: "green" },
          label: { fg: "green" },
        },
      });

      // Help bar replaces command bar
      const helpBar = blessed.box({
        bottom: 0,
        left: 0,
        width: "100%",
        height: 3,
        border: { type: "line" },
        tags: true,
        style: { border: { fg: "white" } },
        content: `${this.bold("(↑/↓)")}navigate  ${this.bold("(^F/^B)")}scroll detail  ${this.bold("(t)")}toggle raw  ${this.bold("(enter)")}go to checkpoint  ${this.bold("(esc/q)")}close`,
      });

      // Hide normal UI
      for (const p of this.focusablePanes) p.box.hide();
      this.statsBar.hide();
      this.commandBar.hide();

      this.screen.append(container);
      this.screen.append(helpBar);

      const renderList = () => {
        const lines = checkpoints.map((cp, i) => {
          let tag = "{gray-fg}[auto]{/gray-fg}";
          if (cp.pinned) {
            tag = cp.label
              ? `{yellow-fg}[manual: ${blessed.escape(cp.label)}]{/yellow-fg}`
              : "{magenta-fg}[code]{/magenta-fg}";
          }
          const fileName = cp.getFilename();
          const line = `${tag} {bold}#${cp.id}{/bold} ${blessed.escape(fileName)}:${blessed.escape(cp.scopeName)}`;
          if (i === selectedIndex) {
            return `{blue-bg}{white-fg} > ${line} {/white-fg}{/blue-bg}`;
          }
          return `   ${line}`;
        });
        listBox.setContent(lines.join("\n"));
        listBox.setLabel(` checkpoints (${selectedIndex + 1}/${checkpoints.length}) `);

        // Scroll to keep selected item visible
        const boxHeight = (listBox as any).height as number;
        const visibleRows = typeof boxHeight === "number" ? boxHeight - 2 : 20;
        if (selectedIndex >= visibleRows) {
          listBox.scrollTo(selectedIndex - Math.floor(visibleRows / 2));
        } else {
          listBox.scrollTo(0);
        }
      };

      const renderFormattedDetail = (cp: Checkpoint): string[] => {
        const lines: string[] = [];

        lines.push(`{bold}{cyan-fg}Checkpoint #${cp.id}{/cyan-fg}{/bold}`);
        lines.push("");
        lines.push(`{bold}Location:{/bold}  ${blessed.escape(cp.getFilename())}:${blessed.escape(cp.scopeName)}`);
        lines.push(`{bold}Step:{/bold}      ${blessed.escape(cp.stepPath)}`);
        lines.push(`{bold}Node:{/bold}      ${blessed.escape(cp.nodeId || "(none)")}`);
        lines.push(`{bold}Pinned:{/bold}    ${cp.pinned ? "yes" : "no"}`);
        if (cp.label) {
          lines.push(`{bold}Label:{/bold}     ${blessed.escape(cp.label)}`);
        }

        // Show the call stack
        const frame = cp.getCurrentFrame();
        if (frame) {
          lines.push("");
          lines.push("{bold}{yellow-fg}Arguments:{/yellow-fg}{/bold}");
          if (frame.args && Object.keys(frame.args).length > 0) {
            for (const [key, value] of Object.entries(frame.args)) {
              if (!key.startsWith("__")) {
                lines.push(`  ${blessed.escape(key)} = ${blessed.escape(formatValue(value))}`);
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
                lines.push(`  ${blessed.escape(key)} = ${blessed.escape(formatValue(value))}`);
              }
            }
          } else {
            lines.push("  (none)");
          }
        }

        // Show globals for this module
        const globals = cp.getGlobalsForModule();
        if (globals) {
          lines.push("");
          lines.push("{bold}{green-fg}Globals:{/green-fg}{/bold}");
          for (const [key, value] of Object.entries(globals)) {
            if (!key.startsWith("__")) {
              lines.push(`  ${blessed.escape(key)} = ${blessed.escape(formatValue(value))}`);
            }
          }
        }

        // Show stack depth
        const frames = cp.stack?.stack;
        if (frames && frames.length > 0) {
          lines.push("");
          lines.push(`{bold}{magenta-fg}Call Stack:{/magenta-fg}{/bold} (${frames.length} frame${frames.length === 1 ? "" : "s"})`);
          for (let i = 0; i < frames.length; i++) {
            const entry = frames[i];
            const prefix = i === frames.length - 1 ? " > " : "   ";
            const argKeys = Object.keys(entry.args).filter(k => !k.startsWith("__"));
            const argStr = argKeys.length > 0 ? `(${argKeys.join(", ")})` : "()";
            lines.push(`${prefix}frame ${i} ${argStr} at step ${entry.step}`);
          }
        }

        return lines;
      };

      const renderRawDetail = (cp: Checkpoint): string[] => {
        const json = JSON.stringify(cp.toJSON(), null, 2);
        return blessed.escape(json).split("\n");
      };

      const renderDetail = () => {
        const cp = checkpoints[selectedIndex];
        const modeLabel = rawMode ? "raw" : "formatted";
        const lines = rawMode ? renderRawDetail(cp) : renderFormattedDetail(cp);
        detailBox.setContent(lines.join("\n"));
        detailBox.setLabel(` checkpoint #${cp.id} detail (${modeLabel}) `);
      };

      const renderAll = () => {
        renderList();
        renderDetail();
        this.screen.render();
      };

      renderAll();
      container.focus();

      const cleanup = () => {
        container.destroy();
        helpBar.destroy();
        // Show normal UI
        for (const p of this.focusablePanes) p.box.show();
        this.statsBar.show();
        this.commandBar.show();
        this.render();
      };

      container.key(["up", "k"], () => {
        if (selectedIndex > 0) {
          selectedIndex--;
          renderAll();
        }
      });

      container.key(["down", "j"], () => {
        if (selectedIndex < checkpoints.length - 1) {
          selectedIndex++;
          renderAll();
        }
      });

      container.key(["C-f"], () => {
        const boxHeight = (detailBox as any).height as number;
        const pageSize = typeof boxHeight === "number" ? boxHeight - 2 : 20;
        detailBox.scroll(pageSize);
        this.screen.render();
      });

      container.key(["C-b"], () => {
        const boxHeight = (detailBox as any).height as number;
        const pageSize = typeof boxHeight === "number" ? boxHeight - 2 : 20;
        detailBox.scroll(-pageSize);
        this.screen.render();
      });

      container.key(["t"], () => {
        rawMode = !rawMode;
        renderAll();
      });

      container.key(["enter"], async () => {
        const cp = checkpoints[selectedIndex];
        cleanup();
        await this.render(cp);
        resolve();
      });

      container.key(["escape", "q"], () => {
        cleanup();
        resolve();
      });

      container.key(["C-c"], () => {
        this.cleanup();
      });
    });
  }

  destroy(): void {
    this.stopSpinner();
    try {
      this.screen.destroy();
    } catch {
      // Screen may already be destroyed
    }
  }
}
