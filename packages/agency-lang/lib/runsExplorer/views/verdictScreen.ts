// One grader's verdict on one test, as a scrollable page: the input the
// agent was given, the output the graders saw, and this grader's score and
// feedback. Lines wrap, so scrolling clamps against the post-wrap count,
// the way the logs viewer's detail screen does.
import { column, line } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { bottomHints } from "../../logsViewer/views/shared.js";
import { wrapLine } from "../../logsViewer/treeRows.js";
import type { GraderVerdict, RunRow, TestDetail } from "../rows.js";
import { verdictValue } from "./gradersTableView.js";
import { fmtScore, scoreColor } from "./rowFormat.js";
import type { ExplorerAction, ExplorerView, Viewport } from "./explorerView.js";

const CHROME_ROWS = 3;

/** A page line with the color it renders in. */
type Styled = { text: string; fg?: string };

export class VerdictScreen implements ExplorerView {
  readonly viewName = "verdict" as const;
  private detail: TestDetail | null = null;
  private verdict: GraderVerdict | null = null;
  private scroll = 0;
  private message = "";

  constructor(
    private readonly runKey: string,
    private readonly inputId: string,
    private readonly graderName: string,
  ) {}

  setData(rows: RunRow[]): void {
    const test = rows
      .find((row) => row.key === this.runKey)
      ?.tests.find((candidate) => candidate.inputId === this.inputId);
    this.detail = test?.detail ?? null;
    this.verdict =
      this.detail?.graders.find((candidate) => candidate.name === this.graderName) ?? null;
  }

  setProgress(): void {
    // Nothing to narrate here.
  }

  notify(message: string): void {
    this.message = message;
  }

  helpLines(): string[] {
    return ["↑↓ / j k scroll    g / G top / bottom    Ctrl+F/B/D/U page    Esc back    q quit"];
  }

  handleKey(event: KeyEvent, viewport: Viewport): ExplorerAction {
    this.message = "";
    const key = formatKey(event);
    if (key === "q" || key === "Ctrl+C") return { kind: "quit" };
    if (key === "Escape" || key === "Left" || key === "h") return { kind: "back" };
    const total = this.pageLines(viewport.cols).length;
    const page = Math.max(1, viewport.rows - CHROME_ROWS);
    const clamp = (value: number) => Math.max(0, Math.min(value, Math.max(0, total - page)));
    if (key === "Up" || key === "k") this.scroll = clamp(this.scroll - 1);
    if (key === "Down" || key === "j") this.scroll = clamp(this.scroll + 1);
    if (key === "g") this.scroll = 0;
    if (key === "G") this.scroll = clamp(total);
    if (key === "Ctrl+F" || key === "Ctrl+D") this.scroll = clamp(this.scroll + page);
    if (key === "Ctrl+B" || key === "Ctrl+U") this.scroll = clamp(this.scroll - page);
    return { kind: "none" };
  }

  render(viewport: Viewport): Element {
    const all = this.pageLines(viewport.cols);
    const page = Math.max(1, viewport.rows - CHROME_ROWS);
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, all.length - page)));
    const visible = all.slice(this.scroll, this.scroll + page);
    const shownTo = Math.min(all.length, this.scroll + page);
    return column(
      { justifyContent: "flex-start" },
      line(this.title(), { height: 1, fg: "bright-white" }),
      ...visible.map((entry) =>
        line(entry.text, { height: 1, ...(entry.fg ? { fg: entry.fg } : {}) }),
      ),
      line(
        bottomHints(
          `↑↓ scroll (${Math.min(this.scroll + 1, all.length)}–${shownTo} of ${all.length})  Esc back  q quit` +
            (this.message ? `  ${this.message}` : ""),
          "verdict",
          viewport.cols,
        ),
        { height: 1, fg: "gray" },
      ),
    );
  }

  private title(): string {
    const verdict = this.verdict;
    if (verdict === null) return `VERDICT  ${this.graderName} on ${this.inputId}`;
    return `VERDICT  ${verdict.name} on ${this.inputId} — ${scoreText(verdict)}`;
  }

  /** The page, wrapped to `cols`. Exposed for tests. */
  pageLines(cols: number): Styled[] {
    const width = Math.max(cols - 2, 8);
    return this.sections().flatMap((entry) =>
      wrapLine(entry.text, width).map((text) => ({ ...entry, text })),
    );
  }

  private sections(): Styled[] {
    const detail = this.detail;
    const verdict = this.verdict;
    if (detail === null || verdict === null) {
      return [{ text: `no verdict named ${this.graderName} for ${this.inputId}`, fg: "gray" }];
    }
    const role = verdict.mustPass ? "must-pass gate" : `weight ${verdict.weight}`;
    return [
      { text: `score:    ${scoreText(verdict)}`, fg: scoreColor(verdictValue(verdict)) },
      { text: `role:     ${role}` },
      { text: `grader:   ${verdict.annotator}`, fg: "gray" },
      { text: "" },
      heading("feedback"),
      ...body(verdict.feedback ?? "(the grader gave no feedback)"),
      { text: "" },
      heading("input"),
      ...body(detail.input ?? "(no input recorded)"),
      { text: "" },
      heading(detail.output.kind === "lastMessage" ? "output (last message)" : "output"),
      ...body(detail.output.kind === "none" ? "(no output recorded)" : detail.output.text),
    ];
  }
}

function heading(text: string): Styled {
  return { text: `── ${text} ──`, fg: "bright-white" };
}

/** A block of text as page lines; JSON is pretty-printed so a structured
 *  output reads as a document rather than one long line. */
function body(text: string): Styled[] {
  return prettyJson(text)
    .split("\n")
    .map((entry) => ({ text: entry }));
}

function prettyJson(text: string): string {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function scoreText(verdict: GraderVerdict): string {
  if (verdict.score.kind === "binary") return verdict.score.pass ? "pass" : "FAIL";
  return fmtScore(verdict.score.value);
}
