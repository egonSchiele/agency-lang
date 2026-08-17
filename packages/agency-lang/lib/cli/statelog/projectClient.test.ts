import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProjectClient, ProjectRequestError } from "./projectClient.js";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "",
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

function nonJsonResponse(status: number, body = "<!doctype html><p>oops</p>"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "",
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function client() {
  return createProjectClient("https://h", "proj", "key");
}

// A well-formed `source` envelope, used as the transport vehicle for the
// route/error tests that aren't about a specific value shape.
const okSource = { success: true, value: { files: [] } };

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("projectClient transport", () => {
  it("GET /source uses the encoded slug path, bearer header, no body", async () => {
    fetchMock.mockResolvedValue(response(200, okSource));
    await createProjectClient("https://h", "my proj", "key").pullSource();
    expect(fetchMock).toHaveBeenCalledWith("https://h/api/projects/my%20proj/source", {
      method: "GET",
      headers: { Authorization: "Bearer key" },
    });
  });

  it("encodes the trace id as an independent path segment", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: [] }));
    await createProjectClient("https://h", "my proj", "key").traceLogs("trace/one");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://h/api/projects/my%20proj/traces/trace%2Fone/logs",
      expect.any(Object),
    );
  });

  it("HTTP 404 → the actionable slug message", async () => {
    fetchMock.mockResolvedValue(response(404, { error: "Project not found" }));
    await expect(client().pullSource()).rejects.toThrow(/not found — check the slug/);
  });

  it("HTTP 403 → the server message", async () => {
    fetchMock.mockResolvedValue(response(403, { error: "You do not have access to this project" }));
    await expect(client().pullSource()).rejects.toThrow("You do not have access to this project");
  });

  it("HTTP 200 success:false 'Trace not found' passes through verbatim", async () => {
    fetchMock.mockResolvedValue(response(200, { success: false, error: "Trace not found" }));
    await expect(client().traceLogs("t1")).rejects.toThrow("Trace not found");
  });

  it("rejects a log whose wire trace_id differs from the request", async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        success: true,
        value: [
          { trace_id: "OTHER", span_id: null, parent_span_id: null, data: { type: "enterNode" } },
        ],
      }),
    );
    await expect(client().traceLogs("t1")).rejects.toBeInstanceOf(ProjectRequestError);
  });

  it("maps a valid log row to TraceLog (data opaque, span nullable)", async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        success: true,
        value: [
          { trace_id: "t1", span_id: "s", parent_span_id: null, data: { type: "toolCall", x: 1 } },
        ],
      }),
    );
    await expect(client().traceLogs("t1")).resolves.toEqual([
      { traceId: "t1", spanId: "s", parentSpanId: null, data: { type: "toolCall", x: 1 } },
    ]);
  });

  it("rejects an empty traceLogs argument before fetch", async () => {
    await expect(client().traceLogs("")).rejects.toBeInstanceOf(ProjectRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps created_at→createdAt and preserves server order", async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        success: true,
        value: [
          { id: "b", created_at: "2026-08-03T02:00:00Z", project_id: "x" },
          { id: "a", created_at: "2026-08-03T01:00:00Z", project_id: "x" },
        ],
      }),
    );
    expect((await client().listTraces()).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("maps a source bundle to name/contents files", async () => {
    fetchMock.mockResolvedValue(
      response(200, { success: true, value: { files: [{ name: "a.agency", contents: "x" }] } }),
    );
    await expect(client().pullSource()).resolves.toEqual([{ name: "a.agency", contents: "x" }]);
  });

  it("wraps a network error without exposing the key", async () => {
    fetchMock.mockRejectedValue(new Error("socket closed"));
    const error = await client()
      .pullSource()
      .catch((caughtError) => caughtError);
    expect((error as Error).message).toContain("could not reach https://h");
    expect((error as Error).message).not.toContain("key");
  });
});

