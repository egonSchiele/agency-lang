import { describe, expect, it } from "vitest";
import { exprParser } from "@/parsers/parsers.js";
import type { TypeAliasEntry, VariableType } from "@/types.js";
import { hasInterpolation, isNullLiteral } from "@/utils/node.js";
import {
  checkProposal,
  describeConstraint,
  renderDeclaredType,
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

  it("does NOT reject bare identifiers or interpolations — the mutator gates those", () => {
    // An unknown bare identifier synthesizes to `any` and typechecks clean,
    // and the undefined-variable pass does not descend into interpolation
    // segments. Both are handled by the mutator's isLiteralExpression /
    // hasInterpolation gates, not by the probe. Pinned so nobody assumes
    // the probe covers them.
    expect(checkProposal("Status", `somevar`, aliases).ok).toBe(true);
    expect(checkProposal("string", `"hi \${x}"`, {}).ok).toBe(true);
    // With an EMPTY registry the same proposal is rejected — but only
    // because the alias itself is unknown, not because of the identifier.
    expect(checkProposal("Status", `somevar`, {}).ok).toBe(false);
  });

  it("rejects values that do not parse", () => {
    expect(checkProposal("number", `{{{`, {}).ok).toBe(false);
  });

  it("resolves aliases nested inside inline annotations (rendered by name, resolved lazily)", () => {
    // formatTypeHint renders alias references by NAME ("Status"), and the
    // probe resolves them against the registry at comparison time — so
    // annotations that CONTAIN aliases work without any eager expansion.
    expect(checkProposal(`{ status: Status }`, `{ status: "fail" }`, aliases).ok).toBe(true);
    expect(checkProposal(`{ status: Status }`, `{ status: "nope" }`, aliases).ok).toBe(false);
    expect(checkProposal(`Status | null`, `null`, aliases).ok).toBe(true);
    expect(checkProposal(`Status | null`, `"exploded"`, aliases).ok).toBe(false);
  });

  it("keeps the internal probe variable out of rejection reasons", () => {
    const bad = checkProposal("number", `"five"`, {});
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).not.toContain("proposedValue");
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

describe("renderDeclaredType + describeConstraint", () => {
  it("renders a union round-trippably and labels freeform / unconstrained", () => {
    const text = renderDeclaredType(statusT);
    expect(checkProposal(text, `"pass"`, {}).ok).toBe(true);
    expect(checkProposal(text, `"exploded"`, {}).ok).toBe(false);

    expect(describeConstraint({ declaredType: null, valueKind: "string" }).toLowerCase()).toContain("free");
    expect(describeConstraint({ declaredType: null, valueKind: "literal" }).toLowerCase()).toContain("literal");
    expect(describeConstraint({ declaredType: "Status", valueKind: "string" })).toBe("Status");
  });
});
