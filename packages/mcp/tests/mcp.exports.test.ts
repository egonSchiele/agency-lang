import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  mcpRaw,
  connectServer,
  serverStates,
  startLogin,
  finishLogin,
  cancelLogin,
  logout,
  disconnectServer,
  configureServers,
  pendingServers,
  markServerFailed,
} from "../src/mcp.js";
import { startFakeOAuthServer, completeLogin, oauthConfig, type FakeOAuthServer } from "./fakeOAuthServer.js";

// The exports build one manager per process with the default token folder.
// Point that folder at a temporary one, so no test touches ~/.agency/tokens.
const tokenDir = vi.hoisted(() => ({ path: "" }));
vi.mock("../src/tokenStore.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/tokenStore.js")>();
  class TestTokenStore extends original.TokenStore {
    constructor(dir?: string) {
      super(dir ?? tokenDir.path);
    }
  }
  return { ...original, TokenStore: TestTokenStore };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SERVER_PATH = path.join(__dirname, "__tests__", "testServer.mjs");
const stdio = { command: "node", args: [TEST_SERVER_PATH] };

// These tests use the real callback port, 19876, because the exports take no
// port. Every test that starts a login is in this one file, so none of them
// run at the same time.
describe("the 0.0.6 exports", () => {
  let server: FakeOAuthServer;

  beforeAll(async () => {
    tokenDir.path = fs.mkdtempSync(path.join(os.tmpdir(), "agency-mcp-exports-"));
    server = await startFakeOAuthServer();
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(tokenDir.path, { recursive: true, force: true });
  });

  // First, so its callback is the one the manager keeps. The manager is
  // built by the first call, and a later call cannot change its callback.
  it("mcpRaw on an untouched OAuth server with no saved login still logs in", async () => {
    let url = "";
    const raw = mcpRaw("e9", {
      config: { e9: oauthConfig(server) },
      onOAuthRequired: (data) => {
        url = data.authUrl;
      },
    });
    await vi.waitFor(() => expect(url).not.toBe(""));
    await completeLogin(url);
    expect((await raw).success).toBe(true);
    await disconnectServer("e9");
  });

  it("connectServer returns needsLogin for a server with no saved login", async () => {
    expect(await connectServer("e1", { config: { e1: oauthConfig(server) } })).toEqual({ status: "needsLogin" });
    await disconnectServer("e1");
  });

  it("serverStates gives a connected server a callTool that works", async () => {
    expect((await connectServer("e2", { config: { e2: stdio } })).status).toBe("connected");
    const state = (await serverStates()).e2;
    expect(state.status).toBe("connected");
    if (state.status === "connected") {
      expect(await state.callTool("e2", "add", { a: 1, b: 2 })).toContain("3");
    }
    await disconnectServer("e2");
  });

  it("startLogin returns started with a URL, and finishLogin returns connected", async () => {
    const started = await startLogin("e3", { config: { e3: oauthConfig(server) } });
    expect(started.status).toBe("started");
    if (started.status !== "started") {
      return;
    }
    const finished = finishLogin("e3");
    await completeLogin(started.authUrl);
    expect((await finished).status).toBe("connected");
    await disconnectServer("e3");
  });

  it("cancelLogin makes a waiting finishLogin return failed with 'login cancelled'", async () => {
    await startLogin("e4", { config: { e4: oauthConfig(server) } });
    const finished = finishLogin("e4");
    await cancelLogin("e4");
    expect(await finished).toEqual({ status: "failed", message: "login cancelled" });
  });

  it("finishLogin with no login in progress returns the no-login failure", async () => {
    expect(await finishLogin("e5")).toEqual({ status: "failed", message: "no login in progress for e5" });
  });

  it("logout returns loggedOut", async () => {
    const started = await startLogin("e6", { config: { e6: oauthConfig(server) } });
    if (started.status !== "started") {
      throw new Error(`login did not start: ${JSON.stringify(started)}`);
    }
    const finished = finishLogin("e6");
    await completeLogin(started.authUrl);
    await finished;
    expect(await logout("e6")).toEqual({ status: "loggedOut" });
    expect((await serverStates()).e6).toEqual({ status: "needsLogin" });
    await disconnectServer("e6");
  });

  it("a later call with a changed config uses the new config", async () => {
    expect((await connectServer("e7", { config: { e7: { command: "nonexistent-command-xyz" } } })).status).toBe(
      "failed",
    );
    expect((await connectServer("e7", { config: { e7: stdio } })).status).toBe("connected");
    await disconnectServer("e7");
  });

  it("configureServers stores the config, and pendingServers lists the servers with no record", async () => {
    configureServers({ config: { p1: stdio, p2: stdio } });
    expect(Object.keys(await pendingServers())).toEqual(["p1", "p2"]);
    await connectServer("p1", { config: { p1: stdio, p2: stdio } });
    await markServerFailed("p2", "not approved");
    expect(await pendingServers()).toEqual({});
    expect((await serverStates()).p2).toEqual({ status: "failed", message: "not approved" });
    await disconnectServer("p1");
    await disconnectServer("p2");
    expect(Object.keys(await pendingServers())).toEqual(["p1", "p2"]);
  });

  it("mcpRaw without a config leaves the stored config alone", async () => {
    await connectServer("e8", { config: { e8: stdio } });
    await disconnectServer("e8");
    expect((await mcpRaw("e8")).success).toBe(true);
    await disconnectServer("e8");
  });
});
