// Pure table-state projection for the runs table: sorting, grouping,
// expansion, and a cursor pinned to ROW IDENTITY. The cursor is stored
// as a key (RunRow.key or a group header's namespaced key), never an
// index — backfill can rename a row's agent and regroup the table under
// the user, and the highlighted row must stay highlighted. The index is
// re-derived on every projection; `cursorIndexHint` is the fallback for
// a row that vanished outright.
import type { RunRow } from "../rows.js";

export type SortKey = "date" | "score" | "cost" | "time" | "agent" | "suite";
export type GroupKey = "none" | "agent" | "suite";

const SORT_CYCLE: SortKey[] = ["date", "score", "cost", "time", "agent", "suite"];
const GROUP_CYCLE: GroupKey[] = ["none", "agent", "suite"];

export type GroupAggregates = {
  /** Latest non-null start among members. */
  date: number | null;
  /** Mean over graded members only. */
  score: number | null;
  /** Sum over members with known cost. */
  cost: number | null;
  /** Sum over members with known wall time. */
  time: number | null;
  agent: string;
  suite: string;
};

export type GroupHeaderRow = {
  kind: "groupHeader";
  key: string;
  group: "agent" | "suite";
  label: string;
  memberKeys: string[];
  count: number;
  aggregates: GroupAggregates;
  expanded: boolean;
};

export type DisplayRow =
  | { kind: "run"; key: string; row: RunRow }
  | GroupHeaderRow;

export type TableState = {
  sort: SortKey;
  ascending: boolean;
  group: GroupKey;
  expandedGroupKeys: string[];
  cursorKey: string | null;
  cursorIndexHint: number;
};

export type TableProjection = {
  rows: DisplayRow[];
  cursorIndex: number | null;
  cursorKey: string | null;
};

export type TableAction =
  | { kind: "move"; delta: number }
  | { kind: "sortNext" }
  | { kind: "sortDirection" }
  | { kind: "groupNext" }
  | { kind: "toggleGroup" };

export function initialTableState(): TableState {
  return {
    sort: "date",
    ascending: false,
    group: "none",
    expandedGroupKeys: [],
    cursorKey: null,
    cursorIndexHint: 0,
  };
}

export function projectTable(rows: RunRow[], state: TableState): TableProjection {
  const display = displayRows(rows, state);
  if (display.length === 0) {
    return { rows: display, cursorIndex: null, cursorKey: null };
  }

  const directIndex = display.findIndex((row) => row.key === state.cursorKey);
  if (directIndex !== -1) {
    return { rows: display, cursorIndex: directIndex, cursorKey: state.cursorKey };
  }

  // A run row hidden inside a collapsed group: the owning header is the
  // nearest visible thing that still means "that row".
  const owningIndex = display.findIndex(
    (row) => row.kind === "groupHeader" && state.cursorKey !== null
      && row.memberKeys.includes(state.cursorKey),
  );
  if (owningIndex !== -1) {
    return { rows: display, cursorIndex: owningIndex, cursorKey: display[owningIndex].key };
  }

  const clamped = Math.max(0, Math.min(display.length - 1, state.cursorIndexHint));
  return { rows: display, cursorIndex: clamped, cursorKey: display[clamped].key };
}

export function updateTable(state: TableState, action: TableAction, rows: RunRow[]): TableState {
  if (action.kind === "move") {
    const projection = projectTable(rows, state);
    if (projection.cursorIndex === null) {
      return state;
    }
    const index = Math.max(0, Math.min(projection.rows.length - 1, projection.cursorIndex + action.delta));
    return { ...state, cursorKey: projection.rows[index].key, cursorIndexHint: index };
  }
  if (action.kind === "sortNext") {
    const at = SORT_CYCLE.indexOf(state.sort);
    return rePin(rows, { ...state, sort: SORT_CYCLE[(at + 1) % SORT_CYCLE.length] });
  }
  if (action.kind === "sortDirection") {
    return rePin(rows, { ...state, ascending: !state.ascending });
  }
  if (action.kind === "groupNext") {
    const at = GROUP_CYCLE.indexOf(state.group);
    return rePin(rows, { ...state, group: GROUP_CYCLE[(at + 1) % GROUP_CYCLE.length] });
  }
  const projection = projectTable(rows, state);
  const cursorRow = projection.cursorIndex === null ? undefined : projection.rows[projection.cursorIndex];
  if (cursorRow === undefined || cursorRow.kind !== "groupHeader") {
    return state;
  }
  const expandedGroupKeys = cursorRow.expanded
    ? state.expandedGroupKeys.filter((key) => key !== cursorRow.key)
    : [...state.expandedGroupKeys, cursorRow.key];
  return { ...state, expandedGroupKeys, cursorKey: cursorRow.key };
}

