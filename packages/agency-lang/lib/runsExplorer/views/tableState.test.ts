import { describe, expect, it } from "vitest";

import type { RunRow } from "../rows.js";
import type { Source } from "../sources.js";
import { initialTableState, projectTable, updateTable, type TableState } from "./tableState.js";

function run(key: string, over: Partial<RunRow> = {}): RunRow {
  const source: Source = { kind: "runDir", dir: `/runs/${key}` };
  return {
    key,
    source,
    startedAtMs: 1_000,
    agent: "agent-a",
    suite: "bench",
    score: 0.5,
    gatesPassed: true,
    status: "ok",
    costUsd: 1,
    wallMs: 60_000,
    models: ["sonnet"],
    tests: [],
    warnings: [],
    backfilled: true,
    ...over,
  };
}

const rows: RunRow[] = [
  run("r-old-good", { startedAtMs: 1_000, score: 0.9, costUsd: 5, agent: "agent-a" }),
  run("r-new-bad", { startedAtMs: 9_000, score: 0.1, costUsd: 1, agent: "agent-b" }),
  run("r-mid-ungraded", {
    startedAtMs: 5_000,
    score: null,
    costUsd: null,
    agent: "agent-a",
    suite: "other",
  }),
];

function keysOf(rowsIn: RunRow[], state: TableState): string[] {
  return projectTable(rowsIn, state).rows.map((r) => r.key);
}

describe("projectTable sorting", () => {
  it("date sorts newest first by default and missing values last in both directions", () => {
    const state = initialTableState();
    expect(keysOf(rows, state)).toEqual(["r-new-bad", "r-mid-ungraded", "r-old-good"]);

    const noDate = [...rows, run("r-no-date", { startedAtMs: null })];
    expect(keysOf(noDate, state).pop()).toBe("r-no-date");
    expect(keysOf(noDate, { ...state, ascending: true }).pop()).toBe("r-no-date");
  });

  it("score sorts put ungraded rows last regardless of direction", () => {
    const state: TableState = { ...initialTableState(), sort: "score" };
    expect(keysOf(rows, state)).toEqual(["r-old-good", "r-new-bad", "r-mid-ungraded"]);
    expect(keysOf(rows, { ...state, ascending: true })).toEqual([
      "r-new-bad",
      "r-old-good",
      "r-mid-ungraded",
    ]);
  });

  it("agent and suite sort lexically with stable key tie-breaks", () => {
    const state: TableState = { ...initialTableState(), sort: "agent", ascending: true };
    expect(keysOf(rows, state)).toEqual(["r-old-good", "r-mid-ungraded", "r-new-bad"]);
  });
});

describe("projectTable grouping", () => {
  const grouped: TableState = { ...initialTableState(), sort: "score", group: "agent" };

  it("emits namespaced headers with member keys and aggregates", () => {
    const projection = projectTable(rows, grouped);
    const headers = projection.rows.filter((r) => r.kind === "groupHeader");
    expect(headers.map((h) => h.key)).toEqual(["group:agent:agent-a", "group:agent:agent-b"]);
    const agentA = headers[0];
    if (agentA.kind !== "groupHeader") {
      throw new Error("expected header");
    }
    expect(agentA.memberKeys).toEqual(["r-old-good", "r-mid-ungraded"]);
    expect(agentA.count).toBe(2);
    expect(agentA.aggregates.score).toBeCloseTo(0.9);
    expect(agentA.aggregates.cost).toBe(5);
    expect(agentA.aggregates.date).toBe(5_000);
  });

  it("collapsed groups hide members; expansion interleaves them under the header", () => {
    expect(keysOf(rows, grouped)).toEqual(["group:agent:agent-a", "group:agent:agent-b"]);

    const expanded: TableState = { ...grouped, expandedGroupKeys: ["group:agent:agent-a"] };
    expect(keysOf(rows, expanded)).toEqual([
      "group:agent:agent-a",
      "r-old-good",
      "r-mid-ungraded",
      "group:agent:agent-b",
    ]);
  });

  it("groups order by the aggregate of the active sort column", () => {
    const byCost: TableState = { ...grouped, sort: "cost" };
    expect(keysOf(rows, byCost)).toEqual(["group:agent:agent-a", "group:agent:agent-b"]);
    const byCostAsc: TableState = { ...byCost, ascending: true };
    expect(keysOf(rows, byCostAsc)).toEqual(["group:agent:agent-b", "group:agent:agent-a"]);
  });
});

