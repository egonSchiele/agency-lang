import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _browserUse as browserUse } from "../browserUse.js";

const FAKE_KEY = "bu_test-key-123";

function mockFetchResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe("browserUse", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.BROWSER_USE_API_KEY;

  beforeEach(() => {
    process.env.BROWSER_USE_API_KEY = FAKE_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.BROWSER_USE_API_KEY = originalEnv;
    } else {
      delete process.env.BROWSER_USE_API_KEY;
    }
  });

  it("creates a session with the task", async () => {
    const mockFetch = mockFetchResponse({
      id: "sess-123",
      status: "stopped",
      output: "result text",
    });
    globalThis.fetch = mockFetch;

    await browserUse("Find trending repos on GitHub");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.browser-use.com/api/v3/sessions");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.task).toBe("Find trending repos on GitHub");
  });

  it("sends API key in X-Browser-Use-API-Key header", async () => {
    const mockFetch = mockFetchResponse({
      id: "sess-123",
      status: "stopped",
      output: "",
    });
    globalThis.fetch = mockFetch;

    await browserUse("test task");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-Browser-Use-API-Key"]).toBe(FAKE_KEY);
  });

  it("uses apiKey option over env var", async () => {
    const mockFetch = mockFetchResponse({
      id: "sess-123",
      status: "stopped",
      output: "",
    });
    globalThis.fetch = mockFetch;

    await browserUse("test", { apiKey: "bu_override" });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-Browser-Use-API-Key"]).toBe("bu_override");
  });

  it("returns output from a completed session", async () => {
    globalThis.fetch = mockFetchResponse({
      id: "sess-456",
      status: "stopped",
      output: "The top repos are...",
    });

    const result = await browserUse("Find repos");

    expect(result).toEqual({
      output: "The top repos are...",
      status: "stopped",
      sessionId: "sess-456",
    });
  });

  it("polls when session is not immediately complete", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (callCount === 1) {
        // POST /sessions - returns running
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "sess-789", status: "running" }),
        };
      }
      // GET /sessions/sess-789 - returns stopped
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "sess-789",
          status: "stopped",
          output: "done",
        }),
      };
    });

    const result = await browserUse("task");

    expect(result.output).toBe("done");
    expect(result.status).toBe("stopped");
    expect(callCount).toBe(2);
  });

  it("includes optional params in request body", async () => {
    const mockFetch = mockFetchResponse({
      id: "sess-123",
      status: "stopped",
      output: "",
    });
    globalThis.fetch = mockFetch;

    await browserUse("task", {
      model: "bu-max",
      maxCostUsd: 0.5,
      proxyCountryCode: "DE",
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.model).toBe("bu-max");
    expect(body.maxCostUsd).toBe(0.5);
    expect(body.proxyCountryCode).toBe("DE");
  });

  it("omits optional params when not provided", async () => {
    const mockFetch = mockFetchResponse({
      id: "sess-123",
      status: "stopped",
      output: "",
    });
    globalThis.fetch = mockFetch;

    await browserUse("task");

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ task: "task" });
  });

  it("throws when no API key is available", async () => {
    delete process.env.BROWSER_USE_API_KEY;
    await expect(browserUse("test")).rejects.toThrow("BROWSER_USE_API_KEY");
  });

  it("throws on non-200 response", async () => {
    globalThis.fetch = mockFetchResponse(
      { message: "Unauthorized" },
      401
    );

    await expect(browserUse("test")).rejects.toThrow(
      "Browser Use API error (401)"
    );
  });

  it("returns empty output when session has no output", async () => {
    globalThis.fetch = mockFetchResponse({
      id: "sess-123",
      status: "stopped",
    });

    const result = await browserUse("task");
    expect(result.output).toBe("");
  });

  it("handles error status from session", async () => {
    globalThis.fetch = mockFetchResponse({
      id: "sess-err",
      status: "error",
      output: "Something went wrong",
    });

    const result = await browserUse("task");
    expect(result.status).toBe("error");
    expect(result.output).toBe("Something went wrong");
  });
});
