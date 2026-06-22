import process from "process";
import type { InterruptEffect } from "../../symbolTable.js";
import type { ExportedFunction, ExportedNode, ExportedItem } from "../types.js";
import type { PolicyStore } from "../policyStore.js";
import type { InterruptHandlers } from "./interruptLoop.js";
import { runWithPolicy } from "./interruptLoop.js";
import { errorMessage } from "../util.js";

function formatToolDescription(description: string, interruptEffects: InterruptEffect[]): string {
  if (interruptEffects.length === 0) return description;
  const effects = interruptEffects.map((ie) => ie.effect).join(", ");
  return `${description}\n\nInterrupt effects: ${effects}`;
}

type JsonRpcId = string | number | null;

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

/** The transport-agnostic handler returned by createMcpHandler. */
export type McpHandler = (message: JsonRpcMessage) => Promise<JsonRpcMessage | null>;

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

export type PolicyConfig = {
  policyStore: PolicyStore;
  interruptHandlers: InterruptHandlers;
};

export type McpConfig = {
  serverName: string;
  serverVersion: string;
  exports: ExportedItem[];
  policyConfig?: PolicyConfig;
};

const POLICY_TOOL_NAMES = {
  GET: "agencyGetPolicy",
  ADD_RULE: "agencyAddRule",
  REMOVE_RULE: "agencyRemoveRule",
  CLEAR: "agencyClearPolicy",
} as const;

const POLICY_TOOL_DEFINITIONS = [
  {
    name: POLICY_TOOL_NAMES.GET,
    description: "Get the current interrupt policy for this agent. Returns a JSON object keyed by interrupt effect, where each effect maps to an ordered array of rules.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: POLICY_TOOL_NAMES.ADD_RULE,
    description: "Add a rule to the interrupt policy. Rules control which actions the agent can take autonomously. Each tool lists its interrupt effects — use those as the 'effect' parameter. Rules are evaluated in order; the first match wins. A rule with no 'match' field is a catch-all.",
    inputSchema: {
      type: "object" as const,
      properties: {
        effect: { type: "string" as const, description: "The interrupt effect to add a rule for (e.g. 'email::send')" },
        action: { type: "string" as const, enum: ["approve", "reject"], description: "What to do when this rule matches" },
        match: { type: "object" as const, additionalProperties: { type: "string" as const }, description: "Optional. Keys are interrupt data field names, values are glob patterns (e.g. '*@company.com'). If omitted, the rule is a catch-all." },
      },
      required: ["effect", "action"],
    },
  },
  {
    name: POLICY_TOOL_NAMES.REMOVE_RULE,
    description: "Remove a rule from the interrupt policy by index. Use agencyGetPolicy to see current rules and their indices.",
    inputSchema: {
      type: "object" as const,
      properties: {
        effect: { type: "string" as const, description: "The interrupt effect to remove a rule from" },
        ruleIndex: { type: "integer" as const, minimum: 0, description: "Zero-based index of the rule to remove" },
      },
      required: ["effect", "ruleIndex"],
    },
  },
  {
    name: POLICY_TOOL_NAMES.CLEAR,
    description: "Clear the entire interrupt policy, resetting to reject-all. After clearing, all interrupt-producing actions will be rejected until new rules are added.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

function handlePolicyTool(
  name: string,
  args: Record<string, any>,
  policyStore: PolicyStore,
): { content: Array<{ type: string; text: string }>; isError: boolean } | null {
  switch (name) {
    case POLICY_TOOL_NAMES.GET:
      return { content: [{ type: "text", text: JSON.stringify(policyStore.get(), null, 2) }], isError: false };
    case POLICY_TOOL_NAMES.ADD_RULE:
      try {
        policyStore.addRule(args.effect, { action: args.action, ...(args.match && { match: args.match }) });
        return { content: [{ type: "text", text: `Rule added for '${args.effect}'.` }], isError: false };
      } catch (err) {
        return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
      }
    case POLICY_TOOL_NAMES.REMOVE_RULE:
      try {
        policyStore.removeRule(args.effect, args.ruleIndex);
        return { content: [{ type: "text", text: `Rule removed from '${args.effect}'.` }], isError: false };
      } catch (err) {
        return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
      }
    case POLICY_TOOL_NAMES.CLEAR:
      try {
        policyStore.clear();
        return { content: [{ type: "text", text: "Policy cleared." }], isError: false };
      } catch (err) {
        return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
      }
    default:
      return null;
  }
}

/**
 * Run a tool invocation through the policy store (if configured) and wrap
 * the result/error into the MCP `tools/call` response shape. `extractData`
 * lets callers unwrap node results that are `{ data, ... }` envelopes
 * before serializing.
 */
async function runToolInvocation(
  id: string | number | null,
  invoke: () => Promise<unknown>,
  policyConfig: McpConfig["policyConfig"],
  extractData: (result: unknown) => unknown = (r) => r,
): Promise<JsonRpcMessage> {
  try {
    const result = policyConfig
      ? await runWithPolicy(invoke, policyConfig.policyStore, policyConfig.interruptHandlers)
      : await invoke();
    return success(id, {
      content: [{ type: "text", text: JSON.stringify(extractData(result), null, 2) }],
      isError: false,
    });
  } catch (err) {
    return success(id, {
      content: [{ type: "text", text: errorMessage(err) }],
      isError: true,
    });
  }
}

async function handleToolCall(
  message: JsonRpcMessage,
  functionsByName: Record<string, ExportedFunction>,
  nodesByName: Record<string, ExportedNode>,
  policyConfig: McpConfig["policyConfig"],
): Promise<JsonRpcMessage> {
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  const id = message.id ?? null;

  if (policyConfig) {
    const policyResult = handlePolicyTool(name, args, policyConfig.policyStore);
    if (policyResult) return success(id, policyResult);
  }

  const fn = functionsByName[name];
  if (fn) {
    return runToolInvocation(
      id,
      () => fn.invoke(args as Record<string, unknown>),
      policyConfig,
    );
  }

  const node = nodesByName[name];
  if (node) {
    const positional = node.parameters.map((p) => args[p.name]);
    return runToolInvocation(
      id,
      () => node.invoke(...positional),
      policyConfig,
      (r) => (r && typeof r === "object" && "data" in r ? (r as any).data : r),
    );
  }

  return rpcError(id, -32602, `Unknown tool '${name}'`);
}

type ToolEntry = {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean };
};

/**
 * Build the `tools/list` payload from a config: one entry per exported
 * function and node, plus the policy-management tools when a policy store
 * is configured. Shared by createMcpHandler (to answer tools/list) and
 * mcpToolSummaryLines (to print the listing at startup).
 */
function buildToolsListPayload(config: McpConfig): ToolEntry[] {
  const { exports, policyConfig } = config;
  const functions = exports.filter((e): e is ExportedFunction => e.kind === "function");
  const nodes = exports.filter((e): e is ExportedNode => e.kind === "node");

  const functionToolEntries: ToolEntry[] = functions.map((f) => ({
    name: f.name,
    description: formatToolDescription(f.description, f.interruptEffects),
    inputSchema: schemaToJsonSchema(f.agencyFunction.toolDefinition?.schema),
    ...(f.agencyFunction.safe ? { annotations: { readOnlyHint: true } } : {}),
  }));

  const nodeToolEntries: ToolEntry[] = nodes.map((n) => ({
    name: n.name,
    description: formatToolDescription(`Run the '${n.name}' node`, n.interruptEffects),
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(n.parameters.map((p) => [p.name, { type: "string" }])),
      required: n.parameters.map((p) => p.name),
    },
  }));

  const toolsListPayload = [...functionToolEntries, ...nodeToolEntries];
  if (policyConfig) {
    toolsListPayload.push(...POLICY_TOOL_DEFINITIONS);
  }
  return toolsListPayload;
}

