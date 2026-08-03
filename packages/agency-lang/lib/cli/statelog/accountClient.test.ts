import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createAccountClient,
  AccountRequestError,
  AccountScopeError,
  type AccountClient,
} from "./accountClient.js";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function rawProject(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "db-project-1",
    project_id: "public-project",
    name: "Public Project",
    description: null,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let client: AccountClient;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  client = createAccountClient("https://host.example", "top-secret-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("accountClient transport", () => {
  it("GET whoami uses the exact route, bearer header, and no body", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: { userId: "user-1" } }));
    await expect(client.whoami()).resolves.toEqual({ userId: "user-1" });
    expect(fetchMock).toHaveBeenCalledWith("https://host.example/api/whoami", {
      method: "GET",
      headers: { Authorization: "Bearer top-secret-key" },
    });
  });

  it("lists projects through /api/projects and strips the private id", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: [rawProject()] }));
    const projects = await client.listProjects();
    expect(projects).toEqual([
      { projectId: "public-project", name: "Public Project", description: null },
    ]);
    expect(JSON.stringify(projects)).not.toContain("db-project-1");
  });

  it("POST projects sends content type and the exact wire body", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: rawProject() }));
    await client.createProject({ name: "Public Project", projectId: "public-project" });
    expect(fetchMock).toHaveBeenCalledWith("https://host.example/api/projects", {
      method: "POST",
      headers: {
        Authorization: "Bearer top-secret-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Public Project",
        project_id: "public-project",
        description: null,
      }),
    });
  });

  it("handles bare non-2xx JSON before envelope validation", async () => {
    fetchMock.mockResolvedValue(response(401, { error: "Invalid API key" }));
    await expect(client.whoami()).rejects.toThrow("Invalid API key");
  });

  it("types only the exact known scope error", async () => {
    fetchMock.mockResolvedValue(
      response(403, { error: "This endpoint requires an account-scoped API key" }),
    );
    await expect(client.listProjects()).rejects.toBeInstanceOf(AccountScopeError);
  });

  it("preserves a different 403 as a general request error", async () => {
    fetchMock.mockResolvedValue(
      response(403, { error: "Your account has not been approved yet." }),
    );
    const error = await client.listProjects().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountRequestError);
    expect(error).not.toBeInstanceOf(AccountScopeError);
    expect(error).toMatchObject({ message: "Your account has not been approved yet." });
  });

  it("falls back for a 401 with no server error string", async () => {
    fetchMock.mockResolvedValue(response(401, {}));
    await expect(client.whoami()).rejects.toThrow("not authenticated (HTTP 401)");
  });

  it("surfaces a success:false body's error", async () => {
    fetchMock.mockResolvedValue(response(200, { success: false, error: "nope" }));
    await expect(client.listProjects()).rejects.toThrow("nope");
  });

  it("rejects a success envelope missing userId", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: {} }));
    await expect(client.whoami()).rejects.toThrow(/userId/);
  });

  it("rejects a project missing a required field", async () => {
    fetchMock.mockResolvedValue(
      response(200, { success: true, value: [rawProject({ name: 42 })] }),
    );
    await expect(client.listProjects()).rejects.toBeInstanceOf(AccountRequestError);
  });

  it("rejects a non-JSON 200 body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError("bad json")),
    } as unknown as Response);
    await expect(client.whoami()).rejects.toThrow(
      "statelog returned a non-JSON response (HTTP 200)",
    );
  });

  it("rejects a non-JSON 500 body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockRejectedValue(new SyntaxError("bad json")),
    } as unknown as Response);
    await expect(client.whoami()).rejects.toThrow("statelog request failed (HTTP 500)");
  });

  it("rejects a malformed 200 envelope", async () => {
    fetchMock.mockResolvedValue(response(200, { value: "no success flag" }));
    await expect(client.whoami()).rejects.toThrow("unexpected account response shape");
  });

  it("wraps a network error without exposing the API key", async () => {
    fetchMock.mockRejectedValue(new Error("socket closed"));
    const error = await client.whoami().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountRequestError);
    expect((error as Error).message).toContain("could not reach https://host.example");
    expect((error as Error).message).toContain("socket closed");
    expect((error as Error).message).not.toContain("top-secret-key");
  });
});

