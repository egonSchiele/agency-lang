import { describe, it, expect } from "vitest";
import { CallbackServer, callbackUrlFor } from "../src/callbackServer.js";
import { freePort } from "./fakeOAuthServer.js";

const STATE = "s1";

async function startedServer(timeoutMs?: number): Promise<{ server: CallbackServer; url: string }> {
  const port = await freePort();
  const server = new CallbackServer({ port, state: STATE, timeoutMs });
  await server.start();
  return { server, url: callbackUrlFor(port) };
}

describe("CallbackServer", () => {
  it("builds the callback URL for a port", () => {
    expect(callbackUrlFor(4321)).toBe("http://127.0.0.1:4321/oauth/callback");
  });

  it("uses the default fixed port when no port is given", () => {
    expect(callbackUrlFor()).toBe("http://127.0.0.1:19876/oauth/callback");
  });

  it("resolves with the authorization code when the callback is received", async () => {
    const { server, url } = await startedServer();
    const response = await fetch(`${url}?code=auth-code-123&state=${STATE}`);
    expect(response.ok).toBe(true);
    expect(await server.waitForCode()).toBe("auth-code-123");
    await server.stop();
  });

  it("refuses a request with another state", async () => {
    const { server, url } = await startedServer();
    const res = await fetch(`${url}?code=c&state=other`);
    expect(res.status).toBe(403);
    await server.stop();
  });

  it("refuses a request with no code", async () => {
    const { server, url } = await startedServer();
    const response = await fetch(`${url}?state=${STATE}`);
    expect(response.status).toBe(400);
    await server.stop();
  });

  it("times out when no callback is received", async () => {
    const { server } = await startedServer(200);
    await expect(server.waitForCode()).rejects.toThrow(/timed out/i);
    await server.stop();
  });

  it("does not time out before waitForCode is called", async () => {
    const { server } = await startedServer(30);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const wait = server.waitForCode(); // the timer starts here
    await expect(wait).rejects.toThrow("OAuth callback timed out");
  });

  it("stop rejects a pending waitForCode", async () => {
    const { server } = await startedServer();
    const wait = server.waitForCode();
    await server.stop();
    await expect(wait).rejects.toThrow("login cancelled");
  });

  it("stop with nobody waiting raises no unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onRejection);
    const { server } = await startedServer();
    await server.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", onRejection);
    expect(seen).toEqual([]);
  });
});
