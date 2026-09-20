import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { isReservedInternalName } from "../reservedNames.js";
import { BUILTIN_VARIABLES } from "../config/config.js";

const RESERVED = "reserved for the compiler";

function messageFor(source: string): string | null {
  const result = parseAgency(source);
  return result.success ? null : (result.message ?? "");
}

describe("isReservedInternalName", () => {
  it("reserves names starting with two underscores", () => {
    expect(isReservedInternalName("__ctx")).toBe(true);
    expect(isReservedInternalName("__matchval_1")).toBe(true);
    expect(isReservedInternalName("__")).toBe(true);
  });

  it("allows ordinary names, including one leading underscore", () => {
    expect(isReservedInternalName("x")).toBe(false);
    expect(isReservedInternalName("_private")).toBe(false);
    expect(isReservedInternalName("a__b")).toBe(false);
  });

  it("knows every builtin variable that starts with two underscores", () => {
    const internal = BUILTIN_VARIABLES.filter((name) => name.startsWith("__"));
    expect(internal.length).toBeGreaterThan(0);
    for (const name of internal) {
      expect(isReservedInternalName(name)).toBe(false);
    }
  });

  it("allows hygienic renames", () => {
    expect(isReservedInternalName("__hyg12_tmp")).toBe(false);
    expect(isReservedInternalName("__hygiene")).toBe(true);
  });
});

describe("the parser refuses reserved names", () => {
  const refused: Record<string, string> = {
    "a const declaration": `node main() {\n  const __x = 1\n}\n`,
    "a let declaration": `node main() {\n  let __x = 1\n}\n`,
    "a top-level const": `const __x = 1\n`,
    "a reassignment": `node main() {\n  __x = 1\n}\n`,
    "a read": `node main() {\n  print(__ctx)\n}\n`,
    "a read inside an expression": `node main() {\n  const y = 1 + __matchval_1\n}\n`,
    "a read inside an interpolation": `node main() {\n  print("v: \${__ctx}")\n}\n`,
    "a read after a comparison": `node main() {\n  if (a == __x) {\n    print(1)\n  }\n}\n`,
    "a read after a pipe": `node main() {\n  const y = a |> __f\n}\n`,
    "a read inside a call after an operator": `node main() {\n  const y = 1 + f(__x)\n}\n`,
    "a read as an access base": `node main() {\n  print(__ctx.handlers)\n}\n`,
    "a function call": `node main() {\n  __readStatic("a")\n}\n`,
    "a new expression": `node main() {\n  const s = new __Thing()\n}\n`,
    "a def name": `def __helper(): number {\n  return 1\n}\n`,
    "a node name": `node __start() {\n  print(1)\n}\n`,
    "a parameter": `def f(__a: number): number {\n  return 1\n}\n`,
    "a variadic parameter": `def f(...__rest: number[]): number {\n  return 1\n}\n`,
    "a for-loop item": `node main() {\n  for (__i in [1]) {\n    print(1)\n  }\n}\n`,
    "a for-loop index": `node main() {\n  for (x, __i in [1]) {\n    print(x)\n  }\n}\n`,
    "a block parameter": `node main() {\n  map([1]) as __n {\n    return 1\n  }\n}\n`,
    "a handler parameter": `node main() {\n  handle {\n    print(1)\n  } with (__i) {\n    return approve()\n  }\n}\n`,
    "a type alias": `type __T = string\n`,
    "a type reference": `def f(a: __T): number {\n  return 1\n}\n`,
    "an imported name": `import { __secret } from "./x.agency"\n`,
    "an import alias": `import { secret as __s } from "./x.agency"\n`,
    "an array pattern binder": `node main() {\n  const [__a, b] = [1, 2]\n}\n`,
    "an object pattern shorthand": `node main() {\n  const { __a } = { __a: 1 }\n}\n`,
    "an object pattern rename": `node main() {\n  const { a: __b } = { a: 1 }\n}\n`,
    "a rest pattern": `node main() {\n  const [a, ...__r] = [1, 2]\n}\n`,
    "a match arm binder": `node main() {\n  const v = match (1) {\n    __n => __n\n  }\n}\n`,
  };
  for (const [what, source] of Object.entries(refused)) {
    it(`refuses ${what}`, () => {
      expect(messageFor(source)).toContain(RESERVED);
    });
  }

  it("refuses a name inside a code literal", () => {
    // The literal body is parsed by a nested parse with its own state.
    const message = messageFor(`node main() {\n  const c = [| const __x = 1 |]\n}\n`);
    expect(message).toContain(RESERVED);
  });

  it("names the offending identifier", () => {
    expect(messageFor(`const __x = 1\n`)).toContain("`__x`");
  });
});

describe("the parser still accepts", () => {
  const accepted: Record<string, string> = {
    __dirname: `node main() {\n  print(__dirname)\n}\n`,
    "a hygienic rename": `node main() {\n  const __hyg1_tmp = 1\n  print(__hyg1_tmp)\n}\n`,
    "an object key": `node main() {\n  const o = { __typename: "User" }\n}\n`,
    "a quoted object key": `node main() {\n  const o = { "__typename": "User" }\n}\n`,
    "a property read": `node main() {\n  const o = { a: 1 }\n  print(o.__typename)\n}\n`,
    "a method call": `node main() {\n  const o = { a: 1 }\n  print(o.__toJSON())\n}\n`,
    "an optional property read": `node main() {\n  const o = { a: 1 }\n  print(o?.__typename)\n}\n`,
    "a property of a call result": `node main() {\n  print(f().__typename)\n}\n`,
    "a type property": `type T = { __typename: string }\n`,
    "an object pattern key": `node main() {\n  const { __typename: t } = { __typename: "U" }\n}\n`,
    "text in a string": `node main() {\n  print("__ctx is internal")\n}\n`,
    "text in a comment": `// __ctx is internal\nnode main() {\n  print(1)\n}\n`,
    "one leading underscore": `node main() {\n  const _x = 1\n}\n`,
    "underscores in the middle": `node main() {\n  const a__b = 1\n}\n`,
  };
  for (const [what, source] of Object.entries(accepted)) {
    it(`accepts ${what}`, () => {
      expect(messageFor(source)).toBeNull();
    });
  }
});
