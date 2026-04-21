import { describe, it, expect, afterEach } from "vitest";
import { McpConnection, interpolateEnvVars } from "./mcpConnection.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SERVER_PATH = path.join(__dirname, "__tests__", "testServer.ts");

describe("McpConnection", () => {
  let conn: McpConnection;

  afterEach(async () => {
    if (conn) {
      await conn.disconnect();
    }
  });

  it("should connect to a stdio server, list tools, and call a tool", async () => {
    conn = new McpConnection("test", {
      command: "npx",
      args: ["tsx", TEST_SERVER_PATH],
    });

    await conn.connect();

    const tools = conn.getTools();
    expect(tools.length).toBeGreaterThan(0);

    const addTool = tools.find((t) => t.name === "test__add");
    expect(addTool).toBeDefined();
    expect(addTool!.serverName).toBe("test");
    expect(addTool!.__mcpTool).toBe(true);

    const result = await conn.callTool("add", { a: 3, b: 4 });
    expect(result).toContain("7");
  });

  it("should throw when connecting to a nonexistent server", async () => {
    conn = new McpConnection("bad", {
      command: "nonexistent-command-that-does-not-exist",
    });

    await expect(conn.connect()).rejects.toThrow();
  });
});

describe("interpolateEnvVars", () => {
  it("should replace ${VAR} with env values", () => {
    const original = process.env.TEST_VAR_ABC;
    process.env.TEST_VAR_ABC = "hello";
    try {
      const result = interpolateEnvVars({ "Authorization": "Bearer ${TEST_VAR_ABC}" });
      expect(result["Authorization"]).toBe("Bearer hello");
    } finally {
      if (original === undefined) delete process.env.TEST_VAR_ABC;
      else process.env.TEST_VAR_ABC = original;
    }
  });

  it("should throw if env var is not set", () => {
    delete process.env.NONEXISTENT_VAR_XYZ;
    expect(() =>
      interpolateEnvVars({ "Authorization": "Bearer ${NONEXISTENT_VAR_XYZ}" }),
    ).toThrow(/NONEXISTENT_VAR_XYZ/);
  });

  it("should pass through headers without env vars unchanged", () => {
    const result = interpolateEnvVars({ "X-Custom": "static-value" });
    expect(result["X-Custom"]).toBe("static-value");
  });

  it("should reject values containing CRLF (CRLF injection)", () => {
    const original = process.env.TEST_CRLF_VAR;
    process.env.TEST_CRLF_VAR = "token\r\nX-Injected: evil";
    try {
      expect(() =>
        interpolateEnvVars({ "Authorization": "Bearer ${TEST_CRLF_VAR}" }),
      ).toThrow(/newline/i);
    } finally {
      if (original === undefined) delete process.env.TEST_CRLF_VAR;
      else process.env.TEST_CRLF_VAR = original;
    }
  });

  it("should reject values containing bare LF (LF injection)", () => {
    const original = process.env.TEST_LF_VAR;
    process.env.TEST_LF_VAR = "token\nX-Injected: evil";
    try {
      expect(() =>
        interpolateEnvVars({ "Authorization": "Bearer ${TEST_LF_VAR}" }),
      ).toThrow(/newline/i);
    } finally {
      if (original === undefined) delete process.env.TEST_LF_VAR;
      else process.env.TEST_LF_VAR = original;
    }
  });
});

describe("McpConnection with connector", () => {
  it("should accept a connector function option", () => {
    const conn = new McpConnection("test", {
      type: "http",
      url: "https://example.com/mcp",
      auth: "oauth",
    }, {
      connector: async () => {
        throw new Error("mock connector");
      },
    });
    expect(conn).toBeDefined();
  });
});
