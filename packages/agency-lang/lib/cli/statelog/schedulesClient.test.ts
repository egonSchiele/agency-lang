import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSchedulesClient, ScheduleRequestError } from "./schedulesClient.js";
import type { RemoteSchedule } from "./schedulesClient.js";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function nonJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token <")),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function client() {
  return createSchedulesClient("https://h", "proj", "secret-key");
}

const wireSchedule = {
  id: "s1",
  name: null,
  fileName: "daily",
  targetKind: "node",
  targetName: "refresh",
  args: { country: "India" },
  cronExpr: "0 9 * * *",
  timezone: "UTC",
  enabled: true,
  nextRunAt: "2026-08-10T09:00:00.000Z",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};

const expectedSchedule: RemoteSchedule = { ...wireSchedule, targetKind: "node" };

const createInput = {
  fileName: "daily",
  target: { kind: "node" as const, name: "refresh" },
  args: { country: "India" },
  cronExpr: "0 9 * * *",
  timezone: "UTC",
};

function lastRequest(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return { url: call[0] as string, init: call[1] as RequestInit };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("schedulesClient transport", () => {
  it("create POSTs to the schedules route with bearer auth and a flattened target", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: wireSchedule }));
    await client().create(createInput);
    const { url, init } = lastRequest();
    expect(url).toBe("https://h/api/projects/proj/schedules");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      fileName: "daily",
      targetKind: "node",
      targetName: "refresh",
      args: { country: "India" },
      cronExpr: "0 9 * * *",
      timezone: "UTC",
    });
  });

  it("create omits an undefined name and preserves an explicit null name", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: wireSchedule }));
    await client().create(createInput);
    expect(JSON.parse(lastRequest().init.body as string)).not.toHaveProperty("name");

    await client().create({ ...createInput, name: null });
    expect(JSON.parse(lastRequest().init.body as string)).toHaveProperty("name", null);

    await client().create({ ...createInput, name: "mine" });
    expect(JSON.parse(lastRequest().init.body as string)).toHaveProperty("name", "mine");
  });

  it("list GETs the schedules route without a body", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: [] }));
    await client().list();
    const { url, init } = lastRequest();
    expect(url).toBe("https://h/api/projects/proj/schedules");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Authorization: "Bearer secret-key" });
    expect(init.body).toBeUndefined();
  });

  it("patch PATCHes the schedule route with only the supplied fields", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: wireSchedule }));
    await client().patch("s1", { enabled: false });
    const { url, init } = lastRequest();
    expect(url).toBe("https://h/api/projects/proj/schedules/s1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
  });

  it("delete DELETEs the schedule route without a body", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: { deleted: true } }));
    await client().delete("s1");
    const { url, init } = lastRequest();
    expect(url).toBe("https://h/api/projects/proj/schedules/s1");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("encodes the project slug as a path segment", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: [] }));
    await createSchedulesClient("https://h", "my project", "k").list();
    expect(lastRequest().url).toBe("https://h/api/projects/my%20project/schedules");
  });

  it("encodes the schedule id as a path segment", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: { deleted: true } }));
    await client().delete("id/one");
    expect(lastRequest().url).toBe("https://h/api/projects/proj/schedules/id%2Fone");
  });
});

describe("schedulesClient valid responses", () => {
  it("create returns the validated schedule", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: wireSchedule }));
    await expect(client().create(createInput)).resolves.toEqual(expectedSchedule);
  });

  it("list returns schedules in server order", async () => {
    const second = { ...wireSchedule, id: "s2", name: "second" };
    fetchMock.mockResolvedValue(response(200, { success: true, value: [second, wireSchedule] }));
    const listed = await client().list();
    expect(listed.map((schedule) => schedule.id)).toEqual(["s2", "s1"]);
  });

  it("patch returns the validated schedule", async () => {
    const disabled = { ...wireSchedule, enabled: false };
    fetchMock.mockResolvedValue(response(200, { success: true, value: disabled }));
    await expect(client().patch("s1", { enabled: false })).resolves.toEqual({
      ...expectedSchedule,
      enabled: false,
    });
  });

  it("delete returns the deletion receipt", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: { deleted: true } }));
    await expect(client().delete("s1")).resolves.toEqual({ deleted: true });
  });
});

