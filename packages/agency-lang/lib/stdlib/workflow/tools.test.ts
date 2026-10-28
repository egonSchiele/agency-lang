import { describe, expect, it } from "vitest";
import { AgencyFunction, type FuncParam } from "../../runtime/agencyFunction.js";
import { createTool } from "../../runtime/createdTool.js";
import { toolRefs } from "./tools.js";

const CWD = "/work";
const DIR = "/work/agent";

const param = (name: string): FuncParam => ({
  name,
  hasDefault: false,
  defaultValue: undefined,
  variadic: false,
});

function fn(name: string, module: string): AgencyFunction {
  return AgencyFunction.create(
    { name, module, params: [param("q")], toolDefinition: null, fn: (_run, q: string) => q },
    {},
  );
}

describe("toolRefs", () => {
  it("rewrites a local file relative to dir and maps a stdlib file to std::", () => {
    const tools = [fn("searchNotes", "agent/notes.agency"), fn("bash", "stdlib/shell.agency")];
    expect(toolRefs(tools, DIR, CWD)).toEqual([
      { module: "./notes.agency", name: "searchNotes" },
      { module: "std::shell", name: "bash" },
    ]);
  });

  it("keeps a nested local path and accepts a relative dir", () => {
    expect(toolRefs([fn("a", "agent/tools/a.agency")], "agent", CWD)).toEqual([
      { module: "./tools/a.agency", name: "a" },
    ]);
  });

  it("refuses a package tool", () => {
    expect(() => toolRefs([fn("speak", "node_modules/kokoro/index.agency")], DIR, CWD)).toThrow(
      'tool "speak" comes from the package "pkg::kokoro"; package tools are not supported yet',
    );
  });

  it("treats a user folder named stdlib as a local file", () => {
    expect(toolRefs([fn("a", "agent/stdlib/notes.agency")], DIR, CWD)).toEqual([
      { module: "./stdlib/notes.agency", name: "a" },
    ]);
  });

  it("refuses a local file outside dir", () => {
    expect(() => toolRefs([fn("a", "other/a.agency")], DIR, CWD)).toThrow(
      'tool "a" is defined in "other/a.agency", outside the workflow directory',
    );
  });

  it("refuses a value that is not an Agency function", () => {
    expect(() => toolRefs([fn("a", "agent/a.agency"), () => 1], DIR, CWD)).toThrow(
      "tool 2 is not an Agency function",
    );
  });

  it("refuses a renamed function", () => {
    expect(() => toolRefs([fn("a", "agent/a.agency").rename("b")], DIR, CWD)).toThrow(
      'tool "b" is renamed from "a"; pass the original def',
    );
  });

  it("refuses a partial", () => {
    expect(() => toolRefs([fn("a", "agent/a.agency").partial({ q: "x" })], DIR, CWD)).toThrow(
      'tool "a" is a partial; pass the original def',
    );
  });

  it("refuses a created tool", () => {
    const created = createTool(
      {
        name: "lookup",
        description: "d",
        inputSchema: { type: "object" },
        params: [param("q")],
        markers: {},
      },
      fn("execute", "agent/a.agency"),
    );
    expect(() => toolRefs([created], DIR, CWD)).toThrow(
      'tool "lookup" was built by createTool and cannot be imported',
    );
  });

  it("refuses a runtime builtin", () => {
    expect(() => toolRefs([fn("checkpoint", "__runtime")], DIR, CWD)).toThrow(
      'tool "checkpoint" is built into the runtime and cannot be imported',
    );
  });

  it("refuses a module path that cannot be written in an import", () => {
    expect(() => toolRefs([fn("a", 'agent/a" } import evil from "x.agency')], DIR, CWD)).toThrow(
      'tool "a" comes from a module path that cannot be written in an import',
    );
  });

  it("refuses two tools with the same name, pointing at .rename()", () => {
    expect(() =>
      toolRefs([fn("a", "agent/a.agency"), fn("a", "agent/b.agency")], DIR, CWD),
    ).toThrow(".rename(");
  });
});
