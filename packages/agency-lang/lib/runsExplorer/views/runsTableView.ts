// The home screen: one row per run, sortable, groupable, cursor pinned
// to row identity. Presentation state (sort/group/cursor/scroll) lives
// here; list shaping is tableState's; cell geometry is TableComponent's.
import { column, line } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { TableComponent, type TableColumn } from "../../tui/table.js";
import { bottomHints } from "../../logsViewer/views/shared.js";
import { agentColors } from "../identity.js";
import type { LoaderProgress } from "../loader.js";
import type { RunRow } from "../rows.js";
import {
  costCellColor,
  fmtCost,
  fmtDate,
  fmtModels,
  fmtPass,
  fmtScore,
  fmtTests,
  fmtTime,
  passColor,
  scoreColor,
  statusColor,
} from "./rowFormat.js";
import type { ExplorerAction, ExplorerView, Viewport } from "./explorerView.js";
import {
  initialTableState,
  projectTable,
  updateTable,
  type DisplayRow,
  type TableState,
} from "./tableState.js";

/** Columns dropped right-to-left when the terminal is too narrow. */
const DROP_ORDER = ["models", "time", "pass"];
const CHROME_ROWS = 4;

const HINTS =
  "t/T views  s sort  S asc/desc  b group  Enter open/expand  o log  i info  e export  q quit";

export class RunsTableView implements ExplorerView {
  readonly viewName = "runs" as const;
  private rows: RunRow[] = [];
  private state: TableState = initialTableState();
  private scrollTop = 0;
  private colors: Record<string, string | undefined> = Object.create(null);
  private progress: LoaderProgress | null = null;
  private message = "";
  private readonly table = new TableComponent<DisplayRow>();

  setData(rows: RunRow[]): void {
    this.rows = rows;
    this.colors = agentColors(rows.map((row) => row.agent));
  }

  setProgress(progress: LoaderProgress | null): void {
    this.progress = progress;
  }

  notify(message: string): void {
    this.message = message;
  }

  helpLines(): string[] {
    return [
      "j/k or arrows  move    g/G first/last    Ctrl+F/B/D/U page",
      "s cycle sort   S flip direction   b group by agent/suite",
      "Enter  expand a group, or open a run's graders    o  open a run's log",
      "i run info    e export CSV    t/T switch view    q quit",
    ];
  }

  handleKey(event: KeyEvent, viewport: Viewport): ExplorerAction {
    this.message = "";
    const key = formatKey(event);
    const page = Math.max(1, viewport.rows - CHROME_ROWS);

    if (key === "q" || key === "Ctrl+C") {
      return { kind: "quit" };
    }
    if (key === "t") {
      return { kind: "cycleView", delta: 1 };
    }
    if (key === "T") {
      return { kind: "cycleView", delta: -1 };
    }
    if (key === "Up" || key === "k") {
      return this.move(-1);
    }
    if (key === "Down" || key === "j") {
      return this.move(1);
    }
    if (key === "g") {
      return this.move(-this.rows.length * 2);
    }
    if (key === "G") {
      return this.move(this.rows.length * 2);
    }
    if (key === "Ctrl+F" || key === "Ctrl+D") {
      return this.move(page);
    }
    if (key === "Ctrl+B" || key === "Ctrl+U") {
      return this.move(-page);
    }
    if (key === "s") {
      this.state = updateTable(this.state, { kind: "sortNext" }, this.rows);
      return { kind: "none" };
    }
    if (key === "S") {
      this.state = updateTable(this.state, { kind: "sortDirection" }, this.rows);
      return { kind: "none" };
    }
    if (key === "b") {
      this.state = updateTable(this.state, { kind: "groupNext" }, this.rows);
      return { kind: "none" };
    }
    if (key === "i") {
      const cursorRow = this.cursorRow();
      if (cursorRow?.kind === "run") {
        return { kind: "openInfo", rowKey: cursorRow.key };
      }
      return { kind: "none" };
    }
    if (key === "e") {
      return { kind: "exportCsv", projection: projectTable(this.rows, this.state) };
    }
    if (key === "o") {
      return this.openCursorLog();
    }
    if (key === "Enter" || key === "Right" || key === "l") {
      return this.openCursorRow();
    }
    return { kind: "none" };
  }

