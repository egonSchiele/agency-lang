// ═══════════════════════════════════════════════════════════════════════
// PROTOTYPE — THROWAWAY CODE. Do not ship, do not test, do not polish.
//
// Question this answers: what should the cross-run explorer look like,
// which of three first screens wins (table / compare-matrix / trend),
// and does table → individual run → full log viewer → back feel right?
// Run: `agency runs-proto [paths...]` (defaults to ./runs). Accepts run
// directories, directories OF run directories, and raw statelog files
// (every trace in a file becomes a row).
// ═══════════════════════════════════════════════════════════════════════
import * as fs from "fs";
import * as path from "path";

import { column, line } from "../tui/builders.js";
import type { Element } from "../tui/elements.js";
import { formatKey } from "../tui/input/format.js";
import type { KeyEvent } from "../tui/input/types.js";
import { scrollList } from "../tui/scrollList.js";
import { parseStatelogJsonl } from "./parse.js";
import type { EventEnvelope } from "./types.js";
import { costColor, fmtDuration, stripQuotes } from "./spanText.js";
import { DEFAULT_THRESHOLDS } from "./thresholds.js";
import { bottomHints } from "./views/shared.js";
import { row as tuiRow } from "../tui/builders.js";

export type RunRow = {
  source: "eval" | "statelog";
  id: string;
  dateMs?: number;
  /** agentName event > eval agentLabel > file/trace name. */
  agent: string;
  command?: string;
  suite: string;
  tests: number;
  passed: number;
  score?: number;              // grading.objective; undefined = ungraded
  costUsd: number;
  durationMs: number;
  models: string[];
  /** What Enter opens: per-test statelogs for eval runs; the whole file
   *  for a statelog trace (the viewer splits traces itself). */
  logs: { label: string; path: string; score?: number; status?: string }[];
};

// ── data layer ─────────────────────────────────────────────────────────

export function loadRows(paths: string[]): RunRow[] {
  const rows: RunRow[] = [];
  for (const p of paths) {
    const stat = fs.statSync(p);
    if (stat.isFile()) {
      rows.push(...statelogRows(p));
    } else if (fs.existsSync(path.join(p, "summary.json"))) {
      const row = evalRunRow(p);
      if (row) rows.push(row);
    } else {
      // a directory OF run directories (e.g. ./runs)
      for (const child of fs.readdirSync(p)) {
        const dir = path.join(p, child);
        if (fs.existsSync(path.join(dir, "summary.json"))) {
          const row = evalRunRow(dir);
          if (row) rows.push(row);
        }
      }
    }
  }
  rows.sort((a, b) => (b.dateMs ?? 0) - (a.dateMs ?? 0));
  return rows;
}

function evalRunRow(dir: string): RunRow | undefined {
  try {
    const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
    const config = readJson(path.join(dir, "config.json")) ?? {};
    const inputs: any[] = summary.inputs ?? [];
    const perInputGrades: any[] = summary.grading?.perInput ?? [];
    const models: string[] = [];
    let costUsd = 0;
    let durationMs = 0;
    let agentName: string | undefined;
    for (const input of inputs) {
      const record = input.evalRecordPath ? readJson(input.evalRecordPath) : undefined;
      if (record?.metrics) {
        costUsd += record.metrics.costUsdTotal ?? 0;
        durationMs += record.durationMs ?? 0;
        for (const m of record.metrics.models ?? []) {
          if (!models.includes(m)) models.push(m);
        }
      } else if (input.statelogPath && fs.existsSync(input.statelogPath)) {
        // Killed/errored run with no salvaged record: the statelog still
        // has the truth — mine it so a $6 kill does not read as $0.00.
        const mined = mineStatelogTotals(input.statelogPath);
        costUsd += mined.costUsd;
        durationMs += mined.durationMs;
        for (const m of mined.models) {
          if (!models.includes(m)) models.push(m);
        }
      }
      if (agentName === undefined && input.statelogPath && fs.existsSync(input.statelogPath)) {
        agentName = agentNameFromEvents(parseStatelogJsonl(fs.readFileSync(input.statelogPath, "utf8")).events);
      }
    }
    const gradeById: Record<string, any> = {};
    for (const g of perInputGrades) gradeById[g.inputId] = g;
    const command = config.provenance?.agent?.command
      ?? (config.provenance?.agent?.entry ? `agency run ${config.provenance.agent.entry}` : undefined);
    return {
      source: "eval",
      id: summary.runId ?? path.basename(dir),
      dateMs: config.startedAt ? Date.parse(config.startedAt) : dateFromRunId(summary.runId),
      agent: agentName ?? shortAgentLabel(summary.agentLabel ?? command ?? path.basename(dir)),
      command,
      suite: inputs.map((i: any) => i.inputId).join(","),
      tests: inputs.length,
      passed: perInputGrades.filter((g) => g.gatesPassed).length,
      score: typeof summary.grading?.objective === "number" ? summary.grading.objective : undefined,
      costUsd,
      durationMs,
      models,
      logs: inputs.map((i: any) => ({
        label: i.inputId,
        path: i.statelogPath,
        score: gradeById[i.inputId]?.objective,
        status: i.status,
      })),
    };
  } catch {
    return undefined;
  }
}

