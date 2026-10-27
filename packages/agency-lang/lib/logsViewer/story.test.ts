import { describe, expect, it } from "vitest";
import { buildForest } from "./tree.js";
import { walkNodes, walkWithDepth } from "./forest.js";
import { findRow } from "./detailTarget.js";
import { payloadFor } from "./payload.js";
import { payloadText } from "./payloadText.js";
import {
  agentLoopTrace,
  event,
  hostedSearchEvents,
  loopEvents,
  sampleRunForest,
} from "./storyFixture.js";
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

describe("top-level thread rows", () => {
  const call = (span: string, at: number, label: string) =>
    event("promptCompletion", at, span, null, {
      threadIdentity: span,
      threadLabel: label,
      messages: [{ role: "user", content: "hi" }],
      completion: { output: "ok" },
    });

  it("gives each of two top-level llmCall spans a thread row with no owning tool", () => {
    const trace = buildForest([
      call("check", 100, "expressionCheck"),
      call("main", 200, "mainConversation"),
    ])[0];
    const rows = outlineRows(trace, STORY);
    expect(rows.map((row) => [row.kind, row.depth])).toEqual([
      ["llmGroup", 0],
      ["user", 1],
      ["round", 1],
      ["llmGroup", 0],
      ["user", 1],
      ["round", 1],
    ]);
    expect(rows[0]).toMatchObject({ label: "expressionCheck", toolName: undefined });
    expect(rows[3]).toMatchObject({ label: "mainConversation" });
  });

  it("keeps a lone top-level llmCall span flat", () => {
    const trace = buildForest([call("main", 200, "mainConversation")])[0];
    expect(outlineRows(trace, STORY).map((row) => row.kind)).toEqual(["user", "round"]);
  });

  it("keeps several top-level calls on one thread flat, as a loop makes them", () => {
    const onMain = (span: string, at: number) =>
      event("promptCompletion", at, span, null, {
        threadIdentity: "main",
        threadLabel: "mainConversation",
        messages: [{ role: "user", content: `step ${at}` }],
        completion: { output: "ok" },
      });
    const trace = buildForest([onMain("A", 100), onMain("B", 200)])[0];
    expect(outlineRows(trace, STORY).map((row) => row.kind)).toEqual([
      "user",
      "round",
      "user",
      "round",
    ]);
  });
});

describe("resumed runs", () => {
  // A tool pauses in run 1 (no handler decided, so the runtime logs
  // `passed`), and run 2 logs the person's approval under its own span.
  function pausedAndResumed(extra: ReturnType<typeof event>[] = []) {
    return buildForest([
      event("agentStart", 0, "run1", null, { entryNode: "main" }),
      event("promptCompletion", 100, "L", "run1", {
        completion: { toolCalls: [{ name: "deploy" }] },
      }),
      event("toolCallStart", 101, "tool", "L", { toolName: "deploy", args: { env: "prod" } }),
      event("interruptThrown", 102, "tool", "L", { interruptId: "i1", interruptData: {} }),
      event("interruptResolved", 103, "tool", "L", {
        interruptId: "i1",
        outcome: "passed",
        resolvedBy: null,
        interrupt: { effect: "ops::deploy", message: "Deploy?" },
      }),
      event("agentStart", 14_300, "run2", null, { entryNode: "main" }),
      event("checkpointRestored", 14_301, "run2", null, { checkpointId: "cp" }),
      event("interruptResolved", 14_302, "run2", null, {
        interruptId: "i1",
        outcome: "approved",
        resolvedBy: "user",
      }),
      event("toolCall", 14_400, "tool", "L", { toolName: "deploy", output: "ok", timeTaken: 10 }),
      ...extra,
    ])[0];
  }

  it("merges the approval from the next run into the interrupt it answers, under the tool", () => {
    const rows = outlineRows(pausedAndResumed(), STORY);
    const interrupts = rows.filter((row) => row.kind === "interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]).toMatchObject({
      depth: 2,
      toolName: "deploy",
      interrupt: { effect: "ops::deploy", outcome: "approved", resolvedBy: "user" },
    });
    expect(rows.find((row) => row.kind === "tool")).toMatchObject({ status: "completed" });
  });

  it("shows the pause under the interrupt, with how long it waited", () => {
    const rows = outlineRows(pausedAndResumed(), STORY);
    const pause = rows.find((row) => row.kind === "pause");
    expect(pause).toMatchObject({ pausedMs: 14_199, resumed: true, depth: 3 });
    expect(rows.indexOf(pause!)).toBe(rows.findIndex((row) => row.kind === "interrupt") + 1);
  });

  it("measures the pause to the person's answer, not to another run sharing the trace", () => {
    const rows = outlineRows(
      pausedAndResumed([event("agentStart", 5_000, "other", null, { entryNode: "watcher" })]),
      STORY,
    );
    expect(rows.find((row) => row.kind === "pause")).toMatchObject({ pausedMs: 14_199 });
  });

  it("keeps the innermost tool as the owner when nested tools log the same interrupt", () => {
    const trace = buildForest([
      event("toolCallStart", 0, "outer", null, { toolName: "outer" }),
      event("toolCallStart", 1, "inner", "outer", { toolName: "inner" }),
      event("interruptThrown", 2, "inner", "outer", { interruptId: "i1" }),
      event("interruptResolved", 3, "inner", "outer", {
        interruptId: "i1",
        outcome: "approved",
        resolvedBy: "handler",
      }),
      event("interruptResolved", 4, "outer", null, {
        interruptId: "i1",
        outcome: "approved",
        resolvedBy: "handler",
      }),
    ])[0];
    const interrupts = outlineRows(trace, STORY).filter((row) => row.kind === "interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]).toMatchObject({
      toolName: "inner",
      interrupt: { resolvedBy: "handler" },
    });
  });

  it("labels a span whose parent is missing and places it by time at the top", () => {
    const trace = buildForest([
      event("promptCompletion", 100, "L", null, { completion: { output: "first" } }),
      event("toolCall", 300, "lost", "gone", {
        toolName: "scheduleTask",
        output: "ok",
        timeTaken: 5,
      }),
      event("promptCompletion", 200, "L", null, { completion: { output: "second" } }),
    ])[0];
    const rows = outlineRows(trace, STORY);
    expect(rows.map((row) => [row.kind, row.depth, row.orphan])).toEqual([
      ["round", 0, false],
      ["round", 0, false],
      ["tool", 0, true],
    ]);
  });
});

