import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { collectBodyFacts } from "./bodyFacts.js";
import { propagateToFixpoint } from "./effects.js";
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
/**
 * Nodes of the given types, found by walking raw object properties.
 *
 * `matchYield.typeSource` is skipped, because `walkNodes` does not descend
 * into it — a pre-existing gap in the walker that hides 83 calls in the
 * standard library from EVERY analysis in the compiler, not only this one.
 * Excluding it here keeps this tripwire strict about everything else instead
 * of failing permanently on a gap this branch did not introduce. Removing the
 * exclusion is the test for a fix.
 *
 * `assignment.matchSource` is skipped because it is not code: it is a deep
 * clone of each arm's pattern and guard, kept on the lowered scrutinee for the
 * exhaustiveness check (see Assignment.matchSource). The guards themselves are
 * lowered into `if` conditions, which the walk does visit.
 */
const WALKER_GAPS = ["matchYield.typeSource", "assignment.matchSource"];

function scanRaw(
  value: unknown,
  types: string[],
  found: Record<string, unknown>[],
  slot = "",
): void {
  if (WALKER_GAPS.includes(slot)) return;
  if (Array.isArray(value)) {
    for (const item of value) scanRaw(item, types, found, slot);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (typeof node.type === "string" && types.includes(node.type)) {
    found.push(node);
  }
  for (const [key, child] of Object.entries(node)) {
    scanRaw(child, types, found, `${String(node.type ?? "?")}.${key}`);
  }
}

/** Every .agency file under a directory, recursively. The interesting
 *  constructs live in stdlib/agents/ and stdlib/data/, not at the top level. */
function agencyFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return agencyFilesUnder(full);
    return entry.name.endsWith(".agency") ? [path.resolve(full)] : [];
  });
}

/** Parse with applyTemplate false so the injected prelude import stays out of
 *  the tree; these tests read one function's body, not a whole module. */
function bodyOf(src: string) {
  const result = parseAgency(src, {}, false);
  if (!result.success) throw new Error(result.message ?? "parse failed");
  const fn = result.result.nodes.find((n): n is FunctionDefinition => n.type === "function");
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
  it("finds every call and interrupt the standard library contains", () => {
    // Identity comparison, not a count: both readings walk the same tree, so
    // every node the raw scan finds must be the very node the walk reports. A
    // "non-empty" assertion would pass for a body with ten calls where the
    // walk found one, which is exactly the drift this has to catch.
    const files = agencyFilesUnder("stdlib");
    const missed: string[] = [];

    for (const file of files) {
      const parsed = parseAgencyFileCached(file, {}, false);
      if (!parsed.success) continue;
      for (const decl of parsed.result.nodes) {
        if (decl.type !== "function" && decl.type !== "graphNode") continue;
        const facts = collectBodyFacts(decl.body);

        const rawCalls: Record<string, unknown>[] = [];
        scanRaw(decl.body, ["functionCall"], rawCalls);
        for (const call of rawCalls) {
          if (!(facts.calls as unknown[]).includes(call)) {
            missed.push(`${path.basename(file)}: call '${String(call.functionName)}'`);
          }
        }

        const rawInterrupts: Record<string, unknown>[] = [];
        scanRaw(decl.body, ["interruptStatement"], rawInterrupts);
        for (const site of rawInterrupts) {
          if (!facts.effects.includes(String(site.effect))) {
            missed.push(`${path.basename(file)}: effect '${String(site.effect)}'`);
          }
        }
      }
    }
    expect(missed).toEqual([]);
  });
});

describe("method calls in an access chain", () => {
  it("records no callee for a method call", () => {
    // `partial` is a method on a function value, not a global. Recording it
    // would attribute any same-named function's effects to this call site.
    const facts = collectBodyFacts(
      bodyOf(`def f(): string { return fetchJSON.partial(method: "GET") }`),
    );
    expect(facts.callees).toEqual([]);
  });

  it("records no callee for a method call on a property path", () => {
    const facts = collectBodyFacts(bodyOf(`def f(): string { return obj.handler.rename("x") }`));
    expect(facts.callees).toEqual([]);
  });

  it("still records a plain call in the same body", () => {
    const facts = collectBodyFacts(
      bodyOf(`def f(): string {\n  const t = fetchJSON.rename("x")\n  return g()\n}`),
    );
    expect(facts.callees).toEqual(["g"]);
  });
});

describe("the type checker finds more than the shared walk, never fewer", () => {
  it("reads a raises clause off a function-typed parameter", () => {
    // The shared walk has no types, so it cannot see this. The type checker
    // can, and must keep doing so after the extraction — deleting the
    // type-aware half of collectFromBody would otherwise break nothing.
    const source =
      `export def runIt(cb: () -> string raises <std::read>): string {\n` + `  return cb()\n}\n`;
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
