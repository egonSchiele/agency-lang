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
  str,
} from "tarsec";
import { DebuggerStatement } from "../types/debuggerStatement.js";
import { optionalSemicolon } from "./parserUtils.js";
import { optionalSpaces, optionalSpacesOrNewline } from "./utils.js";
import { withLoc } from "./loc.js";

function removeQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

export const debuggerParser: Parser<DebuggerStatement> = withLoc(seqC(
  set("type", "debuggerStatement"),
  set("isUserAdded", true),
  str("debugger"),
  char("("),
  optional(capture(map(quotedString, removeQuotes), "label")),
  char(")"),
  optionalSemicolon,
  optionalSpacesOrNewline,
));
