import { describe, it, expect, afterEach } from "vitest";
import { installFetchMock } from "./fetchMock.js";

let uninstall: (() => void) | undefined;
afterEach(() => { uninstall?.(); uninstall = undefined; });

describe("installFetchMock — url/method matching", () => {
  it("serves an exact-URL match as a real Response (body/status/headers)", async () => {
    uninstall = installFetchMock([
      { url: "https://api.example.com/data", return: { answer: 42 }, status: 201, headers: { "content-type": "application/json" } },
    ]);
    const res = await fetch("https://api.example.com/data");
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ answer: 42 });
  });

  it("returns a string body verbatim and exposes a readable stream (getReader)", async () => {
    uninstall = installFetchMock([{ url: "https://x/*", return: "<h1>Hi</h1>" }]);
    const res = await fetch("https://x/page");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("<h1>Hi</h1>");
  });

  it("matches * globs and defaults status to 200", async () => {
    uninstall = installFetchMock([{ url: "https://api.example.com/v1/*", return: "ok" }]);
    const res = await fetch("https://api.example.com/v1/anything/here");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("matches urlPattern regex", async () => {
    uninstall = installFetchMock([{ urlPattern: "weather|forecast", return: "w" }]);
    expect(await (await fetch("https://z/get-forecast")).text()).toBe("w");
  });

  it("respects method when specified, ignores it when absent", async () => {
    uninstall = installFetchMock([
      { url: "https://api/x", method: "POST", return: "posted" },
      { url: "https://api/x", return: "any" },
    ]);
    expect(await (await fetch("https://api/x", { method: "POST" })).text()).toBe("posted");
    expect(await (await fetch("https://api/x")).text()).toBe("any"); // GET falls to 2nd
  });

  it("matches method case-insensitively (both sides normalized)", async () => {
    // Mock declares lowercase, request sends uppercase, and vice versa — both
    // must match. If the .toUpperCase() on either side is dropped, one fails.
    uninstall = installFetchMock([
      { url: "https://api/a", method: "post", return: "A" },
      { url: "https://api/b", method: "POST", return: "B" },
    ]);
    expect(await (await fetch("https://api/a", { method: "POST" })).text()).toBe("A");
    expect(await (await fetch("https://api/b", { method: "post" })).text()).toBe("B");
  });

  it("first match wins and a match is reusable across calls", async () => {
    uninstall = installFetchMock([{ url: "https://api/x", return: "1" }, { url: "https://api/*", return: "2" }]);
    expect(await (await fetch("https://api/x")).text()).toBe("1");
    expect(await (await fetch("https://api/x")).text()).toBe("1");
  });

  it("handles URL and Request input forms", async () => {
    uninstall = installFetchMock([{ url: "https://api/x", return: "ok" }]);
    expect(await (await fetch(new URL("https://api/x"))).text()).toBe("ok");
    expect(await (await fetch(new Request("https://api/x"))).text()).toBe("ok");
  });

  it("throws a helpful error when nothing matches", async () => {
    uninstall = installFetchMock([{ url: "https://api/x", return: "ok" }]);
    await expect(fetch("https://other/y")).rejects.toThrow(/No fetchMock matched GET https:\/\/other\/y/);
  });

  it("rejects with an abort error when the AbortSignal is already aborted", async () => {
    uninstall = installFetchMock([{ url: "https://api/x", return: "ok" }]);
    const ac = new AbortController();
    ac.abort();
    // Match the abort specifically, so an unrelated throw wouldn't pass this.
    await expect(fetch("https://api/x", { signal: ac.signal })).rejects.toThrow(/abort/i);
  });

  it("errors on config: neither or both of url/urlPattern", () => {
    expect(() => installFetchMock([{ return: "x" }])).toThrow(/exactly one of "url" or "urlPattern"/);
    expect(() => installFetchMock([{ url: "a", urlPattern: "b", return: "x" }])).toThrow(/exactly one of "url" or "urlPattern"/);
  });

  it("errors on config: missing return", () => {
    expect(() => installFetchMock([{ url: "https://api/x" }])).toThrow(/"return" body is required/);
  });

  it("errors with a clear message when the mocks value is not an array", () => {
    // Guards against a corrupt/hand-set AGENCY_FETCH_MOCKS_FILE holding a
    // non-array JSON value (otherwise the failure is a cryptic "map is not a
    // function").
    expect(() => installFetchMock({ url: "https://api/x", return: "x" } as any))
      .toThrow(/expected an array of fetch mocks/);
  });
});