function rawProjectKey(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "key-1",
    name: "CI",
    scope: "project",
    projectId: "db-project-1",
    createdAt: "2026-08-03T00:00:00Z",
    ...overrides,
  };
}

function rawAccountKey(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "key-acc",
    name: "root",
    scope: "account",
    projectId: null,
    createdAt: "2026-08-03T00:00:00Z",
    ...overrides,
  };
}

describe("accountClient keys and id translation", () => {
  it("creates a project key by translating the slug to the private id", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { success: true, value: [rawProject()] }))
      .mockResolvedValueOnce(
        response(200, { success: true, value: rawProjectKey({ plainKey: "plain-once" }) }),
      );
    const created = await client.createProjectKey({ name: "CI", projectId: "public-project" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://host.example/api/projects");
    expect(fetchMock.mock.calls[1]).toEqual([
      "https://host.example/api/api_keys",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer top-secret-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "CI", scope: "project", projectId: "db-project-1" }),
      },
    ]);
    expect(created).toEqual({
      id: "key-1",
      name: "CI",
      scope: "project",
      projectId: "public-project",
      createdAt: "2026-08-03T00:00:00Z",
      plainKey: "plain-once",
    });
    expect(JSON.stringify(created)).not.toContain("db-project-1");
  });

  it("fetches projects once and makes no POST for an unknown slug", async () => {
    fetchMock.mockResolvedValueOnce(response(200, { success: true, value: [] }));
    await expect(client.createProjectKey({ name: "CI", projectId: "missing" })).rejects.toThrow(
      "unknown project 'missing'",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://host.example/api/projects");
  });

  it("lists keys after one project fetch and returns only public slugs", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { success: true, value: [rawProject()] }))
      .mockResolvedValueOnce(response(200, { success: true, value: [rawProjectKey()] }));
    const keys = await client.listKeys();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://host.example/api/projects",
      "https://host.example/api/api_keys",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({
      method: "GET",
      headers: { Authorization: "Bearer top-secret-key" },
    });
    expect(keys[0]?.projectId).toBe("public-project");
    expect(JSON.stringify(keys)).not.toContain("db-project-1");
    expect(JSON.stringify(keys)).not.toContain("plainKey");
  });

  it("maps a key whose project no longer exists to the placeholder", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { success: true, value: [] }))
      .mockResolvedValueOnce(
        response(200, { success: true, value: [rawProjectKey({ projectId: "db-gone" })] }),
      );
    const keys = await client.listKeys();
    expect(keys[0]?.projectId).toBe("(unknown project)");
    expect(JSON.stringify(keys)).not.toContain("db-gone");
  });

  it("keeps an account key's projectId null", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { success: true, value: [] }))
      .mockResolvedValueOnce(response(200, { success: true, value: [rawAccountKey()] }));
    const keys = await client.listKeys();
    expect(keys[0]).toMatchObject({ scope: "account", projectId: null });
  });

  it.each([
    ["account key with a projectId", rawAccountKey({ projectId: "db-x" })],
    ["project key with a null projectId", rawProjectKey({ projectId: null })],
    ["unknown scope", rawProjectKey({ scope: "weird" })],
    ["missing id", rawProjectKey({ id: undefined })],
    ["missing createdAt", rawProjectKey({ createdAt: undefined })],
  ])("rejects an impossible/invalid key: %s", async (_label, badKey) => {
    fetchMock
      .mockResolvedValueOnce(response(200, { success: true, value: [rawProject()] }))
      .mockResolvedValueOnce(response(200, { success: true, value: [badKey] }));
    await expect(client.listKeys()).rejects.toBeInstanceOf(AccountRequestError);
  });

  it("rejects a non-array key list", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { success: true, value: [] }))
      .mockResolvedValueOnce(response(200, { success: true, value: {} }));
    await expect(client.listKeys()).rejects.toThrow(/api_keys must be an array/);
  });

  it("rejects a created key without a plainKey", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { success: true, value: [rawProject()] }))
      .mockResolvedValueOnce(response(200, { success: true, value: rawProjectKey() }));
    await expect(
      client.createProjectKey({ name: "CI", projectId: "public-project" }),
    ).rejects.toThrow("created key missing plainKey");
  });
});
