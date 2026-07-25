import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { collectBodyFacts, propagateToFixpoint } from "./effects.js";
import type { FunctionDefinition } from "../types/function.js";
import * as fs from "fs";
import * as path from "path";
import { parseAgencyFileCached } from "../parseCache.js";
import { getEffectsFromFile } from "../compiler/typecheck.js";
import { makeAgencyTempDir } from "../utils/agencyTempDir.js";
import { safeDeleteDirectory } from "../utils.js";

/** Find nodes of the given types by walking raw object properties. Deliberately
 *  not walkNodes: the point is a second opinion about what is in the tree, so
 *  that a gap in walkNodes's hand-written descent shows up as a disagreement
 *  rather than as silence. */
function scanRaw(value: unknown, types: string[], found: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) scanRaw(item, types, found);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (typeof node.type === "string" && types.includes(node.type)) {
    found.push(node.type);
  }
  for (const child of Object.values(node)) scanRaw(child, types, found);
}

/** Parse with applyTemplate false so the injected prelude import stays out of
 *  the tree; these tests read one function's body, not a whole module. */
function bodyOf(src: string) {
  const result = parseAgency(src, {}, false);
  if (!result.success) throw new Error(result.message ?? "parse failed");
  const fn = result.result.nodes.find(
    (n): n is FunctionDefinition => n.type === "function",
  );
  if (!fn) throw new Error("no function in source");
  return fn.body;
}

describe("collectBodyFacts", () => {
  const cases: {
    label: string;
    src: string;
    effects: string[];
    callees: string[];
  }[] = [
    {
      label: "a literal interrupt",
      src: `def f(): string { return interrupt std::read("?", {}) }`,
      effects: ["std::read"],
      callees: [],
    },
    {
      label: "a plain call",
      src: `def f(): string { return g("x") }`,
      effects: [],
      callees: ["g"],
    },
    {
      label: "a goto target",
      src: `def f(): string { goto other() }`,
      effects: [],
      callees: ["other"],
    },
    {
      label: "a guard block, which lowers to _guard later",
      src: `def f(): string {\n  const r = guard(cost: $0.50) {\n    return "hi"\n  }\n  return "done"\n}`,
      effects: [],
      callees: ["_guard"],
    },
    {
      label: "a guard block whose body also calls something",
      src: `def f(): string {\n  const r = guard(cost: $0.50) {\n    return read("x")\n  }\n  return "done"\n}`,
      effects: [],
      callees: ["_guard", "read"],
    },
    {
      label: "the same callee twice",
      src: `def f(): string {\n  g("a")\n  g("b")\n  return ""\n}`,
      effects: [],
      callees: ["g"],
    },
    {
      label: "a call nested three levels deep",
      src: `def f(): string {\n  if (true) {\n    while (false) {\n      for (x in [1]) {\n        g("deep")\n      }\n    }\n  }\n  return ""\n}`,
      effects: [],
      callees: ["g"],
    },
    {
      label: "a call in argument position",
      src: `def f(): string { return outer(inner("x")) }`,
      effects: [],
      callees: ["outer", "inner"],
    },
    {
      label: "a call inside an array literal",
      src: `def f(): string {\n  const xs = [g("a")]\n  return ""\n}`,
      effects: [],
      callees: ["g"],
    },
    {
      label: "a call inside string interpolation",
      src: 'def f(): string { return `value: ${g("a")}` }',
      effects: [],
      callees: ["g"],
    },
  ];

  for (const { label, src, effects, callees } of cases) {
    it(`reads ${label}`, () => {
      const facts = collectBodyFacts(bodyOf(src));
      expect(facts.effects.sort()).toEqual([...effects].sort());
      expect(facts.callees.sort()).toEqual([...callees].sort());
    });
  }

  it("returns each call node so callers can inspect arguments", () => {
    const facts = collectBodyFacts(bodyOf(`def f(): string { return g("x") }`));
    expect(facts.calls.map((call) => call.functionName)).toEqual(["g"]);
  });
});

