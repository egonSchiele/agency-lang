import { describe, it, expect } from "vitest";
import { staticStatementParser } from "./parsers.js";
import { parseAgency } from "../parser.js";

describe("staticStatementParser", () => {
  it("parses `static <functionCall>` as a staticStatement", () => {
    const result = staticStatementParser("static foo()");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.type).toBe("staticStatement");
    expect(result.result.statement.type).toBe("functionCall");
  });

  it("parses `static <method-call>` (valueAccess) as a staticStatement", () => {
    const result = staticStatementParser("static logger.flush()");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.type).toBe("staticStatement");
    expect(result.result.statement.type).toBe("valueAccess");
  });

  it("declines `static const` so modifiedAssignmentParser handles it", () => {
    const result = staticStatementParser("static const x = 1");
    expect(result.success).toBe(false);
  });

  it("rejects `static let` with the canonical message", () => {
    // Reach the fatal-error path via the full pipeline — `parseAgency`
    // surfaces parseError's message via `errorData.prettyMessage`,
    // mirroring how the CLI / LSP show parse failures to users.
    const result = parseAgency("static let x = 1", {}, false);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorData?.message).toMatch(/`static let` is not allowed/);
  });

  it("rejects `static <name> = ...` with actionable guidance", () => {
    const result = parseAgency("static foo = 1", {}, false);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorData?.message).toMatch(
      /`static <name> = \.\.\.` is not allowed/,
    );
  });

  it("declines a bare `static` keyword followed by nothing", () => {
    const result = staticStatementParser("static");
    expect(result.success).toBe(false);
  });
});
