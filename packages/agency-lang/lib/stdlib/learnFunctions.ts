import { z } from "zod";
import { AgencyFunction } from "../runtime/agencyFunction.js";
import { createTool, type CreatedToolDefinition } from "../runtime/createdTool.js";
import { assertUniqueToolNames } from "../runtime/toolInvocation.js";
import type { PreparedFunctions } from "./agencyFunctions.js";

/** Runs inside the metadata node, after the original modules have loaded. */
export function _describeLearnedFunctions(
  targets: AgencyFunction[],
  names: string[],
  callTargets: AgencyFunction[] = [],
): CreatedToolDefinition[] {
  return targets.map((target, index) => {
    const name = names[index];
    try {
      target.validateForLLM();
      if (!target.toolDefinition || !(target.toolDefinition.schema instanceof z.ZodObject)) {
        throw new Error("the function has no concrete parameter schema");
      }
      return {
        name,
        description: target.toolDefinition.description,
        inputSchema: target.toolDefinition.schema.toJSONSchema(),
        params: target.params.map(({ defaultValue: _default, ...param }) => param),
        markers: callTargets[index]?.markers ?? target.markers,
      };
    } catch (error) {
      throw new Error(`Cannot learn '${name}': ${String(error)}`);
    }
  });
}

/** Build the complete batch before returning any callable to the caller. */
export function _createLearnedTools(
  definitions: CreatedToolDefinition[],
  prepared: PreparedFunctions,
  namespace: string,
  options: Record<string, unknown>,
  executePrepared: AgencyFunction,
  maxNameLength: number,
): AgencyFunction[] {
  const tools = definitions.map((definition) => {
    const name = [namespace, definition.name].filter(Boolean).join("_");
    if (name.length > maxNameLength) {
      throw new Error(`Tool name '${name}' exceeds the ${maxNameLength}-character provider limit`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(
        `Tool name '${name}' must contain only letters, numbers, underscores, or hyphens`,
      );
    }
    try {
      return createTool(
        { ...definition, name },
        executePrepared.partial({ prepared, exportName: definition.name, options }),
      );
    } catch (error) {
      throw new Error(`Cannot learn '${definition.name}': ${String(error)}`);
    }
  });
  assertUniqueToolNames(tools);
  return tools;
}
