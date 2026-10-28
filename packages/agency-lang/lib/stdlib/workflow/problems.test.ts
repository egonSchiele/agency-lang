import { describe, expect, it } from "vitest";
import { problemsFromDiagnostics } from "./problems.js";
import type { Range } from "./types.js";

const ranges: Range[] = [
  { from: 5, to: 5, owner: { step: "note", field: "args" } },
  { from: 6, to: 8, owner: { step: "text", field: "args.id" } },
];

// A diagnostic's line is 0-based, as the typechecker reports it; ranges are 1-based.
describe("problemsFromDiagnostics", () => {
  it("maps a diagnostic to the owner of its line", () => {
    expect(
      problemsFromDiagnostics([{ code: "AG2001", message: "bad path", loc: { line: 5 } }], ranges),
    ).toEqual([{ step: "text", field: "args.id", message: "bad path" }]);
  });

  it("takes the argument name from the payload, not the message", () => {
    const diagnostic = {
      code: "AG6012",
      message: "'searchNotes' does not accept the named argument 'querry'.",
      loc: { line: 4 },
      params: { fn: "searchNotes", name: "querry", allowed: "query" },
    };
    expect(problemsFromDiagnostics([diagnostic], ranges)).toEqual([
      {
        step: "note",
        field: "args.querry",
        message: "'searchNotes' does not accept the named argument 'querry'.",
      },
    ]);
  });

  it("keeps the field when the payload has no name", () => {
    expect(
      problemsFromDiagnostics(
        [{ code: "AG6012", message: "m", loc: { line: 4 }, params: { fn: "f" } }],
        ranges,
      ),
    ).toEqual([{ step: "note", field: "args", message: "m" }]);
  });

  it("reads a name only from a diagnostic about an argument", () => {
    const diagnostic = {
      code: "AG6030",
      message: "Function 'searchNotes' is not defined.",
      loc: { line: 4 },
      params: { name: "searchNotes" },
    };
    expect(problemsFromDiagnostics([diagnostic], ranges)).toEqual([
      { step: "note", field: "args", message: diagnostic.message },
    ]);
  });

  it("takes a mistyped argument's name from the payload's param", () => {
    const diagnostic = {
      code: "AG6019",
      message: "Type 'string[]' is not assignable to parameter 'section'.",
      loc: { line: 4 },
      params: { actual: "string[]", expected: "string", fn: "addListItems", param: "section" },
    };
    expect(problemsFromDiagnostics([diagnostic], ranges)).toEqual([
      { step: "note", field: "args.section", message: diagnostic.message },
    ]);
  });

  it("maps a result line to the result field", () => {
    const withResult: Range[] = [
      ...ranges,
      { from: 9, to: 9, owner: { step: null, field: "result" } },
    ];
    expect(
      problemsFromDiagnostics([{ code: "AG2001", message: "m", loc: { line: 8 } }], withResult),
    ).toEqual([{ step: null, field: "result", message: "m" }]);
  });

  it("maps a diagnostic with no line to the type its context names", () => {
    const owners = { Step_m_output: { step: "m", field: "output" } };
    const diagnostic = {
      code: "AG1002",
      message: "Type alias 'Nope' is not defined",
      params: { alias: "Nope", context: "Step_m_output" },
    };
    expect(problemsFromDiagnostics([diagnostic], ranges, owners)).toEqual([
      { step: "m", field: "output", message: diagnostic.message },
    ]);
  });

  it("keeps a diagnostic with no owner", () => {
    expect(
      problemsFromDiagnostics(
        [
          { code: "AG2001", message: "m", loc: { line: 40 } },
          { code: "AG2001", message: "n" },
        ],
        ranges,
      ),
    ).toEqual([
      { step: null, field: null, message: "m" },
      { step: null, field: null, message: "n" },
    ]);
  });
});
