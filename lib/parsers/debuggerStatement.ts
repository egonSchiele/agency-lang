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
import { optionalSemicolon, removeQuotes } from "./parserUtils.js";
import { optionalSpaces, optionalSpacesOrNewline } from "./utils.js";
import { withLoc } from "./loc.js";

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
