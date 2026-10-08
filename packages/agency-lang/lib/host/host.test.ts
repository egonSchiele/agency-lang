import { describe, it, expect } from "vitest";
import {
  CAPABILITIES,
  FILE_WRITE_FUNCTIONS,
  PART_CAPABILITY,
  PLATFORM_CAPABILITIES,
  functionCapability,
  UnsupportedOnHostError,
  makeHost,
  requireCapabilities,
  withClock,
  type Capability,
  type CapabilityPart,
  type Host,
} from "./host.js";
import { nodeHost } from "./node/nodeHost.js";
import { memoryHost } from "./memoryHost.js";
import { FakeClock } from "../runtime/clock.js";

function call(host: Host, functionName: string): unknown {
  const [part, fn] = functionName.split(".");
  const implementation = (host[part as keyof Host] as Record<string, (...a: unknown[]) => unknown>)[
    fn
  ];
  return implementation("x", "y");
}

/** Every function of every capability part, as a real nodeHost has them. */
function capabilityFunctions(): string[] {
  const host = nodeHost();
  return (Object.keys(PART_CAPABILITY) as CapabilityPart[]).flatMap((part) =>
    Object.keys(host[part]).map((fn) => `${part}.${fn}`),
  );
}

describe("FILE_WRITE_FUNCTIONS", () => {
  it("names functions the files part has", () => {
    const files = nodeHost().files as unknown as Record<string, unknown>;
    for (const fn of FILE_WRITE_FUNCTIONS) {
      expect(typeof files[fn]).toBe("function");
    }
  });
});

describe("PART_CAPABILITY", () => {
  it("names a known capability for every part", () => {
    for (const capability of Object.values(PART_CAPABILITY)) {
      expect(CAPABILITIES).toContain(capability);
    }
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
  // One case per function of a real host, found by walking its parts, so a
  // function added to a part is covered without a line here.
  for (const functionName of capabilityFunctions()) {
    const [part, fn] = functionName.split(".");
    const capability = functionCapability(part as CapabilityPart, fn);
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

  it("refuses a function name it has never heard of, on a part it lacks", () => {
    const host = nodeHost({ capabilities: [] });
    expect(() => call(host, "terminal.somethingNew")).toThrow(
      "terminal.somethingNew needs the terminal capability, which the node host does not have.",
    );
  });

  it("throws at build time when a granted part is missing", () => {
    const full = nodeHost();
    expect(() =>
      makeHost({
        name: "partial",
        capabilities: ["env"],
        parts: {
          system: full.system,
          settings: full.settings,
          clock: full.clock,
          random: full.random,
        },
      }),
    ).toThrow("The partial host grants env but its parts have no env.");
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

  it("hands out a copy of the whole environment with no unset entries", () => {
    const host = nodeHost();
    host.env.set("AGENCY_HOST_TEST_VALUE", "one");
    try {
      const all = host.env.all();
      expect(all.AGENCY_HOST_TEST_VALUE).toBe("one");
      expect(Object.values(all).every((value) => typeof value === "string")).toBe(true);
      all.AGENCY_HOST_TEST_VALUE = "two";
      expect(host.env.get("AGENCY_HOST_TEST_VALUE")).toBe("one");
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

  it("reports the terminal size, or null under a pipe", () => {
    const size = nodeHost().terminal.size();
    if (process.stdout.isTTY) {
      expect(size).toEqual({ columns: process.stdout.columns, rows: process.stdout.rows });
    } else {
      expect(size).toBeNull();
    }
  });

  it("decides colour from NO_COLOR, then FORCE_COLOR, then the terminal", () => {
    const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
    const restore = (name: "NO_COLOR" | "FORCE_COLOR") => {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    };
    const terminal = nodeHost().terminal;
    try {
      delete process.env.NO_COLOR;
      process.env.FORCE_COLOR = "1";
      expect(terminal.supportsColor()).toBe(true);
      process.env.NO_COLOR = "1";
      expect(terminal.supportsColor()).toBe(false);
      delete process.env.NO_COLOR;
      process.env.FORCE_COLOR = "0";
      expect(terminal.supportsColor()).toBe(process.stdout.isTTY === true);
      process.env.FORCE_COLOR = "false";
      expect(terminal.supportsColor()).toBe(process.stdout.isTTY === true);
      delete process.env.FORCE_COLOR;
      expect(terminal.supportsColor()).toBe(process.stdout.isTTY === true);
    } finally {
      restore("NO_COLOR");
      restore("FORCE_COLOR");
    }
  });

  it("has a parent channel only when process.send exists", () => {
    const system = nodeHost().system;
    const original = process.send;
    const sent: unknown[] = [];
    const fake = (message: unknown) => {
      sent.push(message);
      return true;
    };
    try {
      process.send = undefined;
      expect(system.parentChannel()).toBeNull();
      process.send = fake as unknown as typeof process.send;
      system.parentChannel()?.send({ type: "hello" });
      expect(sent).toEqual([{ type: "hello" }]);
    } finally {
      process.send = original;
    }
  });

  it("registers an exit listener on the process", () => {
    const system = nodeHost().system;
    const listener = () => {};
    system.onExit(listener);
    try {
      expect(process.listeners("exit")).toContain(listener);
    } finally {
      process.removeListener("exit", listener);
    }
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

describe("memoryHost", () => {
  it("has no terminal size and no colour", () => {
    const host = memoryHost();
    expect(host.terminal.size()).toBeNull();
    expect(host.terminal.supportsColor()).toBe(false);
  });

  it("has no parent and never runs an exit listener", () => {
    const host = memoryHost();
    expect(host.system.parentChannel()).toBeNull();
    let ran = false;
    host.system.onExit(() => {
      ran = true;
    });
    expect(ran).toBe(false);
  });

  it("answers env.all from its variables, as a copy", () => {
    const host = memoryHost({ variables: { A: "1", B: "2" } });
    const all = host.env.all();
    expect(all).toEqual({ A: "1", B: "2" });
    all.C = "3";
    expect(host.env.get("C")).toBeNull();
    host.env.set("D", "4");
    expect(host.env.all()).toEqual({ A: "1", B: "2", D: "4" });
  });
});
