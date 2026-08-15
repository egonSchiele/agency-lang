import { describe, it, expect, afterEach, vi } from "vitest";
import { uploadBundle, serveBaseUrl } from "./uploadClient.js";

const target = { host: "https://statelog.example", projectId: "proj", apiKey: "k" };
const bundle = {
  entrypoint: "greeter.agency",
  files: [{ name: "greeter.agency", contents: "x", absPath: "/tmp/greeter.agency" }],
};

function mockFetch(handler: (url: string, init?: { method?: string }) => unknown): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: unknown,
    init?: { method?: string },
  ) => {
    const body = handler(String(url), init);
    return {
      ok: true,
      status: 200,
      url: String(url),
      text: async () => JSON.stringify(body),
    } as unknown as globalThis.Response;
  }) as unknown as typeof fetch);
}

afterEach(() => vi.restoreAllMocks());

describe("uploadBundle", () => {
  it("returns absolute endpoint URLs and the fetched manifest", async () => {
    const manifest = {
      nodes: [{ name: "main", parameters: ["message"], interruptEffects: [] }],
      functions: [{ name: "add", parameters: ["a", "b"], interruptEffects: [] }],
    };
    mockFetch((url) => {
      if (url.endsWith("/upload")) {
        return {
          success: true,
          value: {
            endpointUrls: ["/serve/u/proj/greeter/list", "/serve/u/proj/greeter/node/main"],
          },
        };
      }
      return manifest;
    });

    const result = await uploadBundle(target, bundle);
    expect(result).toEqual({
      ok: true,
      endpointUrls: [
        "https://statelog.example/serve/u/proj/greeter/list",
        "https://statelog.example/serve/u/proj/greeter/node/main",
      ],
      manifest,
    });
  });

  it("surfaces a rejection envelope as an error", async () => {
    mockFetch(() => ({ success: false, error: "Invalid input: entrypoint required" }));
    const result = await uploadBundle(target, bundle);
    expect(result).toEqual({ ok: false, error: "Invalid input: entrypoint required" });
  });

  it("errors on a success envelope missing endpointUrls rather than crashing", async () => {
    mockFetch(() => ({ success: true, value: {} }));
    const result = await uploadBundle(target, bundle);
    expect(result.ok).toBe(false);
  });

  it("still succeeds without a manifest when /list returns a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (url: unknown) => {
      if (String(url).endsWith("/upload")) {
        return {
          ok: true,
          status: 200,
          url: String(url),
          text: async () =>
            JSON.stringify({ success: true, value: { endpointUrls: ["/serve/u/p/g/list"] } }),
        } as unknown as globalThis.Response;
      }
      return {
        ok: false,
        status: 500,
        url: String(url),
        text: async () => "{}",
      } as unknown as globalThis.Response;
    }) as unknown as typeof fetch);

    const result = await uploadBundle(target, bundle);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest).toBeUndefined();
  });

  // The http:// misconfiguration in the wild: the https redirect turns the
  // POST into an unauthenticated GET, and the sign-in page comes back as
  // HTML with HTTP 200. The error must say all of that, not just "non-JSON".
  it("describes a redirect to the sign-in page instead of a bare non-JSON error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => ({
      ok: true,
      status: 200,
      url: "https://statelog.example/signin?redirect=/api/projects/proj/upload",
      text: async () => "<!doctype html><title>Sign in</title>",
    })) as unknown as typeof fetch);

    const result = await uploadBundle(target, bundle);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("non-JSON response (HTTP 200)");
    expect(result.error).toContain("POST https://statelog.example/api/projects/proj/upload");
    expect(result.error).toContain(
      "redirected to https://statelog.example/signin?redirect=/api/projects/proj/upload",
    );
    expect(result.error).toContain("use https://");
    expect(result.error).toContain("<!doctype html><title>Sign in</title>");
  });

  it("rejects a cross-origin endpoint URL and never fetches the manifest", async () => {
    let listFetched = false;
    mockFetch((url) => {
      if (url.endsWith("/upload")) {
        return {
          success: true,
          value: { endpointUrls: ["https://evil.example/serve/u/p/g/list"] },
        };
      }
      listFetched = true;
      return {};
    });
    const result = await uploadBundle(target, bundle);
    expect(result.ok).toBe(false);
    expect(listFetched).toBe(false);
  });

  it("rejects a non-string endpoint URL entry", async () => {
    mockFetch((url) => {
      if (url.endsWith("/upload")) {
        return { success: true, value: { endpointUrls: [42] } };
      }
      return {};
    });
    const result = await uploadBundle(target, bundle);
    expect(result.ok).toBe(false);
  });

  it("reports a friendly error when the host is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await uploadBundle(target, bundle);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("Could not reach https://statelog.example");
  });
});

describe("serveBaseUrl", () => {
  it("strips the /list segment to give the shared serve base", () => {
    expect(serveBaseUrl(["https://h/serve/u/p/f/list", "https://h/serve/u/p/f/node/main"])).toBe(
      "https://h/serve/u/p/f",
    );
  });

  it("returns undefined when there is no manifest URL", () => {
    expect(serveBaseUrl([])).toBeUndefined();
  });
});

// Characterization: upload deliberately never inspects response.ok — the
// envelope decides the outcome, whatever the HTTP status. These pin that
// settled semantics before the transport-core refactor.
describe("uploadBundle status-agnostic characterization", () => {
  function fetchWith(status: number, rawBody: string): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, "fetch").mockImplementation((async (url: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      url: String(url),
      text: async () => rawBody,
    })) as unknown as typeof fetch);
  }

  it("an HTTP 500 carrying a valid success envelope still succeeds", async () => {
    fetchWith(
      500,
      JSON.stringify({ success: true, value: { endpointUrls: ["/serve/u/proj/greeter/list"] } }),
    );
    const result = await uploadBundle(target, bundle);
    expect(result.ok).toBe(true);
  });

  it("an HTTP 500 non-JSON body returns the detailed readJsonBody diagnostic", async () => {
    fetchWith(500, "<html>gateway error</html>");
    const result = await uploadBundle(target, bundle);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("non-JSON response (HTTP 500)");
    expect(result.error).toContain("<html>gateway error</html>");
  });

  it("an HTTP 500 rejection envelope returns its error string", async () => {
    fetchWith(500, JSON.stringify({ success: false, error: "x" }));
    const result = await uploadBundle(target, bundle);
    expect(result).toEqual({ ok: false, error: "x" });
  });

  it("an HTTP 500 malformed parsed body produces exactly the rejection fallback", async () => {
    fetchWith(500, JSON.stringify({ weird: true }));
    const result = await uploadBundle(target, bundle);
    expect(result).toEqual({ ok: false, error: "Upload rejected (HTTP 500)." });
  });

  it("the upload request carries exact auth, content type, and a once-serialized body", async () => {
    const spy = fetchWith(
      200,
      JSON.stringify({ success: true, value: { endpointUrls: ["/serve/u/proj/greeter/list"] } }),
    );
    await uploadBundle(target, bundle);
    const [, init] = spy.mock.calls[0]! as [unknown, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer k",
      "Content-Type": "application/json",
    });
    expect(init.body).toBe(
      JSON.stringify({
        entrypoint: bundle.entrypoint,
        files: bundle.files.map((file) => ({ name: file.name, contents: file.contents })),
      }),
    );
  });
});