  render(viewport: Viewport): Element {
    const projection = projectTable(this.rows, this.state);
    const bodyRows = Math.max(1, viewport.rows - CHROME_ROWS);
    const cursorIndex = projection.cursorIndex ?? 0;
    if (cursorIndex < this.scrollTop) {
      this.scrollTop = cursorIndex;
    }
    if (cursorIndex >= this.scrollTop + bodyRows) {
      this.scrollTop = cursorIndex - bodyRows + 1;
    }
    const visible = projection.rows.slice(this.scrollTop, this.scrollTop + bodyRows);
    const cursorInWindow = cursorIndex - this.scrollTop;

    const tableElement = this.table.render({
      columns: this.columns(viewport.cols),
      rows: visible,
      cursor: cursorInWindow >= 0 && cursorInWindow < visible.length ? cursorInWindow : null,
      sort: { columnKey: this.state.sort, direction: this.state.ascending ? "asc" : "desc" },
      width: viewport.cols,
    });

    return column(
      { justifyContent: "flex-start" },
      line(this.title(), { height: 1, fg: "bright-white" }),
      tableElement,
      line(this.statusLine(), { height: 1, fg: "gray" }),
      line(bottomHints(HINTS, this.viewName, viewport.cols), { height: 1, fg: "gray" }),
    );
  }

  private title(): string {
    const groupNote = this.state.group === "none" ? "" : `  group:${this.state.group}`;
    return `RUNS  ${this.rows.length} run(s)${groupNote}`;
  }

  private statusLine(): string {
    if (this.message !== "") {
      return this.message;
    }
    if (this.progress !== null) {
      return `Loading runs… ${this.progress.completed}/${this.progress.total}`;
    }
    return "";
  }

  private move(delta: number): ExplorerAction {
    this.state = updateTable(this.state, { kind: "move", delta }, this.rows);
    return { kind: "none" };
  }

  private cursorRow(): DisplayRow | undefined {
    const projection = projectTable(this.rows, this.state);
    return projection.cursorIndex === null ? undefined : projection.rows[projection.cursorIndex];
  }

  private openCursorRow(): ExplorerAction {
    const cursorRow = this.cursorRow();
    if (cursorRow === undefined) {
      return { kind: "none" };
    }
    if (cursorRow.kind === "groupHeader") {
      this.state = updateTable(this.state, { kind: "toggleGroup" }, this.rows);
      return { kind: "none" };
    }
    const row = cursorRow.row;
    if (row.source.kind === "statelog") {
      return { kind: "openLog", statelogPath: row.source.file, title: row.agent };
    }
    if (row.tests.length === 1) {
      return { kind: "openTest", runKey: row.key, inputId: row.tests[0].inputId };
    }
    if (row.tests.length > 1) {
      return { kind: "openRun", parentRunKey: row.key };
    }
    return { kind: "openInfo", rowKey: row.key };
  }

  /** The log viewer on the cursor row's one trace; a run with several
   *  tests picks one through its tests table instead. */
  private openCursorLog(): ExplorerAction {
    const cursorRow = this.cursorRow();
    if (cursorRow === undefined || cursorRow.kind === "groupHeader") {
      return { kind: "none" };
    }
    const row = cursorRow.row;
    if (row.source.kind === "statelog") {
      return { kind: "openLog", statelogPath: row.source.file, title: row.agent };
    }
    if (row.tests.length === 1 && row.tests[0].statelogPath !== undefined) {
      return {
        kind: "openLog",
        statelogPath: row.tests[0].statelogPath,
        title: `${row.agent} / ${row.tests[0].inputId}`,
        traceId: row.tests[0].traceId,
      };
    }
    return { kind: "none" };
  }

  // ── columns ──────────────────────────────────────────────────────

