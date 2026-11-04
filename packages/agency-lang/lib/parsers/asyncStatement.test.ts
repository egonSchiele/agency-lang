import { describe, it, expect } from "vitest";
import { parseAgency } from "@/parser.js";
import { formatSource } from "@/formatter.js";
import type { AgencyNode } from "@/types.js";
import { asyncRefusals } from "@/typeChecker/asyncChecks.js";

/** The statements of `def g()` in `src`, with comments and blank lines
 *  dropped. */
function bodyOf(src: string): AgencyNode[] {
  const parsed = parseAgency(`def g() {\n${src}\n}`, {}, false);
  if (!parsed.success) throw new Error(`expected a successful parse, got: ${parsed.message}`);
  const def = parsed.result.nodes.find((node) => node.type === "function");
  if (!def || def.type !== "function") throw new Error("no def g");
  return def.body.filter((node) => node.type !== "newLine" && node.type !== "comment");
}

describe("the two async forms", () => {
  it("parses the statement form as a flagged call", () => {
    const [stmt] = bodyOf("async extractMemories(msg)");
    expect(stmt.type).toBe("functionCall");
    expect(stmt).toMatchObject({ functionName: "extractMemories", async: true });
  });

  it("parses the binding form as an assignment whose value is flagged", () => {
    const [stmt] = bodyOf("let name = async nameConversation(msg)");
    expect(stmt).toMatchObject({
      type: "assignment",
      declKind: "let",
      variableName: "name",
      value: { type: "functionCall", functionName: "nameConversation", async: true },
    });
  });

  it("parses a method call", () => {
    const [stmt] = bodyOf("let summary = async notes.summarize(text)");
    expect(stmt).toMatchObject({
      type: "assignment",
      value: { type: "valueAccess", async: true },
    });
  });
});

describe("a with suffix on an async call", () => {
  it("wraps the binding form", () => {
    const [stmt] = bodyOf("const title = async nameConversation(msg) with approve");
    expect(stmt).toMatchObject({
      type: "withModifier",
      handlerName: "approve",
      statement: { type: "assignment", value: { functionName: "nameConversation", async: true } },
    });
  });

  it("wraps the statement form as one statement", () => {
    // This used to parse as three statements: the call, then the names
    // `with` and `approve`.
    const body = bodyOf("async extractMemories(msg) with approve");
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      type: "withModifier",
      handlerName: "approve",
      statement: { type: "functionCall", functionName: "extractMemories", async: true },
    });
  });
});

describe("async inside a string concatenation", () => {
  it("is read as a flagged call, so the expression-position check refuses it", () => {
    const parsed = parseAgency(
      `def slowSide(): string {\n  return "x"\n}\n\nnode main() {\n  const text = "got " + async slowSide()\n  print(text)\n}\n`,
      {},
      false,
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const codes = asyncRefusals(parsed.result.nodes).map((error) => error.code);
    expect(codes).toEqual(["AG1026"]);
  });
});

describe("agency fmt keeps async", () => {
  it("round-trips both forms and the with suffix", () => {
    const source = [
      "def g() {",
      "  async extractMemories(msg)",
      "  let name = async nameConversation(msg)",
      "  const title = async nameConversation(msg) with approve",
      "  async extractMemories(msg) with approve",
      "  print(name)",
      "}",
      "",
    ].join("\n");
    expect(formatSource(source)).toBe(source);
  });
});
