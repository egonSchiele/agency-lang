import { readFileSync } from "node:fs";
import { AgencyNode } from "../types.js";
import { exprParser, bodyParser } from "../parsers/parsers.js";
import { generateAgency } from "../backends/agencyGenerator.js";
import { _parseAST, resolveInSandbox } from "./agency.js";
import { holeInfos, holeNames, HoleInfo } from "../utils/holes.js";
import { Code, kindOf } from "../runtime/template/code.js";
import { fillHoles } from "../runtime/template/fill.js";

export type { Code };
export { kindOf };

export function _parseExpr(source: string): Code {
  const trimmed = source.trim();
  const result = exprParser(trimmed);
  if (!result.success || result.rest.trim() !== "") {
    // The rest check is what makes `parseExpr("const x = 1")` fail rather
    // than silently parsing a prefix.
    throw new Error(`Not a single Agency expression: ${source}`);
  }
  return { type: "agencyProgram", kind: "expr", nodes: [result.result as AgencyNode] };
}

export function _parseStatements(source: string): Code {
  const result = bodyParser(source.trim());
  if (!result.success || result.rest.trim() !== "") {
    throw new Error(`Not a list of Agency statements: ${source}`);
  }
  return { type: "agencyProgram", kind: "statements", nodes: result.result };
}

export function _toSource(code: Code): string {
  return generateAgency(code as Parameters<typeof generateAgency>[0]);
}

export function _loadTemplate(dir: string, filename: string): Code {
  const target = resolveInSandbox(dir, filename, { mustExist: true });
  const program = _parseAST(readFileSync(target, "utf-8"));
  return { ...program, kind: "program" } as Code;
}

export function _loadTemplateFromString(source: string): Code {
  return { ..._parseAST(source), kind: "program" } as Code;
}

export function _holesOf(code: Code): HoleInfo[] {
  return holeInfos(code.nodes);
}

export function _fill(code: Code, values: Record<string, unknown>): Code {
  return fillHoles(code, values);
}

/**
 * Merge several fragments into one.
 *
 * Merging is concatenating nodes; the only real question is what kind
 * comes out, and every answer here follows from behavior that already
 * exists rather than being decided fresh.
 *
 * An empty merge is an empty `statements` fragment, matching
 * `parseStatements("")` and the empty code literal — the literal and the
 * runtime parser must not disagree about the same thing. A single input is
 * returned unchanged, so `combine` around a loop that ran once behaves
 * like no `combine` at all, keeping both its kind and its doc comment.
 *
 * Beyond that the rule is smaller than the case list suggests, so it is
 * written as a rule: a `program` fragment may not merge with anything
 * else, and what comes out is `program` only when everything going in was.
 * Widening an expression to a statement is not a new decision either —
 * `fill` already accepts an `expr` fragment wherever statements go,
 * because an expression IS a legal statement in Agency.
 *
 * `program` mixed with anything is refused rather than widened. A
 * declaration and a bare statement have different placement rules, and a
 * silent merge produces a fragment that fails much later, at the completed
 * program's compile, with no useful position.
 */
export function _combine(codes: Code[]): Code {
  if (codes.length === 0) {
    return { type: "agencyProgram", kind: "statements", nodes: [] };
  }
  if (codes.length === 1) {
    return codes[0];
  }
  const kinds = codes.map(kindOf);
  const distinct = kinds.filter((kind, index) => kinds.indexOf(kind) === index);
  if (distinct.includes("program") && distinct.length > 1) {
    throw new Error(
      `A whole-program fragment cannot merge with loose statements or expressions (got ${distinct.sort().join(" and ")}).`,
    );
  }
  return {
    type: "agencyProgram",
    // A merged fragment has no single doc comment, so it carries none.
    kind: distinct[0] === "program" ? "program" : "statements",
    nodes: codes.flatMap((code) => code.nodes),
  };
}

export { holeNames };