describe("decision calls", () => {
  it("labels a decision call with its answer instead of a JSON reply", () => {
    const trace = buildForest([
      event("promptCompletion", 100, "L", null, {
        usageKind: "decision",
        messages: [{ role: "user", content: "Are you able to set up a recurring job?" }],
        completion: { output: JSON.stringify({ response: "curious" }) },
        decision: {
          state: [{ role: "user", content: "Are you able to set up a recurring job?" }],
          questions: {
            response: {
              type: "choice",
              instructions: "Which expression?",
              criteria: { idle: "i", curious: "c" },
            },
          },
          answers: {
            response: {
              type: "choice",
              choice: "curious",
              confidence: 0.7,
              probabilities: { curious: 0.86, idle: 0.14 },
            },
          },
        },
      }),
    ])[0];
    const round = outlineRows(trace, STORY).find((row) => row.kind === "round");
    expect(round).toMatchObject({ gist: "decision · curious 86%" });
  });
  it("puts the provider's hosted calls under their LLM call, before the tools it asked for", () => {
    const trace = buildForest(hostedSearchEvents())[0];
    const rows = outlineRows(trace, STORY);
    expect(rows.map((row) => `${row.depth} ${row.kind} ${row.id}`)).toEqual([
      "0 user round:L:0:user",
      "0 round round:L:0",
      "1 hosted round:L:0:hosted:0",
      "1 hosted round:L:0:hosted:1",
      "1 tool read",
      "0 round round:L:1",
    ]);
    // The raw view shows the provider's item for that call, not the whole LLM call.
    const hosted = rows.find((row) => row.id === "round:L:0:hosted:1")!;
    expect(payloadText(payloadFor(hosted, { raw: true }))).toContain('"id": "ws_2"');
    expect(payloadText(payloadFor(hosted, { raw: true }))).not.toContain("ws_1");
    expect(payloadText(payloadFor(hosted, { raw: false }))).toContain(
      "HOSTED TOOL CALL · web_search",
    );
    expect(findRow(trace, "round:L:0:hosted:0")?.kind).toBe("hosted");
  });
  it("puts hosted calls under their LLM call in the machinery view too", () => {
    const rows = outlineRows(buildForest(hostedSearchEvents())[0], RAW);
    const round = rows.findIndex((row) => row.id === "round:L:0");
    expect(rows.slice(round + 1, round + 3).map((row) => `${row.depth} ${row.id}`)).toEqual([
      `${rows[round].depth + 1} round:L:0:hosted:0`,
      `${rows[round].depth + 1} round:L:0:hosted:1`,
    ]);
  });
});