// Every malformed success value must surface as a ProjectRequestError.
const ENVELOPE = (value: unknown) => ({ success: true, value });

describe.each<[string, unknown, "pullSource" | "listTraces" | "traceLogs"]>([
  ["source bare array", ENVELOPE([{ name: "a", contents: "x" }]), "pullSource"],
  ["source files:{}", ENVELOPE({ files: {} }), "pullSource"],
  ["source name:42", ENVELOPE({ files: [{ name: 42, contents: "x" }] }), "pullSource"],
  ["source contents:42", ENVELOPE({ files: [{ name: "a", contents: 42 }] }), "pullSource"],
  ["traces non-array", ENVELOPE({}), "listTraces"],
  ["traces id:''", ENVELOPE([{ id: "", created_at: "t" }]), "listTraces"],
  ["traces id:42", ENVELOPE([{ id: 42, created_at: "t" }]), "listTraces"],
  ["traces created_at:42", ENVELOPE([{ id: "a", created_at: 42 }]), "listTraces"],
  [
    "logs trace_id:''",
    ENVELOPE([{ trace_id: "", span_id: null, parent_span_id: null, data: { type: "x" } }]),
    "traceLogs",
  ],
  [
    "logs span numeric",
    ENVELOPE([{ trace_id: "t1", span_id: 42, parent_span_id: null, data: { type: "x" } }]),
    "traceLogs",
  ],
  [
    "logs data array",
    ENVELOPE([{ trace_id: "t1", span_id: null, parent_span_id: null, data: [] }]),
    "traceLogs",
  ],
  [
    "logs data.type non-string",
    ENVELOPE([{ trace_id: "t1", span_id: null, parent_span_id: null, data: { type: 1 } }]),
    "traceLogs",
  ],
])("rejects malformed success value: %s", (_label, body, method) => {
  it("throws ProjectRequestError", async () => {
    fetchMock.mockResolvedValue(response(200, body));
    const call = method === "traceLogs" ? client().traceLogs("t1") : client()[method]();
    await expect(call).rejects.toBeInstanceOf(ProjectRequestError);
  });
});

describe("projectClient envelope/transport edge cases", () => {
  it("a 2xx non-JSON body → non-JSON error naming the request and body", async () => {
    fetchMock.mockResolvedValue(nonJsonResponse(200));
    const failure = await client()
      .pullSource()
      .then(
        () => null,
        (error: Error) => error.message,
      );
    expect(failure).toMatch(/non-JSON response \(HTTP 200\)/);
    expect(failure).toContain("GET https://h/api/projects/proj/source");
    expect(failure).toContain("<!doctype html><p>oops</p>");
  });

  it("a malformed envelope (success not boolean) throws", async () => {
    fetchMock.mockResolvedValue(response(200, { success: "yes" }));
    await expect(client().pullSource()).rejects.toThrow("unexpected project response shape");
  });

  it("a non-JSON HTTP 500 mentions HTTP 500", async () => {
    fetchMock.mockResolvedValue(nonJsonResponse(500));
    await expect(client().pullSource()).rejects.toThrow("statelog request failed (HTTP 500)");
  });
});

