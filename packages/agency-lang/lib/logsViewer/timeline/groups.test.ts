import { describe, expect, it } from "vitest";

import { buildTreeIndex } from "../forest.js";
import { leaf, span, trace } from "./fixture.js";
import { timelineSpans } from "./spans.js";
import {
  groupKeyOf,
  groupSpans,
  spanDisplayName,
  scopeThreadLabels,
  threadScopeOf,
  unambiguousThreadLabels,
} from "./groups.js";

const opts = { hideKinds: [] as string[] };

function llm(id: string, at: number, data: Record<string, unknown> = {}) {
  return span("llmCall", [leaf("promptCompletion", at, { model: '"m1"', ...data })], { id });
}

describe("spanDisplayName", () => {
  it("tools show the tool name, nodes the node name, llm the model, others the kind", () => {
    expect(
      spanDisplayName(span("toolExecution", [leaf("toolCallStart", 1, { toolName: "bash" })])),
    ).toBe("bash");
    expect(spanDisplayName(span("nodeExecution", [leaf("enterNode", 1, { nodeId: "main" })]))).toBe(
      "node main",
    );
    expect(spanDisplayName(llm("a", 1))).toBe("llm(m1)");
    expect(spanDisplayName(span("forkAll", [leaf("forkStart", 1)]))).toBe("forkAll");
  });
});

describe("groupKeyOf", () => {
  it("llm groups by thread label when one exists", () => {
    const t = trace([
      leaf("threadCreated", 0, { threadId: "7", label: "codingAgent" }),
      llm("a", 100, { threadId: "7" }),
    ]);
    expect(groupKeyOf("a", t)).toBe("llm(codingAgent)");
  });

  it("falls back to the enclosing function, then the model", () => {
    const enclosed = llm("b", 100, { threadId: "9" });
    const tool = span("toolExecution", [
      leaf("toolCallStart", 50, { toolName: "codeAgent" }),
      enclosed,
    ]);
    const bare = llm("c", 200, { threadId: "9" });
    const t = trace([tool, bare]);
    expect(groupKeyOf("b", t)).toBe("llm(codeAgent)");
    expect(groupKeyOf("c", t)).toBe("llm(m1)");
  });

  it("thread labels are scoped per process subtree (the id-1 collision)", () => {
    const innerLlm = llm("inner", 500, { threadId: "1" });
    const sub = span("subprocessRun", [
      leaf("subprocessStarted", 100),
      leaf("threadCreated", 110, { threadId: "1", label: "sub" }),
      innerLlm,
      leaf("subprocessEnd", 600),
    ]);
    const outerLlm = llm("outer", 900, { threadId: "1" });
    const t = trace([leaf("threadCreated", 0, { threadId: "1", label: "main" }), sub, outerLlm]);
    expect(groupKeyOf("inner", t)).toBe("llm(sub)");
    expect(groupKeyOf("outer", t)).toBe("llm(main)");
  });

  it("nested subprocesses: the outer scope does not see the inner scope labels", () => {
    const deepLlm = llm("deep", 400, { threadId: "1" });
    const innerSub = span("subprocessRun", [
      leaf("subprocessStarted", 200),
      leaf("threadCreated", 210, { threadId: "1", label: "deepest" }),
      deepLlm,
      leaf("subprocessEnd", 450),
    ]);
    const midLlm = llm("mid", 500, { threadId: "1" });
    const outerSub = span("subprocessRun", [
      leaf("subprocessStarted", 100),
      leaf("threadCreated", 110, { threadId: "1", label: "mid-scope" }),
      innerSub,
      midLlm,
      leaf("subprocessEnd", 600),
    ]);
    const t = trace([outerSub]);
    expect(groupKeyOf("deep", t)).toBe("llm(deepest)");
    expect(groupKeyOf("mid", t)).toBe("llm(mid-scope)");
  });

  it("the follow-mode re-grouping race: a late threadCreated changes the key", () => {
    const call = llm("x", 100, { threadId: "4" });
    const before = trace([call]);
    expect(groupKeyOf("x", before)).toBe("llm(m1)");
    const call2 = llm("x", 100, { threadId: "4" });
    const after = trace([call2, leaf("threadCreated", 150, { threadId: "4", label: "late" })]);
    expect(groupKeyOf("x", after)).toBe("llm(late)");
  });

  it("non-llm spans group by display name", () => {
    const tool = span("toolExecution", [leaf("toolCallStart", 1, { toolName: "bash" })], {
      id: "t1",
    });
    const t = trace([tool]);
    expect(groupKeyOf("t1", t)).toBe("bash");
  });
});

