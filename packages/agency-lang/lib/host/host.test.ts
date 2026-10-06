import { describe, it, expect } from "vitest";
import {
  CAPABILITIES,
  NEEDS,
  PLATFORM_CAPABILITIES,
  UnsupportedOnHostError,
  makeHost,
  requireCapabilities,
  withClock,
  type Capability,
  type Host,
  type HostFunctionName,
} from "./host.js";
import { nodeHost } from "./nodeHost.js";
import { FakeClock } from "../runtime/clock.js";

/** The parts of a host that have a capability, by name, as a real host
 *  built with every capability exposes them. */
function capabilityParts(host: Host): Record<string, Record<string, unknown>> {
  const parts: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(NEEDS)) {
    const part = name.split(".")[0];
    parts[part] = host[part as keyof Host] as Record<string, unknown>;
  }
  return parts;
}

function call(host: Host, functionName: HostFunctionName): unknown {
  const [part, fn] = functionName.split(".");
  const implementation = (host[part as keyof Host] as Record<string, (...a: unknown[]) => unknown>)[
    fn
  ];
  return implementation("x", "y");
}

describe("NEEDS", () => {
  it("names a known capability in every entry", () => {
    for (const capability of Object.values(NEEDS)) {
      expect(CAPABILITIES).toContain(capability);
    }
  });

  it("has an entry for every function in every capability part of nodeHost", () => {
    // The type is gone when the test runs, so walk a real host instead.
    const parts = capabilityParts(nodeHost());
    const found = Object.entries(parts).flatMap(([part, functions]) =>
      Object.keys(functions).map((fn) => `${part}.${fn}`),
    );
    expect(found.sort()).toEqual(Object.keys(NEEDS).sort());
  });
});

describe("PLATFORM_CAPABILITIES", () => {
  it("gives Node every capability", () => {
    expect([...PLATFORM_CAPABILITIES.node].sort()).toEqual([...CAPABILITIES].sort());
  });

  it("gives the browser no files and no subprocesses", () => {
    expect(PLATFORM_CAPABILITIES.browser).not.toContain("fileRead");
    expect(PLATFORM_CAPABILITIES.browser).not.toContain("fileWrite");
    expect(PLATFORM_CAPABILITIES.browser).not.toContain("subprocess");
    for (const capability of PLATFORM_CAPABILITIES.browser) {
      expect(CAPABILITIES).toContain(capability);
    }
  });
});

describe("makeHost", () => {
  // Driven by the table: one case per entry in NEEDS, not one per function
  // written by hand, so a function added to a part cannot be forgotten.
  for (const functionName of Object.keys(NEEDS) as HostFunctionName[]) {
    const capability = NEEDS[functionName];
    it(`${functionName} throws on a host without ${capability}`, () => {
      const without = CAPABILITIES.filter((c) => c !== capability);
      const host = nodeHost({ capabilities: without });
      let thrown: unknown;
      try {
        call(host, functionName);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UnsupportedOnHostError);
      const error = thrown as UnsupportedOnHostError;
      expect(error.capability).toBe(capability);
      expect(error.hostName).toBe("node");
      expect(error.functionName).toBe(functionName);
      expect(error.message).toBe(
        `${functionName} needs the ${capability} capability, which the node host does not have.`,
      );
    });
  }

  it("throws at build time when a granted function is missing from the parts", () => {
    const full = nodeHost();
    expect(() =>
      makeHost({
        name: "partial",
        capabilities: ["env"],
        parts: {
          env: { get: () => null } as never,
          system: full.system,
          settings: full.settings,
          clock: full.clock,
          random: full.random,
        },
      }),
    ).toThrow("The partial host grants env but its parts have no env.set function.");
  });

  it("does not need the parts of a capability it does not grant", () => {
    const full = nodeHost();
    const host = makeHost({
      name: "quiet",
      capabilities: [],
      parts: {
        system: full.system,
        settings: full.settings,
        clock: full.clock,
        random: full.random,
      },
    });
    expect(() => host.terminal.writeOut("hi")).toThrow(UnsupportedOnHostError);
    expect(() => host.env.get("HOME")).toThrow(UnsupportedOnHostError);
  });

  it("rejects a capability name it does not know", () => {
    expect(() => nodeHost({ capabilities: ["clipboard" as Capability] })).toThrow(
      'Unknown capability "clipboard" for the node host.',
    );
  });

  it("calls onUse with the function and its capability before the function runs", () => {
    const used: string[] = [];
    const host = nodeHost({ onUse: (fn, capability) => used.push(`${fn}:${capability}`) });
    process.env.AGENCY_HOST_TEST_VALUE = "set";
    try {
      expect(host.env.get("AGENCY_HOST_TEST_VALUE")).toBe("set");
    } finally {
      delete process.env.AGENCY_HOST_TEST_VALUE;
    }
    expect(used).toEqual(["env.get:env"]);
  });

  it("does not call onUse for a part that is not a capability", () => {
    const used: string[] = [];
    const host = nodeHost({ onUse: (fn) => used.push(fn) });
    host.system.cwd();
    host.settings.read("HOME");
    expect(used).toEqual([]);
  });

  it("copies the capability list so a later change to it does not reach the host", () => {
    const capabilities: Capability[] = ["env"];
    const host = nodeHost({ capabilities });
    capabilities.push("terminal");
    expect(host.capabilities).toEqual(["env"]);
  });
});

