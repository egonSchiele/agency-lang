import { describe, it, expect } from "vitest";
import {
  callablesWithTags,
  closestCapability,
  ownCapabilities,
  readCapabilities,
} from "./capabilitiesTag.js";
import { parseAgency } from "../parser.js";

function parse(src: string) {
  const parsed = parseAgency(src);
  if (!parsed.success) {
    throw new Error("parse failed");
  }
  return parsed.result.nodes;
}

function tagsOf(src: string) {
  return callablesWithTags(parse(src))[0].tags;
}

describe("readCapabilities", () => {
  it("reads the names and reports no problem", () => {
    const read = readCapabilities(
      tagsOf('@capabilities(fileRead, llm)\ndef f(): string { return "x" }'),
    );
    expect(read).toEqual({ tagged: true, capabilities: ["fileRead", "llm"], problems: [] });
  });

  it("tells an empty tag from no tag", () => {
    expect(readCapabilities(tagsOf('@capabilities()\ndef f(): string { return "x" }')).tagged).toBe(
      true,
    );
    expect(readCapabilities(tagsOf('def f(): string { return "x" }')).tagged).toBe(false);
  });

  it("drops an unknown name and suggests the closest", () => {
    const read = readCapabilities(
      tagsOf('@capabilities(netwerk, env)\ndef f(): string { return "x" }'),
    );
    expect(read.capabilities).toEqual(["env"]);
    expect(read.problems).toMatchObject([
      { kind: "unknownName", name: "netwerk", suggestion: "network" },
    ]);
  });

  it("counts a name written twice once", () => {
    const read = readCapabilities(
      tagsOf('@capabilities(env, env)\ndef f(): string { return "x" }'),
    );
    expect(read.capabilities).toEqual(["env"]);
  });
});

describe("callablesWithTags and ownCapabilities", () => {
  it("reads a tag above a def and above a node, and skips the untagged", () => {
    const src =
      '@capabilities(fileRead)\nexport def a(): string { return "x" }\n' +
      "def b(): string { return a() }\n" +
      "@capabilities(network, env)\nnode main() {\n  const x = b()\n}";
    expect(callablesWithTags(parse(src)).map((c) => c.name)).toEqual(["a", "b", "main"]);
    expect(ownCapabilities(parse(src))).toEqual({ a: ["fileRead"], main: ["network", "env"] });
  });

  it("reads a tag between a doc comment and the def", () => {
    const src =
      '/** Reads a file. */\n@capabilities(fileRead)\nexport def a(): string { return "x" }';
    expect(ownCapabilities(parse(src))).toEqual({ a: ["fileRead"] });
  });
});

describe("closestCapability", () => {
  it("picks by edit distance", () => {
    expect(closestCapability("fileWrit")).toBe("fileWrite");
    expect(closestCapability("sub")).toBe("subprocess");
  });
});
