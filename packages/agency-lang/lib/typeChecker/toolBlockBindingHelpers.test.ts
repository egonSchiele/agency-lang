/**
 * Spec 2026-06-03 Part 5.2 (last bullet): isolated unit tests for the
 * named helpers powering the tool-binding validator. A regression in a
 * helper used to be diffused across integration-level diagnostics; these
 * tests localize it.
 */
import { describe, expect, it } from "vitest";
import type { FunctionParameter } from "../types.js";
import type { VariableType } from "../types/typeHints.js";
import { isFunctionTyped } from "./utils.js";

const num: VariableType = { type: "primitiveType", value: "number" };
const str: VariableType = { type: "primitiveType", value: "string" };
const anyT: VariableType = { type: "primitiveType", value: "any" };
const blockNumberToNumber: VariableType = {
  type: "blockType",
  params: [{ name: "_0", typeAnnotation: num }],
  returnType: num,
};

const param = (
  name: string,
  typeHint?: VariableType,
  variadic = false,
): FunctionParameter => ({
  type: "functionParameter",
  name,
  variadic,
  typeHint,
});

describe("isFunctionTyped", () => {
  it("returns true for a direct block type", () => {
    expect(isFunctionTyped(param("block", blockNumberToNumber))).toBe(true);
  });

  it("returns true for a union containing a function arm", () => {
    expect(
      isFunctionTyped(
        param("block", { type: "unionType", types: [blockNumberToNumber, str] }),
      ),
    ).toBe(true);
  });

  it("returns true for a variadic whose element type is a function", () => {
    expect(
      isFunctionTyped(
        param(
          "handlers",
          { type: "arrayType", elementType: blockNumberToNumber },
          true,
        ),
      ),
    ).toBe(true);
  });

  it("returns false for a plain primitive type", () => {
    expect(isFunctionTyped(param("a", num))).toBe(false);
  });

  it("returns false for a plain variadic of numbers", () => {
    expect(
      isFunctionTyped(
        param("xs", { type: "arrayType", elementType: num }, true),
      ),
    ).toBe(false);
  });

  it("returns false for `any` (documented limitation)", () => {
    expect(isFunctionTyped(param("a", anyT))).toBe(false);
  });

  it("returns false for an untyped (no hint) param", () => {
    expect(isFunctionTyped(param("a"))).toBe(false);
  });

  it("treats nested unions transparently", () => {
    expect(
      isFunctionTyped(
        param("block", {
          type: "unionType",
          types: [
            { type: "unionType", types: [blockNumberToNumber, num] },
            str,
          ],
        }),
      ),
    ).toBe(true);
  });
});
