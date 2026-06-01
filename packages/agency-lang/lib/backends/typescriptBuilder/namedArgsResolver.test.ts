import { describe, expect, it } from "vitest";
import type { Expression, NamedArgument, SplatExpression } from "../../types.js";
import type { FunctionCall, FunctionParameter } from "../../types/function.js";
import { resolveNamedArgs } from "./namedArgsResolver.js";

// Tiny constructors so each test reads as a one-liner.
const num = (value: number): Expression =>
  ({ type: "number", value } as unknown as Expression);
const str = (value: string): Expression =>
  ({ type: "string", segments: [{ type: "text", value }] } as unknown as Expression);
const named = (name: string, value: Expression): NamedArgument =>
  ({ type: "namedArgument", name, value } as unknown as NamedArgument);

const param = (
  name: string,
  opts: Partial<FunctionParameter> = {},
): FunctionParameter => ({
  type: "functionParameter",
  name,
  ...opts,
});

const call = (
  args: (Expression | SplatExpression | NamedArgument)[],
  name = "f",
): FunctionCall =>
  ({
    type: "functionCall",
    functionName: name,
    arguments: args,
  } as unknown as FunctionCall);

describe("resolveNamedArgs", () => {
  it("returns args untouched when none are named", () => {
    const args = [num(1), num(2)];
    const result = resolveNamedArgs(call(args), [param("a"), param("b")], true);
    expect(result).toEqual(args);
  });

  it("reorders named args to match parameter order", () => {
    const result = resolveNamedArgs(
      call([named("b", num(2)), named("a", num(1))]),
      [param("a"), param("b")],
      true,
    );
    expect(result).toEqual([num(1), num(2)]);
  });

  it("accepts mixed positional + named when named come last", () => {
    const result = resolveNamedArgs(
      call([num(1), named("c", num(3)), named("b", num(2))]),
      [param("a"), param("b"), param("c")],
      true,
    );
    expect(result).toEqual([num(1), num(2), num(3)]);
  });

  it("inserts null placeholders for skipped optional params before a later named arg", () => {
    const defaultLit = num(0) as unknown as FunctionParameter["defaultValue"];
    const result = resolveNamedArgs(
      call([named("c", num(3))]),
      [
        param("a", { defaultValue: defaultLit }),
        param("b", { defaultValue: defaultLit }),
        param("c"),
      ],
      true,
    );
    expect(result).toEqual([{ type: "null" }, { type: "null" }, num(3)]);
  });

  it("omits trailing optional params with no later named arg", () => {
    const defaultLit = num(0) as unknown as FunctionParameter["defaultValue"];
    const result = resolveNamedArgs(
      call([named("a", num(1))]),
      [param("a"), param("b", { defaultValue: defaultLit })],
      true,
    );
    expect(result).toEqual([num(1)]);
  });

  it("ignores variadic params when matching named args, but accepts block-type params by name", () => {
    const blockParam = param("blk", {
      typeHint: { type: "blockType" } as unknown as FunctionParameter["typeHint"],
    });
    const variadicParam = param("rest", { variadic: true });
    // Variadic param is skipped — can't be filled by name.
    const result = resolveNamedArgs(
      call([named("a", num(1))]),
      [param("a"), variadicParam],
      true,
    );
    expect(result).toEqual([num(1)]);

    // Block-type param can be filled by name (function reference).
    const withBlockNamed = resolveNamedArgs(
      call([named("a", num(1)), named("blk", num(2))]),
      [param("a"), blockParam],
      true,
    );
    expect(withBlockNamed).toEqual([num(1), num(2)]);
  });

  it("throws on non-Agency function call with named args", () => {
    expect(() =>
      resolveNamedArgs(call([named("a", num(1))], "ext"), undefined, false),
    ).toThrow(/Named arguments can only be used with Agency-defined functions/);
  });

  it("throws on positional after named", () => {
    expect(() =>
      resolveNamedArgs(call([named("a", num(1)), num(2)]), [param("a"), param("b")], true),
    ).toThrow(/Positional argument cannot follow a named argument/);
  });

  it("throws on splat after named (covered by checker but locked in here too)", () => {
    const splat = (value: Expression): SplatExpression =>
      ({ type: "splat", value } as unknown as SplatExpression);
    expect(() =>
      resolveNamedArgs(
        call([named("a", num(1)), splat(num(0))]),
        [param("a"), param("b")],
        true,
      ),
    ).toThrow(/Positional argument cannot follow a named argument/);
  });

  it("throws on duplicate named arg", () => {
    expect(() =>
      resolveNamedArgs(
        call([named("a", num(1)), named("a", num(2))]),
        [param("a")],
        true,
      ),
    ).toThrow(/Duplicate named argument 'a'/);
  });

  it("throws on unknown named arg", () => {
    expect(() =>
      resolveNamedArgs(call([named("z", str("x"))]), [param("a")], true),
    ).toThrow(/Unknown named argument 'z'/);
  });

  it("throws when named arg conflicts with an already-positional slot", () => {
    expect(() =>
      resolveNamedArgs(
        call([num(1), named("a", num(2))]),
        [param("a"), param("b")],
        true,
      ),
    ).toThrow(/Named argument 'a' conflicts with positional argument/);
  });

  it("throws when a required parameter has neither positional nor named arg", () => {
    expect(() =>
      resolveNamedArgs(call([named("b", num(2))]), [param("a"), param("b")], true),
    ).toThrow(/Missing required argument 'a'/);
  });
});
