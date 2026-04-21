import { describe, it, expect } from "vitest";
import { AgencyConfigSchema } from "./config.js";

describe("AgencyConfigSchema", () => {
  it("should accept an empty config", () => {
    const result = AgencyConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should accept a config with existing fields", () => {
    const result = AgencyConfigSchema.safeParse({
      verbose: true,
      outDir: "dist",
      maxToolCallRounds: 5,
    });
    expect(result.success).toBe(true);
  });

  it("should accept a config with stdio MCP server", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { FOO: "bar" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("should accept a config with HTTP MCP server", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        weather: {
          type: "http",
          url: "https://weather-mcp.example.com/mcp",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("should accept a config with mixed MCP servers", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        filesystem: { command: "npx", args: ["server"] },
        weather: { type: "http", url: "https://example.com/mcp" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("should reject an HTTP server missing url", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        bad: { type: "http" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("should reject a stdio server missing command", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        bad: { args: ["foo"] },
      },
    });
    expect(result.success).toBe(false);
  });
});
