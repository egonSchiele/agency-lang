import { describe, it, expect, afterEach, vi } from "vitest";
import { createServeClient, ServeRequestError } from "./serveClient.js";
import { parseServeBaseUrl } from "./serveUrl.js";
import { interrupt } from "@/runtime/interrupts.js";

const address = parseServeBaseUrl("https://statelog.example/serve/u/p/agent.agency")!;

// Stub fetch: `handler(url)` returns { status?, json } or throws for a network
// error. Records every requested URL.
function mockFetch(handler: (url: string) => { status?: number; json: unknown }): {
  urls: string[];
} {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: unknown) => {
    urls.push(String(url));
    const { status = 200, json } = handler(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      url: String(url),
      text: async () => JSON.stringify(json),
    } as unknown as globalThis.Response;
  }) as unknown as typeof fetch);
  return { urls };
}

function client() {
  return createServeClient(address, "key");
}

afterEach(() => vi.restoreAllMocks());

describe("createServeClient", () => {
  it("invokeNode returns a final value as { data: value }", async () => {
    mockFetch(() => ({ json: { success: true, value: { answer: 42 } } }));
    expect(await client().invokeNode("main", {})).toEqual({ data: { answer: 42 } });
  });

  it("invokeNode returns a pause (state string + real interrupts) as { data: interrupts }", async () => {
    const paused = [interrupt({ effect: "app::confirm", message: "ok?", data: null, origin: "o", runId: "r", interruptId: "i1" })];
    mockFetch(() => ({ json: { success: true, value: { interrupts: paused, state: "serialized" } } }));
    expect(await client().invokeNode("main", {})).toEqual({ data: paused });
  });

  it("treats an object without a string state (or without real interrupts) as final", async () => {
    mockFetch(() => ({ json: { success: true, value: { interrupts: [], completed: 12 } } }));
    expect(await client().invokeNode("main", {})).toEqual({ data: { interrupts: [], completed: 12 } });

    mockFetch(() => ({ json: { success: true, value: { interrupts: ["not-an-interrupt"], state: "s" } } }));
    expect(await client().invokeNode("main", {})).toEqual({
      data: { interrupts: ["not-an-interrupt"], state: "s" },
    });
  });

  it("throws ServeRequestError on a success:false envelope", async () => {
    mockFetch(() => ({ json: { success: false, error: "Tool execution failed" } }));
    await expect(client().invokeNode("main", {})).rejects.toThrow(/Tool execution failed/);
  });

  it("throws ServeRequestError on a non-2xx response with a valid JSON body", async () => {
    // A 404 whose body carries an error message — surfaced, not accepted.
    mockFetch(() => ({ status: 404, json: { error: "no such node" } }));
    await expect(client().invokeNode("main", {})).rejects.toThrow(/no such node/);
    // A 500 whose body happens to be manifest-shaped must not be returned.
    mockFetch(() => ({ status: 500, json: { nodes: [], functions: [] } }));
    await expect(client().fetchManifest()).rejects.toBeInstanceOf(ServeRequestError);
  });

  it("throws ServeRequestError on an HTTP/JSON failure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => ({
      ok: false,
      status: 500,
      url: "",
      text: async () => "<html>Internal Server Error</html>",
    })) as unknown as typeof fetch);
    await expect(client().invokeNode("main", {})).rejects.toBeInstanceOf(ServeRequestError);
  });

  it("encodes a node name needing escaping exactly once", async () => {
    const { urls } = mockFetch(() => ({ json: { success: true, value: null } }));
    await client().invokeNode("a b", {});
    expect(urls[0]).toBe("https://statelog.example/serve/u/p/agent.agency/node/a%20b");
  });

  it("invokeFunction returns the raw value", async () => {
    mockFetch(() => ({ json: { success: true, value: 5 } }));
    expect(await client().invokeFunction("add", { a: 2, b: 3 })).toBe(5);
  });

  it("throws when a function/node returns a failed AgencyResult (wrapped in the success envelope)", async () => {
    // The real shape of a served function that raises an unhandled interrupt.
    const failed = { success: true, value: { __type: "resultType", success: false, error: "boom" } };
    mockFetch(() => ({ json: failed }));
    await expect(client().invokeFunction("f", {})).rejects.toThrow(/boom/);
    mockFetch(() => ({ json: failed }));
    await expect(client().invokeNode("main", {})).rejects.toThrow(/boom/);
  });

  it("passes a successful Result value through unchanged", async () => {
    const ok = { __type: "resultType", success: true, value: 7 };
    mockFetch(() => ({ json: { success: true, value: ok } }));
    expect(await client().invokeFunction("f", {})).toEqual(ok);
  });

  it("resume returns an InterruptResult and can fail on a later leg", async () => {
    mockFetch(() => ({ json: { success: true, value: "resumed" } }));
    expect(await client().resume([], [])).toEqual({ data: "resumed" });

    mockFetch(() => ({ json: { success: false, error: "resume boom" } }));
    await expect(client().resume([], [])).rejects.toThrow(/resume boom/);
  });

  it("fetchManifest validates and returns a typed manifest", async () => {
    mockFetch(() => ({
      json: {
        nodes: [{ name: "main", parameters: ["message"], interruptEffects: ["app::confirm"] }],
        functions: [
          { name: "add", parameters: ["a", "b"], interruptEffects: [], description: "adds", destructive: false },
        ],
      },
    }));
    const manifest = await client().fetchManifest();
    expect(manifest.nodes[0]).toEqual({
      name: "main",
      parameters: ["message"],
      interruptEffects: ["app::confirm"],
    });
    expect(manifest.functions[0].description).toBe("adds");
    expect(manifest.functions[0].destructive).toBe(false);
  });

  it("fetchManifest throws on a malformed manifest item rather than reaching render code", async () => {
    mockFetch(() => ({
      json: { nodes: [{ name: "main", parameters: [42], interruptEffects: [] }], functions: [] },
    }));
    await expect(client().fetchManifest()).rejects.toBeInstanceOf(ServeRequestError);

    mockFetch(() => ({ json: { nodes: "nope", functions: [] } }));
    await expect(client().fetchManifest()).rejects.toBeInstanceOf(ServeRequestError);
  });
});

