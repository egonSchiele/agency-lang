import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProjectClient, ProjectRequestError } from "./projectClient.js";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function client() {
  return createProjectClient("https://h", "proj", "key");
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("projectClient transport", () => {
  it("GET /agent uses the encoded slug path, bearer header, no body", async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        success: true,
        value: {
          entryPoint: "main.agency",
          lastUploadAt: "2026-08-03T00:00:00Z",
          files: [{ name: "main.agency", nodeNames: ["main"], createdAt: "t", updatedAt: "t" }],
        },
      }),
    );
    await createProjectClient("https://h", "my proj", "key").inspectAgent();
    expect(fetchMock).toHaveBeenCalledWith("https://h/api/projects/my%20proj/agent", {
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
    await expect(client().inspectAgent()).rejects.toThrow(/not found — check the slug/);
  });

  it("HTTP 403 → the server message", async () => {
    fetchMock.mockResolvedValue(
      response(403, { error: "You do not have access to this project" }),
    );
    await expect(client().inspectAgent()).rejects.toThrow("You do not have access to this project");
  });

  it("HTTP 200 success:false 'Trace not found' passes through verbatim", async () => {
    fetchMock.mockResolvedValue(response(200, { success: false, error: "Trace not found" }));
    await expect(client().traceLogs("t1")).rejects.toThrow("Trace not found");
  });

  it("rejects a log whose wire trace_id differs from the request", async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        success: true,
        value: [{ trace_id: "OTHER", span_id: null, parent_span_id: null, data: { type: "enterNode" } }],
      }),
    );
    await expect(client().traceLogs("t1")).rejects.toBeInstanceOf(ProjectRequestError);
  });

  it("maps a valid log row to TraceLog (data opaque, span nullable)", async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        success: true,
        value: [{ trace_id: "t1", span_id: "s", parent_span_id: null, data: { type: "toolCall", x: 1 } }],
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

  it("wraps a network error without exposing the key", async () => {
    fetchMock.mockRejectedValue(new Error("socket closed"));
    const error = await client().inspectAgent().catch((caughtError) => caughtError);
    expect((error as Error).message).toContain("could not reach https://h");
    expect((error as Error).message).not.toContain("key");
  });

  it("accepts null entryPoint/lastUploadAt", async () => {
    fetchMock.mockResolvedValue(
      response(200, { success: true, value: { entryPoint: null, lastUploadAt: null, files: [] } }),
    );
    await expect(client().inspectAgent()).resolves.toEqual({
      entryPoint: null,
      lastUploadAt: null,
      files: [],
    });
  });
});

// Every malformed success value must surface as a ProjectRequestError.
const AGENT = (value: unknown) => ({ success: true, value });
const okFile = { name: "a.agency", nodeNames: ["a"], createdAt: "t", updatedAt: "t" };

describe.each<[string, unknown, "inspectAgent" | "pullSource" | "listTraces" | "traceLogs"]>([
  ["agent entryPoint:42", AGENT({ entryPoint: 42, lastUploadAt: null, files: [] }), "inspectAgent"],
  ["agent lastUploadAt:42", AGENT({ entryPoint: null, lastUploadAt: 42, files: [] }), "inspectAgent"],
  ["agent files:{}", AGENT({ entryPoint: null, lastUploadAt: null, files: {} }), "inspectAgent"],
  ["agent file name:42", AGENT({ entryPoint: null, lastUploadAt: null, files: [{ ...okFile, name: 42 }] }), "inspectAgent"],
  ["agent file nodeNames:42", AGENT({ entryPoint: null, lastUploadAt: null, files: [{ ...okFile, nodeNames: 42 }] }), "inspectAgent"],
  ["agent file createdAt:42", AGENT({ entryPoint: null, lastUploadAt: null, files: [{ ...okFile, createdAt: 42 }] }), "inspectAgent"],
  ["agent file updatedAt:42", AGENT({ entryPoint: null, lastUploadAt: null, files: [{ ...okFile, updatedAt: 42 }] }), "inspectAgent"],
  ["source bare array", AGENT([{ name: "a", contents: "x" }]), "pullSource"],
  ["source files:{}", AGENT({ files: {} }), "pullSource"],
  ["source name:42", AGENT({ files: [{ name: 42, contents: "x" }] }), "pullSource"],
  ["source contents:42", AGENT({ files: [{ name: "a", contents: 42 }] }), "pullSource"],
  ["traces non-array", AGENT({}), "listTraces"],
  ["traces id:''", AGENT([{ id: "", created_at: "t" }]), "listTraces"],
  ["traces id:42", AGENT([{ id: 42, created_at: "t" }]), "listTraces"],
  ["traces created_at:42", AGENT([{ id: "a", created_at: 42 }]), "listTraces"],
  ["logs trace_id:''", AGENT([{ trace_id: "", span_id: null, parent_span_id: null, data: { type: "x" } }]), "traceLogs"],
  ["logs span numeric", AGENT([{ trace_id: "t1", span_id: 42, parent_span_id: null, data: { type: "x" } }]), "traceLogs"],
  ["logs data array", AGENT([{ trace_id: "t1", span_id: null, parent_span_id: null, data: [] }]), "traceLogs"],
  ["logs data.type non-string", AGENT([{ trace_id: "t1", span_id: null, parent_span_id: null, data: { type: 1 } }]), "traceLogs"],
])("rejects malformed success value: %s", (_label, body, method) => {
  it("throws ProjectRequestError", async () => {
    fetchMock.mockResolvedValue(response(200, body));
    const call = method === "traceLogs" ? client().traceLogs("t1") : client()[method]();
    await expect(call).rejects.toBeInstanceOf(ProjectRequestError);
  });
});

describe("projectClient envelope/transport edge cases", () => {
  it("a 2xx whose json() rejects → non-JSON error", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError("bad")),
    } as unknown as Response);
    await expect(client().inspectAgent()).rejects.toThrow(/non-JSON response \(HTTP 200\)/);
  });

  it("a malformed envelope (success not boolean) throws", async () => {
    fetchMock.mockResolvedValue(response(200, { success: "yes" }));
    await expect(client().inspectAgent()).rejects.toThrow("unexpected project response shape");
  });

  it("a non-JSON HTTP 500 mentions HTTP 500", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockRejectedValue(new SyntaxError("bad")),
    } as unknown as Response);
    await expect(client().inspectAgent()).rejects.toThrow("statelog request failed (HTTP 500)");
  });
});