describe("requireCapabilities", () => {
  it("passes when the host has every capability asked for", () => {
    expect(() => requireCapabilities(nodeHost(), ["env", "terminal"])).not.toThrow();
  });

  it("throws for the first capability the host lacks, naming the caller", () => {
    const host = nodeHost({ capabilities: ["env"] });
    let thrown: unknown;
    try {
      requireCapabilities(host, ["env", "subprocess", "network"], "_runFor");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedOnHostError);
    expect((thrown as UnsupportedOnHostError).capability).toBe("subprocess");
    expect((thrown as Error).message).toBe(
      "_runFor needs the subprocess capability, which the node host does not have.",
    );
  });

  it("has a message without a caller name too", () => {
    const host = nodeHost({ capabilities: [] });
    expect(() => requireCapabilities(host, ["llm"])).toThrow(
      "This needs the llm capability, which the node host does not have.",
    );
  });
});

describe("withClock", () => {
  it("replaces the clock and keeps everything else", () => {
    const host = nodeHost();
    const clock = new FakeClock();
    const copy = withClock(host, clock);
    expect(copy.clock).toBe(clock);
    expect(copy.system).toBe(host.system);
    expect(copy.capabilities).toEqual(host.capabilities);
    expect(host.clock).not.toBe(clock);
  });
});

describe("nodeHost", () => {
  it("grants every Node capability by default", () => {
    expect(nodeHost().capabilities).toEqual(PLATFORM_CAPABILITIES.node);
  });

  it("reads and writes environment variables", () => {
    const host = nodeHost();
    expect(host.env.get("AGENCY_HOST_TEST_MISSING")).toBeNull();
    host.env.set("AGENCY_HOST_TEST_VALUE", "one");
    try {
      expect(host.env.get("AGENCY_HOST_TEST_VALUE")).toBe("one");
      expect(host.settings.read("AGENCY_HOST_TEST_VALUE")).toBe("one");
    } finally {
      delete process.env.AGENCY_HOST_TEST_VALUE;
    }
  });

  it("answers the system questions from the process", () => {
    const host = nodeHost();
    expect(host.system.cwd()).toBe(process.cwd());
    expect(host.system.processId()).toBe(process.pid);
    expect(host.system.args()).toBe(process.argv);
    expect(["macos", "linux", "windows", "wsl", "unknown"]).toContain(
      host.system.operatingSystem(),
    );
    expect(host.system.moduleDir(import.meta.url)).toBe(import.meta.dirname);
    expect(host.system.isMainModule(import.meta.url)).toBe(false);
  });

  it("makes random ids and bytes", () => {
    const host = nodeHost();
    expect(host.random.id()).not.toBe(host.random.id());
    const bytes = host.random.bytes(16);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(16);
  });

  it("rejects a readLine whose signal is already aborted", async () => {
    const host = nodeHost();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(host.terminal.readLine("? ", controller.signal)).rejects.toThrow("cancelled");
  });
});