describe("schedulesClient malformed values", () => {
  const malformed: Array<[string, Record<string, unknown>]> = [
    ["missing id", (({ id: _, ...rest }) => rest)(wireSchedule)],
    ["non-string id", { ...wireSchedule, id: 7 }],
    ["invalid targetKind", { ...wireSchedule, targetKind: "job" }],
    ["non-object args", { ...wireSchedule, args: "x" }],
    ["array args", { ...wireSchedule, args: [1] }],
    ["non-boolean enabled", { ...wireSchedule, enabled: "yes" }],
    ["non-string non-null name", { ...wireSchedule, name: 5 }],
    ["missing nextRunAt", (({ nextRunAt: _, ...rest }) => rest)(wireSchedule)],
    ["non-string createdAt", { ...wireSchedule, createdAt: 0 }],
    ["non-string updatedAt", { ...wireSchedule, updatedAt: false }],
  ];

  describe.each(malformed)("%s", (_label, value) => {
    it("rejects create", async () => {
      fetchMock.mockResolvedValue(response(200, { success: true, value }));
      await expect(client().create(createInput)).rejects.toBeInstanceOf(ScheduleRequestError);
    });
  });

  it("rejects a non-array list value", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: wireSchedule }));
    await expect(client().list()).rejects.toBeInstanceOf(ScheduleRequestError);
  });

  it("rejects a malformed deletion receipt", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: { deleted: false } }));
    await expect(client().delete("s1")).rejects.toBeInstanceOf(ScheduleRequestError);
  });
});

describe("schedulesClient failures", () => {
  it("HTTP 200 success:false carries the server message and status", async () => {
    fetchMock.mockResolvedValue(
      response(200, { success: false, error: "Agent 'daily' not found" }),
    );
    const failure = await client()
      .create(createInput)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ScheduleRequestError);
    expect((failure as ScheduleRequestError).message).toBe("Agent 'daily' not found");
    expect((failure as ScheduleRequestError).status).toBe(200);
  });

  it("a malformed envelope is rejected", async () => {
    fetchMock.mockResolvedValue(response(200, { value: wireSchedule }));
    await expect(client().list()).rejects.toBeInstanceOf(ScheduleRequestError);
  });

  it("a non-JSON 2xx is rejected with the status", async () => {
    fetchMock.mockResolvedValue(nonJsonResponse(200));
    await expect(client().list()).rejects.toThrow(/non-JSON response \(HTTP 200\)/);
  });

  it.each([[401], [403], [404], [500]])("JSON HTTP %d preserves message and status", async (status) => {
    fetchMock.mockResolvedValue(response(status, { error: `server says ${status}` }));
    const failure = await client()
      .list()
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ScheduleRequestError);
    expect((failure as ScheduleRequestError).message).toBe(`server says ${status}`);
    expect((failure as ScheduleRequestError).status).toBe(status);
  });

  it("a non-JSON 500 reports the status", async () => {
    fetchMock.mockResolvedValue(nonJsonResponse(500));
    await expect(client().list()).rejects.toThrow(/HTTP 500/);
  });

  it("a rejected fetch reports the unreachable origin", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(client().list()).rejects.toThrow(/could not reach https:\/\/h/);
  });

  it("no failure message contains the API key", async () => {
    const failures: unknown[] = [];
    const collect = (error: unknown) => {
      failures.push(error);
      return null;
    };
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await client().list().then(() => null, collect);
    fetchMock.mockResolvedValueOnce(response(401, { error: "nope" }));
    await client().list().then(() => null, collect);
    fetchMock.mockResolvedValueOnce(response(200, { success: false, error: "bad" }));
    await client().list().then(() => null, collect);
    expect(failures).toHaveLength(3);
    for (const failure of failures) {
      expect((failure as Error).message).not.toContain("secret-key");
    }
  });
});
