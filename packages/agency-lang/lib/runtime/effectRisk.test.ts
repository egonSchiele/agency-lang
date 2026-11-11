import { describe, expect, it } from "vitest";
import { effectRisk, RISK_BY_SET } from "./effectRisk.js";
import { builtinEffectSets } from "./effectSets.js";

describe("effectRisk", () => {
  const sets = builtinEffectSets();

  // A new built-in set of dangerous effects with no row would get the
  // default color, with nothing else failing.
  it("covers the members of every built-in set", () => {
    const covered = Object.keys(RISK_BY_SET).flatMap((name) => sets[name]?.members ?? []);
    const uncovered = Object.values(sets)
      .filter((set) => set.composedOf.length === 0 && !Object.hasOwn(RISK_BY_SET, set.name))
      .filter((set) => !set.members.every((member) => covered.includes(member)))
      .map((set) => set.name);
    expect(uncovered).toEqual([]);
    expect(Object.keys(RISK_BY_SET).filter((name) => sets[name] === undefined)).toEqual([]);
  });

  it("reads a file-reading effect as a read", () => {
    expect(effectRisk("std::ls", sets)).toBe("read");
  });
  it("reads a write or a network call as a change", () => {
    expect(effectRisk("std::write", sets)).toBe("change");
    expect(effectRisk("std::http::fetch", sets)).toBe("change");
  });
  it("reads a shell command or a secret as a danger", () => {
    expect(effectRisk("std::bash", sets)).toBe("danger");
    expect(effectRisk("std::getSecret", sets)).toBe("danger");
  });
  it("reads an effect in no set as a change", () => {
    expect(effectRisk("myapp::deploy", sets)).toBe("change");
  });
  it("takes the highest risk when an effect is in several sets", () => {
    const custom = {
      Shell: { name: "Shell", doc: "", members: ["x::y"], composedOf: [] },
      FileRead: { name: "FileRead", doc: "", members: ["x::y"], composedOf: [] },
    };
    expect(effectRisk("x::y", custom)).toBe("danger");
  });
});