describe("projectClient.getSpend", () => {
  const usd = {
    inputCost: 0.3,
    outputCost: 0.2,
    cachedInputCost: 0,
    cacheCreationInputCost: 0,
    hostedToolsCost: 0,
    totalCost: 0.5,
    currency: "USD",
  };
  const tok = {
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 12,
  };
  const okSpend = {
    success: true,
    value: {
      cost: usd,
      tokens: tok,
      invocationCount: 3,
      unpricedCallCount: 0,
      pricingComplete: true,
      usageComplete: true,
      breakdown: [],
      breakdownTruncated: false,
      otherSpend: {
        cost: {
          inputCost: 0,
          outputCost: 0,
          cachedInputCost: 0,
          cacheCreationInputCost: 0,
          hostedToolsCost: 0,
          totalCost: 0,
          currency: "USD",
        },
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: 0,
        },
      },
    },
  };

  it("GETs the spend route with both bounds as query params", async () => {
    fetchMock.mockResolvedValue(response(200, okSpend));
    const spend = await client().getSpend({ from: 1000, to: 2000 });
    expect(fetchMock).toHaveBeenCalledWith("https://h/api/projects/proj/spend?from=1000&to=2000", {
      method: "GET",
      headers: { Authorization: "Bearer key" },
    });
    expect(spend.cost.totalCost).toBe(0.5);
  });

  it("omits a null bound (from-only, to-only, neither)", async () => {
    fetchMock.mockResolvedValue(response(200, okSpend));
    await client().getSpend({ from: 1000, to: null });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://h/api/projects/proj/spend?from=1000",
      expect.any(Object),
    );
    await client().getSpend({ from: null, to: 2000 });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://h/api/projects/proj/spend?to=2000",
      expect.any(Object),
    );
    await client().getSpend({ from: null, to: null });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://h/api/projects/proj/spend",
      expect.any(Object),
    );
  });

  it("rejects a malformed spend shape as a ProjectRequestError", async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        success: true,
        value: { ...okSpend.value, cost: { ...usd, totalCost: -1 } },
      }),
    );
    await expect(client().getSpend({ from: null, to: null })).rejects.toBeInstanceOf(
      ProjectRequestError,
    );
  });

  it("keeps project-not-found for the known JSON 404", async () => {
    fetchMock.mockResolvedValue(response(404, { error: "Project not found" }));
    await expect(client().getSpend({ from: null, to: null })).rejects.toThrow(
      /not found — check the slug/,
    );
  });

  it("reports an unsupported host for any other 404 (JSON and non-JSON)", async () => {
    fetchMock.mockResolvedValue(response(404, { error: "Not Found" }));
    await expect(client().getSpend({ from: null, to: null })).rejects.toThrow(
      /does not support the spend API/,
    );
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      url: "",
      text: vi.fn().mockResolvedValue("<html>bad</html>"),
    } as unknown as Response);
    await expect(client().getSpend({ from: null, to: null })).rejects.toThrow(
      /does not support the spend API/,
    );
  });

  it("leaves a non-JSON 5xx as a server error (not unsupported host)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      url: "",
      text: vi.fn().mockResolvedValue("<html>bad</html>"),
    } as unknown as Response);
    await expect(client().getSpend({ from: null, to: null })).rejects.toThrow(
      "statelog request failed (HTTP 503)",
    );
  });
});

describe("projectClient.fetchAgentInfo", () => {
  const info = {
    entryPoint: "agent.agency",
    lastUploadAt: "2026-08-17T00:00:00.000Z",
    files: [
      {
        name: "agent.agency",
        nodeNames: ["main"],
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
      },
    ],
  };

  it("GETs the agent route and returns the validated info", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: info }));
    await expect(client().fetchAgentInfo()).resolves.toEqual(info);
    expect(fetchMock).toHaveBeenCalledWith("https://h/api/projects/proj/agent", {
      method: "GET",
      headers: { Authorization: "Bearer key" },
    });
  });

  it("rejects a malformed shape as a ProjectRequestError", async () => {
    fetchMock.mockResolvedValue(
      response(200, { success: true, value: { entryPoint: null, lastUploadAt: null } }),
    );
    await expect(client().fetchAgentInfo()).rejects.toBeInstanceOf(ProjectRequestError);
  });

  it("keeps project-not-found for the known JSON 404", async () => {
    fetchMock.mockResolvedValue(response(404, { error: "Project not found" }));
    await expect(client().fetchAgentInfo()).rejects.toThrow(/not found — check the slug/);
  });

  it("reports an unsupported host for any other 404", async () => {
    fetchMock.mockResolvedValue(response(404, { error: "Not Found" }));
    await expect(client().fetchAgentInfo()).rejects.toThrow(/does not support the agent-info API/);
  });
});
