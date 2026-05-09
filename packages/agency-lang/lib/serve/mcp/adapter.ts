import process from "process";
import type { InterruptKind } from "../../symbolTable.js";
import type { ExportedFunction, ExportedItem } from "../types.js";
import { errorMessage } from "../util.js";

function formatToolDescription(description: string, interruptKinds: InterruptKind[]): string {
  if (interruptKinds.length === 0) return description;
  const kinds = interruptKinds.map((ik) => ik.kind).join(", ");
  return `${description}\n\nInterrupt kinds: ${kinds}`;
}

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

const MCP_PROTOCOL_VERSION = "2025-06-18";

function success(id: JsonRpcId, result: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function schemaToJsonSchema(schema: unknown): unknown {
  const s = schema as { toJSONSchema?: () => unknown } | null | undefined;
  return s && typeof s.toJSONSchema === "function"
    ? s.toJSONSchema()
    : { type: "object", properties: {} };
}

export type McpConfig = {
  serverName: string;
  serverVersion: string;
  exports: ExportedItem[];
};

export function createMcpHandler(
  config: McpConfig,
): (message: JsonRpcMessage) => Promise<JsonRpcMessage | null> {
  const { serverName, serverVersion, exports } = config;

  const tools = exports.filter((e): e is ExportedFunction => e.kind === "function");
  const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const toolsListPayload = tools.map((t) => ({
    name: t.name,
    description: formatToolDescription(t.description, t.interruptKinds),
    inputSchema: schemaToJsonSchema(t.agencyFunction.toolDefinition?.schema),
    ...(t.agencyFunction.safe ? { annotations: { readOnlyHint: true } } : {}),
  }));

  return async (message: JsonRpcMessage): Promise<JsonRpcMessage | null> => {
    if (message.jsonrpc !== "2.0") {
      return rpcError(message.id ?? null, -32600, "Expected JSON-RPC 2.0 message");
    }

    switch (message.method) {
      case "initialize":
        return success(message.id ?? null, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version: serverVersion },
        });

      case "notifications/initialized":
        return null;

      case "ping":
        return success(message.id ?? null, {});

      case "tools/list":
        return success(message.id ?? null, { tools: toolsListPayload });

      case "tools/call": {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        const tool = toolsByName[name];
        if (!tool) {
          return rpcError(message.id ?? null, -32602, `Unknown tool '${name}'`);
        }
        try {
          const result = await tool.agencyFunction.invoke({
            type: "named",
            positionalArgs: [],
            namedArgs: args,
          });
          return success(message.id ?? null, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: false,
          });
        } catch (err) {
          return success(message.id ?? null, {
            content: [{ type: "text", text: errorMessage(err) }],
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
          return rpcError(message.id, -32601, `Method not found: ${message.method}`);
        }
        return null;
    }
  };
}

function sendResponse(response: JsonRpcMessage | null): void {
  if (response) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

function processLine(
  line: string,
  handler: (message: JsonRpcMessage) => Promise<JsonRpcMessage | null>,
): void {
  try {
    handler(JSON.parse(line))
      .then(sendResponse)
      .catch((err: unknown) => {
        sendResponse(rpcError(null, -32603, `Handler error: ${errorMessage(err)}`));
      });
  } catch (err) {
    sendResponse(rpcError(null, -32700, `Invalid JSON: ${errorMessage(err)}`));
  }
}

export function startStdioServer(
  handler: (message: JsonRpcMessage) => Promise<JsonRpcMessage | null>,
): void {
  process.stdin.setEncoding("utf-8");

  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) processLine(line, handler);
      newlineIndex = buffer.indexOf("\n");
    }
  });
}
