import { describe, expect, it } from "vitest";
import { McpServersSchema } from "./mcpServers.js";

const isValid = (servers: unknown) => McpServersSchema.safeParse(servers).success;

describe("McpServersSchema", () => {
  it("accepts a stdio server and an http server", () => {
    expect(isValid({ fs: { command: "npx", args: ["-y", "x"], env: { A: "1" } } })).toBe(true);
    expect(isValid({ web: { type: "http", url: "https://x/mcp", headers: { A: "b" } } })).toBe(
      true,
    );
    expect(isValid({ web: { type: "http", url: "http://localhost:3000", auth: "oauth" } })).toBe(
      true,
    );
  });

  it("rejects bad names and unknown fields", () => {
    expect(isValid({ "bad name": { command: "npx" } })).toBe(false);
    expect(isValid({ fs: { command: "npx", extra: 1 } })).toBe(false);
  });

  it.each([
    { auth: "oauth", headers: { A: "b" } },
    { authTimeout: 5 },
    { clientId: "id" },
    { clientSecret: "secret" },
  ])("rejects the http field combination %o", (fields) => {
    expect(isValid({ web: { type: "http", url: "https://x", ...fields } })).toBe(false);
  });

  it("requires https for OAuth, except on localhost", () => {
    expect(isValid({ web: { type: "http", url: "http://example.com", auth: "oauth" } })).toBe(
      false,
    );
    expect(isValid({ web: { type: "http", url: "not a url", auth: "oauth" } })).toBe(false);
  });

  it("keeps the old error messages", () => {
    const result = McpServersSchema.safeParse({
      web: { type: "http", url: "not a url", auth: "oauth" },
    });
    const messages = result.error?.issues.map((issue) => issue.message);
    expect(messages).toEqual(['MCP server "web": invalid URL "not a url"']);
  });
});
