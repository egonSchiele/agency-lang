// Shared helpers for the view tests: quick RunRow literals and a
// text-leaf flattener for rendered elements.
import type { Element } from "../../tui/elements.js";
import type { RunRow, TestRow } from "../rows.js";
import type { Source } from "../sources.js";

export function testRow(inputId: string, over: Partial<TestRow> = {}): TestRow {
  return {
    inputId,
    statelogPath: `/runs/x/inputs/${inputId}/agent/statelog.jsonl`,
    score: 0.5,
    gatesPassed: true,
    status: "ok",
    costUsd: 1,
    durationMs: 60_000,
    startedAtMs: 1_000,
    models: ["sonnet"],
    ...over,
  };
}

export function runRow(key: string, over: Partial<RunRow> = {}): RunRow {
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
    tests: [testRow("t1"), testRow("t2")],
    warnings: [],
    backfilled: true,
    ...over,
  };
}

export function flat(el: Element): string[] {
  if (el.type === "text") {
    return [el.content ?? ""];
  }
  return (el.children ?? []).flatMap(flat);
}

export function screenText(el: Element): string {
  return flat(el).join("\n");
}
