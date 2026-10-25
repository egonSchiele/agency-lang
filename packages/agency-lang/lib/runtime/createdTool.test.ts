import { describe, expect, it as baseIt } from "vitest";
import { z } from "zod";
import { AgencyFunction } from "./agencyFunction.js";
import type { FuncParam } from "./agencyFunction.js";
import { createTool } from "./createdTool.js";
import type { CreatedToolDefinition } from "./createdTool.js";
import { callFromOutside, toolArgumentsFor } from "./toolInvocation.js";
import { repeatKey } from "./toolLoopGuards.js";
import { failure } from "./result.js";
import { testRun, withTestFrame } from "./__tests__/testHelpers.js";

const it = withTestFrame(baseIt);
const param = (name: string, extra: Partial<FuncParam> = {}): FuncParam => ({
  name,
  hasDefault: false,
  defaultValue: undefined,
  variadic: false,
  ...extra,
});

function executor(body: (args: Record<string, unknown>) => unknown = (args) => args) {
  return AgencyFunction.create(
    {
      name: "execute",
      module: "created-tool-test",
      params: [param("args")],
      toolDefinition: null,
      fn: (_run, args: Record<string, unknown>) => body(args),
    },
    {},
  );
}

const definition = (): CreatedToolDefinition => ({
  name: "lookup",
  description: "Look up a series.",
  inputSchema: z
    .object({
      seriesId: z.string(),
      limit: z.number().nullable().describe("Default: 10"),
      values: z.array(z.number()),
    })
    .toJSONSchema(),
  params: [
    param("seriesId", { aliases: ["series"] }),
    param("limit", { hasDefault: true }),
    param("values", { variadic: true }),
  ],
  markers: { idempotent: true },
});

const jsonSchema = (tool: AgencyFunction) =>
  (tool.toolDefinition!.schema as z.ZodType).toJSONSchema();

describe("createTool", () => {
  it("keeps the compiled schema, flat parameters, description, and markers", () => {
    const source = definition();
    const tool = createTool(source, executor());
    expect(jsonSchema(tool)).toEqual(source.inputSchema);
    expect(tool.params).toEqual(source.params);
    expect(tool.description).toBe(source.description);
    expect(tool.markers).toEqual({ idempotent: true });
  });

  it("preserves imported-type shapes and schema annotations through JSON", () => {
    const inputSchema = z
      .object({
        request: z.object({
          kind: z.enum(["series", "search"]),
          filters: z.record(z.string(), z.union([z.string(), z.number()])).nullable(),
        }),
        label: z.string().meta({ description: "A display label", examples: ["GDP"] }),
      })
      .toJSONSchema();
    const tool = createTool(
      { ...definition(), inputSchema, params: [param("request"), param("label")] },
      executor(),
    );
    expect(jsonSchema(tool)).toEqual(inputSchema);
  });

  it("normalizes aliases and model nulls before building the executor record", async () => {
    const tool = createTool(definition(), executor());
    const normalized = toolArgumentsFor(tool, {
      arguments: { series: "UNRATE", limit: null, values: [1, 2] },
    });
    expect(normalized.argCorrections).toEqual([{ from: "series", to: "seriesId" }]);
    expect(await tool.invoke(testRun(), callFromOutside(normalized.namedArgs))).toEqual({
      seriesId: "UNRATE",
      values: [1, 2],
    });
  });

  it("leaves defaults to the executor and preserves explicit programmatic null", async () => {
    const tool = createTool(definition(), executor());
    expect(await tool.invoke(testRun(), callFromOutside({ seriesId: "UNRATE" }))).toEqual({
      seriesId: "UNRATE",
      values: [],
    });
    expect(
      await tool.invoke(testRun(), callFromOutside({ seriesId: "UNRATE", limit: null })),
    ).toEqual({ seriesId: "UNRATE", limit: null, values: [] });
  });

  it("reports original unknown, missing, alias-conflict, and variadic errors", async () => {
    const tool = createTool(definition(), executor());
    for (const [args, message] of [
      [{ typo: "UNRATE" }, /Unknown named argument 'typo'.*seriesId/s],
      [{}, /Missing required argument 'seriesId'/],
      [{ series: "A", seriesId: "B" }, /Both 'series' and 'seriesId'/],
      [{ seriesId: "A", values: 1 }, /Variadic parameter 'values'.*array/],
    ] as const) {
      await expect(tool.invoke(testRun(), callFromOutside(args))).rejects.toThrow(message);
    }
  });

  it("keeps aliases on one repeat key and different names on different keys", () => {
    const tool = createTool(definition(), executor());
    const renamed = tool.rename("otherLookup");
    const key = (fn: AgencyFunction, args: Record<string, unknown>) =>
      repeatKey(fn.name, toolArgumentsFor(fn, { arguments: args }).namedArgs);
    expect(key(tool, { series: "A" })).toBe(key(tool, { seriesId: "A" }));
    expect(key(tool, { seriesId: "A" })).not.toBe(key(renamed, { seriesId: "A" }));
  });

  it("uses normal partial application and keeps the executor's full argument record", async () => {
    const tool = createTool(definition(), executor())
      .partial({ seriesId: "UNRATE", values: [7] })
      .rename("unemployment")
      .describe("Unemployment data.");
    expect(Object.keys((jsonSchema(tool) as { properties: object }).properties)).toEqual(["limit"]);
    expect(await tool.invoke(testRun(), callFromOutside({ limit: 3 }))).toEqual({
      seriesId: "UNRATE",
      limit: 3,
      values: [7],
    });
    expect(tool.created?.definition.name).toBe("lookup");
    expect(tool.description).toBe("Unemployment data.");
  });

  it("propagates failure-valued arguments according to original parameter flags", async () => {
    const rejected = failure("do not execute", { reason: "fixture" });
    let calls = 0;
    const target = executor((args) => {
      calls++;
      return args;
    });
    const source = {
      ...definition(),
      inputSchema: z.object({ value: z.any() }).toJSONSchema(),
      params: [param("value", { acceptsResult: false })],
    };
    const tool = createTool(source, target);
    expect(await tool.invoke(testRun(), callFromOutside({ value: rejected }))).toMatchObject({
      error: rejected.error,
      data: rejected.data,
      skippedFunctions: [{ name: "lookup", param: "value" }],
    });
    expect(calls).toBe(0);
    const accepting = createTool(
      { ...source, params: [param("value", { acceptsResult: true })] },
      target,
    );
    expect(await accepting.invoke(testRun(), callFromOutside({ value: rejected }))).toEqual({
      value: rejected,
    });
  });

  it("returns failures unchanged and does not validate unchecked values against the schema", async () => {
    const rejected = failure("refused", { reason: "fixture" }, { destructiveRan: true });
    const tool = createTool(
      definition(),
      executor(() => rejected),
    );
    expect(await tool.invoke(testRun(), callFromOutside({ seriesId: 42 }))).toBe(rejected);
  });

  it("rejects unsupported executor shapes and required function parameters", () => {
    const noArgs = new AgencyFunction({
      name: "noArgs",
      module: "test",
      fn: () => null,
      params: [],
      toolDefinition: null,
    });
    expect(() => createTool(definition(), noArgs)).toThrow(/one argument record/);
    expect(() =>
      createTool({ ...definition(), inputSchema: { type: "string" } }, executor()),
    ).toThrow(/object parameter schema/);
    expect(() =>
      createTool(
        {
          ...definition(),
          params: [param("block", { isFunctionTyped: true })],
        },
        executor(),
      ),
    ).toThrow(/required.*block|block.*required/);
  });
});
