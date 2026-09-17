import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { findPackageRoot } from "../importPaths.js";
import { CONFIG_MERGE_RULES, mergeConfig } from "./merge.js";

describe("mergeConfig", () => {
  it("merges nested objects key by key", () => {
    const base = { log: { host: "h", projectId: "team" } };
    const override = { log: { projectId: "me" } };
    expect(mergeConfig(base, override)).toEqual({ log: { host: "h", projectId: "me" } });
  });

  it("replaces arrays instead of joining them", () => {
    expect(mergeConfig({ list: ["a", "b"] }, { list: ["c"] })).toEqual({ list: ["c"] });
  });

  it("replaces plain values, and an object replaces a non-object", () => {
    const merged = mergeConfig({ a: 1, b: "x" }, { a: 2, b: { c: 1 } });
    expect(merged).toEqual({ a: 2, b: { c: 1 } });
  });

  it("keeps keys that only one side has", () => {
    expect(mergeConfig({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("does not change its arguments", () => {
    const base = { log: { host: "h" } };
    const override = { log: { host: "other" } };
    mergeConfig(base, override);
    expect(base).toEqual({ log: { host: "h" } });
    expect(override).toEqual({ log: { host: "other" } });
  });

  it("replaces an MCP server whole, and keeps servers only the base names", () => {
    const base = {
      mcpServers: {
        search: { type: "http", url: "https://s/mcp", auth: "oauth" },
        fs: { command: "npx" },
      },
    };
    const override = { mcpServers: { search: { command: "node", args: ["srv.js"] } } };
    expect(mergeConfig(base, override)).toEqual({
      mcpServers: {
        search: { command: "node", args: ["srv.js"] },
        fs: { command: "npx" },
      },
    });
  });

  it("replaces a model alias whole", () => {
    const base = {
      client: {
        defaultModel: "m",
        modelAliases: {
          coder: {
            backend: "mlx",
            uri: "mlx:org/big",
            source: "remote",
            sha256: "abc",
            companions: ["mlx:org/decoder"],
          },
        },
      },
    };
    const override = {
      client: { modelAliases: { coder: { backend: "llama-cpp", uri: "hf:org/small:Q4_K_M" } } },
    };
    expect(mergeConfig(base, override)).toEqual({
      client: {
        defaultModel: "m",
        modelAliases: { coder: { backend: "llama-cpp", uri: "hf:org/small:Q4_K_M" } },
      },
    });
  });

  it("drops __proto__ keys from both sides, at any depth", () => {
    const base = JSON.parse(
      '{"__proto__": {"polluted": true}, "log": {"__proto__": {"polluted": true}}}',
    );
    const override = JSON.parse(
      '{"__proto__": {"polluted": true}, "mcpServers": {"fs": {"__proto__": {"polluted": true}}}}',
    );
    const merged = mergeConfig(base, override);
    expect(Object.keys(merged).sort()).toEqual(["log", "mcpServers"]);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.keys(merged.log)).toEqual([]);
    expect(Object.keys(merged.mcpServers.fs)).toEqual([]);
    expect(({} as any).polluted).toBeUndefined();
  });

  it("copies keys named constructor and prototype", () => {
    const override = { mcpServers: { constructor: { command: "a" }, prototype: { command: "b" } } };
    expect(mergeConfig({}, override)).toEqual(override);
  });
});

describe("CONFIG_MERGE_RULES", () => {
  it("gives a reason for every rule", () => {
    const missing = CONFIG_MERGE_RULES.filter((rule) => rule.why.length === 0);
    expect(missing).toEqual([]);
  });
});

describe("CONFIG_MERGE_RULES in the user docs", () => {
  const guidePath = path.join(
    findPackageRoot(__dirname),
    "docs",
    "site",
    "guide",
    "agency-config-file.md",
  );
  const guide = fs.readFileSync(guidePath, "utf-8");

  it.each(CONFIG_MERGE_RULES.map((rule) => rule.path))("the config guide lists %s", (rulePath) => {
    expect(guide).toContain(`| \`${rulePath}\` |`);
  });
});
