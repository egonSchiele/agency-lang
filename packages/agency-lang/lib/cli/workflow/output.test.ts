import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../../stdlib/workflow/catalog.js";
import {
  formatCatalog,
  formatChecked,
  formatList,
  formatProblems,
  formatRunValue,
  formatUncovered,
} from "./output.js";

const param = (name: string, type: string | null, def: string | null = null) => ({
  name,
  type,
  default: def,
  description: null,
  schema: {},
});

const entries: CatalogEntry[] = [
  {
    module: "./src/agent/lists.agency",
    name: "findLists",
    description: "Find lists whose title matches the query.",
    params: [param("query", "string")],
    returns: "Result<ListSummary[]>",
    effects: [],
  },
  {
    module: "./src/agent/lists.agency",
    name: "addListItems",
    description: "Add items to a section of a list.\n\nMore detail that is not printed.",
    params: [param("listId", "string"), param("items", "string[]"), param("section", "string")],
    returns: "Result<string>",
    effects: ["test::lists::add"],
  },
];

describe("formatCatalog", () => {
  it("prints the spec's example", () => {
    expect(formatCatalog(entries)).toBe(
      [
        "./src/agent/lists.agency",
        "  findLists(query: string): Result<ListSummary[]>",
        "    Find lists whose title matches the query.",
        "  addListItems(listId: string, items: string[], section: string): Result<string>",
        "    Add items to a section of a list.",
        "    raises test::lists::add",
      ].join("\n"),
    );
  });

  it("writes defaults, untyped parameters, a missing return type, and joins a wrapped line", () => {
    const entry: CatalogEntry = {
      module: "std::math",
      name: "round",
      description:
        "Round a number to a given number of decimal places. With no precision it\n  rounds to a whole number.",
      params: [param("num", "number"), param("precision", null, "0")],
      returns: null,
      effects: [],
    };
    expect(formatCatalog([entry])).toBe(
      [
        "std::math",
        "  round(num: number, precision = 0)",
        "    Round a number to a given number of decimal places. With no precision it rounds to a whole number.",
      ].join("\n"),
    );
  });

  it("strips control characters from a description", () => {
    const entry = { ...entries[0], description: "red \u001b[31mtext" };
    expect(formatCatalog([entry])).not.toContain("\u001b");
  });
});

describe("formatProblems", () => {
  it("prints the spec's example", () => {
    const problems = [
      { step: "text", field: "args.id", message: 'reference "steps.notes[0].id" names no step' },
    ];
    expect(formatProblems("workflows/broken.json", problems)).toBe(
      [
        "workflows/broken.json has 1 problem:",
        '  step text, args.id: reference "steps.notes[0].id" names no step',
      ].join("\n"),
    );
  });

  it("counts several problems", () => {
    const problem = { step: null, field: null, message: "x" };
    expect(formatProblems("w", [problem, problem]).split("\n")[0]).toBe("w has 2 problems:");
  });
});

describe("formatChecked", () => {
  it("prints the spec's example, one line per effect in the order it is first raised", () => {
    const steps = [
      { step: "note", tool: "searchNotes", effects: [] },
      { step: "text", tool: "readNote", effects: ["std::read"] },
      { step: "add", tool: "addListItems", effects: ["test::lists::add"] },
    ];
    expect(formatChecked("workflows/updateMealPlanFromNote.json", [], steps)).toBe(
      [
        "workflows/updateMealPlanFromNote.json: no problems",
        "can raise:",
        "  std::read          step text (readNote)",
        "  test::lists::add   step add (addListItems)",
      ].join("\n"),
    );
  });

  it("names every step that raises an effect, and prints warnings", () => {
    const steps = [
      { step: "a", tool: "readNote", effects: ["std::read"] },
      { step: "b", tool: "readNote", effects: ["std::read"] },
    ];
    const warning = { step: "a", field: "tool", message: "untyped" };
    expect(formatChecked("w", [warning], steps)).toBe(
      [
        "w: no problems",
        "warning: step a, tool: untyped",
        "can raise:",
        "  std::read   step a (readNote), step b (readNote)",
      ].join("\n"),
    );
  });

  it("says when a workflow raises nothing", () => {
    expect(formatChecked("w", [], [])).toBe("w: no problems\ncan raise: nothing");
  });
});

describe("formatList", () => {
  it("prints each workflow's name and inputs, then its description", () => {
    const listed = [
      { name: "addOne", workflow: { inputs: "{ noteTitle: string }", description: "Add soup." } },
    ];
    expect(formatList("/p", listed)).toBe("addOne { noteTitle: string }\n  Add soup.");
  });

  it("says when there are none", () => {
    expect(formatList("/p", [])).toBe("no saved workflows in /p/workflows");
  });
});

describe("formatRunValue", () => {
  it("prints a string as itself and anything else as indented JSON", () => {
    expect(formatRunValue("added 1 items")).toBe("added 1 items");
    expect(formatRunValue({ added: 1 })).toBe('{\n  "added": 1\n}');
  });

  it("strips control characters", () => {
    expect(formatRunValue("a\u001b[31mb")).not.toContain("\u001b");
  });
});

describe("formatUncovered", () => {
  it("prints the spec's table", () => {
    expect(
      formatUncovered([
        { effect: "test::lists::add", steps: ["add (addListItems)"] },
        { effect: "std::read", steps: ["text (readNote)"] },
      ]),
    ).toBe(
      [
        "Your policy does not cover these interrupts:",
        "  test::lists::add   step add (addListItems)",
        "  std::read          step text (readNote)",
      ].join("\n"),
    );
  });
});
