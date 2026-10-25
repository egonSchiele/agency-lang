import { AgencyFunction, createTool } from "agency-lang/runtime";
import { z } from "zod";

const definition = {
  name: "runtimeEcho",
  description: "Echo a query.",
  inputSchema: z.object({ query: z.string() }).toJSONSchema(),
  params: [{ name: "query", aliases: ["q"], hasDefault: false, variadic: false }],
  markers: { idempotent: true },
};

export function makeUnregisteredTool() {
  return new AgencyFunction({
    name: definition.name,
    module: "unregistered-fixture",
    params: definition.params.map(param => ({ ...param, defaultValue: undefined })),
    toolDefinition: {
      name: definition.name,
      description: definition.description,
      schema: z.fromJSONSchema(definition.inputSchema),
    },
    fn: (_run, query) => `unregistered:${query}`,
  });
}

export function makeCreatedTool(executor) {
  return createTool(definition, executor);
}
