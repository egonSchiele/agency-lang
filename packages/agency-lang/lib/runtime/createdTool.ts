import { z } from "zod";
import { AgencyFunction } from "./agencyFunction.js";
import type { FuncParam, ToolDefinition, ToolMarkers } from "./agencyFunction.js";

export type CreatedToolDefinition = Pick<ToolDefinition, "name" | "description"> & {
  inputSchema: unknown;
  params: Omit<FuncParam, "defaultValue">[];
  markers: ToolMarkers;
};

/** The executor's normal function reference carries its partial bindings. */
export type CreatedTool = {
  definition: CreatedToolDefinition;
  executor: AgencyFunction;
};

/** Build a callable from compiled metadata and a registered executor that
 *  accepts the resolved arguments as one record. */
export function createTool(
  definition: CreatedToolDefinition,
  executor: AgencyFunction,
): AgencyFunction {
  if (!AgencyFunction.isAgencyFunction(executor)) {
    throw new Error("A created tool's executor must be an Agency function");
  }
  const [record, ...remaining] = executor.getUnboundParams();
  if (
    !record ||
    record.variadic ||
    record.isFunctionTyped ||
    remaining.some((param) => !param.hasDefault && !param.variadic)
  ) {
    throw new Error(
      "A created tool's executor must accept one argument record with no other required arguments",
    );
  }
  return buildCreatedTool({ definition, executor });
}

function buildCreatedTool(created: CreatedTool): AgencyFunction {
  const { definition, executor } = created;
  const schema = z.fromJSONSchema(definition.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(`Created tool '${definition.name}' needs an object parameter schema`);
  }
  const tool = new AgencyFunction({
    name: definition.name,
    module: executor.module,
    params: definition.params.map((param) => ({ ...param, defaultValue: undefined })),
    toolDefinition: {
      name: definition.name,
      description: definition.description,
      schema,
    },
    markers: definition.markers,
    created,
    fn: (run, ...resolved) =>
      executor.invoke(run, { type: "positional", args: [tool.namedArguments(resolved)] }),
  });
  tool.validateForLLM();
  return tool;
}

/** The executor may be an unresolved reference while a parent carries a
 *  child's checkpoint. Preserve it without requiring its module here. */
export function restoreCreatedTool(value: unknown): AgencyFunction {
  if (
    !value ||
    typeof value !== "object" ||
    !("definition" in value) ||
    !("executor" in value) ||
    !AgencyFunction.isAgencyFunction(value.executor)
  ) {
    throw new Error(
      "Invalid created function reference: expected a definition and Agency executor",
    );
  }
  const definition = value.definition as CreatedToolDefinition | null;
  if (
    !definition ||
    typeof definition.name !== "string" ||
    typeof definition.description !== "string" ||
    !Array.isArray(definition.params) ||
    !definition.markers ||
    typeof definition.markers !== "object"
  ) {
    throw new Error("Invalid created function reference: malformed tool definition");
  }
  return buildCreatedTool({ definition, executor: value.executor });
}
