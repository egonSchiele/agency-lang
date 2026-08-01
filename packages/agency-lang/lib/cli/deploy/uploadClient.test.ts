import { describe, it, expect, afterEach, vi } from "vitest";
import { uploadBundle, serveBaseUrl } from "./uploadClient.js";

const target = { host: "https://statelog.example", projectId: "proj", apiKey: "k" };
const bundle = { entrypoint: "greeter.agency", files: [{ name: "greeter.agency", contents: "x" }] };

function mockFetch(handler: (url: string, init?: { method?: string }) => unknown): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: { method?: string }) => {
    const body = handler(String(url), init);
    return { status: 200, json: async () => body } as unknown as globalThis.Response;
  }) as unknown as typeof fetch);
}

afterEach(() => vi.restoreAllMocks());

describe("uploadBundle", () => {
  it("returns absolute endpoint URLs and the fetched manifest", async () => {
    const manifest = { nodes: [{ name: "main", parameters: ["message"] }], functions: [{ name: "add" }] };
    mockFetch((url) => {
      if (url.endsWith("/upload")) {
        return { success: true, value: { endpointUrls: ["/serve/u/proj/greeter/list", "/serve/u/proj/greeter/node/main"] } };
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
