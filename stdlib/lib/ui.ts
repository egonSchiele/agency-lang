import * as readline from "readline";
import { color } from "termcolors";

const ESC = "\x1b";
const CSI = `${ESC}[`;

function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}

function clearLine(): string {
  return `${CSI}2K`;
}

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

type UIConfig = {
  title: string;
  statusRight: string;
};

let config: UIConfig = { title: "", statusRight: "" };
let initialized = false;
let statusBarRow = 0;
let inputRow = 0;
let hintRow = 0;
let cols = 80;
let rows = 24;
let currentStatusLeft = "";
let currentStatusRight = "";
let activeRl: readline.Interface | null = null;
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
      color.bold("❯") + ` ${prompt}` +
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
    saveCursor() +
      moveTo(statusBarRow - 1, 1) +
      "\n" +
      text +
      restoreCursor(),
  );
}

function writeBox(
  filename: string,
  lines: string[],
  renderLine: (line: string, index: number) => string,
): void {
  writeInScrollRegion(color.dim(`┌─ ${filename} ${"─".repeat(Math.max(0, cols - filename.length - 6))}`));
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
  const colorFn = role === "user" ? color.blue.bold : role === "agent" ? color.green.bold : color.yellow.bold;
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

export function _diff(filename: string, content: string): void {
  if (!initialized) return;
  writeBox(filename, content.split("\n"), (line) => {
    if (line.startsWith("+")) {
      return color.green(`│ ${line}`);
    } else if (line.startsWith("-")) {
      return color.red(`│ ${line}`);
    }
    return `${color.dim("│")} ${line}`;
  });
}

export function _separator(label: string): void {
  if (!initialized) return;
  const padding = Math.max(0, cols - label.length - 4);
  writeInScrollRegion(color.dim(`── ${label} ${"─".repeat(padding)}`));
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
