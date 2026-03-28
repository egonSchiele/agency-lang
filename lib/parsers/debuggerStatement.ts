import {
  capture,
  char,
  failure,
  map,
  optional,
  Parser,
  ParserResult,
  quotedString,
  seqC,
  set,
  success,
  regexParser,
} from "tarsec";
import { DebuggerStatement } from "../types/debuggerStatement.js";
import { optionalSemicolon } from "./parserUtils.js";
import { optionalSpaces } from "./utils.js";

function removeQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// Matches the literal "debugger" only when NOT followed by a word character
const debuggerKeyword = regexParser(/^debugger(?![a-zA-Z0-9_])/);

export function debuggerParser(input: string): ParserResult<DebuggerStatement> {
  // Try to match "debugger" keyword (with negative lookahead)
  const keywordResult = debuggerKeyword(input);
  if (!keywordResult.success) {
    return failure("expected 'debugger'", input);
  }

  let rest = keywordResult.rest;

  // Optionally match ("label") or ('label')
  const labelParser = seqC(
    optionalSpaces,
    char("("),
    capture(map(quotedString, removeQuotes), "label"),
    char(")"),
  );

  const labelResult = labelParser(rest);

  let label: string | undefined;
  if (labelResult.success) {
    label = labelResult.result.label;
    rest = labelResult.rest;
  }

  // Consume optional semicolon
  const semiResult = optionalSemicolon(rest);
  if (semiResult.success) {
    rest = semiResult.rest;
  }

  const node: DebuggerStatement = {
    type: "debuggerStatement",
    ...(label !== undefined ? { label } : {}),
  };

  return success(node, rest);
}