describe("propagateToFixpoint", () => {
  it("carries an effect along a chain of three", () => {
    const settled = propagateToFixpoint({
      a: { effects: [], calleeKeys: ["b"] },
      b: { effects: [], calleeKeys: ["c"] },
      c: { effects: ["std::read"], calleeKeys: [] },
    });
    expect(settled.a.effects).toEqual(["std::read"]);
  });

  it("does not push an effect backwards from caller to callee", () => {
    const settled = propagateToFixpoint({
      caller: { effects: ["std::read"], calleeKeys: ["callee"] },
      callee: { effects: [], calleeKeys: [] },
    });
    expect(settled.callee.effects).toEqual([]);
  });

  it("does not union unrelated entries", () => {
    const settled = propagateToFixpoint({
      one: { effects: ["std::read"], calleeKeys: [] },
      two: { effects: [], calleeKeys: [] },
    });
    expect(settled.two.effects).toEqual([]);
  });

  it("terminates on a cycle", () => {
    const settled = propagateToFixpoint({
      a: { effects: [], calleeKeys: ["b"] },
      b: { effects: ["std::exec"], calleeKeys: ["a"] },
    });
    expect(settled.a.effects).toEqual(["std::exec"]);
    expect(settled.b.effects).toEqual(["std::exec"]);
  });

  it("ignores a callee key with no entry", () => {
    const settled = propagateToFixpoint({
      a: { effects: [], calleeKeys: ["missing"] },
    });
    expect(settled.a.effects).toEqual([]);
  });
});

describe("the walk sees everything a raw scan sees", () => {
  it("finds calls and interrupts in every standard library body that has them", () => {
    const types = ["functionCall", "interruptStatement", "guardBlock"];
    const files = fs
      .readdirSync("stdlib")
      .filter((name) => name.endsWith(".agency"))
      .map((name) => path.resolve("stdlib", name));

    const disagreements: string[] = [];
    for (const file of files) {
      const parsed = parseAgencyFileCached(file, {}, false);
      if (!parsed.success) continue;
      for (const decl of parsed.result.nodes) {
        if (decl.type !== "function" && decl.type !== "graphNode") continue;
        const raw: string[] = [];
        scanRaw(decl.body, types, raw);
        if (raw.length === 0) continue;
        const facts = collectBodyFacts(decl.body);
        if (facts.calls.length + facts.effects.length === 0) {
          disagreements.push(
            `${path.basename(file)}: a body with ${raw.length} call-bearing nodes read as empty`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});

describe("the .invoke() call form", () => {
  it("records the receiver, not the method name", () => {
    const facts = collectBodyFacts(
      bodyOf(`def f(): string { return read.invoke("x") }`),
    );
    expect(facts.callees).toEqual(["read"]);
  });

  it("records the receiver when invoke follows another chain link", () => {
    // `f.partial(...)` and `f.rename(...)` are ordinary Agency, so invoke is
    // often not the first link. tests/agency-js/http-post/agent.agency:28
    const facts = collectBodyFacts(
      bodyOf(`def f(): string { return fetchJSON.partial(method: "GET").invoke() }`),
    );
    expect(facts.callees).toEqual(["fetchJSON"]);
  });

  it("attributes nothing when the receiver is not a plain variable", () => {
    // obj.handler.invoke() calls whatever obj.handler holds, which needs types.
    // Attributing it to obj would be wrong, not merely imprecise.
    const facts = collectBodyFacts(
      bodyOf(`def f(): string { return obj.handler.invoke("x") }`),
    );
    expect(facts.callees).toEqual([]);
  });
});

describe("the type checker finds more than the shared walk, never fewer", () => {
  it("reads a raises clause off a function-typed parameter", () => {
    // The shared walk has no types, so it cannot see this. The type checker
    // can, and must keep doing so after the extraction — deleting the
    // type-aware half of collectFromBody would otherwise break nothing.
    const source =
      `export def runIt(cb: () -> string raises <std::read>): string {\n` +
      `  return cb()\n}\n`;
    expect(collectBodyFacts(bodyOf(source)).effects).toEqual([]);

    const dir = makeAgencyTempDir("invariant");
    try {
      const entry = path.join(dir, "main.agency");
      fs.writeFileSync(entry, source, "utf-8");
      expect(getEffectsFromFile(entry)["runIt"]).toContain("std::read");
    } finally {
      safeDeleteDirectory(dir, false);
    }
  });
});
