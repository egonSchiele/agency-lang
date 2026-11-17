import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./mcpResolver.js", () => ({
  isMcpAvailable: vi.fn(() => true),
  exposeResolvedMcpPath: vi.fn(),
  resolveMcpEntry: vi.fn(() => "/x/mcp"),
}));
vi.mock("./mcpBridge.mjs", () => ({
  mcpRaw: vi.fn(),
  packageVersion: vi.fn(async () => "0.0.6"),
  mcpToolToAgencyFunction: vi.fn(async (tool) => ({ name: tool.name })),
  readProjectMcpConfig: vi.fn(async () => ({})),
  connectServer: vi.fn(),
  serverStates: vi.fn(async () => ({})),
  startLogin: vi.fn(),
  finishLogin: vi.fn(),
  cancelLogin: vi.fn(async () => {}),
  logout: vi.fn(),
  disconnectServer: vi.fn(async () => {}),
  configureServers: vi.fn(async () => {}),
  pendingServers: vi.fn(async () => ({})),
  markServerFailed: vi.fn(async () => {}),
}));

import * as bridge from "./mcpBridge.mjs";
import * as resolver from "./mcpResolver.js";
import {
  _mergeMcpServers,
  _loadMcpTools,
  _loadMcpToolsWithStatus,
  _mcpPackageProblem,
  _connectMcpServers,
  _mcpServerStates,
  _startMcpLogin,
  _finishMcpLogin,
  _reconnectMcpServer,
  _logoutMcpServer,
  _disconnectMcpServer,
  _configureMcpServers,
  _pendingMcpServers,
  _markMcpServerFailed,
  _mcpCommandLine,
  _mcpEnvLine,
} from "./mcp.js";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { AgencyCancelledError } from "../runtime/errors.js";

const ok = (tools: any[]) => ({ success: true, value: { tools, callTool: async () => "r" } });
const bad = (msg: string) => ({ success: false, error: msg });

beforeEach(() => vi.clearAllMocks());

describe("_mergeMcpServers", () => {
  it("project overrides global", () => {
    expect(_mergeMcpServers({ a: 1, b: 2 } as any, { a: 9 } as any)).toEqual({ a: 9, b: 2 });
  });

  it("does not pollute the prototype via a __proto__ server name", () => {
    const merged = _mergeMcpServers({ ["__proto__"]: { command: "x" } } as any, {} as any);
    expect(Object.getPrototypeOf(merged)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(merged, "__proto__")).toBe(true);
    // A normal object's prototype is untouched.
    expect(({} as any).command).toBeUndefined();
  });
});

describe("_loadMcpTools", () => {
  it("returns [] when the package is unavailable", async () => {
    (resolver.isMcpAvailable as any).mockReturnValueOnce(false);
    expect(await _loadMcpTools({ s: {} } as any)).toEqual([]);
  });

  it("wraps a server's tools", async () => {
    (bridge.mcpRaw as any).mockResolvedValue(ok([{ name: "s__t" }]));
    const tools = await _loadMcpTools({ s: {} } as any);
    expect(tools).toHaveLength(1);
    expect(bridge.mcpToolToAgencyFunction).toHaveBeenCalled();
  });

  it("skips a failing server but loads the others, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (bridge.mcpRaw as any)
      .mockResolvedValueOnce(bad("down")) // first server fails
      .mockResolvedValueOnce(ok([{ name: "g__t" }])); // second succeeds
    const tools = await _loadMcpTools({ broken: {}, good: {} } as any);
    expect(tools).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken"));
  });

  it("returns [] and warns when the version cannot be verified (T11)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (bridge.packageVersion as any).mockRejectedValueOnce(new Error("boom"));
    expect(await _loadMcpTools({ s: {} } as any)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("version"));
  });
});

describe("_loadMcpToolsWithStatus", () => {
  it("reports connected for a loaded server and unavailable for a failed one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    (bridge.mcpRaw as any)
      .mockResolvedValueOnce(ok([{ name: "g__t" }])) // good (first, primed)
      .mockResolvedValueOnce(bad("down")); // broken
    const { tools, status } = await _loadMcpToolsWithStatus({ good: {}, broken: {} } as any);
    expect(tools).toHaveLength(1);
    expect(status).toEqual({ good: "connected", broken: "unavailable" });
  });

  it("returns empty status when the package is unavailable", async () => {
    (resolver.isMcpAvailable as any).mockReturnValueOnce(false);
    expect(await _loadMcpToolsWithStatus({ s: {} } as any)).toEqual({ tools: [], status: {} });
  });
});

