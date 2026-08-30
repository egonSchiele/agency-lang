import { describe, it, expect } from "vitest";
import { liftTailVerdicts, completeClause } from "./onClauseHandler.js";
import type { AgencyNode } from "@/types.js";

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
    const out = liftTailVerdicts(body) as [{ thenBody: AgencyNode[]; elseBody: AgencyNode[] }];
    expect(out[0].thenBody).toEqual([ret("approve")]);
    expect(out[0].elseBody).toEqual([ret("reject")]);
  });

  it("descends into an else-less trailing if — the spec's clause-completion shape", () => {
    const body: AgencyNode[] = [
      {
        type: "ifElse",
        condition: { type: "boolean", value: true },
        thenBody: [call("approve")],
      } as AgencyNode,
    ];
    const out = liftTailVerdicts(body) as [{ thenBody: AgencyNode[]; elseBody?: AgencyNode[] }];
    expect(out[0].thenBody).toEqual([ret("approve")]);
    expect(out[0].elseBody).toBeUndefined();
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
