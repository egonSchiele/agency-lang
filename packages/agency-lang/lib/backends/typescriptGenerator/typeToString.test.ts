import { describe, it, expect } from "vitest";
import { variableTypeToString } from "./typeToString.js";
import type { VariableType } from "../../types.js";

describe("variableTypeToString: genericType", () => {
  it("renders Record<string, number>", () => {
    const t: VariableType = {
      type: "genericType",
      name: "Record",
      typeArgs: [
        { type: "primitiveType", value: "string" },
        { type: "primitiveType", value: "number" },
      ],
    };
    expect(variableTypeToString(t, {})).toBe("Record<string, number>");
  });

  it("renders user-defined generics like Container<T>", () => {
    const t: VariableType = {
      type: "genericType",
      name: "Container",
      typeArgs: [{ type: "primitiveType", value: "string" }],
    };
    expect(variableTypeToString(t, {})).toBe("Container<string>");
  });

  it("renders nested generics", () => {
    const t: VariableType = {
      type: "genericType",
      name: "Record",
      typeArgs: [
        { type: "primitiveType", value: "string" },
        {
          type: "genericType",
          name: "Record",
          typeArgs: [
            { type: "primitiveType", value: "string" },
            { type: "primitiveType", value: "number" },
          ],
        },
      ],
    };
    expect(variableTypeToString(t, {})).toBe(
      "Record<string, Record<string, number>>",
    );
  });

  it("renders generics with multiple args", () => {
    const t: VariableType = {
      type: "genericType",
      name: "Pair",
      typeArgs: [
        { type: "primitiveType", value: "string" },
        { type: "primitiveType", value: "number" },
      ],
    };
    expect(variableTypeToString(t, {})).toBe("Pair<string, number>");
  });
});