// Characterization: serve's wire quirks — Content-Type on every call including
// bodyless GETs, and `{}` for an undefined POST body — pinned before the
// transport-core refactor (removing either would be a wire change).
describe("serveClient wire characterization", () => {
  function captureFetch(json: unknown): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, "fetch").mockImplementation((async (url: unknown) => ({
      ok: true,
      status: 200,
      url: String(url),
      text: async () => JSON.stringify(json),
    })) as unknown as typeof fetch);
  }

  it("GET /list sends Authorization AND Content-Type with no body", async () => {
    const spy = captureFetch({ nodes: [], functions: [] });
    await client().fetchManifest();
    const [, init] = spy.mock.calls[0]! as [unknown, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({
      Authorization: "Bearer key",
      "Content-Type": "application/json",
    });
    expect(init.body).toBeUndefined();
  });

  it("invokeNode POSTs the exact serialized args body", async () => {
    const spy = captureFetch({ success: true, value: 42 });
    await client().invokeNode("main", { message: "hi" });
    const [, init] = spy.mock.calls[0]! as [unknown, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ message: "hi" }));
  });

  it("a POST given undefined args preserves the {} fallback", async () => {
    const spy = captureFetch({ success: true, value: 42 });
    // The public signature requires args; the wire fallback still exists for
    // any looser caller, so exercise it past the type.
    await client().invokeNode("main", undefined as unknown as Record<string, unknown>);
    const [, init] = spy.mock.calls[0]! as [unknown, RequestInit];
    expect(init.body).toBe("{}");
  });

  it("a rejected fetch names the full URL in the unreachable message", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    await expect(client().fetchManifest()).rejects.toThrow(
      /could not reach https:\/\/statelog\.example\/serve\/u\/p\/agent\.agency\/list \(ECONNREFUSED\)/,
    );
  });
});
