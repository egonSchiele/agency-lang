import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { INTERRUPT_KEYWORD_AS_NAME_MESSAGE } from "./messages.js";

const MAIN = ["node main() {", "  print(1)", "}", ""];

function parse(lines: string[]) {
  return parseAgency([...lines, ...MAIN].join("\n"), {}, false);
}

/** The parse error for a program that starts with `lines`. */
function messageFor(lines: string[]): string {
  const parsed = parse(lines);
  if (parsed.success) {
    throw new Error("expected a parse error");
  }
  return parsed.message ?? "";
}

// `raise(...)` and `interrupt(...)` always raise an interrupt, so a function
// with either name could be declared and never called.
describe("a callable cannot be named raise or interrupt", () => {
  it.each([
    {
      name: "a def named raise",
      keyword: "raise",
      lines: ["def raise(): number {", "  return 1", "}"],
    },
    {
      name: "a def named interrupt",
      keyword: "interrupt",
      lines: ["def interrupt(): number {", "  return 1", "}"],
    },
    { name: "a node named raise", keyword: "raise", lines: ["node raise() {", "  print(1)", "}"] },
    {
      name: "an import named raise",
      keyword: "raise",
      lines: ['import { raise } from "./helper.js"'],
    },
    {
      name: "an import named interrupt, after another name",
      keyword: "interrupt",
      lines: ['import { helper, interrupt } from "./helper.js"'],
    },
    {
      name: "an import renamed to interrupt",
      keyword: "interrupt",
      lines: ['import { helper as interrupt } from "./helper.js"'],
    },
    {
      name: "a default import named raise",
      keyword: "raise",
      lines: ['import raise from "./helper.js"'],
    },
    {
      name: "a re-export named raise",
      keyword: "raise",
      lines: ['export { raise } from "./helper.js"'],
    },
    {
      name: "a re-export renamed to interrupt",
      keyword: "interrupt",
      lines: ['export { helper as interrupt } from "./helper.agency"'],
    },
    {
      name: "a namespace import named raise",
      keyword: "raise",
      lines: ['import * as raise from "./helper.js"'],
    },
  ])("refuses $name", ({ keyword, lines }) => {
    expect(messageFor(lines)).toContain(INTERRUPT_KEYWORD_AS_NAME_MESSAGE(keyword));
  });

  it.each([
    {
      name: "an import of raise under another name",
      lines: ['import { raise as raiseFromJs } from "./helper.js"'],
    },
    {
      name: "a def whose name starts with raise",
      lines: ["def raiseHand(): number {", "  return 1", "}"],
    },
    {
      name: "a handler parameter named interrupt",
      lines: [
        "def guarded() {",
        "  handle {",
        "    print(1)",
        "  } with (interrupt) {",
        "    return approve()",
        "  }",
        "}",
      ],
    },
    {
      name: "a variable named raise",
      lines: ["def holder(): number {", "  const raise = 2", "  return 1", "}"],
    },
  ])("still accepts $name", ({ lines }) => {
    expect(parse(lines).success).toBe(true);
  });
});
