import process from "process";
import {
  agencyCompletions,
  agencyDefinition,
  agencyDiagnostics,
  agencyDocumentSymbols,
  agencyFormat,
  agencyHover,
} from "./tools.js";
import { VERSION } from "../version.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

type ToolHandler = (args: Record<string, unknown>) => Record<string, unknown>;

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
};

export const MCP_TOOLS: ToolDefinition[] = [
  {
    name: "agency_diagnostics",
    description: "Parse and type-check an .agency file and return diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        text: { type: "string" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
    handler: (args) => agencyDiagnostics(args as any),
  },
  {
    name: "agency_definition",
    description: "Find the definition for the symbol at a file position.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        text: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
      },
      required: ["file_path", "line", "character"],
      additionalProperties: false,
    },
    handler: (args) => agencyDefinition(args as any),
  },
  {
    name: "agency_hover",
    description: "Get hover information for the symbol at a file position.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        text: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
      },
      required: ["file_path", "line", "character"],
      additionalProperties: false,
    },
    handler: (args) => agencyHover(args as any),
  },
  {
    name: "agency_document_symbols",
    description: "List top-level symbols in an .agency file.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        text: { type: "string" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
    handler: (args) => agencyDocumentSymbols(args as any),
  },
  {
    name: "agency_format",
    description: "Format an .agency file and return the formatted text.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        text: { type: "string" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
    handler: (args) => agencyFormat(args as any),
  },
  {
    name: "agency_completions",
    description: "List completion candidates available in an .agency file.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        text: { type: "string" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
    handler: (args) => agencyCompletions(args as any),
  },
];

function success(id: JsonRpcId, result: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result };
}

function error(id: JsonRpcId, code: number, message: string): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(data: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: false,
  };
}

export function handleMcpMessage(message: JsonRpcMessage): JsonRpcMessage | null {
  if (message.jsonrpc !== "2.0") {
    return error(message.id ?? null, -32600, "Expected JSON-RPC 2.0 message");
  }

  switch (message.method) {
    case "initialize":
      return success(message.id ?? null, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: "agency-mcp",
          version: VERSION,
        },
      });
    case "notifications/initialized":
      return null;
    case "ping":
      return success(message.id ?? null, {});
    case "tools/list":
      return success(message.id ?? null, {
        tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
      if (!tool) {
        return error(message.id ?? null, -32602, `Unknown tool '${name}'`);
      }
      try {
        return success(message.id ?? null, toolResult(tool.handler(args)));
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        return success(message.id ?? null, {
          content: [{ type: "text", text: messageText }],
          isError: true,
        });
      }
    }
    case "shutdown":
      return success(message.id ?? null, {});
    case "exit":
      process.exit(0);
    default:
      if (message.id !== undefined) {
        return error(message.id, -32601, `Method not found: ${message.method}`);
      }
      return null;
  }
}

export function startMcpServer(): void {
  process.stdin.setEncoding("utf-8");

  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          const response = handleMcpMessage(JSON.parse(line));
          if (response) {
            process.stdout.write(`${JSON.stringify(response)}\n`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stdout.write(
            `${JSON.stringify(error(null, -32700, `Invalid JSON input: ${message}`))}\n`,
          );
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
}
