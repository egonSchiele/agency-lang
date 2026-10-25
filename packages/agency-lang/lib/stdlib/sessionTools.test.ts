import { expect, it as baseIt } from "vitest";
import { z } from "zod";
import { AgencyFunction, type FuncParam } from "../runtime/agencyFunction.js";
import { createTool, type CreatedToolDefinition } from "../runtime/createdTool.js";
import { testRun, withTestFrame } from "../runtime/__tests__/testHelpers.js";
import { callFromOutside } from "../runtime/toolInvocation.js";
import type { PreparedFunctions } from "./agencyFunctions.js";
import {
  _addLearnedRecords,
  _learnedRecords,
  _toolsFromRecords,
  type LearnedState,
} from "./sessionTools.js";

const it = withTestFrame(baseIt);
const param = (name: string): FuncParam => ({
  name,
  hasDefault: false,
  defaultValue: undefined,
  variadic: false,
});
const prepared: PreparedFunctions = {
  compiled: { moduleId: "test", code: "prepared code" },
  exportNames: ["lookup"],
  sourceModule: "fixture.agency",
  invokeNode: "invokeLearned",
};
const definition: CreatedToolDefinition = {
  name: "session_lookup",
  description: "Look up a series.",
  inputSchema: z.object({ seriesId: z.string() }).toJSONSchema(),
  params: [{ ...param("seriesId"), aliases: ["id"] }],
  markers: { idempotent: true },
};

function executor() {
  return AgencyFunction.create(
    {
      name: "executePrepared",
      module: "session-tools-test",
      params: [param("prepared"), param("exportName"), param("args"), param("options")],
      fn: (_run, program, name, args, options) => ({ program, name, args, options }),
    },
    {},
  );
}

function learned(name = "session_lookup", exportName = "lookup", program = prepared) {
  return createTool(
    { ...definition, name },
    executor().partial({
      prepared: program,
      exportName,
      options: { maxCost: 0.1 },
    }),
  );
}

it("keeps data only, then rebuilds the schema, aliases, and executor bindings", async () => {
  const records = _learnedRecords([learned()]);
  const restored = JSON.parse(JSON.stringify(records));
  expect(restored).toEqual(records);
  const [tool] = _toolsFromRecords(restored, executor());
  expect(tool.toolDefinition!.schema.toJSONSchema()).toEqual(definition.inputSchema);
  expect(await tool.invoke(testRun(), callFromOutside({ id: "UNRATE" }))).toEqual({
    program: prepared,
    name: "lookup",
    args: { seriesId: "UNRATE" },
    options: { maxCost: 0.1 },
  });
});

const empty: LearnedState = { programs: [], records: [] };

it("stores one prepared program for multiple exports after JSON has copied their bindings", async () => {
  const state = _learnedRecords([
    learned(),
    learned("session_search", "search", JSON.parse(JSON.stringify(prepared))),
  ]);
  const serialized = JSON.stringify(state);
  expect(serialized.match(/prepared code/g)).toHaveLength(1);
  const restored = JSON.parse(serialized);
  expect(restored.programs).toHaveLength(1);
  expect(restored.records.map((record: { programIndex: number }) => record.programIndex)).toEqual([
    0, 0,
  ]);
  expect(restored.records.every((record: object) => !Object.hasOwn(record, "prepared"))).toBe(true);
  const tools = _toolsFromRecords(restored, executor());
  for (const [index, tool] of tools.entries()) {
    expect(await tool.invoke(testRun(), callFromOutside({ id: "UNRATE" }))).toEqual({
      program: prepared,
      name: index === 0 ? "lookup" : "search",
      args: { seriesId: "UNRATE" },
      options: { maxCost: 0.1 },
    });
  }
});

it("offsets program indexes when another learning batch is appended", async () => {
  const first = _learnedRecords([learned()]);
  const secondProgram = { ...prepared, compiled: { moduleId: "second", code: "second code" } };
  const second = _learnedRecords([learned("next_lookup", "lookup", secondProgram)]);
  const result = _addLearnedRecords(first, second, [], 64);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(result.error);
  }
  expect(result.value.programs).toEqual([prepared, secondProgram]);
  expect(
    result.value.records.map((record: { programIndex: number }) => record.programIndex),
  ).toEqual([0, 1]);
  const [, rebuilt] = _toolsFromRecords(JSON.parse(JSON.stringify(result.value)), executor());
  expect(await rebuilt.invoke(testRun(), callFromOutside({ id: "GDP" }))).toMatchObject({
    program: secondProgram,
    args: { seriesId: "GDP" },
  });
  expect(first.programs).toHaveLength(1);
  expect(second.records[0].programIndex).toBe(0);
});

it("refuses missing, renamed, or unbound executor bindings during extraction", () => {
  for (const name of ["prepared", "exportName", "options"]) {
    for (const change of ["rename", "unbound", "undefined"]) {
      const tool = learned();
      const binding = tool.created!.executor.params.find((parameter) => parameter.name === name)!;
      if (change === "rename") {
        binding.name = "changed";
      }
      if (change === "unbound") {
        binding.isBound = false;
      }
      if (change === "undefined") {
        binding.boundValue = undefined;
      }
      expect(() => _learnedRecords([tool])).toThrow("was not returned by learn");
    }
  }
});

it("refuses a whole batch when a name is already held, offered, repeated, or too long", () => {
  const records = _learnedRecords([learned()]);
  expect(_addLearnedRecords(records, records, [], 64).success).toBe(false);
  expect(_addLearnedRecords(empty, records, ["session_lookup"], 64).success).toBe(false);
  const repeated = { ...records, records: [...records.records, ...records.records] };
  expect(_addLearnedRecords(empty, repeated, [], 64).success).toBe(false);
  expect(_addLearnedRecords(empty, records, [], 5).success).toBe(false);
  expect(records.records).toHaveLength(1);
  expect(records.programs).toHaveLength(1);
  expect(_addLearnedRecords(empty, records, [], 64)).toMatchObject({
    success: true,
    value: records,
  });
});