describe("cursor stability", () => {
  it("the cursor pins to its row identity across sort and direction changes", () => {
    let state: TableState = { ...initialTableState(), cursorKey: "r-mid-ungraded" };
    expect(projectTable(rows, state).cursorKey).toBe("r-mid-ungraded");

    state = updateTable(state, { kind: "sortNext" }, rows);
    state = updateTable(state, { kind: "sortDirection" }, rows);
    const projection = projectTable(rows, state);
    expect(projection.cursorKey).toBe("r-mid-ungraded");
    expect(projection.rows[projection.cursorIndex ?? -1].key).toBe("r-mid-ungraded");
  });

  it("an agent rename arriving from backfill regroups without losing the cursor", () => {
    const state: TableState = {
      ...initialTableState(),
      sort: "score",
      group: "agent",
      cursorKey: "r-new-bad",
      expandedGroupKeys: ["group:agent:agent-b", "group:agent:agent-c"],
    };
    expect(projectTable(rows, state).cursorKey).toBe("r-new-bad");

    const renamed = rows.map((r) => (r.key === "r-new-bad" ? { ...r, agent: "agent-c" } : r));
    const projection = projectTable(renamed, state);
    expect(projection.cursorKey).toBe("r-new-bad");
    expect(projection.rows[projection.cursorIndex ?? -1].key).toBe("r-new-bad");
  });

  it("a member hidden by collapse maps to its owning header", () => {
    const state: TableState = {
      ...initialTableState(),
      sort: "score",
      group: "agent",
      cursorKey: "r-old-good",
    };
    const projection = projectTable(rows, state);
    expect(projection.cursorKey).toBe("group:agent:agent-a");
  });

  it("a removed row clamps near the previous position via the index hint", () => {
    const state: TableState = {
      ...initialTableState(),
      cursorKey: "r-mid-ungraded",
      cursorIndexHint: 1,
    };
    const without = rows.filter((r) => r.key !== "r-mid-ungraded");
    const projection = projectTable(without, state);
    expect(projection.cursorIndex).toBe(1);
    expect(projection.cursorKey).toBe("r-old-good");
  });

  it("move updates both the key and the hint and clamps at the edges", () => {
    let state: TableState = { ...initialTableState() };
    state = updateTable(state, { kind: "move", delta: 1 }, rows);
    expect(state.cursorKey).toBe("r-mid-ungraded");
    state = updateTable(state, { kind: "move", delta: 100 }, rows);
    expect(state.cursorKey).toBe("r-old-good");
    state = updateTable(state, { kind: "move", delta: -100 }, rows);
    expect(state.cursorKey).toBe("r-new-bad");
  });
});

describe("updateTable transitions", () => {
  it("sortNext cycles through every column and groupNext through the group keys", () => {
    let state = initialTableState();
    const seenSorts: string[] = [state.sort];
    for (let i = 0; i < 6; i++) {
      state = updateTable(state, { kind: "sortNext" }, rows);
      seenSorts.push(state.sort);
    }
    expect(seenSorts).toEqual(["date", "score", "cost", "time", "agent", "suite", "date"]);

    let groupState = initialTableState();
    groupState = updateTable(groupState, { kind: "groupNext" }, rows);
    expect(groupState.group).toBe("agent");
    groupState = updateTable(groupState, { kind: "groupNext" }, rows);
    expect(groupState.group).toBe("suite");
    groupState = updateTable(groupState, { kind: "groupNext" }, rows);
    expect(groupState.group).toBe("none");
  });

  it("toggleGroup expands and collapses the header under the cursor", () => {
    let state: TableState = {
      ...initialTableState(),
      sort: "score",
      group: "agent",
      cursorKey: "group:agent:agent-a",
    };
    state = updateTable(state, { kind: "toggleGroup" }, rows);
    expect(state.expandedGroupKeys).toEqual(["group:agent:agent-a"]);
    state = updateTable(state, { kind: "toggleGroup" }, rows);
    expect(state.expandedGroupKeys).toEqual([]);
  });
});