  private columns(cols: number): TableColumn<DisplayRow>[] {
    const all: TableColumn<DisplayRow>[] = [
      {
        key: "date",
        header: "date",
        width: 14,
        cell: (row) =>
          row.kind === "groupHeader"
            ? `${row.expanded ? "▾" : "▸"} `
            : fmtDate(row.row.startedAtMs),
        cellStyle: (row) =>
          row.kind === "groupHeader"
            ? { fg: this.colors[row.aggregates.agent] ?? "bright-cyan", bold: true }
            : { fg: "gray" },
      },
      {
        key: "agent",
        header: "agent",
        width: 22,
        cell: (row) =>
          row.kind === "groupHeader"
            ? row.group === "agent"
              ? `${row.label} (${row.count})`
              : ""
            : row.row.agent,
        cellStyle: (row) =>
          row.kind === "groupHeader"
            ? { fg: this.colors[row.label] ?? "bright-cyan", bold: true }
            : {
                fg: this.colors[row.row.agent] ?? (row.row.status === "trace" ? "gray" : undefined),
              },
      },
      {
        key: "suite",
        header: "suite",
        width: 16,
        cell: (row) =>
          row.kind === "groupHeader"
            ? row.group === "suite"
              ? `${row.label} (${row.count})`
              : ""
            : row.row.suite,
        cellStyle: (row) =>
          row.kind === "groupHeader"
            ? { fg: "bright-cyan", bold: true }
            : { fg: row.row.status === "trace" ? "gray" : undefined },
      },
      {
        key: "test",
        header: "test",
        width: 20,
        cell: (row) => (row.kind === "groupHeader" ? "" : fmtTests(row.row)),
      },
      {
        key: "score",
        header: "score",
        width: 7,
        align: "right",
        cell: (row) =>
          row.kind === "groupHeader" ? fmtScore(row.aggregates.score) : fmtScore(row.row.score),
        cellStyle: (row) => ({
          fg: scoreColor(row.kind === "groupHeader" ? row.aggregates.score : row.row.score),
        }),
      },
      {
        key: "pass",
        header: "pass",
        width: 6,
        align: "right",
        cell: (row) => (row.kind === "groupHeader" ? "" : fmtPass(row.row.gatesPassed)),
        cellStyle: (row) => ({
          fg: row.kind === "groupHeader" ? undefined : passColor(row.row.gatesPassed),
        }),
      },
      {
        key: "status",
        header: "status",
        width: 9,
        cell: (row) => (row.kind === "groupHeader" ? "" : row.row.status),
        cellStyle: (row) => ({
          fg: row.kind === "groupHeader" ? undefined : statusColor(row.row.status),
        }),
      },
      {
        key: "cost",
        header: "cost",
        width: 9,
        align: "right",
        cell: (row) =>
          row.kind === "groupHeader"
            ? fmtCost(row.aggregates.cost, false)
            : fmtCost(row.row.costUsd, !row.row.backfilled),
        cellStyle: (row) => ({
          fg: costCellColor(row.kind === "groupHeader" ? row.aggregates.cost : row.row.costUsd),
        }),
      },
      {
        key: "time",
        header: "time",
        width: 9,
        align: "right",
        cell: (row) =>
          row.kind === "groupHeader"
            ? fmtTime(row.aggregates.time, false)
            : fmtTime(row.row.wallMs, !row.row.backfilled),
        cellStyle: () => ({ fg: undefined }),
      },
      {
        key: "models",
        header: "models",
        width: "flex",
        cell: (row) => (row.kind === "groupHeader" ? "" : fmtModels(row.row.models)),
        cellStyle: () => ({ fg: "gray" }),
      },
    ];
    return dropToFit(all, cols);
  }
}

/** Drop whole columns (models, then time, then pass) until the columns
 *  fit the viewport; a flex column claims a little minimum room. */
export function dropToFit<Row>(all: TableColumn<Row>[], cols: number): TableColumn<Row>[] {
  let columns = all;
  for (const dropKey of DROP_ORDER) {
    if (neededWidth(columns) <= cols) {
      return columns;
    }
    columns = columns.filter((columnSpec) => columnSpec.key !== dropKey);
  }
  return columns;
}

const MIN_FLEX_WIDTH = 8;

function neededWidth<Row>(columns: TableColumn<Row>[]): number {
  const fixed = columns.reduce(
    (sum, columnSpec) => sum + (typeof columnSpec.width === "number" ? columnSpec.width : 0),
    0,
  );
  const hasFlex = columns.some((columnSpec) => columnSpec.width === "flex");
  return fixed + (hasFlex ? MIN_FLEX_WIDTH : 0);
}
