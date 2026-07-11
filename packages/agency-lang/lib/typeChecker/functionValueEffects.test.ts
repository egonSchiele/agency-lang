import { describe, it, expect } from "vitest";
import { pfaBaseName } from "./functionValueEffects.js";
import type { Expression } from "../types.js";

const va = (baseName: string, methods: string[]): Expression =>
  ({
    type: "valueAccess",
    base: { type: "variableName", value: baseName },
    chain: methods.map((m) => ({
      kind: "methodCall",
      functionCall: { type: "functionCall", functionName: m, arguments: [] },
    })),
  }) as unknown as Expression;

describe("pfaBaseName", () => {
  it("recovers the base name through a PFA chain", () => {
    expect(pfaBaseName(va("read", ["partial", "preapprove"]))).toBe("read");
  });
  it("recovers through describe/rename too", () => {
    expect(pfaBaseName(va("send", ["describe", "rename"]))).toBe("send");
  });
  it("null when a chain element is not a known method", () => {
    expect(pfaBaseName(va("read", ["partial", "frobnicate"]))).toBeNull();
  });
  it("null when the base is not a variable name", () => {
    expect(
      pfaBaseName({
        type: "valueAccess",
        base: { type: "functionCall", functionName: "f", arguments: [] },
        chain: [{ kind: "methodCall", functionCall: { type: "functionCall", functionName: "partial", arguments: [] } }],
      } as unknown as Expression),
    ).toBeNull();
  });
  it("null for a non-valueAccess", () => {
    expect(pfaBaseName({ type: "variableName", value: "x" } as unknown as Expression)).toBeNull();
  });
});