/**
 * Render a tool's parameters for display from its JSON Schema, e.g.
 * `(name, count?)`. Optional params (not in `required`) get a `?` suffix.
 * Returns "" when the tool takes no params.
 */
function describeToolSchema(inputSchema: unknown): string {
  const s = inputSchema as
    | { properties?: Record<string, unknown>; required?: string[] }
    | null
    | undefined;
  const names = Object.keys(s?.properties ?? {});
  if (names.length === 0) return "";
  const required = s?.required ?? [];
  const parts = names.map((n) => (required.includes(n) ? n : `${n}?`));
  return ` (${parts.join(", ")})`;
}

/**
 * Build the lines printed at MCP server startup listing the exposed tools,
 * e.g. ["Tools exposed:", "  add (a, b)", "  main (message)"]. Callers
 * decide where to write them (stderr for stdio, logger for HTTP).
 */
export function mcpToolSummaryLines(config: McpConfig): string[] {
  const entries = buildToolsListPayload(config);
  return [
    "Tools exposed:",
    ...entries.map((e) => `  ${e.name}${describeToolSchema(e.inputSchema)}`),
  ];
}

export function createMcpHandler(config: McpConfig): McpHandler {
  const { serverName, serverVersion, exports } = config;

  const functions = exports.filter((e): e is ExportedFunction => e.kind === "function");
  const nodes = exports.filter((e): e is ExportedNode => e.kind === "node");
  const functionsByName = Object.fromEntries(functions.map((f) => [f.name, f]));
  const nodesByName = Object.fromEntries(nodes.map((n) => [n.name, n]));

  const toolsListPayload = buildToolsListPayload(config);

  const { policyConfig } = config;

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

      case "tools/call":
        return handleToolCall(message, functionsByName, nodesByName, policyConfig);

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

function processLine(line: string, handler: McpHandler): void {
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

/**
 * Maximum size of an unterminated stdio line. A peer that streams data
 * without ever sending a newline would otherwise grow the buffer
 * unboundedly and OOM the process.
 */
const MAX_STDIO_LINE_BYTES = 10 * 1024 * 1024; // 10 MB

export function startStdioServer(
  handler: McpHandler,
  toolSummary?: string[],
): void {
  // stdout is the JSON-RPC channel for the stdio transport, so the tool
  // listing must go to stderr (the MCP-conventional log channel) to avoid
  // corrupting the protocol stream.
  if (toolSummary) {
    for (const line of toolSummary) process.stderr.write(`${line}\n`);
  }

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
    const bufferBytes = Buffer.byteLength(buffer, "utf-8");
    if (bufferBytes > MAX_STDIO_LINE_BYTES) {
      // Drop the oversized partial and continue reading. We can't reply
      // because we have no message id; surface the problem to stderr.
      process.stderr.write(
        `MCP stdio: discarding partial input of ${bufferBytes} bytes (no newline within ${MAX_STDIO_LINE_BYTES} bytes)\n`,
      );
      buffer = "";
    }
  });
}
