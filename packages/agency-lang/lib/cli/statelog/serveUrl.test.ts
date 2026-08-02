import { describe, it, expect } from "vitest";
import {
  resolveTrustedEndpointUrl,
  parseServeBaseUrl,
  serveRouteUrl,
  projectPageUrl,
} from "./serveUrl.js";

const HOST = "https://statelog.example.com";

describe("resolveTrustedEndpointUrl", () => {
  it("resolves a relative endpoint against the trusted host", () => {
    expect(resolveTrustedEndpointUrl("/serve/u/p/a/list", HOST)).toBe(
      "https://statelog.example.com/serve/u/p/a/list",
    );
  });

  it("keeps a same-origin absolute endpoint", () => {
    expect(resolveTrustedEndpointUrl(`${HOST}/serve/u/p/a`, HOST)).toBe(
      "https://statelog.example.com/serve/u/p/a",
    );
  });

  it("rejects a cross-origin endpoint", () => {
    expect(() => resolveTrustedEndpointUrl("https://evil.com/x", HOST)).toThrow();
  });

  it("rejects embedded credentials", () => {
    expect(() =>
      resolveTrustedEndpointUrl("https://user:pw@statelog.example.com/x", HOST),
    ).toThrow();
  });

  it("rejects a non-HTTP(S) protocol", () => {
    expect(() => resolveTrustedEndpointUrl("ftp://statelog.example.com/x", HOST)).toThrow();
  });

  it("rejects a non-string", () => {
    expect(() => resolveTrustedEndpointUrl(42 as unknown as string, HOST)).toThrow();
  });
});

describe("parseServeBaseUrl", () => {
  it("parses the exact serve base and decodes identifiers", () => {
    expect(parseServeBaseUrl(`${HOST}/serve/u/p/agent.agency`)).toMatchObject({
      origin: HOST,
      userId: "u",
      projectId: "p",
      filename: "agent.agency",
      serveUrl: `${HOST}/serve/u/p/agent.agency`,
    });
  });

  it("decodes percent-encoded identifiers and re-encodes the canonical serveUrl once", () => {
    const address = parseServeBaseUrl(`${HOST}/serve/u%20x/p/a`);
    expect(address?.userId).toBe("u x");
    expect(address?.serveUrl).toBe(`${HOST}/serve/u%20x/p/a`);
  });

  it("canonicalizes a trailing slash", () => {
    expect(parseServeBaseUrl(`${HOST}/serve/u/p/a/`)?.serveUrl).toBe(`${HOST}/serve/u/p/a`);
  });

  it("rejects a command route, extra/prefix segments, and empty identifiers", () => {
    expect(parseServeBaseUrl(`${HOST}/serve/u/p/a/node/main`)).toBeNull();
    expect(parseServeBaseUrl(`${HOST}/x/serve/u/p/a`)).toBeNull();
    expect(parseServeBaseUrl(`${HOST}/serve//p/a`)).toBeNull();
    expect(parseServeBaseUrl(`${HOST}/serve/u/p`)).toBeNull();
  });

  it("rejects query, hash, credentials, and unsupported protocols", () => {
    expect(parseServeBaseUrl(`${HOST}/serve/u/p/a?x=1`)).toBeNull();
    expect(parseServeBaseUrl(`${HOST}/serve/u/p/a#frag`)).toBeNull();
    expect(parseServeBaseUrl(`https://user:pw@statelog.example.com/serve/u/p/a`)).toBeNull();
    expect(parseServeBaseUrl(`ftp://statelog.example.com/serve/u/p/a`)).toBeNull();
    expect(parseServeBaseUrl("not a url")).toBeNull();
  });
});

describe("serveRouteUrl", () => {
  const base = `${HOST}/serve/u/p/a`;

  it("appends encoded path segments exactly once", () => {
    expect(serveRouteUrl(base, ["list"])).toBe(`${base}/list`);
    expect(serveRouteUrl(base, ["node", "main"])).toBe(`${base}/node/main`);
    expect(serveRouteUrl(base, ["node", "a b"])).toBe(`${base}/node/a%20b`);
  });

  it("returns the base itself for no segments", () => {
    expect(serveRouteUrl(base, [])).toBe(base);
  });

  it("throws when the base is not a serve URL", () => {
    expect(() => serveRouteUrl(`${HOST}/not/serve`, ["list"])).toThrow();
  });
});

describe("projectPageUrl", () => {
  it("builds the project page URL, encoding the decoded project id", () => {
    const address = parseServeBaseUrl(`${HOST}/serve/u/p%20q/a`)!;
    expect(projectPageUrl(address)).toBe(`${HOST}/projects/show?id=p+q`);
  });
});
