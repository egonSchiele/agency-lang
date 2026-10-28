import { traceEvents } from "./traceFixture.js";
// traceSearch.test.ts
import { describe, expect, it } from "vitest";
import { buildForest } from "./tree.js";
import {
  agentFilter,
  applyFilters,
  parsePickerQuery,
  searchTraces,
  stringsIn,
  textFilter,
  traceTexts,
} from "./traceSearch.js";
import { traceSummaries } from "./traceSummaries.js";

describe("stringsIn", () => {
  it("collects every string, however deep, in order", () => {
    const value = { a: "one", b: [{ c: "two" }, 3, null], d: { e: { f: "three" } } };
    expect(stringsIn(value)).toEqual(["one", "two", "three"]);
  });
  it("a bare string is itself, and a number is nothing", () => {
    expect(stringsIn("x")).toEqual(["x"]);
    expect(stringsIn(7)).toEqual([]);
  });
});

describe("searchTraces", () => {
  const roots = buildForest([
    ...traceEvents("A", {
      answer: "def archiveNotes(count) {\n  return 1\n}",
      toolOutput: "nothing here",
    }),
    ...traceEvents("B", {
      answer: "hello",
      toolOutput: 'grep found "ArchiveNotes" twice: archivenotes',
    }),
    ...traceEvents("C", { answer: "unrelated", toolOutput: "unrelated" }),
  ]);
  const texts = traceTexts(roots);

  it("finds a match inside a model's answer and inside a tool's output", () => {
    const hits = searchTraces(texts, "archiveNotes");
    expect(hits.map((hit) => hit.traceId)).toEqual(["A", "B"]);
  });

  it("ignores case and counts every occurrence", () => {
    const hits = searchTraces(texts, "ARCHIVENOTES");
    expect(hits.find((hit) => hit.traceId === "B")!.count).toBe(2);
  });

  it("matches across a real line break, which JSON text would not", () => {
    expect(searchTraces(texts, "{\n  return 1").map((hit) => hit.traceId)).toEqual(["A"]);
  });

  it("the snippet shows the first hit with text around it, on one line", () => {
    const [hit] = searchTraces(texts, "return 1");
    expect(hit.snippet).toContain("return 1");
    expect(hit.snippet).not.toContain("\n");
  });

  it("an empty query matches nothing, and so does a stranger", () => {
    expect(searchTraces(texts, "")).toEqual([]);
    expect(searchTraces(texts, "zzzz")).toEqual([]);
  });

  it("a text filter keeps only the traces that were hit", () => {
    const summaries = traceSummaries(roots, {});
    const hits = searchTraces(texts, "archiveNotes");
    const shown = applyFilters(summaries, [textFilter("archiveNotes", hits)]);
    expect(shown.map((summary) => summary.traceId)).toEqual(["A", "B"]);
  });

  it("with no filters every trace is shown", () => {
    expect(applyFilters(traceSummaries(roots, {}), [])).toHaveLength(3);
  });

  it("filters combine: a trace must pass all of them", () => {
    const summaries = traceSummaries(roots, {});
    const onlyB = {
      id: "onlyB",
      label: "only B",
      accepts: (summary: { traceId: string }) => summary.traceId === "B",
    };
    const hits = searchTraces(texts, "archiveNotes");
    const shown = applyFilters(summaries, [textFilter("archiveNotes", hits), onlyB]);
    expect(shown.map((summary) => summary.traceId)).toEqual(["B"]);
  });
});

describe("parsePickerQuery", () => {
  it("a plain query is all text", () => {
    expect(parsePickerQuery("hello world")).toEqual({
      agentPrefix: undefined,
      text: "hello world",
    });
  });
  it("agent: alone is an empty prefix and no text", () => {
    expect(parsePickerQuery("agent:")).toEqual({ agentPrefix: "", text: "" });
  });
  it("the prefix ends at the first space and the rest is text", () => {
    expect(parsePickerQuery("agent:agency-agent/ time out")).toEqual({
      agentPrefix: "agency-agent/",
      text: "time out",
    });
  });
  it("extra spaces after the prefix are not part of the text", () => {
    expect(parsePickerQuery("agent:x   ask")).toEqual({ agentPrefix: "x", text: "ask" });
  });
  it("the keyword ignores case and leading spaces; the name prefix keeps both", () => {
    expect(parsePickerQuery("  Agent:Bot x")).toEqual({ agentPrefix: "Bot", text: "x" });
  });
  it("agent: in the middle of a query is just text", () => {
    expect(parsePickerQuery("see agent:x")).toEqual({
      agentPrefix: undefined,
      text: "see agent:x",
    });
  });
});

describe("agentFilter", () => {
  const summaries = traceSummaries(
    buildForest([
      ...traceEvents("A", {
        answer: "ok",
        toolOutput: "ok",
        agentName: "agency-agent/coordinator",
      }),
      ...traceEvents("B", { answer: "ok", toolOutput: "ok", agentName: "Agency-agent/x" }),
      ...traceEvents("C", { answer: "ok", toolOutput: "ok" }),
    ]),
    {},
  );
  it("keeps names that start with the prefix, case-sensitively, and drops unnamed traces", () => {
    const kept = applyFilters(summaries, [agentFilter("agency-agent/")]).map((s) => s.traceId);
    expect(kept).toEqual(["A"]);
  });
  it("an empty prefix keeps every named trace", () => {
    expect(applyFilters(summaries, [agentFilter("")]).map((s) => s.traceId)).toEqual(["A", "B"]);
  });
  it("a name mentioned only in a prompt does not count", () => {
    const [summaryD] = traceSummaries(
      buildForest(
        traceEvents("D", {
          answer: "ok",
          toolOutput: "ok",
          ask: "run agency-agent/coordinator please",
        }),
      ),
      {},
    );
    expect(applyFilters([summaryD], [agentFilter("agency-agent")])).toEqual([]);
  });
});
