// Per-test drill-in: the same table shape as the runs screen, one row
// per test input of one run. Holds only the parent's KEY — every
// setData re-resolves the live parent from the global rows, so backfill
// patches show up while this screen is open. The cursor pins to the
// test's inputId the same way the runs table pins to a run key.
import { column, line } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { TableComponent, type TableColumn } from "../../tui/table.js";
import { bottomHints } from "../../logsViewer/views/shared.js";
import type { LoaderProgress } from "../loader.js";
import type { RunRow, TestRow } from "../rows.js";
import {
  costCellColor,
  fmtCost,
  fmtDate,
  fmtModels,
  fmtPass,
  fmtScore,
  fmtTime,
  passColor,
  scoreColor,
  statusColor,
} from "./rowFormat.js";
import { dropToFit } from "./runsTableView.js";
import type { ExplorerAction, ExplorerView, Viewport } from "./explorerView.js";

const CHROME_ROWS = 4;
const HINTS = "Enter open log  Esc back  q quit";

export class TestsTableView implements ExplorerView {
  readonly viewName = "tests" as const;
  private parent: RunRow | null = null;
  private cursorInputId: string | null = null;
  private scrollTop = 0;
  private message = "";
  private readonly table = new TableComponent<TestRow>();

  constructor(private readonly parentRunKey: string) {}

  setData(rows: RunRow[]): void {
    this.parent = rows.find((row) => row.key === this.parentRunKey) ?? null;
  }

  setProgress(): void {
    // The runs table narrates loading; this screen only shows its own rows.
  }

  notify(message: string): void {
    this.message = message;
  }

  helpLines(): string[] {
    return [
      "j/k move    Enter open this test's log in the viewer",
      "Esc back to the runs table    q quit",
    ];
  }

  handleKey(event: KeyEvent, viewport: Viewport): ExplorerAction {
    this.message = "";
    const key = formatKey(event);
    const tests = this.parent?.tests ?? [];
    const cursor = this.cursorIndex(tests);
    const page = Math.max(1, viewport.rows - CHROME_ROWS);

    if (key === "q" || key === "Ctrl+C") {
      return { kind: "quit" };
    }
    if (key === "Escape" || key === "Left" || key === "h") {
      return { kind: "back" };
    }
    if (key === "t") {
      return { kind: "cycleView", delta: 1 };
    }
    if (key === "T") {
      return { kind: "cycleView", delta: -1 };
    }
    if (key === "Up" || key === "k") {
      return this.moveTo(tests, cursor - 1);
    }
    if (key === "Down" || key === "j") {
      return this.moveTo(tests, cursor + 1);
    }
    if (key === "g") {
      return this.moveTo(tests, 0);
    }
    if (key === "G") {
      return this.moveTo(tests, tests.length - 1);
    }
    if (key === "Ctrl+F" || key === "Ctrl+D") {
      return this.moveTo(tests, cursor + page);
    }
    if (key === "Ctrl+B" || key === "Ctrl+U") {
      return this.moveTo(tests, cursor - page);
    }
    if (key === "Enter" || key === "Right" || key === "l") {
      const test = tests[cursor];
      if (test !== undefined && test.statelogPath !== undefined && this.parent !== null) {
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
    const parent = this.parent;
    const tests = parent?.tests ?? [];
    const bodyRows = Math.max(1, viewport.rows - CHROME_ROWS);
    const cursor = this.cursorIndex(tests);
    if (cursor < this.scrollTop) {
      this.scrollTop = cursor;
    }
    if (cursor >= this.scrollTop + bodyRows) {
      this.scrollTop = cursor - bodyRows + 1;
    }
    const visible = tests.slice(this.scrollTop, this.scrollTop + bodyRows);

    const title =
      parent === null
        ? `RUN ${this.parentRunKey} — waiting for data…`
        : `RUN ${parent.agent} — ${parent.suite} — open which test?`;
    const tableElement = this.table.render({
      columns: this.columns(!(parent?.backfilled ?? true), viewport.cols),
      rows: visible,
      cursor:
        cursor - this.scrollTop >= 0 && cursor - this.scrollTop < visible.length
          ? cursor - this.scrollTop
          : null,
      width: viewport.cols,
    });

    return column(
      { justifyContent: "flex-start" },
      line(title, { height: 1, fg: "bright-white" }),
      tableElement,
      line(this.message, { height: 1, fg: "gray" }),
      line(bottomHints(HINTS, "pick test", viewport.cols), { height: 1, fg: "gray" }),
    );
  }

  private cursorIndex(tests: TestRow[]): number {
    const pinned = tests.findIndex((test) => test.inputId === this.cursorInputId);
    return pinned === -1 ? 0 : pinned;
  }

  private moveTo(tests: TestRow[], index: number): ExplorerAction {
    if (tests.length === 0) {
      return { kind: "none" };
    }
    const clamped = Math.max(0, Math.min(tests.length - 1, index));
    this.cursorInputId = tests[clamped].inputId;
    return { kind: "none" };
  }

  private columns(pending: boolean, cols: number): TableColumn<TestRow>[] {
    const all: TableColumn<TestRow>[] = [
      {
        key: "date",
        header: "date",
        width: 14,
        cell: (test) => fmtDate(test.startedAtMs),
        cellStyle: () => ({ fg: "gray" }),
      },
      { key: "test", header: "test", width: 22, cell: (test) => test.inputId },
      {
        key: "score",
        header: "score",
        width: 7,
        align: "right",
        cell: (test) => fmtScore(test.score),
        cellStyle: (test) => ({ fg: scoreColor(test.score) }),
      },
      {
        key: "pass",
        header: "pass",
        width: 6,
        align: "right",
        cell: (test) => fmtPass(test.gatesPassed),
        cellStyle: (test) => ({ fg: passColor(test.gatesPassed) }),
      },
      {
        key: "status",
        header: "status",
        width: 9,
        cell: (test) => test.status,
        cellStyle: (test) => ({ fg: statusColor(test.status) }),
      },
      {
        key: "cost",
        header: "cost",
        width: 9,
        align: "right",
        cell: (test) => fmtCost(test.costUsd, pending),
        cellStyle: (test) => ({ fg: costCellColor(test.costUsd) }),
      },
      {
        key: "time",
        header: "time",
        width: 9,
        align: "right",
        cell: (test) => fmtTime(test.durationMs, pending),
      },
      {
        key: "models",
        header: "models",
        width: "flex",
        cell: (test) => fmtModels(test.models),
        cellStyle: () => ({ fg: "gray" }),
      },
    ];
    return dropToFit(all, cols);
  }
}
