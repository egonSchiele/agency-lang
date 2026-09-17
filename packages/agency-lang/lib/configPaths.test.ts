import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isPlainObject,
  mapConfigValues,
  matchesConfigPath,
  schemaAtConfigPath,
} from "./configPaths.js";

describe("matchesConfigPath", () => {
  it("matches exact keys and * wildcards", () => {
    expect(matchesConfigPath("log.apiKey", ["log", "apiKey"])).toBe(true);
    expect(matchesConfigPath("mcpServers.*", ["mcpServers", "fs"])).toBe(true);
    expect(matchesConfigPath("mcpServers.*.env.*", ["mcpServers", "fs", "env", "TOKEN"])).toBe(
      true,
    );
  });

  it("does not match a different key or a different length", () => {
    expect(matchesConfigPath("log.apiKey", ["log", "host"])).toBe(false);
    expect(matchesConfigPath("mcpServers.*", ["mcpServers"])).toBe(false);
    expect(matchesConfigPath("mcpServers.*", ["mcpServers", "fs", "env"])).toBe(false);
  });
});

describe("mapConfigValues", () => {
  const upper = (value: unknown) => (typeof value === "string" ? value.toUpperCase() : value);

  it("transforms only the values at matching paths", () => {
    const config = {
      log: { apiKey: "secret", host: "host" },
      mcpServers: { fs: { command: "npx", env: { TOKEN: "tok" } } },
    };
    expect(mapConfigValues(config, ["log.apiKey", "mcpServers.*.env.*"], upper)).toEqual({
      log: { apiKey: "SECRET", host: "host" },
      mcpServers: { fs: { command: "npx", env: { TOKEN: "TOK" } } },
    });
  });

  it("returns a copy and leaves the input alone", () => {
    const config = { log: { apiKey: "secret" } };
    mapConfigValues(config, ["log.apiKey"], upper);
    expect(config).toEqual({ log: { apiKey: "secret" } });
  });

  it("copies arrays", () => {
    expect(mapConfigValues({ list: ["a"] }, [], upper)).toEqual({ list: ["a"] });
  });
});

describe("schemaAtConfigPath", () => {
  const schema = z
    .object({
      log: z.object({ apiKey: z.string() }).partial(),
      keys: z.object({ openAi: z.string() }).partial(),
      servers: z.record(
        z.string(),
        z.union([z.object({ command: z.string() }), z.object({ url: z.string() })]),
      ),
    })
    .partial();

  it("finds fields, record values, union members, and any key of an object", () => {
    expect(schemaAtConfigPath(schema, "log.apiKey")).toBeDefined();
    expect(schemaAtConfigPath(schema, "servers.*")).toBeDefined();
    expect(schemaAtConfigPath(schema, "servers.*.url")).toBeDefined();
    expect(schemaAtConfigPath(schema, "keys.*")).toBeDefined();
  });

  it("returns undefined for a path the schema does not have", () => {
    expect(schemaAtConfigPath(schema, "log.nope")).toBeUndefined();
    expect(schemaAtConfigPath(schema, "servers.fs")).toBeUndefined();
    expect(schemaAtConfigPath(schema, "servers.*.nope")).toBeUndefined();
  });
});

describe("isPlainObject", () => {
  it("is true only for non-array objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });
});
