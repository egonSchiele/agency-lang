import { describe, expect, it } from "vitest";
import { exprParser } from "@/parsers/parsers.js";
import type { TypeAliasEntry, VariableType } from "@/types.js";
import {
  checkProposal,
  describeConstraint,
  hasInterpolation,
  isNullLiteral,
  renderConstraintText,
} from "./constraint.js";

const statusT: VariableType = {
  type: "unionType",
  types: [
    { type: "stringLiteralType", value: "pass" },
    { type: "stringLiteralType", value: "fail" },
  ],
};
const jobT: VariableType = {
  type: "objectType",
  properties: [
    { key: "status", value: { type: "typeAliasVariable", aliasName: "Status" } },
    {
      key: "priority",
      value: {
        type: "unionType",
        types: [
          { type: "primitiveType", value: "number" },
          { type: "primitiveType", value: "null" },
        ],
      },
    },
  ],
};
const aliases: Record<string, TypeAliasEntry> = { Status: { body: statusT }, Job: { body: jobT } };

describe("checkProposal", () => {
  it("accepts a union member and rejects a non-member with the checker's message", () => {
    expect(checkProposal("Status", `"fail"`, aliases).ok).toBe(true);
    const bad = checkProposal("Status", `"exploded"`, aliases);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("Status");
  });

  it("enforces primitives in both directions", () => {
    expect(checkProposal("number", `-5`, {}).ok).toBe(true);
    expect(checkProposal("number", `"five"`, {}).ok).toBe(false);
    expect(checkProposal("boolean", `true`, {}).ok).toBe(true);
    expect(checkProposal("boolean", `"yes"`, {}).ok).toBe(false);
  });

  it("accepts null for a nullable annotation", () => {
    expect(checkProposal("number | null", `null`, {}).ok).toBe(true);
    expect(checkProposal("number | null", `6`, {}).ok).toBe(true);
    expect(checkProposal("number | null", `"six"`, {}).ok).toBe(false);
  });

  it("matches the language on records (verified semantics)", () => {
    // Nullable field may be omitted; nested unions are enforced through the
    // alias registry; unknown fields are rejected.
    expect(checkProposal("Job", `{ status: "fail" }`, aliases).ok).toBe(true);
    expect(checkProposal("Job", `{ status: "nope" }`, aliases).ok).toBe(false);
    expect(checkProposal("Job", `{ status: "fail", extra: 1 }`, aliases).ok).toBe(false);
  });

  it("KNOWN FAIL-OPEN: an explicit null field skips the record check (language behavior, inherited)", () => {
    // synthObject degrades the whole literal to "any" when any field
    // synthesizes "any" (a bare null does), and checkType skips "any".
    // Fail-open is acceptable — it can never wrongly reject. Pinned as a
    // tripwire: if the language tightens null synthesis, this test diffs
    // and gets updated deliberately.
    expect(checkProposal("Job", `{ status: "nope", priority: null }`, aliases).ok).toBe(true);
  });

  it("rejects bare variable references, but NOT interpolations (the mutator gates those)", () => {
    expect(checkProposal("Status", `somevar`, {}).ok).toBe(false);
    // The undefined-variable pass does not descend into interpolation
    // segments, so the probe alone accepts this — which is why the mutator
    // applies the explicit hasInterpolation gate before probing.
    expect(checkProposal("string", `"hi \${x}"`, {}).ok).toBe(true);
  });

  it("rejects values that do not parse", () => {
    expect(checkProposal("number", `{{{`, {}).ok).toBe(false);
  });

  it("accepts anything against an any annotation", () => {
    expect(checkProposal("any", `{ a: 1 }`, {}).ok).toBe(true);
  });
});

describe("hasInterpolation", () => {
  function expr(src: string) {
    const parsed = exprParser(src);
    if (!parsed.success) throw new Error(`could not parse: ${src}`);
    return parsed.result;
  }

  it("detects interpolations at top level and nested in objects/arrays", () => {
    expect(hasInterpolation(expr(`"plain"`))).toBe(false);
    expect(hasInterpolation(expr(`"hi \${x}"`))).toBe(true);
    expect(hasInterpolation(expr(`{ a: "hi \${x}" }`))).toBe(true);
    expect(hasInterpolation(expr(`[1, "\${x}"]`))).toBe(true);
    expect(hasInterpolation(expr(`{ a: 1, b: [true, "ok"] }`))).toBe(false);
  });
});

describe("isNullLiteral", () => {
  it("recognizes the parser's variableName representation of null", () => {
    const parsed = exprParser("null");
    if (!parsed.success) throw new Error("parse failed");
    expect(isNullLiteral(parsed.result)).toBe(true);

    const other = exprParser("nullish");
    if (!other.success) throw new Error("parse failed");
    expect(isNullLiteral(other.result)).toBe(false);
  });
});

describe("renderConstraintText + describeConstraint", () => {
  it("renders a union round-trippably and labels freeform / unconstrained", () => {
    const text = renderConstraintText(statusT);
    expect(checkProposal(text, `"pass"`, {}).ok).toBe(true);
    expect(checkProposal(text, `"exploded"`, {}).ok).toBe(false);

    expect(describeConstraint({ constraintText: null, valueKind: "string" }).toLowerCase()).toContain("free");
    expect(describeConstraint({ constraintText: null, valueKind: "literal" }).toLowerCase()).toContain("literal");
    expect(describeConstraint({ constraintText: "Status", valueKind: "string" })).toBe("Status");
  });
});
