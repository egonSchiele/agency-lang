// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/standaloneMcpHttp.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import * as mod from {{{compiledModulePath:string}}};
import { discoverExports } from {{{discoveryPath:string}}};
import { createMcpHandler, mcpToolSummaryLines } from {{{mcpAdapterPath:string}}};
import { startMcpHttpServer } from {{{mcpHttpTransportPath:string}}};
import { PolicyStore } from {{{policyStorePath:string}}};
import { createLogger } from {{{loggerPath:string}}};

const exportedNodeNames = {{{exportedNodeNamesJson:string}}};
const interruptEffectsByName = {{{interruptEffectsByNameJson:string}}};

const exports = discoverExports({
  toolRegistry: mod.__toolRegistry ?? {},
  moduleExports: mod,
  moduleId: {{{moduleId:string}}},
  exportedNodeNames,
  interruptEffectsByName,
});

const serverName = {{{serverName:string}}};
const policyStore = new PolicyStore(serverName);

const interruptHandlers = {
  hasInterrupts: mod.hasInterrupts,
  respondToInterrupts: async (interrupts, responses) => {
    const wrapped = await mod.respondToInterrupts(interrupts, responses);
    return wrapped.data;
  },
};

const mcpConfig = {
  serverName,
  serverVersion: {{{serverVersion:string}}},
  exports,
  policyConfig: { policyStore, interruptHandlers },
};
const handler = createMcpHandler(mcpConfig);

const rawPort = process.env.PORT ?? {{{defaultPort:string}}};
const port = parseInt(rawPort, 10);
if (isNaN(port) || port < 1 || port > 65535) {
  console.error("Invalid PORT: " + rawPort + ". Must be an integer between 1 and 65535.");
  process.exit(1);
}
const host = process.env.HOST ?? {{{defaultHost:string}}};
const mcpPath = process.env.MCP_PATH ?? {{{defaultPath:string}}};
const apiKey = process.env[{{{apiKeyEnv:string}}}];

try {
  startMcpHttpServer({
    handler,
    port,
    host,
    path: mcpPath,
    apiKey,
    logger: createLogger("info"),
    toolSummary: mcpToolSummaryLines(mcpConfig),
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
`;

export type TemplateType = {
  compiledModulePath: string;
  discoveryPath: string;
  mcpAdapterPath: string;
  mcpHttpTransportPath: string;
  policyStorePath: string;
  loggerPath: string;
  exportedNodeNamesJson: string;
  interruptEffectsByNameJson: string;
  moduleId: string;
  serverName: string;
  serverVersion: string;
  defaultPort: string;
  defaultHost: string;
  defaultPath: string;
  apiKeyEnv: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    