const connected = (names: string[]) => ({
  status: "connected",
  tools: names.map((name) => ({ name })),
  callTool: async () => "r",
});

describe("_mcpCommandLine", () => {
  it("leaves plain words as they are", () => {
    expect(_mcpCommandLine({ command: "npx", args: ["-y", "@scope/server-fs", "/Users/me"] })).toBe(
      "npx -y @scope/server-fs /Users/me",
    );
  });

  it("quotes a word with a space, so different arg lists never read the same", () => {
    expect(_mcpCommandLine({ command: "sh", args: ["-c", "echo hi"] })).toBe('sh -c "echo hi"');
    expect(_mcpCommandLine({ command: "sh", args: ["-c", "echo", "hi"] })).toBe("sh -c echo hi");
  });

  it("quotes a word that holds a quote", () => {
    expect(_mcpCommandLine({ command: "node", args: ['"a"'] })).toBe('node "\\"a\\""');
  });

  it("works with no args", () => {
    expect(_mcpCommandLine({ command: "server" })).toBe("server");
  });
});

describe("_mcpEnvLine", () => {
  it("is empty with no env", () => {
    expect(_mcpEnvLine({ command: "node" })).toBe("");
  });

  it("lists the variables sorted, quoting a value that needs it", () => {
    expect(
      _mcpEnvLine({ command: "node", env: { TOKEN: "x", NODE_OPTIONS: "--require /tmp/p.js" } }),
    ).toBe('"NODE_OPTIONS=--require /tmp/p.js" TOKEN=x');
  });
});

describe("_mcpPackageProblem", () => {
  it("is empty for 0.0.6", async () => {
    expect(await _mcpPackageProblem()).toBe("");
  });

  it("names the version and the command for 0.0.5", async () => {
    (bridge.packageVersion as any).mockResolvedValueOnce("0.0.5");
    expect(await _mcpPackageProblem()).toBe(
      "@agency-lang/mcp 0.0.5 is too old. Run: npm install -g @agency-lang/mcp@latest",
    );
  });

  it("is empty when the package is not installed", async () => {
    (resolver.isMcpAvailable as any).mockReturnValueOnce(false);
    expect(await _mcpPackageProblem()).toBe("");
  });

  it("says the version could not be read, not that it is too old", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    (bridge.packageVersion as any).mockRejectedValueOnce(new Error("no version"));
    expect(await _mcpPackageProblem()).toBe(
      "could not read the installed @agency-lang/mcp version. Run: npm install -g @agency-lang/mcp@latest",
    );
  });
});

describe("_configureMcpServers, _pendingMcpServers, and _markMcpServerFailed", () => {
  it("store the config, list the pending servers, and record a refusal", async () => {
    (bridge.pendingServers as any).mockResolvedValueOnce({ files: { command: "npx" } });
    await _configureMcpServers({ files: { command: "npx" } } as any);
    expect(bridge.configureServers).toHaveBeenCalledWith({ config: { files: { command: "npx" } } });
    expect(await _pendingMcpServers()).toEqual({ files: { command: "npx" } });
    await _markMcpServerFailed("files", "not approved");
    expect(bridge.markServerFailed).toHaveBeenCalledWith("files", "not approved");
  });

  it("list nothing when the package is not installed", async () => {
    (resolver.isMcpAvailable as any).mockReturnValue(false);
    try {
      expect(await _pendingMcpServers()).toEqual({});
    } finally {
      (resolver.isMcpAvailable as any).mockReturnValue(true);
    }
  });
});

describe("_disconnectMcpServer", () => {
  it("disconnects the server in the package", async () => {
    await _disconnectMcpServer("gone");
    expect(bridge.disconnectServer).toHaveBeenCalledWith("gone");
  });
});

