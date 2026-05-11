// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/standaloneMcp.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import * as mod from {{{compiledModulePath:string}}};
import { discoverExports } from {{{discoveryPath:string}}};
import { createMcpHandler, startStdioServer } from {{{mcpAdapterPath:string}}};
import { PolicyStore } from {{{policyStorePath:string}}};

const exportedNodeNames = {{{exportedNodeNamesJson:string}}};
const interruptKindsByName = {{{interruptKindsByNameJson:string}}};

const exports = discoverExports({
  toolRegistry: mod.__toolRegistry ?? {},
  moduleExports: mod,
  moduleId: {{{moduleId:string}}},
  exportedNodeNames,
  interruptKindsByName,
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

const handler = createMcpHandler({
  serverName,
  serverVersion: {{{serverVersion:string}}},
  exports,
  policyConfig: { policyStore, interruptHandlers },
});

startStdioServer(handler);
`;

export type TemplateType = {
  compiledModulePath: string;
  discoveryPath: string;
  mcpAdapterPath: string;
  policyStorePath: string;
  exportedNodeNamesJson: string;
  interruptKindsByNameJson: string;
  moduleId: string;
  serverName: string;
  serverVersion: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    