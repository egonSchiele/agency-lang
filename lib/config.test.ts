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

  it("should accept HTTP server with auth: oauth", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        github: { type: "http", url: "https://github-mcp.example.com/mcp", auth: "oauth" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("should accept HTTP server with headers", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        weather: {
          type: "http",
          url: "https://weather.example.com/mcp",
          headers: { "Authorization": "Bearer ${WEATHER_KEY}" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("should accept HTTP server with authTimeout", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        github: {
          type: "http",
          url: "https://github-mcp.example.com/mcp",
          auth: "oauth",
          authTimeout: 120000,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("should reject HTTP server with both auth and headers", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        github: {
          type: "http",
          url: "https://example.com/mcp",
          auth: "oauth",
          headers: { "Authorization": "Bearer token" },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("should reject authTimeout without auth: oauth", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        github: {
          type: "http",
          url: "https://example.com/mcp",
          authTimeout: 120000,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("should reject clientSecret without auth: oauth", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        github: {
          type: "http",
          url: "https://example.com/mcp",
          clientSecret: "secret",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("should reject OAuth over plain HTTP (non-localhost)", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        github: {
          type: "http",
          url: "http://evil.com/mcp",
          auth: "oauth",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("should allow OAuth over HTTP on localhost", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        local: {
          type: "http",
          url: "http://localhost:3000/mcp",
          auth: "oauth",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("should reject server names with invalid characters", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        "../evil": { command: "npx", args: ["server"] },
      },
    });
    expect(result.success).toBe(false);
  });

  it("should reject auth on stdio server", () => {
    const result = AgencyConfigSchema.safeParse({
      mcpServers: {
        local: {
          command: "npx",
          args: ["some-server"],
          auth: "oauth",
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
