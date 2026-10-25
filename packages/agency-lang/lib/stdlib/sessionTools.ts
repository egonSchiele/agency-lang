import { AgencyFunction } from "../runtime/agencyFunction.js";
import { createTool, type CreatedToolDefinition } from "../runtime/createdTool.js";
import { failure, success, type ResultValue } from "../runtime/result.js";
import type { PreparedFunctions } from "./agencyFunctions.js";

/** The coordinator saves these records in its Agency globals. No callable
 *  is needed to rebuild a turn's tools from a between-turn checkpoint. */
export type LearnedRecord = {
  advertisedName: string;
  definition: CreatedToolDefinition;
  prepared: PreparedFunctions;
  exportName: string;
  options: Record<string, unknown>;
};

/** Only tools just returned by std::agency.learn pass through here. Keep
 *  knowledge of their executor bindings out of the coordinator's Agency code. */
export function _learnedRecords(tools: AgencyFunction[]): LearnedRecord[] {
  return tools.map((tool) => {
    if (!tool.created) {
      throw new Error(`Cannot keep ${tool.name}: it was not returned by learn.`);
    }
    const bindings = Object.fromEntries(
      tool.created.executor.params
        .filter((param) => param.isBound)
        .map((param) => [param.name, param.boundValue]),
    );
    return {
      advertisedName: tool.name,
      definition: tool.created.definition,
      prepared: bindings.prepared as PreparedFunctions,
      exportName: bindings.exportName as string,
      options: bindings.options as Record<string, unknown>,
    };
  });
}

export function _toolsFromRecords(
  records: LearnedRecord[],
  executePrepared: AgencyFunction,
): AgencyFunction[] {
  return records.map((record) =>
    createTool(
      record.definition,
      executePrepared.partial({
        prepared: record.prepared,
        exportName: record.exportName,
        options: record.options,
      }),
    ),
  );
}

/** Validate the complete batch before the caller replaces its global. */
export function _addLearnedRecords(
  current: LearnedRecord[],
  candidates: LearnedRecord[],
  offeredNames: string[],
  maxNameLength: number,
): ResultValue {
  const names = candidates.map((record) => record.advertisedName);
  const occupied = [...offeredNames, ...current.map((record) => record.advertisedName)];
  const duplicate = names.find(
    (name, index) => occupied.includes(name) || names.indexOf(name) < index,
  );
  if (duplicate !== undefined) {
    return failure(`A tool named '${duplicate}' is already available. Choose another namespace.`);
  }
  const tooLong = names.find((name) => name.length > maxNameLength);
  if (tooLong !== undefined) {
    return failure(`Tool name '${tooLong}' exceeds the ${maxNameLength}-character provider limit.`);
  }
  return success([...current, ...candidates]);
}
