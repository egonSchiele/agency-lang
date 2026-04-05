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

  private focusIndex = 0;
  private focusablePanes: {
    box: blessed.Widgets.BoxElement;
    name: string;
    color: string;
  }[];
  public state: UIState;
  public prevState: UIState | null = null;
  private commandBarContent = "";
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

    // Activity pane (~20% height)
    this.activityBox = blessed.box({
      ...baseStyle,
      top: "65%",
      left: 0,
      width: "50%",
      height: "35%-3",
      label: " activity ",
      style: {
        border: { fg: "yellow" },
        label: { fg: "yellow" },
      },
    });

    // Activity pane (~20% height)
    this.stdoutBox = blessed.box({
      ...baseStyle,
      top: "65%",
      right: 0,
      width: "50%",
      height: "35%-3",
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

    this.screen.append(this.sourceBox);
    this.screen.append(this.threadsBox);
    this.screen.append(this.localsBox);
    this.screen.append(this.globalsBox);
    this.screen.append(this.callStackBox);
    this.screen.append(this.activityBox);
    this.screen.append(this.stdoutBox);
    this.screen.append(this.commandBar);
    this.screen.append(this.commandInput);

    this.focusablePanes = [
      { box: this.sourceBox, name: "sourceBox", color: "cyan" },
      { box: this.localsBox, name: "localsBox", color: "green" },
      { box: this.globalsBox, name: "globalsBox", color: "green" },
      { box: this.callStackBox, name: "callStackBox", color: "magenta" },
      { box: this.activityBox, name: "activityBox", color: "yellow" },
      { box: this.stdoutBox, name: "stdoutBox", color: "blue" },
    ];

    // Ctrl-C to quit — blessed puts the terminal in raw mode so SIGINT
    // is not generated; we must catch the keypress directly.
    this.screen.key(["C-c"], () => this.cleanup());

    // Terminal cleanup handlers
    process.on("SIGINT", () => this.cleanup());
    process.on("SIGTERM", () => this.cleanup());
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
    const threadData = this.state.getThreadMessages();
    const focusedName = this.focusablePanes[this.focusIndex]?.name;
    if (!threadData) {
      this.threadsBox.hide();
      this.sourceBox.width = "100%";
      this.focusablePanes = this.focusablePanes.filter(
        (p) => p.name !== "threadsBox",
      );
      this.restoreFocusByName(focusedName);
      return;
    }

    // Resize source and show threads
    this.sourceBox.width = "65%";
    this.threadsBox.show();

    // Add to focusable panes if not already there
    if (!this.focusablePanes.some((p) => p.name === "threadsBox")) {
      this.focusablePanes.splice(1, 0, {
        box: this.threadsBox,
        name: "threadsBox",
        color: "cyan",
      });
      this.restoreFocusByName(focusedName);
    }

    this.threadsBox.setLabel(` threads: ${this.fmt(threadData.threadId)} `);

    // Format messages
    const content = threadData.messages
      .map((m) => {
        const truncated =
          m.content.length > 200 ? m.content.slice(0, 197) + "..." : m.content;
        return `  ${this.bold(`[${this.fmt(m.role)}]`)} ${this.fmt(truncated)}`;
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
            this.cycleFocus();
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
          default:
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

      // Handle escape to cancel
      const onEscape = (
        _ch: string,
        key: blessed.Widgets.Events.IKeyEventArg,
      ) => {
        if (key.name === "escape") {
          done(null);
        }
      };

      const done = (value: string | null) => {
        this.commandInput.removeListener("keypress", onEscape);
        this.commandInput.hide();
        this.commandBar.show();
        this.screen.restoreFocus();
        this.screen.render();
        resolve(value);
      };

      this.commandInput.readInput((_err: any, value: string | undefined) => {
        done(value || null);
      });

      this.commandInput.on("keypress", onEscape);
    });
  }

  private cycleFocus(): void {
    // Restore previous pane's border color
    const prev = this.focusablePanes[this.focusIndex];
    prev.box.style.border.fg = prev.color;
    prev.box.style.label.fg = prev.color;

    this.focusIndex = (this.focusIndex + 1) % this.focusablePanes.length;

    // Highlight the newly focused pane
    const next = this.focusablePanes[this.focusIndex];
    next.box.style.border.fg = "white";
    next.box.style.label.fg = "white";
    next.box.focus();
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

      list.key(["escape", "q"], () => {
        cleanup();
        this.render();
        resolve(null);
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
