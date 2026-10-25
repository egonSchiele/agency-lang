import { expect, it as baseIt } from "vitest";
import { z } from "zod";
import { AgencyFunction, type FuncParam } from "../runtime/agencyFunction.js";
import { createTool, type CreatedToolDefinition } from "../runtime/createdTool.js";
import { testRun, withTestFrame } from "../runtime/__tests__/testHelpers.js";
import { callFromOutside } from "../runtime/toolInvocation.js";
import type { PreparedFunctions } from "./agencyFunctions.js";
import { _addLearnedRecords, _learnedRecords, _toolsFromRecords } from "./sessionTools.js";

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

function learned() {
  return createTool(
    definition,
    executor().partial({
      prepared,
      exportName: "lookup",
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

it("refuses a whole batch when a name is already held, offered, repeated, or too long", () => {
  const records = _learnedRecords([learned()]);
  expect(_addLearnedRecords(records, records, [], 64).success).toBe(false);
  expect(_addLearnedRecords([], records, ["session_lookup"], 64).success).toBe(false);
  expect(_addLearnedRecords([], [...records, ...records], [], 64).success).toBe(false);
  expect(_addLearnedRecords([], records, [], 5).success).toBe(false);
  expect(records).toHaveLength(1);
  expect(_addLearnedRecords([], records, [], 64)).toMatchObject({ success: true, value: records });
});
