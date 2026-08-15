import { describe, expect, it } from "vitest";

import { csvRowsFromProjection, csvRowsFromRuns, exportCsv } from "./csv.js";
import { runRow } from "./views/viewTestUtils.js";
import { initialTableState, projectTable } from "./views/tableState.js";

describe("exportCsv", () => {
  it("names the file with a timestamp in the working directory", () => {
    const { path: outPath } = exportCsv([], new Date("2026-08-01T09:05:07"));
    expect(outPath.endsWith("runs-export-20260801-090507.csv")).toBe(true);
  });

  it("emits a header from the union of keys, quotes commas and quotes, and blanks nulls", () => {
    const { content } = exportCsv(
      [
        { agent: "a,b", note: 'say "hi"', score: null },
        { agent: "plain", note: "x", score: 0.5 },
      ],
      new Date(),
    );

    const [header, first, second] = content.trimEnd().split("\n");
    expect(header).toBe("agent,note,score");
    expect(first).toBe('"a,b","say ""hi""",');
    expect(second).toBe("plain,x,0.5");
  });
});

describe("csvRowsFromRuns", () => {
  it("orders rows newest first and carries the table fields", () => {
    const rows = csvRowsFromRuns([
      runRow("old", { startedAtMs: 1_000, agent: "a" }),
      runRow("new", { startedAtMs: 9_000, agent: "b" }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["new", "old"]);
    expect(rows[0].agent).toBe("b");
    expect(rows[0].models).toBe("sonnet");
    expect(rows[0].score).toBe(0.5);
  });
});

describe("csvRowsFromProjection", () => {
  it("includes members under their headers even when collapsed, without duplicates", () => {
    const runs = [
      runRow("a1", { agent: "agent-a", score: 0.9 }),
      runRow("a2", { agent: "agent-a", score: 0.7 }),
      runRow("b1", { agent: "agent-b", score: 0.5 }),
    ];
    const state = {
      ...initialTableState(),
      sort: "score" as const,
      group: "agent" as const,
      expandedGroupKeys: ["group:agent:agent-a"],
    };
    const projection = projectTable(runs, state);

    const rows = csvRowsFromProjection(projection, runs);

    expect(rows.map((r) => r.key)).toEqual([
      "group:agent:agent-a",
      "a1",
      "a2",
      "group:agent:agent-b",
      "b1",
    ]);
    expect(rows[0].type).toBe("group");
    expect(rows[0].count).toBe(2);
    expect(rows[1].type).toBe("run");
  });
});