describe("installFetchMock — body matching", () => {
  it("dispatches same-URL POSTs by exact string body", async () => {
    uninstall = installFetchMock([
      { url: "https://api/x", body: "ping", return: "pong" },
      { url: "https://api/x", return: "fallback" },
    ]);
    expect(await (await fetch("https://api/x", { method: "POST", body: "ping" })).text()).toBe("pong");
    expect(await (await fetch("https://api/x", { method: "POST", body: "other" })).text()).toBe("fallback");
  });

  it("exact string body must NOT match a superstring (=== not includes)", async () => {
    // Pins raw === want. If it weakened to raw.includes(want), "pinging" would
    // wrongly match "ping" and this test would go red.
    uninstall = installFetchMock([{ url: "https://api/x", body: "ping", return: "pong" }]);
    await expect(fetch("https://api/x", { method: "POST", body: "pinging" }))
      .rejects.toThrow(/No fetchMock matched/);
  });

  it("matches an object body as a JSON subset (extra fields ignored)", async () => {
    uninstall = installFetchMock([
      { url: "https://api/s", body: { q: "cats" }, return: "C" },
      { url: "https://api/s", body: { q: "dogs" }, return: "D" },
    ]);
    const opt = (q: string) => ({ method: "POST", body: JSON.stringify({ q, extra: 1 }) });
    expect(await (await fetch("https://api/s", opt("cats"))).text()).toBe("C");
    expect(await (await fetch("https://api/s", opt("dogs"))).text()).toBe("D");
  });

  it("subset-matches array-valued and nested-object fields (and rejects length/shape mismatch)", async () => {
    // Exercises deepSubset's array branch (exact length + elements) and its
    // recursion into nested objects — both untested by flat single-key bodies.
    uninstall = installFetchMock([
      { url: "https://api/t", body: { tags: ["a", "b"] }, return: "TAGS" },
      { url: "https://api/n", body: { filter: { type: "x" } }, return: "NEST" },
    ]);
    expect(await (await fetch("https://api/t", { method: "POST", body: JSON.stringify({ tags: ["a", "b"], z: 1 }) })).text()).toBe("TAGS");
    expect(await (await fetch("https://api/n", { method: "POST", body: JSON.stringify({ filter: { type: "x", extra: 1 } }) })).text()).toBe("NEST");
    // array length mismatch must NOT match
    await expect(fetch("https://api/t", { method: "POST", body: JSON.stringify({ tags: ["a"] }) }))
      .rejects.toThrow(/No fetchMock matched/);
  });

  it("reads the body from a Request object via clone (init.body absent)", async () => {
    // The input.clone().text() branch is only reachable when the body rides on a
    // Request object rather than init.body — exercise it explicitly.
    uninstall = installFetchMock([{ url: "https://api/r", body: "ping", return: "pong" }]);
    const req = new Request("https://api/r", { method: "POST", body: "ping" });
    expect(await (await fetch(req)).text()).toBe("pong");
  });

  it("object body never matches a non-JSON request body", async () => {
    uninstall = installFetchMock([{ url: "https://api/s", body: { q: "x" }, return: "hit" }]);
    await expect(fetch("https://api/s", { method: "POST", body: "not json" })).rejects.toThrow(/No fetchMock matched/);
  });

  it("matches bodyPattern regex, and does not match a non-matching body", async () => {
    uninstall = installFetchMock([{ url: "https://api/s", bodyPattern: "\"q\":\\s*\"ca", return: "R" }]);
    expect(await (await fetch("https://api/s", { method: "POST", body: '{"q": "cats"}' })).text()).toBe("R");
    await expect(fetch("https://api/s", { method: "POST", body: '{"q": "dogs"}' }))
      .rejects.toThrow(/No fetchMock matched/);
  });

  it("errors on config: both body and bodyPattern", () => {
    expect(() => installFetchMock([{ url: "a", body: "x", bodyPattern: "y", return: "z" }]))
      .toThrow(/at most one of "body" or "bodyPattern"/);
  });
});
