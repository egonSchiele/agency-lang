import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TEXT_AFTER_STATEMENT_MESSAGE } from "./messages.js";

function parseBody(body: string) {
  return parseAgency(`node main() {\n${body}\n}\n`, {}, false);
}

function messageFor(body: string): string {
  const parsed = parseBody(body);
  return parsed.success ? "" : (parsed.message ?? "");
}

describe("a statement is the last thing on its line", () => {
  it.each([
    ["two declarations", "const x = 1 const y = 2\n"],
    ["a word that is not a keyword before a declaration", "global let threshold = 10\n"],
  ])("refuses %s at the top level", (_name, source) => {
    const parsed = parseAgency(source, {}, false);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.message).toContain(TEXT_AFTER_STATEMENT_MESSAGE);
  });

  it("accepts a tag on the line of its declaration", () => {
    expect(parseAgency(`@jsonSchema({ a: 1 }) type P = { n: number }\n`, {}, false).success).toBe(
      true,
    );
  });

  it.each([
    ["the rest of a number with two dots", "  const x = 1.2.3"],
    ["a second call", "  print(1) print(2)"],
    ["a second string", `  const s = "a" "b"`],
    ["a statement after a block", "  if (true) { print(1) } print(2)"],
    ["two statements in a one-line block", "  if (true) { const x = 41  return x }"],
  ])("refuses %s", (_name, body) => {
    expect(messageFor(body)).toContain(TEXT_AFTER_STATEMENT_MESSAGE);
  });

  it("points at the text that is left over", () => {
    expect(messageFor("  const x = 1.2.3")).toContain("Line 2, col 16");
  });

  it.each([
    ["statements separated by a semicolon", "  print(1); print(2)"],
    ["a line comment after a statement", "  print(1) // why"],
    ["a block comment after a statement", "  print(1) /* why */"],
    ["a one-line block", "  if (true) { print(1) }"],
    ["a one-line block with semicolons", "  if (true) { print(1); print(2) } else { print(3) }"],
    ["Windows line endings", "  print(1)\r\n  print(2)\r"],
    ["a blank line between statements", "  print(1)\n\n  print(2)"],
  ])("accepts %s", (_name, body) => {
    expect(parseBody(body).success).toBe(true);
  });

  it.each([
    ["an assignment with no value", "  const broken ="],
    ["an operator with nothing after it", "  return 1 +"],
    ["a string that never closes", `  return "open`],
  ])("leaves %s to the unreadable-statement error", (_name, body) => {
    const message = messageFor(body);
    expect(message).not.toBe("");
    expect(message).not.toContain(TEXT_AFTER_STATEMENT_MESSAGE);
  });
});
