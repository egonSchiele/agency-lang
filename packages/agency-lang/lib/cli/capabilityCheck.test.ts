import { describe, it, expect } from "vitest";
import { checkCapabilityLog, effectCapabilitiesFor } from "./capabilityCheck.js";
import { formatCapabilityLogLine, parseCapabilityLog } from "../runtime/capabilityLog.js";
import { resolveAgencyImportPath } from "../importPaths.js";
import type { Capability } from "../host/host.js";

describe("the capability log", () => {
  it("round-trips use and raise lines", () => {
    const text = [
      formatCapabilityLogLine({
        kind: "use",
        functionName: "files.readText",
        capability: "fileRead",
      }),
      formatCapabilityLogLine({ kind: "raise", effect: "std::read" }),
      "half-written",
      "",
    ].join("\n");
    expect(parseCapabilityLog(text)).toEqual([
      { kind: "use", functionName: "files.readText", capability: "fileRead" },
      { kind: "raise", effect: "std::read" },
    ]);
  });
});

describe("checkCapabilityLog", () => {
  const tags: Record<string, Capability[]> = {
    "std::read": ["fileRead"],
    "std::write": ["fileRead", "fileWrite"],
  };

  it("passes when a raised effect is tagged with every checked use", () => {
    expect(
      checkCapabilityLog(
        [
          { kind: "raise", effect: "std::write" },
          { kind: "use", functionName: "files.fixedRoot", capability: "fileRead" },
          { kind: "use", functionName: "files.writeText", capability: "fileWrite" },
        ],
        tags,
      ),
    ).toEqual({ wrongTags: [], silentUses: [] });
  });

  it("names the host functions and the raised effects on a wrong tag", () => {
    expect(
      checkCapabilityLog(
        [
          { kind: "raise", effect: "std::read" },
          { kind: "use", functionName: "files.readText", capability: "fileRead" },
          { kind: "use", functionName: "files.writeText", capability: "fileWrite" },
          { kind: "use", functionName: "files.writeText", capability: "fileWrite" },
        ],
        tags,
      ),
    ).toEqual({
      wrongTags: [
        "files.writeText used the fileWrite capability, and no raised effect is tagged with it (raised: std::read)",
      ],
      silentUses: [],
    });
  });

  it("reports a use with no raise as silent, not as a wrong tag", () => {
    expect(
      checkCapabilityLog(
        [{ kind: "use", functionName: "subprocess.run", capability: "subprocess" }],
        tags,
      ),
    ).toEqual({
      wrongTags: [],
      silentUses: ["subprocess.run used the subprocess capability, and no effect was raised"],
    });
  });

  it("ignores terminal, env, and llm uses", () => {
    expect(
      checkCapabilityLog(
        [
          { kind: "use", functionName: "terminal.print", capability: "terminal" },
          { kind: "use", functionName: "env.get", capability: "env" },
        ],
        tags,
      ),
    ).toEqual({ wrongTags: [], silentUses: [] });
  });
});

describe("effectCapabilitiesFor", () => {
  it("reads the stdlib tags through a file's import closure", () => {
    const tags = effectCapabilitiesFor(resolveAgencyImportPath("std::index", process.cwd()), {});
    expect(tags["std::read"]).toEqual(["fileRead"]);
    expect(tags["std::write"]).toEqual(["fileRead", "fileWrite"]);
  });
});
