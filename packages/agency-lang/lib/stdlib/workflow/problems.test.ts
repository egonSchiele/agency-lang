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
    expect(problemsFromDiagnostics([{ message: "bad path", loc: { line: 5 } }], ranges)).toEqual([
      { step: "text", field: "args.id", message: "bad path" },
    ]);
  });

  it("takes the argument name from the payload, not the message", () => {
    const diagnostic = {
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
      problemsFromDiagnostics([{ message: "m", loc: { line: 4 }, params: { fn: "f" } }], ranges),
    ).toEqual([{ step: "note", field: "args", message: "m" }]);
  });

  it("keeps a diagnostic with no owner", () => {
    expect(
      problemsFromDiagnostics([{ message: "m", loc: { line: 40 } }, { message: "n" }], ranges),
    ).toEqual([
      { step: null, field: null, message: "m" },
      { step: null, field: null, message: "n" },
    ]);
  });
});
