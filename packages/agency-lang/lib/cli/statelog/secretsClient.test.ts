import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSecretsClient, SecretRequestError } from "./secretsClient.js";

const SENTINEL = "sk-live-EXTREMELY-SECRET";
const API_KEY = "stlog-api-key-9876";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "",
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

function nonJsonResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "",
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function client() {
  return createSecretsClient("https://h", "proj", API_KEY);
}

const wireSecret = {
  name: "OPENAI_API_KEY",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};

async function failureOf(promise: Promise<unknown>): Promise<SecretRequestError> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(SecretRequestError);
  return outcome as SecretRequestError;
}

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

describe("secretsClient transport", () => {
  it("set POSTs the secrets route with bearer auth and the name/value body", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: wireSecret }));
    await client().set("OPENAI_API_KEY", SENTINEL);
    const { url, init } = lastRequest();
    expect(url).toBe("https://h/api/projects/proj/secrets");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      name: "OPENAI_API_KEY",
      value: SENTINEL,
    });
  });

  it("list GETs the secrets route without a body", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: [wireSecret] }));
    await expect(client().list()).resolves.toEqual([wireSecret]);
    const { url, init } = lastRequest();
    expect(url).toBe("https://h/api/projects/proj/secrets");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("delete DELETEs the named secret", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: wireSecret }));
    await client().delete("A_B");
    const { url, init } = lastRequest();
    expect(url).toBe("https://h/api/projects/proj/secrets/A_B");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("path-encodes the secret name as its own segment", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: wireSecret }));
    await client().delete("odd/name");
    expect(lastRequest().url).toBe("https://h/api/projects/proj/secrets/odd%2Fname");
  });

  it("set returns the validated metadata", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: wireSecret }));
    await expect(client().set("OPENAI_API_KEY", SENTINEL)).resolves.toEqual(wireSecret);
  });

  it("rejects a malformed DTO, sanitized, preserving the HTTP status", async () => {
    fetchMock.mockResolvedValue(
      response(200, { success: true, value: { ...wireSecret, createdAt: SENTINEL, updatedAt: 7 } }),
    );
    const error = await failureOf(client().set("OPENAI_API_KEY", SENTINEL));
    expect(error.message).not.toContain(SENTINEL);
    expect(error.status).toBe(200);
  });

  it("set's alsoRedact values join the first redaction pass", async () => {
    const other = "another-import-value";
    fetchMock.mockResolvedValue(
      response(200, { success: false, error: `echoing a different secret: ${other}` }),
    );
    const error = await failureOf(
      client().set("N", SENTINEL, { alsoRedact: [other] }),
    );
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(other);
  });
});

describe("secretsClient failure taxonomy", () => {
  it("a 200-envelope 'Secret not found.' passes through verbatim and never suggests an upgrade", async () => {
    fetchMock.mockResolvedValue(response(200, { success: false, error: "Secret not found." }));
    const error = await failureOf(client().delete("NOPE"));
    expect(error.message).toBe("Secret not found.");
    expect(error.message).not.toContain("upgrade");
    expect(error.status).toBe(200);
  });

  it("the domain race 'Project not found.' (with period, HTTP 200) passes through", async () => {
    fetchMock.mockResolvedValue(response(200, { success: false, error: "Project not found." }));
    const error = await failureOf(client().list());
    expect(error.message).toBe("Project not found.");
    expect(error.status).toBe(200);
  });

  it("the middleware 404 maps to slug guidance, matching the error field only", async () => {
    fetchMock.mockResolvedValue(
      response(404, { error: "Project not found", extra: "harmless" }),
    );
    const error = await failureOf(client().list());
    expect(error.message).toContain("project 'proj' not found");
    expect(error.message).not.toContain("upgrade");
  });

  it("any other 404 maps to the unsupported-host message", async () => {
    fetchMock.mockResolvedValue(nonJsonResponse(404, "<!doctype html>"));
    const error = await failureOf(client().list());
    expect(error.message).toContain("does not support the secrets API");
  });

  it.each([[401], [403]])("HTTP %d preserves the status on the error", async (status) => {
    fetchMock.mockResolvedValue(response(status, { error: "not allowed" }));
    const error = await failureOf(client().set("N", SENTINEL));
    expect(error.status).toBe(status);
    expect(error.message).toContain("not allowed");
  });

  it("a 200 failure envelope carries the server message with status 200", async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        success: false,
        error: "This project has reached the maximum number of secrets.",
      }),
    );
    const error = await failureOf(client().set("N", SENTINEL));
    expect(error.message).toBe("This project has reached the maximum number of secrets.");
    expect(error.status).toBe(200);
  });
});

describe("secretsClient hostile-response redaction", () => {
  it("redacts the value from a non-JSON 200 body", async () => {
    fetchMock.mockResolvedValue(nonJsonResponse(200, `<html>echo ${SENTINEL}</html>`));
    const error = await failureOf(client().set("N", SENTINEL));
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(SENTINEL);
  });

  it("redacts a whitespace-containing value from a non-JSON body before collapsing", async () => {
    const spaced = "first\nsecond secret";
    fetchMock.mockResolvedValue(nonJsonResponse(200, `<html>${spaced}</html>`));
    const error = await failureOf(client().set("N", spaced));
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("second secret");
  });

  it("redacts the value from a non-2xx JSON error", async () => {
    fetchMock.mockResolvedValue(response(500, { error: `boom: ${SENTINEL}` }));
    const error = await failureOf(client().set("N", SENTINEL));
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(SENTINEL);
  });

  it("redacts the value from a 200 failure envelope message", async () => {
    fetchMock.mockResolvedValue(
      response(200, { success: false, error: `rejected value ${SENTINEL}` }),
    );
    const error = await failureOf(client().set("N", SENTINEL));
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(SENTINEL);
  });

  it("redacts the value from a rejected-fetch error message", async () => {
    fetchMock.mockRejectedValue(new Error(`socket said ${SENTINEL}`));
    const error = await failureOf(client().set("N", SENTINEL));
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(SENTINEL);
  });

  it.each([["list"], ["delete"]] as const)(
    "redacts the API key from a hostile %s response",
    async (verb) => {
      fetchMock.mockResolvedValue(
        response(200, { success: false, error: `your key is ${API_KEY}` }),
      );
      const promise = verb === "list" ? client().list() : client().delete("N");
      const error = await failureOf(promise);
      expect(error.message).toContain("[redacted]");
      expect(error.message).not.toContain(API_KEY);
    },
  );
});

// Characterization: the rejected-fetch message is redacted as a WHOLE — the
// current client wraps `could not reach ${origin} (…)` in its redactor, so a
// sensitive value appearing in the ORIGIN is redacted too, not only one in the
// exception's cause. The transport-core mapper must redact the complete
// constructed message, not just failure.cause.
describe("secretsClient whole-message unreachable redaction", () => {
  it("redacts a value embedded in the origin, not only in the cause", async () => {
    fetchMock.mockRejectedValue(new Error("plain network error"));
    const leakyOrigin = `https://${SENTINEL}.example`;
    const error = await failureOf(
      createSecretsClient(leakyOrigin, "proj", API_KEY).set("N", SENTINEL),
    );
    expect(error.message).toContain("could not reach");
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(SENTINEL);
  });
});
