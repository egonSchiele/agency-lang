import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "test-server",
  version: "1.0.0",
});

server.tool(
  "add",
  "Add two numbers together",
  { a: z.number(), b: z.number() },
  async ({ a, b }) => {
    return {
      content: [{ type: "text" as const, text: String(a + b) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
