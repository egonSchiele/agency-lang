// Full metadata for one run: everything that doesn't fit in a table
// cell — the full command line, source paths, per-test statuses, and
// the load warnings that the table only hints at. Holds the row KEY and
// re-resolves on setData so backfill keeps this screen current too.
import { column, line } from "../../tui/builders.js";
import type { Element } from "../../tui/elements.js";
import { formatKey } from "../../tui/input/format.js";
import type { KeyEvent } from "../../tui/input/types.js";
import { bottomHints } from "../../logsViewer/views/shared.js";
import type { RunRow } from "../rows.js";
import { fmtCost, fmtDate, fmtScore, fmtTime } from "./rowFormat.js";
import type { ExplorerAction, ExplorerView, Viewport } from "./explorerView.js";

const HINTS = "Esc back  q quit";

export class InfoScreen implements ExplorerView {
  readonly viewName = "info" as const;
  private row: RunRow | null = null;
  private message = "";

  constructor(private readonly rowKey: string) {}

  setData(rows: RunRow[]): void {
    this.row = rows.find((row) => row.key === this.rowKey) ?? null;
  }

  setProgress(): void {
    // Nothing to narrate here.
  }

  notify(message: string): void {
    this.message = message;
  }

  helpLines(): string[] {
    return ["Esc back to the table    q quit"];
  }

  handleKey(event: KeyEvent): ExplorerAction {
    const key = formatKey(event);
    if (key === "q" || key === "Ctrl+C") {
      return { kind: "quit" };
    }
    if (key === "Escape" || key === "Left" || key === "h" || key === "i") {
      return { kind: "back" };
    }
    return { kind: "none" };
  }

  render(viewport: Viewport): Element {
    const row = this.row;
    const lines = row === null ? [`no data for ${this.rowKey}`] : this.infoLines(row);
    return column({ justifyContent: "flex-start" },
      line(`RUN INFO  ${this.rowKey}`, { height: 1, fg: "bright-white" }),
      ...lines.slice(0, Math.max(1, viewport.rows - 3)).map((text) => line(text, { height: 1 })),
      line(this.message, { height: 1, fg: "gray" }),
      line(bottomHints(HINTS, "run info", viewport.cols), { height: 1, fg: "gray" }),
    );
  }

  private infoLines(row: RunRow): string[] {
    const lines = [
      `agent:    ${row.agent}`,
      `command:  ${row.command ?? row.agentLabel ?? "—"}`,
      `suite:    ${row.suite}`,
      `status:   ${row.status}`,
      `date:     ${fmtDate(row.startedAtMs)}`,
      `score:    ${fmtScore(row.score)}`,
      `cost:     ${fmtCost(row.costUsd, !row.backfilled)}`,
      `time:     ${fmtTime(row.wallMs, !row.backfilled)}`,
      `models:   ${row.models.join(", ") || "—"}`,
      `source:   ${row.source.kind === "runDir" ? row.source.dir : row.source.file}`,
    ];
    if (row.tests.length > 0) {
      lines.push("tests:");
      for (const test of row.tests) {
        lines.push(`  ${test.inputId}: ${test.status}  ${fmtScore(test.score)}  ${test.statelogPath ?? ""}`);
      }
    }
    if (row.warnings.length > 0) {
      lines.push("warnings:");
      for (const warning of row.warnings) {
        lines.push(`  ${warning}`);
      }
    }
    return lines;
  }
}
