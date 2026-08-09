import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { statelogRequest } from "./statelogRequest.js";
import type { StatelogRequestOptions } from "./statelogRequest.js";

function textResponse(status: number, rawBody: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "",
    text: vi.fn().mockResolvedValue(rawBody),
  } as unknown as Response;
}

function jsonResponse(status: number, body: unknown): Response {
  return textResponse(status, JSON.stringify(body));
}

let fetchMock: ReturnType<typeof vi.fn>;

function request(overrides: Partial<StatelogRequestOptions> = {}) {
  return statelogRequest({
    method: "GET",
    url: "https://h/api/x",
    apiKey: "key",
    ...overrides,
  });
}

async function failureOf(overrides: Partial<StatelogRequestOptions> = {}) {
  const result = await request(overrides);
  if (result.ok) throw new Error("expected a failure");
  return result.failure;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("statelogRequest precedence matrix", () => {
  it("2xx non-JSON → non-json with the diagnostic", async () => {
    fetchMock.mockResolvedValue(textResponse(200, "<html>"));
    const failure = await failureOf();
    expect(failure.kind).toBe("non-json");
    if (failure.kind !== "non-json") return;
    expect(failure.status).toBe(200);
    expect(failure.diagnostic).toContain("non-JSON response (HTTP 200)");
  });

  it("non-2xx non-JSON under the default policy → http with no serverError", async () => {
    fetchMock.mockResolvedValue(textResponse(500, "<html>"));
    expect(await failureOf()).toEqual({ kind: "http", status: 500 });
  });

  it("non-2xx bare { error } → http with serverError", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "denied" }));
    expect(await failureOf()).toEqual({ kind: "http", status: 403, serverError: "denied" });
  });

  it("non-2xx { success:false, error } → http, NOT envelope-error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { success: false, error: "boom" }));
    expect(await failureOf()).toEqual({ kind: "http", status: 500, serverError: "boom" });
  });

  it("non-2xx success envelope under the default policy → http", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { success: true, value: 1 }));
    expect(await failureOf()).toEqual({ kind: "http", status: 500 });
  });

  it("envelope:false still rejects non-2xx under the default policy", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { fine: true }));
    expect(await failureOf({ envelope: false })).toEqual({ kind: "http", status: 500 });
  });

  it("requireOk:false returns parsed JSON at any status", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { success: true, value: "kept" }));
    const result = await request({ requireOk: false });
    expect(result).toEqual({ ok: true, value: "kept", status: 500 });
  });

  it("requireOk:false still yields non-json on a parse failure", async () => {
    fetchMock.mockResolvedValue(textResponse(500, "<html>"));
    const failure = await failureOf({ requireOk: false });
    expect(failure.kind).toBe("non-json");
  });

  it("rejected fetch → unreachable with the cause", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await failureOf()).toEqual({ kind: "unreachable", cause: "ECONNREFUSED" });
  });

  it("2xx non-envelope object with envelope:true → bad-envelope", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { value: 1 }));
    expect(await failureOf()).toEqual({ kind: "bad-envelope", status: 200 });
  });

  it("success:false at 2xx → envelope-error with serverError", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: false, error: "nope" }));
    expect(await failureOf()).toEqual({
      kind: "envelope-error",
      status: 200,
      serverError: "nope",
    });
  });

  it("success:true → the value and the status", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, value: { a: 1 } }));
    expect(await request()).toEqual({ ok: true, value: { a: 1 }, status: 200 });
  });

  it("envelope:false at 2xx returns the bare parsed value", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { nodes: [] }));
    expect(await request({ envelope: false })).toEqual({
      ok: true,
      value: { nodes: [] },
      status: 200,
    });
  });
});

describe("statelogRequest construction", () => {
  it("sends Bearer always; when-body adds Content-Type only with a body", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, value: 1 }));
    await request();
    expect(fetchMock.mock.calls[0]![1]).toEqual({
      method: "GET",
      headers: { Authorization: "Bearer key" },
      body: undefined,
    });

    await request({ method: "POST", body: { a: 1 } });
    expect(fetchMock.mock.calls[1]![1]).toEqual({
      method: "POST",
      headers: { Authorization: "Bearer key", "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
  });

  it("contentType:'always' adds the header on a bodyless GET", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, value: 1 }));
    await request({ contentType: "always" });
    expect(fetchMock.mock.calls[0]![1]).toEqual({
      method: "GET",
      headers: { Authorization: "Bearer key", "Content-Type": "application/json" },
      body: undefined,
    });
  });

  it("forwards the sanitizer to readJsonBody's diagnostics", async () => {
    fetchMock.mockResolvedValue(textResponse(200, "<html>sk-live-EXTREMELY-SECRET</html>"));
    const failure = await failureOf({
      sanitizeDiagnostic: (raw) => raw.split("sk-live-EXTREMELY-SECRET").join("[redacted]"),
    });
    expect(failure.kind).toBe("non-json");
    if (failure.kind !== "non-json") return;
    expect(failure.diagnostic).toContain("[redacted]");
    expect(failure.diagnostic).not.toContain("sk-live-EXTREMELY-SECRET");
  });
});

describe("statelogRequest programmer-error boundary", () => {
  it("an unserializable body propagates the native error, never unreachable", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, value: 1 }));
    await expect(request({ method: "POST", body: { n: 1n } })).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a throwing sanitizer propagates rather than returning a failure", async () => {
    fetchMock.mockResolvedValue(textResponse(200, "<html>"));
    await expect(
      request({
        sanitizeDiagnostic: () => {
          throw new Error("sanitizer bug");
        },
      }),
    ).rejects.toThrow("sanitizer bug");
  });
});