/** After a sort/group change the cursor keeps its identity; only the
 *  index hint moves. */
function rePin(rows: RunRow[], state: TableState): TableState {
  const projection = projectTable(rows, state);
  if (projection.cursorIndex === null) {
    return state;
  }
  return { ...state, cursorKey: projection.cursorKey, cursorIndexHint: projection.cursorIndex };
}

// ── projection internals ───────────────────────────────────────────

function displayRows(rows: RunRow[], state: TableState): DisplayRow[] {
  const sorted = [...rows].sort((a, b) => compareValues(sortValue(a, state.sort), sortValue(b, state.sort), state.ascending));
  if (state.group === "none") {
    return sorted.map((row) => ({ kind: "run", key: row.key, row }));
  }

  const group = state.group;
  const byLabel: Record<string, RunRow[]> = Object.create(null);
  for (const row of sorted) {
    const label = group === "agent" ? row.agent : row.suite;
    (byLabel[label] ??= []).push(row);
  }

  const headers: GroupHeaderRow[] = Object.entries(byLabel).map(([label, members]) => {
    const key = groupHeaderKey(group, label);
    return {
      kind: "groupHeader",
      key,
      group,
      label,
      memberKeys: members.map((m) => m.key),
      count: members.length,
      aggregates: aggregate(members, group, label),
      expanded: state.expandedGroupKeys.includes(key),
    };
  });
  headers.sort((a, b) => compareValues(headerSortValue(a, state.sort), headerSortValue(b, state.sort), state.ascending));

  const display: DisplayRow[] = [];
  for (const header of headers) {
    display.push(header);
    if (header.expanded) {
      const members = byLabel[header.label];
      display.push(...members.map((row): DisplayRow => ({ kind: "run", key: row.key, row })));
    }
  }
  return display;
}

function groupHeaderKey(group: "agent" | "suite", label: string): string {
  return `group:${group}:${label.replace(/:/g, "%3A")}`;
}

function aggregate(members: RunRow[], group: "agent" | "suite", label: string): GroupAggregates {
  const dates = members.map((m) => m.startedAtMs).filter((v): v is number => v !== null);
  const scores = members.map((m) => m.score).filter((v): v is number => v !== null);
  const costs = members.map((m) => m.costUsd).filter((v): v is number => v !== null);
  const times = members.map((m) => m.wallMs).filter((v): v is number => v !== null);
  return {
    date: dates.length === 0 ? null : Math.max(...dates),
    score: scores.length === 0 ? null : scores.reduce((s, v) => s + v, 0) / scores.length,
    cost: costs.length === 0 ? null : costs.reduce((s, v) => s + v, 0),
    time: times.length === 0 ? null : times.reduce((s, v) => s + v, 0),
    agent: group === "agent" ? label : sharedLabel(members.map((m) => m.agent)),
    suite: group === "suite" ? label : sharedLabel(members.map((m) => m.suite)),
  };
}

function sharedLabel(labels: string[]): string {
  const first = labels[0] ?? "—";
  return labels.every((label) => label === first) ? first : "mixed";
}

function sortValue(row: RunRow, sort: SortKey): number | string | null {
  if (sort === "date") return row.startedAtMs;
  if (sort === "score") return row.score;
  if (sort === "cost") return row.costUsd;
  if (sort === "time") return row.wallMs;
  if (sort === "agent") return row.agent;
  return row.suite;
}

function headerSortValue(header: GroupHeaderRow, sort: SortKey): number | string | null {
  return header.aggregates[sort];
}

/** Missing values sort LAST in both directions — an ungraded run must
 *  never look like the best or the worst. Sort is otherwise stable, so
 *  ties keep input order. */
function compareValues(a: number | string | null, b: number | string | null, ascending: boolean): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const base = typeof a === "string" || typeof b === "string"
    ? String(a).localeCompare(String(b))
    : a - b;
  return ascending ? base : -base;
}
