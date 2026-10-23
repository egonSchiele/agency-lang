import { describe, expect, it } from "vitest";
import { aliasHint, canonicalKeys, parameterForKey } from "./parameterAliases.js";

const params = [
  { name: "baseUrl", aliases: ["url", "href"] },
  { name: "path" },
  { name: "method", aliases: ["verb"] },
];

describe("parameterForKey", () => {
  it("finds a parameter by its canonical name", () => {
    expect(parameterForKey(params, "baseUrl")).toEqual({ param: params[0], viaAlias: false });
  });

  it("finds a parameter by an alias and says so", () => {
    expect(parameterForKey(params, "href")).toEqual({ param: params[0], viaAlias: true });
  });

  it("returns null for a key that names nothing", () => {
    expect(parameterForKey(params, "uri")).toBeNull();
  });

  it("prefers the canonical name when a key is both", () => {
    const clashing = [{ name: "a", aliases: ["b"] }, { name: "b" }];
    expect(parameterForKey(clashing, "b")).toEqual({ param: clashing[1], viaAlias: false });
  });
});

describe("canonicalKeys", () => {
  it("renames an alias key to the canonical name and records it", () => {
    const result = canonicalKeys({ url: "https://a", path: "/x" }, params);
    expect(result).toEqual({
      args: { baseUrl: "https://a", path: "/x" },
      corrections: [{ from: "url", to: "baseUrl" }],
      conflict: null,
    });
  });

  it("is idempotent on canonical input", () => {
    const args = { baseUrl: "https://a", path: "/x" };
    const result = canonicalKeys(args, params);
    expect(result.args).toEqual(args);
    expect(result.args).not.toBe(args);
    expect(result.corrections).toEqual([]);
    expect(result.conflict).toBeNull();
  });

  it("passes a key that names nothing through untouched", () => {
    const result = canonicalKeys({ uri: "x" }, params);
    expect(result.args).toEqual({ uri: "x" });
    expect(result.corrections).toEqual([]);
  });

  it("reports canonical plus alias as a conflict and leaves the arguments as given", () => {
    const args = { baseUrl: "a", url: "b" };
    const result = canonicalKeys(args, params);
    expect(result.conflict).toBe(
      "Both 'baseUrl' and 'url' were given for parameter 'baseUrl'. Pass one.",
    );
    expect(result.args).toEqual(args);
    expect(result.corrections).toEqual([]);
  });

  it("reports two aliases of one parameter as a conflict, in call order", () => {
    const result = canonicalKeys({ href: "a", url: "b" }, params);
    expect(result.conflict).toBe(
      "Both 'href' and 'url' were given for parameter 'baseUrl'. Pass one.",
    );
  });

  it("treats a null alias key as absent", () => {
    const result = canonicalKeys({ baseUrl: "a", url: null }, params);
    expect(result).toEqual({ args: { baseUrl: "a" }, corrections: [], conflict: null });
  });

  it("keeps a null canonical key, since dropping null defaults is someone else's job", () => {
    const result = canonicalKeys({ baseUrl: null }, params);
    expect(result.args).toEqual({ baseUrl: null });
  });

  it("corrects several aliases in one call", () => {
    const result = canonicalKeys({ url: "a", verb: "GET" }, params);
    expect(result.args).toEqual({ baseUrl: "a", method: "GET" });
    expect(result.corrections).toEqual([
      { from: "url", to: "baseUrl" },
      { from: "verb", to: "method" },
    ]);
  });
});

describe("aliasHint", () => {
  it("names the alias and the canonical name", () => {
    expect(aliasHint("url", "baseUrl")).toBe("'url' is an alias of 'baseUrl'; use 'baseUrl'.");
  });
});
