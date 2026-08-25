// One test's graders: a row per effective score row, with the score, the
// gate, the weight, and the first line of the grader's feedback. Enter on
// a row opens the verdict screen. Holds only the run KEY and test id, and
// re-resolves the live test on every setData, like the tests table.
import { column, line } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { TableComponent, type TableColumn } from "../../tui/table.js";
import { bottomHints } from "../../logsViewer/views/shared.js";
import type { GraderVerdict, RunRow, TestRow } from "../rows.js";
import { fmtScore, scoreColor } from "./rowFormat.js";
import type { ExplorerAction, ExplorerView, Viewport } from "./explorerView.js";

const CHROME_ROWS = 4;
const HINTS = "Enter verdict  o log  Esc back  q quit";

/** A verdict's score as 0..1, the same number the run row's mean uses. */
export function verdictValue(verdict: GraderVerdict): number {
  return verdict.score.kind === "binary" ? (verdict.score.pass ? 1 : 0) : verdict.score.value;
}

/** "gate" for a must-pass grader, else its weight when not the default 1. */
function fmtRole(verdict: GraderVerdict): string {
  if (verdict.mustPass) return "gate";
  return verdict.weight === 1 ? "" : `×${verdict.weight}`;
}

function firstLine(text: string | null): string {
  return text === null ? "" : text.split("\n")[0];
}

export class GradersTableView implements ExplorerView {
  readonly viewName = "graders" as const;
  private parent: RunRow | null = null;
  private test: TestRow | null = null;
  private cursorName: string | null = null;
  private scrollTop = 0;
  private message = "";
  private readonly table = new TableComponent<GraderVerdict>();

  constructor(
    private readonly runKey: string,
    private readonly inputId: string,
  ) {}

  setData(rows: RunRow[]): void {
    this.parent = rows.find((row) => row.key === this.runKey) ?? null;
    this.test = this.parent?.tests.find((test) => test.inputId === this.inputId) ?? null;
  }

  setProgress(): void {
    // The runs table narrates loading; this screen only shows its own rows.
  }

  notify(message: string): void {
    this.message = message;
  }

  helpLines(): string[] {
    return [
      "j/k move    Enter this grader's verdict with the input and output it judged",
      "o this test's log in the viewer    Esc back    q quit",
    ];
  }

  handleKey(event: KeyEvent, viewport: Viewport): ExplorerAction {
    this.message = "";
    const key = formatKey(event);
    const verdicts = this.verdicts();
    const cursor = this.cursorIndex(verdicts);
    const page = Math.max(1, viewport.rows - CHROME_ROWS);

    if (key === "q" || key === "Ctrl+C") {
      return { kind: "quit" };
    }
    if (key === "Escape" || key === "Left" || key === "h") {
      return { kind: "back" };
    }
    if (key === "Up" || key === "k") {
      return this.moveTo(verdicts, cursor - 1);
    }
    if (key === "Down" || key === "j") {
      return this.moveTo(verdicts, cursor + 1);
    }
    if (key === "g") {
      return this.moveTo(verdicts, 0);
    }
    if (key === "G") {
      return this.moveTo(verdicts, verdicts.length - 1);
    }
    if (key === "Ctrl+F" || key === "Ctrl+D") {
      return this.moveTo(verdicts, cursor + page);
    }
    if (key === "Ctrl+B" || key === "Ctrl+U") {
      return this.moveTo(verdicts, cursor - page);
    }
    if (key === "Enter" || key === "Right" || key === "l") {
      const verdict = verdicts[cursor];
      if (verdict !== undefined) {
        return {
          kind: "openVerdict",
          runKey: this.runKey,
          inputId: this.inputId,
          graderName: verdict.name,
        };
      }
    }
    if (key === "o") {
      const test = this.test;
      if (test !== null && test.statelogPath !== undefined && this.parent !== null) {
        return {
          kind: "openLog",
          statelogPath: test.statelogPath,
          title: `${this.parent.agent} / ${test.inputId}`,
          traceId: test.traceId,
        };
      }
    }
    return { kind: "none" };
  }

  render(viewport: Viewport): Element {
    const verdicts = this.verdicts();
    const bodyRows = Math.max(1, viewport.rows - CHROME_ROWS);
    const cursor = this.cursorIndex(verdicts);
    if (cursor < this.scrollTop) {
      this.scrollTop = cursor;
    }
    if (cursor >= this.scrollTop + bodyRows) {
      this.scrollTop = cursor - bodyRows + 1;
    }
    const visible = verdicts.slice(this.scrollTop, this.scrollTop + bodyRows);
    const tableElement = this.table.render({
      columns: this.columns(),
      rows: visible,
      cursor:
        cursor - this.scrollTop >= 0 && cursor - this.scrollTop < visible.length
          ? cursor - this.scrollTop
          : null,
      width: viewport.cols,
    });
    return column(
      { justifyContent: "flex-start" },
      line(this.title(), { height: 1, fg: "bright-white" }),
      tableElement,
      line(this.message || this.emptyNote(verdicts), { height: 1, fg: "gray" }),
      line(bottomHints(HINTS, "graders", viewport.cols), { height: 1, fg: "gray" }),
    );
  }

  private title(): string {
    if (this.parent === null || this.test === null) {
      return `TEST ${this.inputId} — waiting for data…`;
    }
    return `TEST ${this.inputId} — ${this.parent.agent} — score ${fmtScore(this.test.score)}`;
  }

  private emptyNote(verdicts: GraderVerdict[]): string {
    if (this.test === null || verdicts.length > 0) return "";
    return this.test.detail === undefined
      ? "this test wrote no trace, so nothing was graded"
      : "no grading pass has scored this test yet (agency eval grade <dir>)";
  }

  private verdicts(): GraderVerdict[] {
    return this.test?.detail?.graders ?? [];
  }

  private cursorIndex(verdicts: GraderVerdict[]): number {
    const pinned = verdicts.findIndex((verdict) => verdict.name === this.cursorName);
    return pinned === -1 ? 0 : pinned;
  }

  private moveTo(verdicts: GraderVerdict[], index: number): ExplorerAction {
    if (verdicts.length === 0) {
      return { kind: "none" };
    }
    const clamped = Math.max(0, Math.min(verdicts.length - 1, index));
    this.cursorName = verdicts[clamped].name;
    return { kind: "none" };
  }

  private columns(): TableColumn<GraderVerdict>[] {
    return [
      { key: "grader", header: "grader", width: { min: 12 }, cell: (verdict) => verdict.name },
      {
        key: "score",
        header: "score",
        width: 7,
        align: "right",
        cell: (verdict) =>
          verdict.score.kind === "binary"
            ? verdict.score.pass
              ? "pass"
              : "FAIL"
            : fmtScore(verdict.score.value),
        cellStyle: (verdict) => ({ fg: scoreColor(verdictValue(verdict)) }),
      },
      {
        key: "role",
        header: "",
        width: 5,
        cell: fmtRole,
        cellStyle: () => ({ fg: "gray" }),
      },
      {
        key: "feedback",
        header: "feedback",
        width: "flex",
        cell: (verdict) => firstLine(verdict.feedback),
        cellStyle: () => ({ fg: "gray" }),
      },
    ];
  }
}