describe("_connectMcpServers", () => {
  it("returns one state per server, in config order", async () => {
    const byName: Record<string, unknown> = {
      a: connected(["a__t"]),
      b: { status: "needsLogin" },
      c: { status: "failed", message: "boom" },
    };
    (bridge.connectServer as any).mockImplementation(async (name: string) => byName[name]);
    const states = await _connectMcpServers({ a: {}, b: {}, c: {} } as any);
    expect(states.map((s) => [s.name, s.status, s.message])).toEqual([
      ["a", "connected", ""],
      ["b", "needsLogin", ""],
      ["c", "failed", "boom"],
    ]);
    expect(states[0].tools).toHaveLength(1);
  });

  it("gates a connected server's tools", async () => {
    (bridge.connectServer as any).mockResolvedValue(connected(["a__t", "a__u"]));
    await _connectMcpServers({ a: {} } as any);
    expect(bridge.mcpToolToAgencyFunction).toHaveBeenCalledTimes(2);
  });

  it("returns [] when the package is too old", async () => {
    (bridge.packageVersion as any).mockResolvedValueOnce("0.0.5");
    expect(await _connectMcpServers({ a: {} } as any)).toEqual([]);
    expect(bridge.connectServer).not.toHaveBeenCalled();
  });

  it("returns [] when the package is not installed", async () => {
    (resolver.isMcpAvailable as any).mockReturnValue(false);
    try {
      expect(await _connectMcpServers({ a: {} } as any)).toEqual([]);
    } finally {
      (resolver.isMcpAvailable as any).mockReturnValue(true);
    }
  });
});

describe("_mcpServerStates", () => {
  it("returns one state per record, in key order", async () => {
    (bridge.serverStates as any).mockResolvedValueOnce({
      x: { status: "needsLogin" },
      y: connected(["y__t"]),
    });
    const states = await _mcpServerStates();
    expect(states.map((s) => s.name)).toEqual(["x", "y"]);
  });
});

describe("_startMcpLogin", () => {
  it("returns success with the URL", async () => {
    (bridge.startLogin as any).mockResolvedValueOnce({
      status: "started",
      authUrl: "https://login",
    });
    const result = await _startMcpLogin({ a: {} } as any, "a");
    expect(result.success).toBe(true);
    expect(result.success && result.value).toBe("https://login");
  });

  it("returns failure with the package's message", async () => {
    (bridge.startLogin as any).mockResolvedValueOnce({ status: "failed", message: "nope" });
    const result = await _startMcpLogin({ a: {} } as any, "a");
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toBe("nope");
  });
});

function testContext(): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
}

describe("_finishMcpLogin", () => {
  it("returns the connected state", async () => {
    (bridge.finishLogin as any).mockResolvedValueOnce(connected(["a__t"]));
    const ctx = testContext();
    const state = await runInTestContext(ctx, ctx.stateStack, new ThreadStore(), () =>
      _finishMcpLogin("a"),
    );
    expect(state.status).toBe("connected");
    expect(state.tools).toHaveLength(1);
  });

  it("cancels the login and throws the cancel error when the run is aborted", async () => {
    let finish: (value: unknown) => void = () => {};
    (bridge.finishLogin as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    (bridge.cancelLogin as any).mockImplementationOnce(async () => {
      finish({ status: "failed", message: "login cancelled" });
    });
    const ctx = testContext();
    const waiting = runInTestContext(ctx, ctx.stateStack, new ThreadStore(), () =>
      _finishMcpLogin("a"),
    );
    await vi.waitFor(() => expect(bridge.finishLogin).toHaveBeenCalled());
    ctx.abortController.abort();
    await expect(waiting).rejects.toBeInstanceOf(AgencyCancelledError);
    expect(bridge.cancelLogin).toHaveBeenCalledWith("a");
  });
});

describe("_reconnectMcpServer", () => {
  it("disconnects, then connects", async () => {
    const order: string[] = [];
    (bridge.disconnectServer as any).mockImplementationOnce(async () => {
      order.push("disconnect");
    });
    (bridge.connectServer as any).mockImplementationOnce(async () => {
      order.push("connect");
      return { status: "needsLogin" };
    });
    const state = await _reconnectMcpServer({ a: {} } as any, "a");
    expect(order).toEqual(["disconnect", "connect"]);
    expect(state.status).toBe("needsLogin");
  });
});

describe("_logoutMcpServer", () => {
  it("returns success for loggedOut and failure for failed", async () => {
    (bridge.logout as any).mockResolvedValueOnce({ status: "loggedOut" });
    expect((await _logoutMcpServer("a")).success).toBe(true);
    (bridge.logout as any).mockResolvedValueOnce({ status: "failed", message: "disk" });
    const result = await _logoutMcpServer("a");
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toBe("disk");
  });
});
