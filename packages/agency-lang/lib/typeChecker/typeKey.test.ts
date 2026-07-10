import { describe, it, expect } from "vitest";
import { typeKey } from "./typeKey.js";
import { uniteTypes } from "./flow.js";
import { typecheckSource } from "./testUtils.js";
import type { VariableType, TypeAliasEntry } from "../types.js";

const STR: VariableType = { type: "primitiveType", value: "string" };
const NUM: VariableType = { type: "primitiveType", value: "number" };
const NO_ALIASES: Record<string, TypeAliasEntry> = {};

function treeAliases(name: string): Record<string, TypeAliasEntry> {
  return {
    [name]: {
      body: {
        type: "objectType",
        properties: [
          { key: "value", value: NUM },
          {
            key: "children",
            value: {
              type: "arrayType",
              elementType: { type: "typeAliasVariable", aliasName: name },
            },
          },
        ],
      },
    },
  };
}

describe("typeKey", () => {
  it("is property-order insensitive", () => {
    const ab: VariableType = {
      type: "objectType",
      properties: [
        { key: "a", value: STR },
        { key: "b", value: NUM },
      ],
    };
    const ba: VariableType = {
      type: "objectType",
      properties: [
        { key: "b", value: NUM },
        { key: "a", value: STR },
      ],
    };
    expect(typeKey(ab, NO_ALIASES)).toBe(typeKey(ba, NO_ALIASES));
  });

  it("is union-member-order insensitive", () => {
    const ab: VariableType = { type: "unionType", types: [STR, NUM] };
    const ba: VariableType = { type: "unionType", types: [NUM, STR] };
    expect(typeKey(ab, NO_ALIASES)).toBe(typeKey(ba, NO_ALIASES));
  });

  it("ignores tags, trivia, descriptions, and effect-set flags", () => {
    const plainObj: VariableType = {
      type: "objectType",
      properties: [{ key: "a", value: STR }],
    };
    const decoratedObj: VariableType = {
      type: "objectType",
      properties: [
        {
          key: "a",
          value: {
            type: "primitiveType",
            value: "string",
            tags: [{ type: "tag", name: "validate", arguments: [] }],
          },
          description: "described",
        },
      ],
      trivia: [{ anchorIndex: 0, comments: [] }],
    };
    expect(typeKey(decoratedObj, NO_ALIASES)).toBe(typeKey(plainObj, NO_ALIASES));
    const union: VariableType = { type: "unionType", types: [STR, NUM] };
    const effectUnion: VariableType = {
      type: "unionType",
      types: [STR, NUM],
      isEffectSet: true,
    };
    expect(typeKey(effectUnion, NO_ALIASES)).toBe(typeKey(union, NO_ALIASES));
  });

  it("resolves a top-level alias one step so alias and body key equal", () => {
    const aliases: Record<string, TypeAliasEntry> = { Age: { body: NUM } };
    const ref: VariableType = { type: "typeAliasVariable", aliasName: "Age" };
    expect(typeKey(ref, aliases)).toBe(typeKey(NUM, aliases));
  });

  it("keeps NESTED alias refs nominal: {a: AgeRef} differs from {a: number}", () => {
    const aliases: Record<string, TypeAliasEntry> = { Age: { body: NUM } };
    const nominal: VariableType = {
      type: "objectType",
      properties: [{ key: "a", value: { type: "typeAliasVariable", aliasName: "Age" } }],
    };
    const structural: VariableType = {
      type: "objectType",
      properties: [{ key: "a", value: NUM }],
    };
    expect(typeKey(nominal, aliases)).not.toBe(typeKey(structural, aliases));
  });

  it("keys a recursive alias without looping, and DIFFERENT recursive aliases key differently", () => {
    const aliases = { ...treeAliases("Tree"), ...treeAliases("Tree2") };
    const tree: VariableType = { type: "typeAliasVariable", aliasName: "Tree" };
    const tree2: VariableType = { type: "typeAliasVariable", aliasName: "Tree2" };
    // Same shape, different names: inner refs are nominal, so keys differ.
    expect(typeKey(tree, aliases)).not.toBe(typeKey(tree2, aliases));
  });

  it("distinguishes value-param instantiations (valueArgs are identity)", () => {
    const age18: VariableType = {
      type: "typeAliasVariable",
      aliasName: "Age",
      valueArgs: [{ type: "number", value: "18" }],
    };
    const age21: VariableType = {
      type: "typeAliasVariable",
      aliasName: "Age",
      valueArgs: [{ type: "number", value: "21" }],
    };
    // Unknown alias — stays nominal; the valueArgs must still distinguish.
    expect(typeKey(age18, NO_ALIASES)).not.toBe(typeKey(age21, NO_ALIASES));
  });

  it("distinguishes genuinely different types", () => {
    expect(typeKey(STR, NO_ALIASES)).not.toBe(typeKey(NUM, NO_ALIASES));
    const arr: VariableType = { type: "arrayType", elementType: STR };
    expect(typeKey(arr, NO_ALIASES)).not.toBe(typeKey(STR, NO_ALIASES));
  });
});

describe("typeKey adoption at the dedup sites", () => {
  it("uniteTypes dedups property-order-flipped members to ONE (pins the flow.ts wiring)", () => {
    // Direct pin: reverting uniteTypes to raw JSON.stringify keying makes
    // this return a 2-member union. (A pipeline-level observable proved
    // unreachable: assignability is already order-insensitive and the
    // assignment diagnostic renders the declared scope type, not the
    // join — verified during execution.)
    const objAB: VariableType = {
      type: "objectType",
      properties: [
        { key: "a", value: NUM },
        { key: "b", value: NUM },
      ],
    };
    const objBA: VariableType = {
      type: "objectType",
      properties: [
        { key: "b", value: NUM },
        { key: "a", value: NUM },
      ],
    };
    const joined = uniteTypes([objAB, objBA], NO_ALIASES);
    expect(joined).toEqual(objAB);
  });

  it("a joined branch-reassignment program typechecks clean (general regression)", () => {
    const errors = typecheckSource(`
def f(flag: boolean): number {
  let x = { a: 1, b: 2 }
  if (flag) {
    x = { b: 2, a: 1 }
  }
  const n: number = x
  return n
}
node main() {
  return f(true)
}
`);
    const msg = errors.map((e) => e.message).join("\n");
    expect(msg).toMatch(/not assignable/);
    expect(msg).not.toMatch(/\|/);
  });
});
