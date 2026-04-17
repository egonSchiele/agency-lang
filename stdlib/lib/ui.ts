import * as readline from "readline";
import { color } from "termcolors";
import { syntaxHighlight } from "./syntax.js";

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

export function _emptyLine(): string {
  return " ".repeat(cols);
}

type UIConfig = {
  title: string;
  statusRight: string;
};

// UI title and default right-side status text, set once during _initUI()
let config: UIConfig = { title: "", statusRight: "" };

// Whether the UI has been initialized via _initUI()
let initialized = false;

// Terminal row where the status bar is drawn (2 rows from bottom)
let statusBarRow = 0;

// Terminal row where the input prompt is drawn (1 row from bottom)
let inputRow = 0;

// Terminal row where the hint text is drawn (last row)
let hintRow = 0;

// Current terminal width in columns
let cols = 80;

// Current terminal height in rows
let rows = 24;

// Dynamic left-side status bar text; overrides config.title when non-empty
let currentStatusLeft = "";

// Dynamic right-side status bar text; overrides config.statusRight when non-empty
let currentStatusRight = "";

// Active readline interface during _prompt(), closed when the user submits input
let activeRl: readline.Interface | null = null;

// Interval handle for the spinner animation, cleared by _stopSpinner()
let spinnerInterval: ReturnType<typeof setInterval> | null = null;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerIdx = 0;
let spinnerText = "";

let resizeHandler: (() => void) | null = null;
let exitHandler: (() => void) | null = null;
let sigintHandler: (() => void) | null = null;

function getTermSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

const MIN_ROWS = 6;

function updateLayout() {
  const size = getTermSize();
  rows = Math.max(size.rows, MIN_ROWS);
  cols = size.cols;
  statusBarRow = rows - 2;
  inputRow = rows - 1;
  hintRow = rows;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function renderStatusBar() {
  const rawLeft = currentStatusLeft || config.title;
  const rawRight = currentStatusRight || config.statusRight;
  const maxContent = cols - 4;
  const rightLen = Math.min(rawRight.length, Math.floor(maxContent / 3));
  const leftLen = Math.min(rawLeft.length, maxContent - rightLen);
  const left = truncate(rawLeft, leftLen);
  const right = truncate(rawRight, rightLen);
  const padding = Math.max(0, cols - left.length - right.length - 2);
  const bar = color.cyan(` ${left}${"─".repeat(padding)} ${right}`);
  process.stdout.write(
    saveCursor() +
      moveTo(statusBarRow, 1) +
      clearLine() +
      bar +
      restoreCursor(),
  );
}

function renderInputPrompt(prompt: string) {
  process.stdout.write(
    saveCursor() +
      moveTo(inputRow, 1) +
      clearLine() +
      color.bold("❯") +
      ` ${prompt}` +
      restoreCursor(),
  );
}

function renderHintBar(hint: string) {
  process.stdout.write(
    saveCursor() +
      moveTo(hintRow, 1) +
      clearLine() +
      color.dim(`  ${hint}`) +
      restoreCursor(),
  );
}

function clearBottomArea() {
  process.stdout.write(
    saveCursor() +
      moveTo(statusBarRow, 1) +
      clearLine() +
      moveTo(inputRow, 1) +
      clearLine() +
      moveTo(hintRow, 1) +
      clearLine() +
      restoreCursor(),
  );
}

function setupScrollRegion() {
  updateLayout();
  process.stdout.write(setScrollRegion(1, statusBarRow - 1));
  process.stdout.write(moveTo(1, 1));
}

function writeInScrollRegion(text: string) {
  process.stdout.write(
    saveCursor() + moveTo(statusBarRow - 1, 1) + "\n" + text + restoreCursor(),
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
  renderStatusBar();
}

function resetState() {
  config = { title: "", statusRight: "" };
  currentStatusLeft = "";
  currentStatusRight = "";
  spinnerIdx = 0;
  spinnerText = "";
}

export function _initUI(title: string): void {
  if (initialized) return;
  initialized = true;
  config.title = title;
  config.statusRight = "";

  setupScrollRegion();
  renderStatusBar();
  renderInputPrompt("");
  renderHintBar("");

  resizeHandler = () => {
    updateLayout();
    process.stdout.write(setScrollRegion(1, statusBarRow - 1));
    renderStatusBar();
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
  clearBottomArea();
  process.stdout.write(moveTo(rows, 1) + "\n");
  resetState();
}

export function _log(message: string): void {
  if (!initialized) return;
  writeInScrollRegion(message);
  renderStatusBar();
}

export function _status(left: string, right: string): void {
  if (!initialized) return;
  currentStatusLeft = left;
  currentStatusRight = right;
  renderStatusBar();
}

export function _chat(role: string, message: string): void {
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
  renderStatusBar();
}

export function _code(filename: string, content: string): void {
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
    return `| ${line}`;
    //return `${color.dim("│")} ${line}`;
  });
}

export function _separator(label: string): void {
  if (!initialized) return;
  if (label) {
    const padding = Math.max(0, cols - label.length - 4);
    writeInScrollRegion(color.dim(`── ${label} ${"─".repeat(padding)}`));
  } else {
    writeInScrollRegion(color.dim("─".repeat(cols)));
  }
  renderStatusBar();
}

export function _startSpinner(text: string): void {
  if (!initialized || spinnerInterval) return;
  spinnerText = text;
  spinnerIdx = 0;
  const update = () => {
    const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
    renderInputPrompt(`${color.cyan(frame)} ${spinnerText}`);
    spinnerIdx++;
  };
  update();
  spinnerInterval = setInterval(update, 80);
}

export function _stopSpinner(): void {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
  if (initialized) {
    renderInputPrompt("");
  }
}

export function _prompt(question: string): Promise<string> {
  if (!initialized) {
    return Promise.resolve("");
  }
  _stopSpinner();

  return new Promise<string>((resolve) => {
    process.stdout.write(
      moveTo(inputRow, 1) + clearLine() + color.bold("❯") + " ",
    );
    renderHintBar(question);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      prompt: "",
    });
    activeRl = rl;

    process.stdout.write(moveTo(inputRow, 4));

    rl.on("line", (answer: string) => {
      rl.close();
      activeRl = null;
      process.stdout.write(
        moveTo(inputRow, 1) + clearLine() + moveTo(hintRow, 1) + clearLine(),
      );
      renderInputPrompt("");
      renderHintBar("");
      resolve(answer);
    });
  });
}
