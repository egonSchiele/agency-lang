import { describe, it, expect } from "vitest";
import { CallbackServer } from "../src/callbackServer.js";

// Use port 0 in tests so the OS assigns a random available port,
// avoiding collisions with other tests or the default port.
const testOpts = { port: 0 };

describe("CallbackServer", () => {
  it("should start and return a URL with the correct port", async () => {
    const server = new CallbackServer(testOpts);
    const url = await server.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    await server.stop();
  });

  it("should use the default fixed port when no port is specified", () => {
    const server = new CallbackServer();
    // Before start(), callbackUrl reflects the configured port
    expect(server.callbackUrl).toBe("http://127.0.0.1:19876/oauth/callback");
  });

  it("should resolve with the authorization code when callback is received", async () => {
    const server = new CallbackServer(testOpts);
    const url = await server.start();
    const state = server.state;

    const callbackUrl = `${url}?code=auth-code-123&state=${state}`;
    const response = await fetch(callbackUrl);
    expect(response.ok).toBe(true);

    const code = await server.waitForCode();
    expect(code).toBe("auth-code-123");

    await server.stop();
  });

  it("should reject when state parameter doesn't match", async () => {
    const server = new CallbackServer(testOpts);
    const url = await server.start();

    const callbackUrl = `${url}?code=auth-code-123&state=wrong-state`;
    const response = await fetch(callbackUrl);
    expect(response.status).toBe(403);

    await server.stop();
  });

  it("should reject when code is missing", async () => {
    const server = new CallbackServer(testOpts);
    const url = await server.start();
    const state = server.state;

    const callbackUrl = `${url}?state=${state}`;
    const response = await fetch(callbackUrl);
    expect(response.status).toBe(400);

    await server.stop();
  });

  it("should time out if no callback is received", async () => {
    const server = new CallbackServer({ ...testOpts, timeoutMs: 200 });
    await server.start();

    await expect(server.waitForCode()).rejects.toThrow(/timed out/i);

    await server.stop();
  });

  it("should stop cleanly even if no callback was received", async () => {
    const server = new CallbackServer(testOpts);
    await server.start();
    await server.stop();
  });
});