function statelogRows(file: string): RunRow[] {
  const events = parseStatelogJsonl(fs.readFileSync(file, "utf8")).events;
  const byTrace: Record<string, EventEnvelope[]> = Object.create(null);
  for (const e of events) {
    (byTrace[e.trace_id] ??= []).push(e);
  }
  return Object.entries(byTrace).map(([traceId, traceEvents], i) => {
    const times = traceEvents
      .map((e) => Date.parse(e.data.timestamp))
      .filter(Number.isFinite);
    const models: string[] = [];
    let costUsd = 0;
    for (const e of traceEvents) {
      if (e.data.type !== "promptCompletion") continue;
      costUsd += e.data.cost?.totalCost ?? 0;
      const m = typeof e.data.model === "string" ? stripQuotes(e.data.model) : undefined;
      if (m && !models.includes(m)) models.push(m);
    }
    return {
      source: "statelog" as const,
      id: `${path.basename(file)}#${i + 1}`,
      dateMs: times.length > 0 ? Math.min(...times) : undefined,
      agent: agentNameFromEvents(traceEvents) ?? `${path.basename(file)}#${traceId.slice(0, 6)}`,
      command: undefined,
      suite: "—",
      tests: 0,
      passed: 0,
      score: undefined,
      costUsd,
      durationMs: times.length > 0 ? Math.max(...times) - Math.min(...times) : 0,
      models,
      logs: [{ label: `trace ${traceId.slice(0, 8)}`, path: file }],
    };
  });
}

function mineStatelogTotals(file: string): { costUsd: number; durationMs: number; models: string[] } {
  const totals = { costUsd: 0, durationMs: 0, models: [] as string[] };
  for (const trace of statelogRows(file)) {
    totals.costUsd += trace.costUsd;
    totals.durationMs += trace.durationMs;
    for (const m of trace.models) {
      if (!totals.models.includes(m)) totals.models.push(m);
    }
  }
  return totals;
}

/** The owner's proposed convention: a stdlib statelog call emits an
 *  `agentName` event; when present it becomes the row identity and the
 *  command moves to the detail screen. */
function agentNameFromEvents(events: EventEnvelope[]): string | undefined {
  for (const e of events) {
    if (e.data.type === "agentName" && typeof e.data.name === "string") {
      return e.data.name;
    }
  }
  return undefined;
}

function shortAgentLabel(label: string): string {
  // eval command labels are long argv strings; entry labels are absolute
  // paths — keep the human-meaningful bit of each. (Prototype finding:
  // without this, most real rows read "/Users/adityabhargava…".)
  const m = label.match(/agent --agent (\S+)/);
  if (label.includes("agency.js agent") || label.includes("agency agent")) {
    return m && m[1] ? `agency-agent(${m[1]})` : "agency-agent";
  }
  const agencyFile = label.match(/([^\s/]+\.agency)/);
  if (agencyFile) return agencyFile[1];
  return label.length > 24 ? `${label.slice(0, 23)}…` : label;
}

