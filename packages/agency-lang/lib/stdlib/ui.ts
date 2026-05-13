import * as readline from "readline";
import process from "process";
import { color } from "../utils/termcolors.js";
import { syntaxHighlight } from "./syntax.js";
import { _input } from "./builtins.js";

// Evaluated once at load time — the env var is set by the debugger CLI
// before any compiled agency code runs and never changes.
const isDebuggerMode = !!process.env.AGENCY_DEBUGGER;

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

export function _emptyLine(): void {
  if (isDebuggerMode) {
    console.log("");
    return;
  }
  if (!initialized) return;
  writeInScrollRegion("");
  renderFixedArea();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let initialized = false;
let cols = 80;
let rows = 24;

let appTitle = "";

// Status bar content
let statusLeft = "";
let statusRight = "";

// Input bar content
let inputContent = "";
let hintContent = "";

// Spinner
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerIdx = 0;

// Readline
let activeRl: readline.Interface | null = null;

// Event handlers (stored for cleanup)
let resizeHandler: (() => void) | null = null;
let exitHandler: (() => void) | null = null;
let sigintHandler: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Fixed area — the single place that defines the bottom of the screen
// ---------------------------------------------------------------------------

// The index (within the fixed lines array) where the input prompt lives.
// Set by buildFixedLines() so _prompt() can position the cursor correctly.
let inputLineIndex = 0;

// Returns an array of strings, one per line. The length of this array
// determines how many rows are reserved at the bottom. Change this function
// to add, remove, or restyle lines without touching anything else.
function buildFixedLines(): string[] {
  const lines: string[] = [];

  lines.push("");
  lines.push("");
  // prompt
  lines.push(color.dim("─".repeat(cols)));
  inputLineIndex = lines.length;
  lines.push(`${color.bold("❯")} ${inputContent}`);
  lines.push(color.dim("─".repeat(cols)));

  // status bar
  const left = truncate(
    statusLeft || hintContent,
    Math.floor(((cols - 4) * 2) / 3),
  );
  const right = truncate(statusRight, Math.floor((cols - 4) / 3));
  const padding = Math.max(0, cols - left.length - right.length - 2);
  lines.push(color.cyan(`${left} ${" ".repeat(padding)} ${right}`));
  lines.push("");

  return lines;
}

function fixedLineCount(): number {
  return buildFixedLines().length;
}

// The row where the fixed area starts (1-indexed)
function fixedAreaStart(): number {
  return rows - fixedLineCount() + 1;
}

// The last row of the scroll region (one above the fixed area)
function scrollBottom(): number {
  return fixedAreaStart() - 1;
}

// Renders the entire fixed area at the bottom of the screen.
// This is the ONLY function that writes to the fixed rows.
function renderFixedArea() {
  const lines = buildFixedLines();
  const startRow = fixedAreaStart();
  let out = saveCursor();
  for (let i = 0; i < lines.length; i++) {
    out += moveTo(startRow + i, 1) + clearLine() + lines[i];
  }
  out += restoreCursor();
  process.stdout.write(out);
}

function clearFixedArea() {
  const startRow = fixedAreaStart();
  const count = fixedLineCount();
  let out = saveCursor();
  for (let i = 0; i < count; i++) {
    out += moveTo(startRow + i, 1) + clearLine();
  }
  out += restoreCursor();
  process.stdout.write(out);
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

function updateSize() {
  cols = process.stdout.columns || 80;
  // Ensure at least enough rows for the fixed area plus one scroll line
  const minRows = fixedLineCount() + 1;
  rows = Math.max(process.stdout.rows || 24, minRows);
}

function truncate(str: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function applyScrollRegion() {
  process.stdout.write(setScrollRegion(1, scrollBottom()));
}

function writeInScrollRegion(text: string) {
  process.stdout.write(
    saveCursor() + moveTo(scrollBottom(), 1) + "\n" + text + restoreCursor(),
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
  renderFixedArea();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function _initUI(title: string): void {
  if (isDebuggerMode) return;
  if (initialized) return;
  initialized = true;

  appTitle = title;
  statusLeft = "";
  statusRight = "";
  inputContent = "";
  hintContent = "";

  updateSize();
  applyScrollRegion();
  process.stdout.write(moveTo(1, 1));
  renderFixedArea();
  _separator(appTitle);

  resizeHandler = () => {
    updateSize();
    applyScrollRegion();
    renderFixedArea();
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
  if (isDebuggerMode) return;
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
  clearFixedArea();
  process.stdout.write(moveTo(rows, 1) + "\n");

  statusLeft = "";
  statusRight = "";
  inputContent = "";
  hintContent = "";
}

// ---------------------------------------------------------------------------
// Public API — scrollable output
// ---------------------------------------------------------------------------

export function _log(message: string): void {
  if (isDebuggerMode) {
    console.log(message);
    return;
  }
  if (!initialized) return;
  writeInScrollRegion(message);
  renderFixedArea();
}

export function _chat(role: string, message: string): void {
  if (isDebuggerMode) {
    console.log(`${role}: ${message}`);
    return;
  }
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
  renderFixedArea();
}

export function _code(filename: string, content: string): void {
  if (isDebuggerMode) {
    console.log(`[${filename}]\n${content}`);
    return;
  }
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
  if (isDebuggerMode) {
    console.log(`[${filename}]\n${_content}`);
    return;
  }
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
    return `│ ${line}`;
  });
}

export function _separator(label: string): void {
  if (isDebuggerMode) {
    console.log(label ? `── ${label} ──` : "────");
    return;
  }
  if (!initialized) return;
  if (label) {
    const padding = Math.max(0, cols - label.length - 4);
    writeInScrollRegion(color.dim(`── ${label} ${"─".repeat(padding)}`));
  } else {
    writeInScrollRegion(color.dim("─".repeat(cols)));
  }
  renderFixedArea();
}

// ---------------------------------------------------------------------------
// Public API — fixed area updates
// ---------------------------------------------------------------------------

export function _status(left: string, right: string): void {
  if (isDebuggerMode) return;
  if (!initialized) return;
  statusLeft = left;
  statusRight = right;
  renderFixedArea();
}

export function _startSpinner(text: string): void {
  if (isDebuggerMode) return;
  if (!initialized || spinnerInterval) return;
  spinnerIdx = 0;
  const update = () => {
    const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
    inputContent = `${color.cyan(frame)} ${text}`;
    renderFixedArea();
    spinnerIdx++;
  };
  update();
  spinnerInterval = setInterval(update, 80);
}

export function _stopSpinner(): void {
  if (isDebuggerMode) return;
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
  if (initialized) {
    inputContent = "";
    renderFixedArea();
  }
}

export function _prompt(question: string): Promise<string> {
  // Delegate to the builtin input() which supports the __agencyInputOverride
  // hook and works inside handler bodies (where interrupts are forbidden).
  if (isDebuggerMode) return _input(question);
  if (!initialized) {
    return Promise.resolve("");
  }
  _stopSpinner();

  return new Promise<string>((resolve) => {
    // Update hint, clear input, position cursor on the input row
    hintContent = question;
    inputContent = "";
    renderFixedArea();

    // Position cursor after the prompt character for typing
    process.stdout.write(moveTo(fixedAreaStart() + inputLineIndex, 4));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      prompt: "",
    });
    activeRl = rl;

    rl.on("line", (answer: string) => {
      rl.close();
      activeRl = null;
      inputContent = "";
      hintContent = "";
      renderFixedArea();
      resolve(answer);
    });
  });
}
