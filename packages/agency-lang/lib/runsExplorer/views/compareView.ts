// Which agent wins where: rows are suites, columns are the four
// most-frequent agents, each cell the mean score over that pair's
// GRADED runs (an objective of zero is a real grade and stays in the
// denominator) with a ×count so a 1-run 1.00 cannot outshine a 12-run
// 0.94. Pairs with no graded runs render a dim dash.
import { column, line } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { TableComponent, type TableColumn } from "../../tui/table.js";
import { bottomHints } from "../../logsViewer/views/shared.js";
import { agentColors } from "../identity.js";
import type { RunRow } from "../rows.js";
import { EMPTY_CELL, scoreColor } from "./rowFormat.js";
import type { ExplorerAction, ExplorerView, Viewport } from "./explorerView.js";

const MAX_COMPARE_AGENTS = 4;
const HINTS = "t/T views  Esc back  q quit";

type CompareCell = { mean: number; count: number } | null;
type CompareRow = { suite: string; cells: Record<string, CompareCell> };

export class CompareView implements ExplorerView {
  readonly viewName = "compare" as const;
  private rows: RunRow[] = [];
  private colors: Record<string, string | undefined> = Object.create(null);
  private message = "";
  private readonly table = new TableComponent<CompareRow>();

  setData(rows: RunRow[]): void {
    this.rows = rows;
    this.colors = agentColors(rows.map((row) => row.agent));
  }

  setProgress(): void {
    // The runs table narrates loading.
  }

  notify(message: string): void {
    this.message = message;
  }

  helpLines(): string[] {
    return [
      "Each cell: mean score × how many graded runs it averages.",
      "Columns are the four most-seen agents.",
      "t/T switch view    Esc back to the runs table    q quit",
    ];
  }

  handleKey(event: KeyEvent): ExplorerAction {
    const key = formatKey(event);
    if (key === "q" || key === "Ctrl+C") {
      return { kind: "quit" };
    }
    if (key === "t") {
      return { kind: "cycleView", delta: 1 };
    }
    if (key === "T") {
      return { kind: "cycleView", delta: -1 };
    }
    if (key === "Escape" || key === "Left" || key === "h") {
      return { kind: "back" };
    }
    return { kind: "none" };
  }

  render(viewport: Viewport): Element {
    const agents = this.topAgents();
    const compareRows = this.compareRows(agents);
    const tableElement = this.table.render({
      columns: this.columns(agents),
      rows: compareRows,
      cursor: null,
      width: viewport.cols,
    });
    const empty = compareRows.length === 0
      ? line("(no graded eval runs — comparing needs scores)", { height: 1, fg: "gray" })
      : tableElement;
    return column({ justifyContent: "flex-start" },
      line("COMPARE  which agent does best on which suite?", { height: 1, fg: "bright-white" }),
      empty,
      line(this.message, { height: 1, fg: "gray" }),
      line(bottomHints(HINTS, this.viewName, viewport.cols), { height: 1, fg: "gray" }),
    );
  }

  private graded(): RunRow[] {
    return this.rows.filter((row) => row.score !== null);
  }

  private topAgents(): string[] {
    const counts: Record<string, number> = Object.create(null);
    for (const row of this.graded()) {
      counts[row.agent] = (counts[row.agent] ?? 0) + 1;
    }
    return Object.entries(counts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_COMPARE_AGENTS)
      .map(([agent]) => agent);
  }

  private compareRows(agents: string[]): CompareRow[] {
    const graded = this.graded();
    const suites = [...new Set(graded.map((row) => row.suite))];
    return suites.map((suite) => {
      const cells: Record<string, CompareCell> = Object.create(null);
      for (const agent of agents) {
        const pair = graded.filter((row) => row.suite === suite && row.agent === agent);
        cells[agent] = pair.length === 0
          ? null
          : {
              mean: pair.reduce((sum, row) => sum + (row.score ?? 0), 0) / pair.length,
              count: pair.length,
            };
      }
      return { suite, cells };
    });
  }

  private columns(agents: string[]): TableColumn<CompareRow>[] {
    const suiteColumn: TableColumn<CompareRow> = {
      key: "suite", header: "suite", width: 18,
      cell: (row) => row.suite,
      cellStyle: () => ({ fg: "bright-white" }),
    };
    const agentColumns = agents.map((agent): TableColumn<CompareRow> => ({
      key: `agent:${agent}`,
      header: agent,
      // 15 + the component's built-in gap column leaves visible air
      // between cells; 18 + 4×15 still fits an 80-column terminal.
      width: 15,
      cell: (row) => {
        const cell = row.cells[agent];
        return cell === null ? EMPTY_CELL : `${cell.mean.toFixed(2)} ×${cell.count}`;
      },
      headerStyle: () => ({ fg: this.colors[agent] ?? "bright-cyan", bold: true }),
      cellStyle: (row) => {
        const cell = row.cells[agent];
        return { fg: cell === null ? "gray" : scoreColor(cell.mean) };
      },
    }));
    return [suiteColumn, ...agentColumns];
  }
}
