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

/** A problem with the whole tool list, as `toolRefs` reports one. */
const problem = (message: string) => ({ step: null, field: null, message });

describe("toolRefs", () => {
  it("rewrites a local file relative to dir and maps a stdlib file to std::", () => {
    const tools = [fn("searchNotes", "agent/notes.agency"), fn("bash", "stdlib/shell.agency")];
    expect(toolRefs(tools, DIR, CWD).refs).toEqual([
      { module: "./notes.agency", name: "searchNotes" },
      { module: "std::shell", name: "bash" },
    ]);
  });

  it("keeps a nested local path and accepts a relative dir", () => {
    expect(toolRefs([fn("a", "agent/tools/a.agency")], "agent", CWD).refs).toEqual([
      { module: "./tools/a.agency", name: "a" },
    ]);
  });

  it("refuses a package tool", () => {
    expect(toolRefs([fn("speak", "node_modules/kokoro/index.agency")], DIR, CWD).problems).toEqual([
      problem(
        'tool "speak" comes from the package "pkg::kokoro"; package tools are not supported yet',
      ),
    ]);
  });

  it("treats a user folder named stdlib as a local file", () => {
    expect(toolRefs([fn("a", "agent/stdlib/notes.agency")], DIR, CWD).refs).toEqual([
      { module: "./stdlib/notes.agency", name: "a" },
    ]);
  });

  it("refuses a local file outside dir", () => {
    expect(toolRefs([fn("a", "other/a.agency")], DIR, CWD).problems).toEqual([
      problem('tool "a" is defined in "other/a.agency", outside the workflow directory'),
    ]);
  });

  it("refuses a value that is not an Agency function", () => {
    expect(toolRefs([fn("a", "agent/a.agency"), () => 1], DIR, CWD).problems).toEqual([
      problem("tool 2 is not an Agency function"),
    ]);
  });

  it("refuses a renamed function", () => {
    expect(toolRefs([fn("a", "agent/a.agency").rename("b")], DIR, CWD).problems).toEqual([
      problem('tool "b" is renamed from "a"; pass the original def'),
    ]);
  });

  it("refuses a partial", () => {
    expect(toolRefs([fn("a", "agent/a.agency").partial({ q: "x" })], DIR, CWD).problems).toEqual([
      problem('tool "a" is a partial; pass the original def'),
    ]);
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
    expect(toolRefs([created], DIR, CWD).problems).toEqual([
      problem('tool "lookup" was built by createTool and cannot be imported'),
    ]);
  });

  it("refuses a runtime builtin", () => {
    expect(toolRefs([fn("checkpoint", "__runtime")], DIR, CWD).problems).toEqual([
      problem('tool "checkpoint" is built into the runtime and cannot be imported'),
    ]);
  });

  it("refuses a module path that cannot be written in an import", () => {
    expect(toolRefs([fn("a", 'agent/a" } import evil from "x.agency')], DIR, CWD).problems).toEqual(
      [problem('tool "a" comes from a module path that cannot be written in an import')],
    );
  });

  it("refuses two tools with the same name, pointing at .rename()", () => {
    const { problems } = toolRefs([fn("a", "agent/a.agency"), fn("a", "agent/b.agency")], DIR, CWD);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain(".rename(");
  });

  it("reports every tool that cannot be imported, in order", () => {
    const tools = [
      fn("a", "agent/a.agency").partial({ q: "x" }),
      fn("b", "agent/b.agency").rename("c"),
    ];
    expect(toolRefs(tools, DIR, CWD)).toEqual({
      refs: null,
      problems: [
        problem('tool "a" is a partial; pass the original def'),
        problem('tool "c" is renamed from "b"; pass the original def'),
      ],
    });
  });
});