function readJson(p: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

function dateFromRunId(runId?: string): number | undefined {
  const m = runId?.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return undefined;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

// ── the explorer state machine ─────────────────────────────────────────

type Variant = "table" | "compare" | "trend";
type SortKey = "date" | "score" | "cost" | "duration";
type GroupKey = "none" | "agent" | "suite";

export type ExplorerAction =
  | { kind: "none" }
  | { kind: "quit" }
  | { kind: "openLog"; path: string; title: string };

export class ExplorerProto {
  private variant: Variant = "table";
  private sort: SortKey = "date";
  private group: GroupKey = "none";
  private cursor = 0;
  private scrollTop = 0;
  private screen: "main" | "info" | "logs" = "main";
  private agentColors: Record<string, string | undefined> | undefined;
  private logsCursor = 0;
  private message = "";

  constructor(private readonly rows: RunRow[]) {}

  handleKey(ev: KeyEvent, viewport: { rows: number; cols: number }): ExplorerAction {
    this.message = "";
    const fmt = formatKey(ev);
    if (this.screen === "info") {
      if (fmt === "Escape" || fmt === "Left" || fmt === "h" || fmt === "i") this.screen = "main";
      return { kind: "none" };
    }
    if (this.screen === "logs") {
      return this.logsKeys(fmt);
    }
    const visible = this.visibleRows();
    const move = (d: number) => {
      this.cursor = Math.max(0, Math.min(visible.length - 1, this.cursor + d));
    };
    if (fmt === "q" || fmt === "Ctrl+C") return { kind: "quit" };
    else if (fmt === "Up" || fmt === "k") move(-1);
    else if (fmt === "Down" || fmt === "j") move(1);
    else if (fmt === "g") this.cursor = 0;
    else if (fmt === "G") this.cursor = Math.max(0, visible.length - 1);
    else if (fmt === "b") this.group = this.group === "none" ? "agent" : this.group === "agent" ? "suite" : "none";
    else if (fmt === "Ctrl+F" || fmt === "Ctrl+D") move(Math.max(1, viewport.rows - 5));
    else if (fmt === "Ctrl+B" || fmt === "Ctrl+U") move(-Math.max(1, viewport.rows - 5));
    else if (fmt === "t") this.variant = this.variant === "table" ? "compare" : this.variant === "compare" ? "trend" : "table";
    else if (fmt === "s") this.sort = this.sort === "date" ? "score" : this.sort === "score" ? "cost" : this.sort === "cost" ? "duration" : "date";
    else if (fmt === "i") this.screen = "info";
    else if (fmt === "e") this.exportCsv();
    else if (fmt === "Enter" || fmt === "Right" || fmt === "l") {
      const row = this.selectedRun();
      if (row === undefined) return { kind: "none" };
      if (row.logs.length === 1) {
        return { kind: "openLog", path: row.logs[0].path, title: `${row.id} / ${row.logs[0].label}` };
      }
      this.screen = "logs";
      this.logsCursor = 0;
    }
    return { kind: "none" };
  }

  render(viewport: { rows: number; cols: number }): Element {
    if (this.screen === "info") return this.renderInfo(viewport);
    if (this.screen === "logs") return this.renderLogs(viewport);
    if (this.variant === "compare") return this.renderCompare(viewport);
    if (this.variant === "trend") return this.renderTrend(viewport);
    return this.renderTable(viewport);
  }

  // ── table variant ────────────────────────────────────────────────────

  private visibleRows(): (RunRow | { groupLabel: string; rows: RunRow[] })[] {
    const sorted = [...this.rows].sort((a, b) => this.compare(a, b));
    if (this.group === "none" || this.variant !== "table") return sorted;
    const key = this.group === "agent" ? (r: RunRow) => r.agent : (r: RunRow) => r.suite;
    const byKey: Record<string, RunRow[]> = Object.create(null);
    for (const r of sorted) (byKey[key(r)] ??= []).push(r);
    return Object.entries(byKey).map(([groupLabel, rows]) => ({ groupLabel, rows }));
  }

  private compare(a: RunRow, b: RunRow): number {
    if (this.sort === "date") return (b.dateMs ?? 0) - (a.dateMs ?? 0);
    if (this.sort === "score") return (b.score ?? -1) - (a.score ?? -1);
    if (this.sort === "cost") return b.costUsd - a.costUsd;
    return b.durationMs - a.durationMs;
  }

  private selectedRun(): RunRow | undefined {
    const v = this.visibleRows()[this.cursor];
    if (v === undefined) return undefined;
    return "groupLabel" in v ? v.rows[0] : v;
  }

  private renderTable(viewport: { rows: number; cols: number }): Element {
    const visible = this.visibleRows();
    const bodyRows = Math.max(1, viewport.rows - 4);
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + bodyRows) this.scrollTop = this.cursor - bodyRows + 1;
    const header =
      `  ${pad("date", 12)}${pad("agent", 24)}${pad("suite", 22)}${pad("score", 7)}${pad("pass", 6)}${pad("cost", 9)}${pad("time", 8)}models`;
    const { element: body } = scrollList({
      items: visible as unknown[],
      cursorIdx: this.cursor,
      scrollTop: this.scrollTop,
      viewportRows: bodyRows,
      renderItem: (item, isCursor) => this.renderTableRow(item as any, isCursor),
    });
    return column({ justifyContent: "flex-start" },
      line(`RUNS  ${this.rows.length} run(s)  sort:${this.sort}  group:${this.group}`, { fg: "bright-white" }),
      line(header, { fg: "gray" }),
      body,
      line(this.footer(), { fg: "bright-white" }),
      line(bottomHints("t view  s sort  b group  g/G top/bottom  Enter open log  i info  e export csv  q quit", "table", viewport.cols), { fg: "gray" }),
    );
  }

  /** Color scheme (screenshot feedback: all-monochrome was hard to
   *  read): agent gets an identity color (same idea as the timeline's
   *  group palette), score is a verdict color (green 1.0 / yellow mid /
   *  red 0), cost uses the viewer's expense thresholds, statelog-source
   *  rows are dimmed, the cursor row is bright-white throughout. */
  private renderTableRow(item: RunRow | { groupLabel: string; rows: RunRow[] }, isCursor: boolean): Element {
    const marker = isCursor ? "▶ " : "  ";
    if ("groupLabel" in item) {
      const rows = item.rows;
      const scored = rows.filter((r) => r.score !== undefined);
      const mean = scored.length > 0
        ? (scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length).toFixed(2)
        : "—";
      const cost = rows.reduce((s, r) => s + r.costUsd, 0);
      const text = `${marker}${pad(`(${rows.length})`, 12)}${pad(clip(item.groupLabel, 44), 46)}${pad(mean, 7)}${pad("", 6)}${pad(`$${cost.toFixed(2)}`, 9)}`;
      return line(text, { fg: isCursor ? "bright-white" : this.agentColor(item.groupLabel) ?? "bright-cyan" });
    }
    const r = item;
    if (isCursor) {
      return line(this.rowText(r, marker), { fg: "bright-white" });
    }
    const dim = r.source === "statelog";
    const scoreColor = r.score === undefined ? "gray"
      : r.score >= 0.99 ? "green" : r.score <= 0.01 ? "bright-red" : "yellow";
    return tuiRow(
      line(`${marker}${pad(fmtDate(r.dateMs), 12)}`, { fg: "gray" }),
      line(pad(clip(r.agent, 22), 24), { fg: this.agentColor(r.agent) ?? (dim ? "gray" : undefined) }),
      line(pad(clip(r.suite, 20), 22), dim ? { fg: "gray" } : undefined),
      line(pad(r.score !== undefined ? r.score.toFixed(2) : "—", 7), { fg: scoreColor }),
      line(pad(r.tests > 0 ? `${r.passed}/${r.tests}` : "—", 6), { fg: r.tests > 0 && r.passed === r.tests ? "green" : r.tests > 0 ? "bright-red" : "gray" }),
      line(pad(`$${r.costUsd.toFixed(2)}`, 9), { fg: costColor(r.costUsd, DEFAULT_THRESHOLDS) ?? (dim ? "gray" : undefined) }),
      line(pad(fmtDuration(r.durationMs, { minutes: true }), 8), dim ? { fg: "gray" } : undefined),
      line(clip(r.models.join(","), 30), { fg: "gray" }),
    );
  }

  private rowText(r: RunRow, marker: string): string {
    return `${marker}${pad(fmtDate(r.dateMs), 12)}${pad(clip(r.agent, 22), 24)}${pad(clip(r.suite, 20), 22)}` +
      `${pad(r.score !== undefined ? r.score.toFixed(2) : "—", 7)}` +
      `${pad(r.tests > 0 ? `${r.passed}/${r.tests}` : "—", 6)}` +
      `${pad(`$${r.costUsd.toFixed(2)}`, 9)}${pad(fmtDuration(r.durationMs, { minutes: true }), 8)}${clip(r.models.join(","), 30)}`;
  }

  /** Stable identity colors for the most-seen agents — "cyan means
   *  agency-agent" holds everywhere in the table, like the timeline. */
  private agentColor(agent: string): string | undefined {
    if (this.agentColors === undefined) {
      const counts: Record<string, number> = Object.create(null);
      for (const r of this.rows) counts[r.agent] = (counts[r.agent] ?? 0) + 1;
      const palette = ["bright-cyan", "bright-magenta", "bright-yellow", "bright-green", "bright-blue", "cyan", "magenta"];
      const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      this.agentColors = Object.create(null);
      const colors: Record<string, string | undefined> = Object.create(null);
      ranked.forEach(([name], i) => {
        colors[name] = palette[i];
      });
      this.agentColors = colors;
    }
    return this.agentColors[agent];
  }

  // ── compare variant: agent × suite matrix of mean scores ─────────────

  private renderCompare(viewport: { rows: number; cols: number }): Element {
    const scored = this.rows.filter((r) => r.score !== undefined);
    const agents = [...new Set(scored.map((r) => r.agent))];
    const suites = [...new Set(scored.map((r) => r.suite))].slice(0, 4);
    const out: string[] = [];
    out.push(`  ${pad("", 26)}${suites.map((s) => pad(clip(s, 18), 20)).join("")}`);
    for (const agent of agents) {
      const cells = suites.map((suite) => {
        const cell = scored.filter((r) => r.agent === agent && r.suite === suite);
        if (cell.length === 0) return pad("·", 20);
        const mean = cell.reduce((s, r) => s + (r.score ?? 0), 0) / cell.length;
        const cost = cell.reduce((s, r) => s + r.costUsd, 0) / cell.length;
        return pad(`${mean.toFixed(2)} ($${cost.toFixed(2)}) ×${cell.length}`, 20);
      });
      out.push(`  ${pad(clip(agent, 24), 26)}${cells.join("")}`);
    }
    if (agents.length === 0) out.push("  (no scored runs — compare needs eval runs)");
    return column({ justifyContent: "flex-start" },
      line(`RUNS  mean score ($ mean cost) ×runs — agents × suites`, { fg: "bright-white" }),
      ...out.slice(0, viewport.rows - 3).map((t, i) => line(t, i === 0 ? { fg: "gray" } : undefined)),
      line(bottomHints("t next view  q quit", "compare", viewport.cols), { fg: "gray" }),
    );
  }

  // ── trend variant: score & cost per day ──────────────────────────────

  private renderTrend(viewport: { rows: number; cols: number }): Element {
    const dated = this.rows
      .filter((r) => r.dateMs !== undefined)
      .sort((a, b) => (a.dateMs ?? 0) - (b.dateMs ?? 0));
    const out: string[] = [];
    const width = Math.max(10, Math.min(40, viewport.cols - 46));
    for (const r of dated.slice(-Math.max(1, viewport.rows - 4))) {
      const scoreBar = r.score !== undefined
        ? "█".repeat(Math.max(1, Math.round(r.score * 10))).padEnd(10)
        : pad("—", 10);
      const costBar = "▄".repeat(Math.min(width, Math.max(r.costUsd > 0 ? 1 : 0, Math.round(r.costUsd * 4))));
      out.push(`  ${pad(fmtDate(r.dateMs), 12)}${pad(clip(r.agent, 20), 22)}${scoreBar} ${pad(`$${r.costUsd.toFixed(2)}`, 8)}${costBar}`);
    }
    return column({ justifyContent: "flex-start" },
      line(`RUNS  chronological — score (█/10) and cost bars`, { fg: "bright-white" }),
      line(`  ${pad("date", 12)}${pad("agent", 22)}${pad("score", 11)}${pad("cost", 8)}`, { fg: "gray" }),
      ...out.map((t) => line(t)),
      line(bottomHints("t next view  q quit", "trend", viewport.cols), { fg: "gray" }),
    );
  }

  // ── info + logs screens ──────────────────────────────────────────────

  private renderInfo(viewport: { rows: number; cols: number }): Element {
    const r = this.selectedRun();
    const lines_: string[] = r === undefined ? ["no selection"] : [
      `id:       ${r.id}`,
      `source:   ${r.source}`,
      `agent:    ${r.agent}`,
      `command:  ${r.command ?? "—"}`,
      `suite:    ${r.suite}`,
      `score:    ${r.score !== undefined ? r.score.toFixed(3) : "— (ungraded source)"}`,
      `passed:   ${r.tests > 0 ? `${r.passed}/${r.tests}` : "—"}`,
      `cost:     $${r.costUsd.toFixed(4)}`,
      `duration: ${fmtDuration(r.durationMs, { minutes: true })}`,
      `models:   ${r.models.join(", ") || "—"}`,
      `logs:     ${r.logs.map((l) => l.label).join(", ")}`,
    ];
    return column({ justifyContent: "flex-start" },
      line(`RUN INFO  ${r?.id ?? ""}`, { fg: "bright-white" }),
      ...lines_.flatMap((t) => wrap(t, viewport.cols - 2)).map((t) => line(t)),
      line(bottomHints("←/Esc back", "run info", viewport.cols), { fg: "gray" }),
    );
  }

  private logsKeys(fmt: string): ExplorerAction {
    const r = this.selectedRun();
    const logs = r?.logs ?? [];
    if (fmt === "Escape" || fmt === "Left" || fmt === "h") {
      this.screen = "main";
    } else if (fmt === "Up" || fmt === "k") {
      this.logsCursor = Math.max(0, this.logsCursor - 1);
    } else if (fmt === "Down" || fmt === "j") {
      this.logsCursor = Math.min(logs.length - 1, this.logsCursor + 1);
    } else if (fmt === "Enter" || fmt === "Right" || fmt === "l") {
      const log = logs[this.logsCursor];
      if (log !== undefined && r !== undefined) {
        this.screen = "main";
        return { kind: "openLog", path: log.path, title: `${r.id} / ${log.label}` };
      }
    } else if (fmt === "q" || fmt === "Ctrl+C") {
      return { kind: "quit" };
    }
    return { kind: "none" };
  }

  private renderLogs(_viewport: { rows: number; cols: number }): Element {
    const r = this.selectedRun();
    const logs = r?.logs ?? [];
    return column({ justifyContent: "flex-start" },
      line(`OPEN WHICH TEST?  ${r?.id ?? ""}`, { fg: "bright-white" }),
      ...logs.map((l, i) => line(
        `${i === this.logsCursor ? "▶ " : "  "}${pad(l.label, 24)}${pad(l.score !== undefined ? l.score.toFixed(2) : "—", 7)}${l.status ?? ""}`,
        { fg: i === this.logsCursor ? "bright-white" : undefined },
      )),
      line(bottomHints("Enter open in log viewer  ←/Esc back", "pick test", 80), { fg: "gray" }),
    );
  }

  private footer(): string {
    const r = this.selectedRun();
    const base = r === undefined ? "" : `${r.id}  ·  ${r.logs.length} log(s)  ·  Enter drills into the log viewer`;
    return this.message ? `${base}  ${this.message}` : base;
  }

  private exportCsv(): void {
    const header = "id,date,agent,suite,score,passed,tests,costUsd,durationMs,models,source";
    const lines_ = this.rows.map((r) => [
      r.id, fmtDate(r.dateMs), csv(r.agent), csv(r.suite),
      r.score ?? "", r.passed, r.tests, r.costUsd.toFixed(4), r.durationMs,
      csv(r.models.join("|")), r.source,
    ].join(","));
    const out = path.resolve("runs-export.csv");
    fs.writeFileSync(out, [header, ...lines_].join("\n") + "\n");
    this.message = `exported ${this.rows.length} rows → ${out}`;
  }
}

function csv(s: string): string {
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmtDate(ms?: number): string {
  if (ms === undefined) return "—";
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + " " : s + " ".repeat(w - s.length);
}

function clip(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, w - 1) + "…";
}

function wrap(s: string, w: number): string[] {
  if (s.length <= w) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += w) out.push(s.slice(i, i + w));
  return out;
}
