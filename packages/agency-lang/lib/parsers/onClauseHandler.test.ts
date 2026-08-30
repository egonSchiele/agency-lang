import { describe, it, expect } from "vitest";
import {
  liftTailVerdicts,
  completeClause,
  buildOnClauseHandler,
  type ParsedOnClause,
} from "./onClauseHandler.js";
import { handleBlockParser } from "./parsers.js";
import { normalizeCode } from "@/index.js";
import type { AgencyNode } from "@/types.js";
import type { MatchBlock, MatchBlockCase } from "@/types/matchBlock.js";
// `toEqualWithoutLoc` is a custom matcher registered by
// lib/parsers/vitest.setup.ts — available for free in any lib/parsers/*.test.ts.

const call = (name: string): AgencyNode =>
  ({ type: "functionCall", functionName: name, arguments: [] }) as AgencyNode;
const ret = (name: string): AgencyNode =>
  ({ type: "returnStatement", value: call(name) }) as AgencyNode;

describe("liftTailVerdicts", () => {
  it("lifts a trailing bare verdict call to a return", () => {
    expect(liftTailVerdicts([call("approve")])).toEqual([ret("approve")]);
  });

  it("leaves an explicit return untouched", () => {
    expect(liftTailVerdicts([ret("reject")])).toEqual([ret("reject")]);
  });

  it("leaves a non-tail verdict call as a call", () => {
    const body = [call("pass"), call("approve")];
    expect(liftTailVerdicts(body)).toEqual([call("pass"), ret("approve")]);
  });

  it("descends into a trailing if/else, both branches", () => {
    const body: AgencyNode[] = [
      {
        type: "ifElse",
        condition: { type: "boolean", value: true },
        thenBody: [call("approve")],
        elseBody: [call("reject")],
      } as AgencyNode,
    ];
    const out = liftTailVerdicts(body);
    const first = out[0] as { thenBody: AgencyNode[]; elseBody: AgencyNode[] };
    expect(first.thenBody).toEqual([ret("approve")]);
    expect(first.elseBody).toEqual([ret("reject")]);
  });

  it("descends into an else-less trailing if — the spec's clause-completion shape", () => {
    const body: AgencyNode[] = [
      {
        type: "ifElse",
        condition: { type: "boolean", value: true },
        thenBody: [call("approve")],
      } as AgencyNode,
    ];
    const out = liftTailVerdicts(body);
    const first = out[0] as { thenBody: AgencyNode[]; elseBody?: AgencyNode[] };
    expect(first.thenBody).toEqual([ret("approve")]);
    expect(first.elseBody).toBeUndefined();
  });

  it("does NOT descend into a trailing match", () => {
    const body: AgencyNode[] = [
      { type: "matchBlock", expression: call("x"), cases: [] } as AgencyNode,
    ];
    expect(liftTailVerdicts(body)).toEqual(body);
  });
});

const retPass: AgencyNode = { type: "returnStatement", value: call("pass") } as AgencyNode;

describe("completeClause", () => {
  it("appends return pass() to a side-effect-only clause", () => {
    const body = [call("log")];
    expect(completeClause(body)).toEqual([call("log"), retPass]);
  });

  it("appends return pass() to an if with no else", () => {
    const body: AgencyNode[] = [
      {
        type: "ifElse",
        condition: { type: "boolean", value: true },
        thenBody: [ret("approve")],
      } as AgencyNode,
    ];
    expect(completeClause(body)).toEqual([...body, retPass]);
  });

  it("leaves a clause that already returns on every path unchanged", () => {
    expect(completeClause([ret("approve")])).toEqual([ret("approve")]);
  });

  it("leaves an if/else that returns on both branches unchanged", () => {
    const body: AgencyNode[] = [
      {
        type: "ifElse",
        condition: { type: "boolean", value: true },
        thenBody: [ret("approve")],
        elseBody: [ret("reject")],
      } as AgencyNode,
    ];
    expect(completeClause(body)).toEqual(body);
  });
});

describe("buildOnClauseHandler", () => {
  it("builds the same handler as the canonical hand-written form", () => {
    // on std::read(data) { approve() }   on _ { reject() }
    const clauses: ParsedOnClause[] = [
      {
        effect: "std::read",
        binding: "data",
        body: [{ type: "functionCall", functionName: "approve", arguments: [] } as AgencyNode],
      },
      {
        effect: null,
        binding: null,
        body: [{ type: "functionCall", functionName: "reject", arguments: [] } as AgencyNode],
      },
    ];
    const built = buildOnClauseHandler(clauses);

    const canonical = handleBlockParser(
      normalizeCode(
        "handle {\n  foo()\n} with (intr) {\n" +
          "  return match (intr.effect) {\n" +
          '    "std::read" => {\n      const data = intr.data\n      return approve()\n    }\n' +
          "    _ => return reject()\n" +
          "  }\n}",
      ),
    );
    expect(canonical.success).toBe(true);
    if (!canonical.success) return;
    expect(built).toEqualWithoutLoc(canonical.result.handler);
  });

  it("appends _ => pass() when no on _ is given", () => {
    const clauses: ParsedOnClause[] = [
      {
        effect: "std::read",
        binding: null,
        body: [
          {
            type: "returnStatement",
            value: { type: "functionCall", functionName: "approve", arguments: [] },
          } as AgencyNode,
        ],
      },
    ];
    const built = buildOnClauseHandler(clauses);
    if (built.kind !== "inline") throw new Error("expected inline handler");
    const returnStmt = built.body[0] as { value: MatchBlock };
    const match = returnStmt.value;
    const lastArm = match.cases[match.cases.length - 1] as MatchBlockCase;
    expect(lastArm.caseValue).toBe("_");
    expect(lastArm.body).toEqual([
      {
        type: "returnStatement",
        value: { type: "functionCall", functionName: "pass", arguments: [] },
      },
    ]);
  });
});
