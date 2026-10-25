import { AgencyFunction } from "../runtime/agencyFunction.js";
import { createTool, type CreatedToolDefinition } from "../runtime/createdTool.js";
import { failure, success, type ResultValue } from "../runtime/result.js";
import type { PreparedFunctions } from "./agencyFunctions.js";

/** Each record points to the prepared program shared by its learning batch. */
export type LearnedRecord = {
  advertisedName: string;
  definition: CreatedToolDefinition;
  programIndex: number;
  exportName: string;
  options: Record<string, unknown>;
};

/** The coordinator keeps this data together in one Agency global. */
export type LearnedState = {
  programs: PreparedFunctions[];
  records: LearnedRecord[];
};

type LearnedCandidate = Omit<LearnedRecord, "programIndex"> & {
  prepared: PreparedFunctions;
};

function learnedCandidate(tool: AgencyFunction): LearnedCandidate {
  const invalid = () => new Error(`Cannot keep ${tool.name}: it was not returned by learn.`);
  if (!tool.created) {
    throw invalid();
  }
  const bindings = Object.fromEntries(
    tool.created.executor.params
      .filter((param) => param.isBound)
      .map((param) => [param.name, param.boundValue]),
  );
  if (
    ["prepared", "exportName", "options"].some(
      (name) => !Object.hasOwn(bindings, name) || bindings[name] === undefined,
    )
  ) {
    throw invalid();
  }
  const prepared = bindings.prepared as PreparedFunctions | null;
  if (!prepared?.compiled || typeof prepared.compiled.moduleId !== "string") {
    throw invalid();
  }
  return {
    advertisedName: tool.name,
    definition: tool.created.definition,
    prepared,
    exportName: bindings.exportName as string,
    options: bindings.options as Record<string, unknown>,
  };
}

/** Extract only tools returned by learn. A module ID identifies one prepared
 * batch even after a checkpoint has copied its bound values into each tool. */
export function _learnedRecords(tools: AgencyFunction[]): LearnedState {
  const candidates = tools.map(learnedCandidate);
  const allPrograms = candidates.map((candidate) => candidate.prepared);
  const programs = allPrograms.filter(
    (program, index) =>
      allPrograms.findIndex((other) => other.compiled.moduleId === program.compiled.moduleId) ===
      index,
  );
  const records = candidates.map(({ prepared, ...record }) => ({
    ...record,
    programIndex: programs.findIndex(
      (program) => program.compiled.moduleId === prepared.compiled.moduleId,
    ),
  }));
  return { programs, records };
}

export function _toolsFromRecords(
  state: LearnedState,
  executePrepared: AgencyFunction,
): AgencyFunction[] {
  return state.records.map((record) => {
    const prepared = state.programs[record.programIndex];
    if (!prepared) {
      throw new Error(`Cannot rebuild ${record.advertisedName}: its prepared program is missing.`);
    }
    return createTool(
      record.definition,
      executePrepared.partial({ prepared, exportName: record.exportName, options: record.options }),
    );
  });
}

/** Validate the complete batch before the caller replaces its global. */
export function _addLearnedRecords(
  current: LearnedState,
  candidates: LearnedState,
  offeredNames: string[],
  maxNameLength: number,
): ResultValue {
  const names = candidates.records.map((record) => record.advertisedName);
  const occupied = [...offeredNames, ...current.records.map((record) => record.advertisedName)];
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
  const added = candidates.records.map((record) => ({
    ...record,
    programIndex: current.programs.length + record.programIndex,
  }));
  return success({
    programs: [...current.programs, ...candidates.programs],
    records: [...current.records, ...added],
  });
}
