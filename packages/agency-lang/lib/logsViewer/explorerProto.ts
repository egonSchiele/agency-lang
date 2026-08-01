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
  logs: {
    label: string;
    path: string;
    score?: number;
    status?: string;
    costUsd: number;
    durationMs: number;
    models: string[];
  }[];
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
    const perTest: Record<string, { costUsd: number; durationMs: number; models: string[] }> = Object.create(null);
    for (const input of inputs) {
      const record = input.evalRecordPath ? readJson(input.evalRecordPath) : undefined;
      let t = { costUsd: 0, durationMs: 0, models: [] as string[] };
      if (record?.metrics) {
        t = {
          costUsd: record.metrics.costUsdTotal ?? 0,
          durationMs: record.durationMs ?? 0,
          models: record.metrics.models ?? [],
        };
      } else if (input.statelogPath && fs.existsSync(input.statelogPath)) {
        // Killed/errored run with no salvaged record: the statelog still
        // has the truth — mine it so a $6 kill does not read as $0.00.
        t = mineStatelogTotals(input.statelogPath);
      }
      perTest[input.inputId] = t;
      costUsd += t.costUsd;
      durationMs += t.durationMs;
      for (const m of t.models) {
        if (!models.includes(m)) models.push(m);
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
        costUsd: perTest[i.inputId]?.costUsd ?? 0,
        durationMs: perTest[i.inputId]?.durationMs ?? 0,
        models: perTest[i.inputId]?.models ?? [],
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
      logs: [{
        label: `trace ${traceId.slice(0, 8)}`,
        path: file,
        costUsd,
        durationMs: times.length > 0 ? Math.max(...times) - Math.min(...times) : 0,
        models,
      }],
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

/** One fixed-width table segment. Without an explicit width the tui row
 *  layout gives every child flex:1 and SPLITS the terminal evenly across
 *  them — which is exactly the column-drift the screenshot showed. */
function seg(text: string, width: number, fg?: string, bg?: string): Element {
  const style: Record<string, unknown> = { width, height: 1 };
  if (fg) style.fg = fg;
  if (bg) style.bg = bg;
  return { type: "text", content: pad(text, width), style } as unknown as Element;
}

const CURSOR_BG = "#3a3a3a";

export type ExplorerAction =
  | { kind: "none" }
  | { kind: "quit" }
  | { kind: "openLog"; path: string; title: string };

export class ExplorerProto {
  private variant: Variant = "table";
  private sort: SortKey = "date";
  private sortAsc = false;
  private group: GroupKey = "none";
  private expandedGroups: string[] = [];
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
      if (fmt === "q" || fmt === "Ctrl+C") return { kind: "quit" };
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
    else if (fmt === "T") this.variant = this.variant === "table" ? "trend" : this.variant === "trend" ? "compare" : "table";
    else if (fmt === "s") this.sort = this.sort === "date" ? "score" : this.sort === "score" ? "cost" : this.sort === "cost" ? "duration" : "date";
    else if (fmt === "S") this.sortAsc = !this.sortAsc;
    else if (fmt === "i") this.screen = "info";
    else if (fmt === "e") this.exportCsv();
    else if (fmt === "Enter" || fmt === "Right" || fmt === "l") {
      const item = this.visibleRows()[this.cursor];
      if (item === undefined) return { kind: "none" };
      if ("groupLabel" in item) {
        this.expandedGroups = item.expanded
          ? this.expandedGroups.filter((g) => g !== item.groupLabel)
          : [...this.expandedGroups, item.groupLabel];
        return { kind: "none" };
      }
      if (item.logs.length === 1) {
        return { kind: "openLog", path: item.logs[0].path, title: `${item.id} / ${item.logs[0].label}` };
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

  private visibleRows(): (RunRow | { groupLabel: string; rows: RunRow[]; expanded: boolean })[] {
    const sorted = [...this.rows].sort((a, b) => this.compare(a, b));
    if (this.group === "none" || this.variant !== "table") return sorted;
    const key = this.group === "agent" ? (r: RunRow) => r.agent : (r: RunRow) => r.suite;
    const byKey: Record<string, RunRow[]> = Object.create(null);
    for (const r of sorted) (byKey[key(r)] ??= []).push(r);
    // Group headers with their member runs nested beneath when expanded —
    // Enter on a header toggles it (screenshot feedback: there was no way
    // to see "just those 14 runs").
    const out: (RunRow | { groupLabel: string; rows: RunRow[]; expanded: boolean })[] = [];
    for (const [groupLabel, rows] of Object.entries(byKey)) {
      const expanded = this.expandedGroups.includes(groupLabel);
      out.push({ groupLabel, rows, expanded });
      if (expanded) out.push(...rows);
    }
    return out;
  }

  private compare(a: RunRow, b: RunRow): number {
    let out: number;
    if (this.sort === "date") out = (b.dateMs ?? 0) - (a.dateMs ?? 0);
    else if (this.sort === "score") out = (b.score ?? -1) - (a.score ?? -1);
    else if (this.sort === "cost") out = b.costUsd - a.costUsd;
    else out = b.durationMs - a.durationMs;
    return this.sortAsc ? -out : out;
  }

  private selectedRun(): RunRow | undefined {
    const v = this.visibleRows()[this.cursor];
    if (v === undefined) return undefined;
    return "groupLabel" in v ? v.rows[0] : v;
  }

  /** Header segments: the active sort column is highlighted and carries a
   *  direction arrow (screenshot feedback). */
  private renderHeader(): Element {
    const arrow = this.sortAsc ? "▲" : "▼";
    const col = (label: string, width: number, sortKey?: SortKey) => {
      const active = sortKey !== undefined && this.sort === sortKey;
      return seg(active ? `${label}${arrow}` : label, width, active ? "bright-white" : "gray");
    };
    return tuiRow({ height: 1 },
      col("  date", 14, "date"),
      col("agent", 24),
      col("suite", 22),
      col("score", 7, "score"),
      col("pass", 6),
      col("cost", 9, "cost"),
      col("time", 8, "duration"),
      col("models", 42),
    );
  }

  private renderTable(viewport: { rows: number; cols: number }): Element {
    const visible = this.visibleRows();
    const bodyRows = Math.max(1, viewport.rows - 4);
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + bodyRows) this.scrollTop = this.cursor - bodyRows + 1;
    const { element: body } = scrollList({
      items: visible as unknown[],
      cursorIdx: this.cursor,
      scrollTop: this.scrollTop,
      viewportRows: bodyRows,
      renderItem: (item, isCursor) => this.renderTableRow(item as any, isCursor),
    });
    return column({ justifyContent: "flex-start" },
      line(`RUNS  ${this.rows.length} run(s)  sort:${this.sort}${this.sortAsc ? " (asc)" : ""}  group:${this.group}`, { fg: "bright-white" }),
      this.renderHeader(),
      body,
      line(this.footer(), { fg: "bright-white" }),
      line(bottomHints("t/T views  s sort  S asc/desc  b group (Enter expands)  Enter open  i info  e export  q quit", "table", viewport.cols), { fg: "gray" }),
    );
  }

  /** Color scheme (screenshot feedback): identity color per agent,
   *  verdict colors on score/pass, expense thresholds on cost, dimmed
   *  statelog rows. The cursor row keeps the SAME text colors and adds a
   *  background highlight instead (owner request). Every segment has an
   *  explicit width — the fix for the column-drift bug. */
  private renderTableRow(item: RunRow | { groupLabel: string; rows: RunRow[]; expanded: boolean }, isCursor: boolean): Element {
    const bg = isCursor ? CURSOR_BG : undefined;
    const marker = isCursor ? "▶ " : "  ";
    if ("groupLabel" in item) {
      const rows = item.rows;
      const scored = rows.filter((r) => r.score !== undefined);
      const mean = scored.length > 0
        ? (scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length).toFixed(2)
        : "—";
      const cost = rows.reduce((s, r) => s + r.costUsd, 0);
      const label = `${clip(item.groupLabel, 32)} (${rows.length} runs)`;
      const groupColor = this.agentColor(item.groupLabel) ?? "bright-cyan";
      const meanColor = mean === "—" ? "gray"
        : Number(mean) >= 0.99 ? "green" : Number(mean) <= 0.01 ? "bright-red" : "yellow";
      // The label sits under the column it groups by; date holds only the
      // expand arrow (the count under "date" was the confusing part).
      const agentCell = this.group === "agent" ? label : "";
      const suiteCell = this.group === "suite" ? label : "";
      return tuiRow({ height: 1 },
        seg(`${marker}${item.expanded ? "▾" : "▸"}`, 14, groupColor, bg),
        seg(agentCell, 24, groupColor, bg),
        seg(suiteCell, 22, groupColor, bg),
        seg(mean, 7, meanColor, bg),
        seg("", 6, undefined, bg),
        seg(`$${cost.toFixed(2)}`, 9, costColor(cost, DEFAULT_THRESHOLDS), bg),
        seg("", 8, undefined, bg),
        seg("", 42, undefined, bg),
      );
    }
    const r = item;
    const dim = r.source === "statelog";
    const scoreColor = r.score === undefined ? "gray"
      : r.score >= 0.99 ? "green" : r.score <= 0.01 ? "bright-red" : "yellow";
    const passColor = r.tests > 0 && r.passed === r.tests ? "green" : r.tests > 0 ? "bright-red" : "gray";
    return tuiRow({ height: 1 },
      seg(`${marker}${fmtDate(r.dateMs)}`, 14, "gray", bg),
      seg(clip(r.agent, 22), 24, this.agentColor(r.agent) ?? (dim ? "gray" : undefined), bg),
      seg(clip(r.suite, 20), 22, dim ? "gray" : undefined, bg),
      seg(r.score !== undefined ? r.score.toFixed(2) : "—", 7, scoreColor, bg),
      seg(r.tests > 0 ? `${r.passed}/${r.tests}` : "—", 6, passColor, bg),
      seg(`$${r.costUsd.toFixed(2)}`, 9, costColor(r.costUsd, DEFAULT_THRESHOLDS) ?? (dim ? "gray" : undefined), bg),
      seg(fmtDuration(r.durationMs, { minutes: true }), 8, dim ? "gray" : undefined, bg),
      seg(clip(r.models.join(","), 40), 42, "gray", bg),
    );
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

  /** One row per agent, one column per suite; the cell answers "how did
   *  this agent do on this suite" (screenshot feedback: the old one-line
   *  header explained none of this). */
  private renderCompare(viewport: { rows: number; cols: number }): Element {
    const scored = this.rows.filter((r) => r.score !== undefined);
    const agents = [...new Set(scored.map((r) => r.agent))];
    const suites = [...new Set(scored.map((r) => r.suite))].slice(0, 4);
    const rows: Element[] = [];
    rows.push(line(`  ${pad("agent", 26)}${suites.map((s) => pad(clip(`suite: ${s}`, 24), 26)).join("")}`, { fg: "gray" }));
    for (const agent of agents) {
      const cells = suites.map((suite) => {
        const cell = scored.filter((r) => r.agent === agent && r.suite === suite);
        if (cell.length === 0) return seg("·", 26, "gray");
        const mean = cell.reduce((s, r) => s + (r.score ?? 0), 0) / cell.length;
        const cost = cell.reduce((s, r) => s + r.costUsd, 0) / cell.length;
        const meanColor = mean >= 0.99 ? "green" : mean <= 0.01 ? "bright-red" : "yellow";
        return seg(`${mean.toFixed(2)}  $${cost.toFixed(2)}  (${cell.length} run${cell.length === 1 ? "" : "s"})`, 26, meanColor);
      });
      rows.push(tuiRow({ height: 1 }, seg(`  ${clip(agent, 24)}`, 28, this.agentColor(agent)), ...cells));
    }
    if (agents.length === 0) rows.push(line("  (no scored runs — comparing needs eval runs)"));
    return column({ justifyContent: "flex-start" },
      line(`COMPARE  which agent does best on which suite?`, { fg: "bright-white" }),
      line(`  each cell: mean score · mean cost · how many runs it averages`, { fg: "gray" }),
      ...rows.slice(0, viewport.rows - 4),
      line(bottomHints("t/T next/prev view  q quit", "compare", viewport.cols), { fg: "gray" }),
    );
  }

  // ── trend variant: score & cost per day ──────────────────────────────

  private renderTrend(viewport: { rows: number; cols: number }): Element {
    const dated = this.rows
      .filter((r) => r.dateMs !== undefined)
      .sort((a, b) => (a.dateMs ?? 0) - (b.dateMs ?? 0));
    const barWidth = Math.max(10, Math.min(40, viewport.cols - 64));
    const rowEls: Element[] = [];
    for (const r of dated.slice(-Math.max(1, viewport.rows - 5))) {
      const scoreColor = r.score === undefined ? "gray"
        : r.score >= 0.99 ? "green" : r.score <= 0.01 ? "bright-red" : "yellow";
      const scoreBar = r.score !== undefined
        ? "█".repeat(Math.max(1, Math.round(r.score * 10)))
        : "—";
      const costBar = "▄".repeat(Math.min(barWidth, Math.max(r.costUsd > 0 ? 1 : 0, Math.round(r.costUsd * 4))));
      rowEls.push(tuiRow({ height: 1 },
        seg(`  ${fmtDate(r.dateMs)}`, 14, "gray"),
        seg(clip(r.agent, 20), 22, this.agentColor(r.agent)),
        seg(scoreBar, 11, scoreColor),
        seg(`$${r.costUsd.toFixed(2)}`, 8, costColor(r.costUsd, DEFAULT_THRESHOLDS)),
        seg(costBar, barWidth, costColor(r.costUsd, DEFAULT_THRESHOLDS) ?? "yellow"),
      ));
    }
    return column({ justifyContent: "flex-start" },
      line(`TREND  every run in time order — is it getting better or cheaper?`, { fg: "bright-white" }),
      line(`  score bar: █ = 0.1 (full bar = perfect)   cost bar: ▄ ≈ $0.25`, { fg: "gray" }),
      line(`  ${pad("date", 12)}${pad("agent", 22)}${pad("score", 11)}${pad("cost", 8)}`, { fg: "gray" }),
      ...rowEls,
      line(bottomHints("t/T next/prev view  q quit", "trend", viewport.cols), { fg: "gray" }),
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

  /** Same table shape as the main screen — date, name, score, status,
   *  cost, time, models — so drilling in does not change the world
   *  (screenshot feedback: the old picker dropped the columns). */
  private renderLogs(viewport: { rows: number; cols: number }): Element {
    const r = this.selectedRun();
    const logs = r?.logs ?? [];
    const header =
      `  ${pad("date", 12)}${pad("test", 24)}${pad("", 22)}${pad("score", 7)}${pad("pass", 6)}${pad("cost", 9)}${pad("time", 8)}models`;
    const rows = logs.map((l, i) => {
      const isCursor = i === this.logsCursor;
      const bg = isCursor ? CURSOR_BG : undefined;
      const scoreColor = l.score === undefined ? "gray"
        : l.score >= 0.99 ? "green" : l.score <= 0.01 ? "bright-red" : "yellow";
      const statusColor = l.status === "ok" ? "green" : l.status === "error" ? "bright-red" : "gray";
      return tuiRow({ height: 1 },
        seg(`${isCursor ? "▶ " : "  "}${fmtDate(r?.dateMs)}`, 14, "gray", bg),
        seg(clip(l.label, 22), 24, this.agentColor(r?.agent ?? "") ?? undefined, bg),
        seg("", 22, undefined, bg),
        seg(l.score !== undefined ? l.score.toFixed(2) : "—", 7, scoreColor, bg),
        seg(l.status ?? "—", 6, statusColor, bg),
        seg(`$${l.costUsd.toFixed(2)}`, 9, costColor(l.costUsd, DEFAULT_THRESHOLDS), bg),
        seg(fmtDuration(l.durationMs, { minutes: true }), 8, undefined, bg),
        seg(clip(l.models.join(","), 40), 42, "gray", bg),
      );
    });
    return column({ justifyContent: "flex-start" },
      line(`RUN ${r?.id ?? ""}  —  ${r?.agent ?? ""}  —  open which test?`, { fg: "bright-white" }),
      line(header, { fg: "gray" }),
      ...rows,
      line(bottomHints("Enter open in log viewer  ←/Esc back  q quit", "pick test", viewport.cols), { fg: "gray" }),
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
