import { describe, expect, it } from "vitest";
import { tagArgToTs } from "./tagArgToTs.js";
import type { Expression } from "../../types.js";

const ident = (name: string): Expression =>
  ({ type: "variableName", value: name }) as any;
const nm = (n: string): Expression => ({ type: "number", value: n }) as any;

describe("tagArgToTs — value-param unsubstituted guard", () => {
  it("throws when an identifier matches a declared value-param name", () => {
    expect(() => tagArgToTs(ident("low"), ["low", "high"])).toThrow(
      /value param 'low' left unsubstituted/,
    );
  });

  it("throws when an identifier inside an object value matches a value param", () => {
    const e: Expression = {
      type: "agencyObject",
      entries: [{ key: "minimum", value: ident("low") }],
    } as any;
    expect(() => tagArgToTs(e, ["low"])).toThrow(
      /value param 'low' left unsubstituted/,
    );
  });

  it("throws when a value-param ident appears inside a PFA method-call arg", () => {
    const pfa: Expression = {
      type: "valueAccess",
      base: ident("min"),
      chain: [
        {
          kind: "methodCall",
          functionCall: {
            type: "functionCall",
            functionName: "partial",
            arguments: [
              { type: "namedArgument", name: "n", value: ident("low") },
            ],
          },
        },
      ],
    } as any;
    expect(() => tagArgToTs(pfa, ["low"])).toThrow(
      /value param 'low' left unsubstituted/,
    );
  });

  it("does not throw on non-param identifiers", () => {
    expect(tagArgToTs(ident("isEmail"), ["low"])).toBe("isEmail");
  });

  it("default mode (no param list) accepts any identifier without throwing", () => {
    expect(tagArgToTs(ident("low"))).toBe("low");
  });

  it("preserves literal printing behavior", () => {
    expect(tagArgToTs(nm("42"))).toBe("42");
  });
});
