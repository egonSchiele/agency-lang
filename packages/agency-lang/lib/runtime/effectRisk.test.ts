import { describe, expect, it } from "vitest";
import { effectRisk } from "./effectRisk.js";
import { builtinEffectSets } from "./effectSets.js";

describe("effectRisk", () => {
  const sets = builtinEffectSets();

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
