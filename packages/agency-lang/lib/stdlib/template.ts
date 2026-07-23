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

export { holeNames };
