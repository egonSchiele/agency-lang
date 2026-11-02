import { describe, expect, it } from "vitest";
import { AgencyGenerator } from "./agencyGenerator.js";
import type { AgencyProgram } from "../types.js";
import type { AccessChainElement } from "../types/access.js";

const call = (functionName: string) =>
  ({ type: "functionCall", functionName, arguments: [] }) as const;
const unwrap: AccessChainElement = { kind: "unwrap" };
const methodCall = (functionName: string): AccessChainElement => ({
  kind: "methodCall",
  functionCall: call(functionName) as any,
});
const access = (base: unknown, chain: AccessChainElement[]) => ({
  type: "valueAccess",
  base,
  chain,
});

function print(value: unknown): string {
  const program = {
    type: "agencyProgram",
    nodes: [{ type: "assignment", declKind: "const", variableName: "p", value }],
  } as unknown as AgencyProgram;
  return new AgencyGenerator().generate(program).output.trim();
}

describe("formatting the ? operator", () => {
  it("prints an unwrap after a call", () => {
    expect(print(access(call("foo"), [unwrap]))).toBe("const p = foo()?");
  });

  it("prints a chain with unwraps in order", () => {
    expect(
      print(access(call("a"), [unwrap, methodCall("b"), unwrap, methodCall("c"), unwrap])),
    ).toBe("const p = a()?.b()?.c()?");
  });
});
