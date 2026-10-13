import { describe, it, expect } from "vitest";
import { checkCapabilityLog, CHECKED_CAPABILITIES } from "./capabilityCheck.js";
import { formatCapabilityLogLine, parseCapabilityLog } from "../runtime/capabilityLog.js";

describe("the capability log", () => {
  it("round-trips use, enter, and exit lines", () => {
    const text = [
      formatCapabilityLogLine({ kind: "enter", name: "main", capabilities: [] }),
      formatCapabilityLogLine({ kind: "enter", name: "read", capabilities: ["fileRead"] }),
      formatCapabilityLogLine({
        kind: "use",
        functionName: "files.readText",
        capability: "fileRead",
      }),
      formatCapabilityLogLine({ kind: "exit", name: "read" }),
      formatCapabilityLogLine({
        kind: "enter",
        name: "write",
        capabilities: ["fileRead", "fileWrite"],
      }),
      "half-written",
      "",
    ].join("\n");
    expect(parseCapabilityLog(text)).toEqual([
      { kind: "enter", name: "main", capabilities: [] },
      { kind: "enter", name: "read", capabilities: ["fileRead"] },
      { kind: "use", functionName: "files.readText", capability: "fileRead" },
      { kind: "exit", name: "read" },
      { kind: "enter", name: "write", capabilities: ["fileRead", "fileWrite"] },
    ]);
  });
});

describe("checkCapabilityLog", () => {
  it("passes when a running function declares every checked use", () => {
    expect(
      checkCapabilityLog([
        { kind: "enter", name: "main", capabilities: [] },
        { kind: "enter", name: "write", capabilities: ["fileRead", "fileWrite"] },
        { kind: "use", functionName: "files.fixedRoot", capability: "fileRead" },
        { kind: "use", functionName: "files.writeText", capability: "fileWrite" },
        { kind: "exit", name: "write" },
        { kind: "exit", name: "main" },
      ]),
    ).toEqual({ uncovered: [], outside: [] });
  });

  it("covers a use through an outer function's tag", () => {
    expect(
      checkCapabilityLog([
        { kind: "enter", name: "skillsDir", capabilities: ["fileRead"] },
        { kind: "enter", name: "helper", capabilities: [] },
        { kind: "use", functionName: "files.readText", capability: "fileRead" },
        { kind: "exit", name: "helper" },
        { kind: "exit", name: "skillsDir" },
      ]),
    ).toEqual({ uncovered: [], outside: [] });
  });

  it("names the host function, the capability, and the innermost function", () => {
    expect(
      checkCapabilityLog([
        { kind: "enter", name: "read", capabilities: ["fileRead"] },
        { kind: "use", functionName: "files.readText", capability: "fileRead" },
        { kind: "use", functionName: "files.writeText", capability: "fileWrite" },
        { kind: "use", functionName: "files.writeText", capability: "fileWrite" },
        { kind: "exit", name: "read" },
      ]),
    ).toEqual({
      uncovered: [
        "files.writeText used the fileWrite capability inside read, whose tag does not name it",
      ],
      outside: [],
    });
  });

  it("stops covering once the function has exited", () => {
    expect(
      checkCapabilityLog([
        { kind: "enter", name: "write", capabilities: ["fileRead", "fileWrite"] },
        { kind: "enter", name: "read", capabilities: ["fileRead"] },
        { kind: "exit", name: "read" },
        { kind: "use", functionName: "files.readText", capability: "fileRead" },
        { kind: "use", functionName: "files.writeText", capability: "fileWrite" },
        { kind: "exit", name: "write" },
        { kind: "use", functionName: "files.readText", capability: "fileRead" },
      ]),
    ).toEqual({
      uncovered: [],
      outside: ["files.readText used the fileRead capability outside any function"],
    });
  });

  it("pops the innermost frame with the name, so recursion unwinds in order", () => {
    expect(
      checkCapabilityLog([
        { kind: "enter", name: "walk", capabilities: ["fileRead"] },
        { kind: "enter", name: "walk", capabilities: ["fileRead"] },
        { kind: "exit", name: "walk" },
        { kind: "use", functionName: "files.list", capability: "fileRead" },
        { kind: "exit", name: "walk" },
      ]),
    ).toEqual({ uncovered: [], outside: [] });
  });

  it("checks env, and leaves llm and terminal out", () => {
    expect(CHECKED_CAPABILITIES).toContain("env");
    expect(CHECKED_CAPABILITIES).toContain("fileRead");
    expect(CHECKED_CAPABILITIES).not.toContain("llm");
    expect(CHECKED_CAPABILITIES).not.toContain("terminal");
    expect(
      checkCapabilityLog([
        { kind: "enter", name: "main", capabilities: [] },
        { kind: "use", functionName: "llm.complete", capability: "llm" },
        { kind: "use", functionName: "terminal.size", capability: "terminal" },
        { kind: "use", functionName: "env.get", capability: "env" },
      ]),
    ).toEqual({
      uncovered: ["env.get used the env capability inside main, whose tag does not name it"],
      outside: [],
    });
  });

  it("reports a use outside any function as a note, not a failure", () => {
    expect(
      checkCapabilityLog([
        { kind: "enter", name: "main", capabilities: [] },
        { kind: "exit", name: "main" },
        { kind: "use", functionName: "files.writeText", capability: "fileWrite" },
      ]),
    ).toEqual({
      uncovered: [],
      outside: ["files.writeText used the fileWrite capability outside any function"],
    });
  });
});
