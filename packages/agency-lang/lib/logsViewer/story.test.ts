import { describe, expect, it } from "vitest";
import { buildForest } from "./tree.js";
import { walkNodes, walkWithDepth } from "./forest.js";
import { agentLoopTrace, event, loopEvents, sampleRunForest } from "./storyFixture.js";
import {
  outlineRows,
  classifyTool,
  type ToolEvidence,
  type ToolStatus,
  type ToolWork,
} from "./story.js";
const STORY = { machinery: false, admin: false };
const RAW = { machinery: true, admin: true };
describe("story outline", () => {
  it("places tools and interrupts under their asking round without inventing errors", () => {
    const rows = outlineRows(agentLoopTrace(), STORY);
    expect(rows.map((row) => `${row.depth} ${row.kind}`)).toEqual([
      "0 user",
      "0 round",
      "1 tool",
      "2 interrupt",
      "0 round",
      "1 tool",
      "2 interrupt",
      "0 round",
    ]);
    expect(rows.find((row) => row.kind === "interrupt")).toMatchObject({
      interrupt: { effect: "std::read", outcome: "approved", resolvedBy: "ipc" },
    });
    expect(rows.find((row) => row.id === "grep")).toMatchObject({
      status: "rejected",
      work: "unknown",
      durationMs: undefined,
    });
  });
  it.each([
    [{ completed: false, errors: [], interrupts: [] }, "unfinished", "unknown"],
    [{ completed: false, errors: [], interrupts: ["pending"] }, "awaitingApproval", "unknown"],
    [{ completed: false, errors: [], interrupts: ["rejected"] }, "rejected", "unknown"],
    [
      {
        completed: false,
        errors: [{ neverStarted: false, destructiveRan: true }],
        interrupts: ["rejected"],
      },
      "failed",
      "started",
    ],
    [
      { completed: false, errors: [{ neverStarted: true, destructiveRan: false }], interrupts: [] },
      "failed",
      "notStarted",
    ],
    [{ completed: true, errors: [], interrupts: ["approved"] }, "completed", "started"],
  ] satisfies [ToolEvidence, ToolStatus, ToolWork][])(
    "classifies evidence %j",
    (evidence, status, work) => expect(classifyTool(evidence)).toEqual({ status, work }),
  );
  it("places admin decisions under their interrupt", () => {
    const rows = outlineRows(agentLoopTrace(), { ...STORY, admin: true });
    const position = rows.findIndex((row) => row.kind === "interrupt");
    expect(rows[position + 1]).toMatchObject({ kind: "machinery", depth: 3 });
  });
  it("tracks the latest interrupt state and keeps nested tool evidence separate", () => {
    const events = [
      event("toolCallStart", 0, "outer", null, { toolName: "outer" }),
      event("interruptThrown", 1, "outer", null, { interruptId: "one" }),
      event("interruptResolved", 2, "outer", null, { interruptId: "one", outcome: "propagated" }),
      event("interruptResolved", 3, "outer", null, { interruptId: "one", outcome: "approved" }),
      event("toolCallStart", 4, "inner", "outer", { toolName: "inner" }),
      event("interruptResolved", 5, "inner", "outer", { outcome: "rejected" }),
    ];
    let rows = outlineRows(buildForest(events)[0], STORY);
    expect(rows.find((row) => row.id === "outer")).toMatchObject({ status: "unfinished" });
    expect(rows.find((row) => row.id === "inner")).toMatchObject({ status: "rejected" });
    expect(rows.filter((row) => row.kind === "interrupt")).toHaveLength(2);
    events.push(event("error", 6, "inner", "outer", { message: "failed", destructiveRan: true }));
    rows = outlineRows(buildForest(events)[0], STORY);
    expect(rows.find((row) => row.id === "inner")).toMatchObject({
      status: "failed",
      work: "started",
    });
    expect(rows.find((row) => row.id === "outer")).toMatchObject({ status: "unfinished" });
  });
  it("keeps missing interrupt ids independent and pending work visible", () => {
    const trace = buildForest([
      event("toolCallStart", 0, "tool", null, { toolName: "read" }),
      event("interruptThrown", 1, "tool"),
      event("interruptResolved", 2, "tool", null, { outcome: "approved" }),
    ])[0];
    expect(outlineRows(trace, STORY).find((row) => row.id === "tool")).toMatchObject({
      status: "awaitingApproval",
    });
  });
  it("labels nested LLM calls by thread and keeps the owning tool as metadata", () => {
    const trace = buildForest([
      event("toolCallStart", 0, "tool", null, { toolName: "researchAgent" }),
      event("promptCompletion", 10, "child", "tool", {
        threadLabel: "main",
        threadIdentity: "main-thread",
      }),
    ])[0];
    const rows = outlineRows(trace, STORY);
    expect(rows.map((row) => [row.kind, row.depth])).toEqual([
      ["tool", 0],
      ["llmGroup", 1],
      ["round", 2],
    ]);
    expect(rows[1]).toMatchObject({
      label: "main",
      toolName: "researchAgent",
      rounds: [expect.objectContaining({ threadLabel: "main" })],
    });
    const unknown = buildForest([event("somethingNew", 0, null)])[0];
    expect(outlineRows(unknown, STORY)).toEqual([]);
    expect(outlineRows(unknown, RAW)).toHaveLength(1);
  });
  it("keeps row ids stable when a promptStart disappears on follow", () => {
    const before = loopEvents().slice(0, 9);
    before.unshift(event("promptStart", 0, "L"));
    before.push(event("promptStart", 250, "L"));
    const after = [
      ...before,
      event("promptCompletion", 300, "L", null, {
        messages: [{ role: "user", content: "write a module" }],
      }),
    ];
    for (const options of [STORY, RAW]) {
      const earlier = outlineRows(buildForest(before)[0], options).filter(
        (row) => row.node.label !== "promptStart",
      );
      const ids = outlineRows(buildForest(after)[0], options).map((row) => row.id);
      expect(earlier.every((row) => ids.includes(row.id))).toBe(true);
      expect(ids.filter((id, position) => ids.indexOf(id) === position)).toHaveLength(ids.length);
    }
  });
});
describe("forest outline", () => {
  it.each([agentLoopTrace, sampleRunForest])("has exactly one row per node", (factory) => {
    const value = factory();
    const trace = Array.isArray(value) ? value[0] : value;
    const rows = outlineRows(trace, RAW);
    expect(rows).toHaveLength(walkNodes(trace).length - 1);
    expect(
      rows.filter((row, position) => rows.findIndex((other) => other.id === row.id) === position),
    ).toHaveLength(rows.length);
  });
  it("keeps forest nesting and skips whole admin subtrees", () => {
    const trace = agentLoopTrace();
    const rows = outlineRows(trace, RAW);
    expect(rows.find((row) => row.kind === "round")?.depth).toBe(
      rows.find((row) => row.kind === "tool")?.depth,
    );
    expect(rows.some((row) => row.kind === "user")).toBe(false);
    const visible = outlineRows(trace, { machinery: true, admin: false });
    expect(visible.some((row) => row.node.label === "handlerDecision")).toBe(false);
    expect(
      walkWithDepth(trace, (node) => node.label === "handlerChain").map((placed) => placed.node.id),
    ).toEqual(visible.map((row) => row.node.id));
  });
  it("the recorded failures preserve their error evidence", () => {
    const rows = outlineRows(sampleRunForest()[0], STORY);
    expect(rows.filter((row) => row.kind === "round")).toHaveLength(10);
    expect(rows.filter((row) => row.kind === "tool" && row.status === "failed")).toHaveLength(4);
    expect(
      rows.filter((row) => row.kind === "interrupt" && row.interrupt.outcome === "rejected"),
    ).toHaveLength(4);
  });
});
