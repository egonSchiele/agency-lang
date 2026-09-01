import { describe, it, expect } from "vitest";
import { builtinEffectSets, parseEffectSets } from "./effectSets.js";

// These parse the REAL shipped stdlib/capabilities.agency, so they double
// as drift tests: an edit to that file the walker misreads fails here.
describe("builtinEffectSets", () => {
  const sets = builtinEffectSets();

  it("reads FileRead's exact members", () => {
    expect(sets["FileRead"].members).toEqual([
      "std::read",
      "std::readBinary",
      "std::ls",
      "std::glob",
      "std::grep",
    ]);
  });

  it("flattens a nested set to the union of its parts", () => {
    expect(sets["FileSystem"].members).toEqual([
      ...sets["FileRead"].members,
      ...sets["FileWrite"].members,
    ]);
    expect(sets["Notes"].members).toEqual([
      ...sets["NotesRead"].members,
      ...sets["NotesWrite"].members,
    ]);
  });

  it("records the composition of a nested set", () => {
    expect(sets["FileSystem"].composedOf).toEqual(["FileRead", "FileWrite"]);
    expect(sets["FileRead"].composedOf).toEqual([]);
  });

  it("every member of every set is a namespaced effect name", () => {
    for (const set of Object.values(sets)) {
      expect(set.members.length).toBeGreaterThan(0);
      for (const member of set.members) {
        expect(member).toContain("::");
      }
    }
  });

  it("every set carries a doc line", () => {
    for (const set of Object.values(sets)) {
      expect(set.doc.length).toBeGreaterThan(0);
    }
  });

  it("includes the known set names", () => {
    for (const name of ["FileRead", "FileWrite", "FileSystem", "Shell", "Network", "Secrets"]) {
      expect(sets[name]).toBeDefined();
    }
  });

  it("is safe against prototype-colliding lookups", () => {
    expect(sets["toString"]).toBeUndefined();
    expect(sets["__proto__"]).toBeUndefined();
  });
});

describe("parseEffectSets", () => {
  it("pairs a doc comment with the declaration that follows it", () => {
    const sets = parseEffectSets(
      `/** Everything filesystem. */\nexport effectSet Fs = <std::read, std::write>\n`,
      "test",
    );
    expect(sets["Fs"].doc).toBe("Everything filesystem.");
    expect(sets["Fs"].members).toEqual(["std::read", "std::write"]);
  });

  it("refuses a set declared as <*> (no enumerable members)", () => {
    expect(() => parseEffectSets(`export effectSet Anything = <*>\n`, "test")).toThrow(
      "cannot be expanded",
    );
  });

  it("refuses a reference to an undeclared set", () => {
    expect(() => parseEffectSets(`export effectSet A = <Missing>\n`, "test")).toThrow(
      "unknown set 'Missing'",
    );
  });
});
