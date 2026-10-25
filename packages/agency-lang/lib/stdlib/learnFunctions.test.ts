import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgencyFunction } from "../runtime/agencyFunction.js";
import { _createLearnedTools, _describeLearnedFunctions } from "./learnFunctions.js";
import type { PreparedFunctions } from "./agencyFunctions.js";

function original() {
  return new AgencyFunction({
    name: "lookup",
    module: "fixture",
    fn: () => {
      throw new Error("Metadata must not execute the function");
    },
    params: [
      {
        name: "id",
        aliases: ["series"],
        hasDefault: true,
        defaultValue: "default",
        variadic: false,
        acceptsResult: false,
      },
    ],
    toolDefinition: {
      name: "lookup",
      description: "Look up a series.",
      schema: z.object({ id: z.string().nullable() }),
    },
    markers: { idempotent: true },
  });
}

const prepared: PreparedFunctions = {
  compiled: { moduleId: "fixture", code: "fixture" },
  sourceModule: "<source>",
  exportNames: ["lookup"],
  invokeNode: "invokeLearned",
};

function executor() {
  return AgencyFunction.create(
    {
      name: "executePrepared",
      module: "fixture",
      fn: () => null,
      toolDefinition: null,
      params: ["prepared", "exportName", "args", "options"].map((name) => ({
        name,
        hasDefault: false,
        defaultValue: undefined,
        variadic: false,
      })),
    },
    {},
  );
}

describe("learned definitions", () => {
  it("keeps original schema and aliases while stripping defaults and honoring re-export markers", () => {
    const target = original();
    const called = new AgencyFunction({
      name: "renamedExport",
      module: "reexport",
      params: target.params,
      fn: () => null,
      toolDefinition: target.toolDefinition,
      markers: { destructive: true },
    });
    const [definition] = _describeLearnedFunctions([target], ["renamedExport"], [called]);
    expect(definition.name).toBe("renamedExport");
    expect(definition.description).toBe(target.description);
    expect(definition.params[0]).toEqual({
      name: "id",
      aliases: ["series"],
      hasDefault: true,
      variadic: false,
      acceptsResult: false,
    });
    expect(definition.markers).toEqual({ destructive: true });
    expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
  });

  it("advertises namespaced names but binds the original export and run options", () => {
    const definitions = _describeLearnedFunctions([original()], ["lookup"]);
    const [tool] = _createLearnedTools(
      definitions,
      prepared,
      "session",
      { maxDepth: 2 },
      executor(),
      64,
    );
    expect(tool.name).toBe("session_lookup");
    expect(
      tool.created?.executor.params.find((param) => param.name === "exportName")?.boundValue,
    ).toBe("lookup");
    expect(
      tool.created?.executor.params.find((param) => param.name === "options")?.boundValue,
    ).toEqual({ maxDepth: 2 });
  });

  it("refuses unusable names and duplicate names before returning a batch", () => {
    const definitions = _describeLearnedFunctions([original()], ["lookup"]);
    expect(() =>
      _createLearnedTools(definitions, prepared, "x".repeat(64), {}, executor(), 64),
    ).toThrow(/provider limit/);
    expect(() =>
      _createLearnedTools(definitions, prepared, "bad namespace", {}, executor(), 64),
    ).toThrow(/letters/);
    expect(() =>
      _createLearnedTools([...definitions, ...definitions], prepared, "", {}, executor(), 64),
    ).toThrow(/Duplicate tool name/);
  });
});
