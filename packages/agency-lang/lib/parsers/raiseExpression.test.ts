import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { INTERRUPT_KEYWORD_ALONE_MESSAGE } from "./messages.js";

/** The lines every test program starts with. */
const PROGRAM_HEAD = [
  "effect feel { }",
  "def raiseHand(count: number): number {",
  "  return count",
  "}",
];

/** A program whose `node main` has the body `bodyLines`. */
function programWith(bodyLines: string[]): string {
  return [...PROGRAM_HEAD, "node main() {", ...bodyLines, "}", ""].join("\n");
}

/** The parse error for a program whose body is `bodyLines`. */
function messageFor(bodyLines: string[]): string {
  const parsed = parseAgency(programWith(bodyLines), {}, false, false);
  if (parsed.success) {
    throw new Error("expected a parse error");
  }
  return parsed.message ?? "";
}

/** The statements of `node main` in a program whose body is `bodyLines`. */
function statementsOf(bodyLines: string[]): any[] {
  // Not lowered, so a match is still a matchBlock.
  const parsed = parseAgency(programWith(bodyLines), {}, false, false);
  if (!parsed.success) {
    throw new Error(parsed.message ?? "parse failed");
  }
  const main = parsed.result.nodes.find((node: any) => node.type === "graphNode") as any;
  return main.body.filter((statement: any) => statement.type !== "newLine");
}

/** The fields that differ between the two spellings for reasons other than
 *  meaning: source positions and the formatter's keyword marker. */
const SPELLING_ONLY_FIELDS = ["loc", "viaRaise"];

function dropSpellingOnlyFields(key: string, value: unknown): unknown {
  if (SPELLING_ONLY_FIELDS.includes(key)) {
    return undefined;
  }
  return value;
}

/** A copy of `tree` with the spelling-only fields removed. */
function meaningOf(tree: unknown): unknown {
  return JSON.parse(JSON.stringify(tree, dropSpellingOnlyFields));
}

/** Each raise form, with the interrupt form that means the same thing. */
const FORMS = [
  { raise: 'raise interrupt("q")', interrupt: 'interrupt("q")' },
  { raise: 'raise interrupt feel("q")', interrupt: 'interrupt feel("q")' },
  { raise: 'raise feel("q")', interrupt: 'interrupt feel("q")' },
  { raise: 'raise std::write("q", {})', interrupt: 'interrupt std::write("q", {})' },
  { raise: 'raise("q")', interrupt: 'interrupt("q")' },
];

/** Each position where the interrupt spelling already parses as a value.
 *  `VALUE` is replaced by the form under test. */
const POSITIONS = [
  { name: "an assignment", lines: ["  const answer = VALUE"] },
  { name: "a return", lines: ["  return VALUE"] },
  { name: "a call argument", lines: ["  print(VALUE)"] },
  {
    name: "a match arm",
    lines: ["  const answer = match (1) {", "    1 => VALUE", "    _ => 0", "  }"],
  },
  { name: "before with approve", lines: ["  const answer = VALUE with approve"] },
];

const ROWS = POSITIONS.flatMap((position) =>
  FORMS.map((form) => ({ ...form, position: position.name, lines: position.lines })),
);

/** `lines` with the placeholder replaced by `form`. */
function withValue(lines: string[], form: string): string[] {
  return lines.map((line) => line.replace("VALUE", form));
}

/** The shape the guide's example has: a raise assigned to a variable, then
 *  a string that uses the variable. Copied here; the test does not read the
 *  guide. */
const RAISE_THEN_TEMPLATE_STRING = [
  '  const msg = raise interrupt("How do you feel?")',
  '  const prompt = "Please categorize the following message: ${msg}"',
  "  return prompt",
];

describe("raise as a value", () => {
  it.each(ROWS)("$raise reads like $interrupt in $position", ({ raise, interrupt, lines }) => {
    const raised = statementsOf(withValue(lines, raise));
    const interrupted = statementsOf(withValue(lines, interrupt));
    expect(raised).toHaveLength(1);
    expect(meaningOf(raised)).toEqual(meaningOf(interrupted));
  });

  it("marks the node so the formatter prints raise", () => {
    const [assignment] = statementsOf(['  const answer = raise feel("q")']);
    expect(assignment.value).toMatchObject({ type: "interruptStatement", viaRaise: true });
  });

  it("reads a raise assignment followed by a template string as separate statements", () => {
    const types = statementsOf(RAISE_THEN_TEMPLATE_STRING).map((statement) => statement.type);
    expect(types).toEqual(["assignment", "assignment", "returnStatement"]);
  });

  it.each([
    {
      name: "a call to a function whose name starts with raise",
      lines: ["  const answer = raiseHand(1)"],
      valueType: "functionCall",
    },
    {
      name: "a variable whose name starts with raise",
      lines: ["  const raised = 1", "  const answer = raised"],
      valueType: "variableName",
    },
  ])("leaves $name alone", ({ lines, valueType }) => {
    const statements = statementsOf(lines);
    expect(statements[statements.length - 1].value.type).toBe(valueType);
  });

  // An interrupt cannot be split across two lines. Read as two statements,
  // the second line would run with no interrupt in front of it.
  it.each([
    {
      name: "interrupt, then its effect on the next line",
      keyword: "interrupt",
      lines: ["  interrupt", '    feel("Ship it?")'],
    },
    {
      name: "raise, then its effect on the next line",
      keyword: "raise",
      lines: ["  raise", '    feel("Ship it?")'],
    },
    {
      name: "raise interrupt, then its effect on the next line",
      keyword: "interrupt",
      lines: ["  raise interrupt", '    feel("Ship it?")'],
    },
    {
      name: "interrupt as a value, then a call on the next line",
      keyword: "interrupt",
      lines: ["  const answer = interrupt", "  print(answer)"],
    },
    {
      name: "raise as a value, then a call on the next line",
      keyword: "raise",
      lines: ["  const answer = raise", "  print(answer)"],
    },
    {
      name: "interrupt, then a comment",
      keyword: "interrupt",
      lines: ["  interrupt // ask first", '  feel("Ship it?")'],
    },
    {
      name: "interrupt, then a block comment on the same line",
      keyword: "interrupt",
      lines: ['  const answer = interrupt /* why */ feel("Ship it?")'],
    },
    {
      name: "raise as the last thing in the body",
      keyword: "raise",
      lines: ["  raise"],
    },
  ])("refuses $name", ({ keyword, lines }) => {
    expect(messageFor(lines)).toContain(INTERRUPT_KEYWORD_ALONE_MESSAGE(keyword));
  });
});
