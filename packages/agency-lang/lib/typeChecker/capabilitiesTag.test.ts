import { describe, it, expect } from "vitest";
import { closestCapability, readCapabilities, sameCapabilities } from "./capabilitiesTag.js";
import { parseAgency } from "../parser.js";
import { effectDeclarationsWithTags } from "../utils/tagsAbove.js";

function tagsOf(src: string) {
  const parsed = parseAgency(src);
  if (!parsed.success) {
    throw new Error("parse failed");
  }
  return effectDeclarationsWithTags(parsed.result.nodes)[0].tags ?? [];
}

describe("readCapabilities", () => {
  it("reads the names and reports no problem", () => {
    const read = readCapabilities(tagsOf("@capabilities(fileRead, llm)\neffect app::x {}"));
    expect(read).toEqual({ tagged: true, capabilities: ["fileRead", "llm"], problems: [] });
  });

  it("tells an empty tag from no tag", () => {
    expect(readCapabilities(tagsOf("@capabilities()\neffect app::x {}")).tagged).toBe(true);
    expect(readCapabilities(tagsOf("effect app::x {}")).tagged).toBe(false);
  });

  it("drops an unknown name and suggests the closest", () => {
    const read = readCapabilities(tagsOf("@capabilities(netwerk, env)\neffect app::x {}"));
    expect(read.capabilities).toEqual(["env"]);
    expect(read.problems).toMatchObject([
      { kind: "unknownName", name: "netwerk", suggestion: "network" },
    ]);
  });

  it("counts a name written twice once", () => {
    const read = readCapabilities(tagsOf("@capabilities(env, env)\neffect app::x {}"));
    expect(read.capabilities).toEqual(["env"]);
  });
});

describe("closestCapability", () => {
  it("picks by edit distance", () => {
    expect(closestCapability("fileWrit")).toBe("fileWrite");
    expect(closestCapability("sub")).toBe("subprocess");
  });
});

describe("sameCapabilities", () => {
  it("ignores order", () => {
    expect(sameCapabilities(["env", "llm"], ["llm", "env"])).toBe(true);
    expect(sameCapabilities(["env"], ["llm", "env"])).toBe(false);
  });
});