describe("groupSpans", () => {
  it("sums member self-time, dedupes models, sorts by total desc", () => {
    const a = llm("a", 1_000, { threadId: "7", timeTaken: 1_000 });
    const b = llm("b", 3_000, { threadId: "7", timeTaken: 500, model: '"m2"' });
    const tool = span(
      "toolExecution",
      [
        leaf("toolCallStart", 100, { toolName: "bash" }),
        leaf("toolCall", 200, { toolName: "bash" }),
      ],
      { id: "t" },
    );
    const t = trace([leaf("threadCreated", 0, { threadId: "7", label: "agent" }), a, b, tool]);
    const groups = groupSpans(timelineSpans(t, opts), t);
    expect(groups[0].key).toBe("llm(agent)");
    expect(groups[0].count).toBe(2);
    expect(groups[0].totalSelfMs).toBe(1_500);
    expect(groups[0].models).toEqual(["m1", "m2"]);
    expect(groups[1].key).toBe("bash");
  });

  it("parallel shares may exceed 100% — spec v2.1: true compute time, not the nesting bug", () => {
    const branchA = llm("a", 10_000, { timeTaken: 10_000 });
    const branchB = llm("b", 10_000, { timeTaken: 10_000 });
    const fork = span("forkAll", [leaf("forkStart", 0), branchA, branchB]);
    const t = trace([fork]);
    const groups = groupSpans(timelineSpans(t, opts), t);
    const llmGroup = groups.find((g) => g.key === "llm(m1)")!;
    expect(llmGroup.share).toBeCloseTo(2.0);
  });
});

describe("threadScopeOf", () => {
  it("is the nearest enclosing subprocess, else the trace", () => {
    const inner = llm("inner", 300, { threadId: "1" });
    const sub = span("subprocessRun", [leaf("subprocessStarted", 200), inner], { id: "sub" });
    const outer = llm("outer", 100, { threadId: "1" });
    const root = trace([outer, sub]);
    const index = buildTreeIndex(root);
    expect(threadScopeOf(inner, index).id).toBe("sub");
    expect(threadScopeOf(outer, index).id).toBe("trace-T");
  });
});

describe("unambiguousThreadLabels", () => {
  it("returns a label for one creation", () => {
    const root = trace([leaf("threadCreated", 0, { threadId: "0", label: "main" })]);
    expect(unambiguousThreadLabels(root, Object.create(null))["0"]).toBe("main");
  });

  it("omits a reused local id", () => {
    const root = trace([
      leaf("threadCreated", 0, { threadId: "0", label: "first" }),
      leaf("threadCreated", 1, { threadId: "0", label: "second" }),
    ]);
    expect(unambiguousThreadLabels(root, Object.create(null))["0"]).toBeUndefined();
  });

  it("does not count a nested subprocess creation in its parent scope", () => {
    const sub = span(
      "subprocessRun",
      [leaf("threadCreated", 1, { threadId: "0", label: "child" })],
      { id: "sub" },
    );
    const root = trace([leaf("threadCreated", 0, { threadId: "0", label: "parent" }), sub]);
    expect(unambiguousThreadLabels(root, Object.create(null))["0"]).toBe("parent");
  });
});

describe("scope label caches", () => {
  it.each([true, false])(
    "keeps last and unambiguous labels separate (last first: %s)",
    (lastFirst) => {
      const root = trace([
        leaf("threadCreated", 0, { threadId: "0", label: "first" }),
        leaf("threadCreated", 1, { threadId: "0", label: "second" }),
      ]);
      const cache = Object.create(null);
      if (lastFirst) {
        scopeThreadLabels(root, cache);
      } else {
        unambiguousThreadLabels(root, cache);
      }
      expect(scopeThreadLabels(root, cache)["0"]).toBe("second");
      expect(unambiguousThreadLabels(root, cache)["0"]).toBeUndefined();
    },
  );

  it("does not traverse nested subprocess contents when scanning a scope", () => {
    const sub = span("subprocessRun", [], { id: "sub" });
    const root = trace([leaf("threadCreated", 0, { threadId: "0", label: "parent" }), sub]);
    Object.defineProperty(sub, "children", {
      get() {
        throw new Error("outside scope");
      },
    });
    expect(scopeThreadLabels(root, Object.create(null))["0"]).toBe("parent");
    expect(unambiguousThreadLabels(root, Object.create(null))["0"]).toBe("parent");
  });
});
