import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { isReservedInternalName } from "../reservedNames.js";
import { BUILTIN_VARIABLES } from "../config/config.js";
import { ACCEPTED_SOURCES, REFUSED_SOURCES } from "./reservedNames.cases.js";

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
  for (const [what, source] of Object.entries(REFUSED_SOURCES)) {
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
  for (const [what, source] of Object.entries(ACCEPTED_SOURCES)) {
    it(`accepts ${what}`, () => {
      expect(messageFor(source)).toBeNull();
    });
  }
});
