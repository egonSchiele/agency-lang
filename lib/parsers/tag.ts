import {
  capture,
  char,
  label,
  many1WithJoin,
  map,
  or,
  quotedString,
  sepBy,
  seqC,
  set,
  succeed,
  trace,
} from "tarsec";
import { Tag } from "@/types.js";
import { comma, optionalSpaces, varNameChar } from "./utils.js";
import { optionalSemicolon, removeQuotes } from "./parserUtils.js";
import { withLoc } from "./loc.js";

// A single tag argument: either a quoted string or a bare identifier
// Both are normalized to plain strings
const stringArg = map(quotedString, removeQuotes);
const identArg = many1WithJoin(varNameChar);
const tagArg = or(stringArg, identArg);

// Parenthesized argument list: (arg1, arg2) or ("string arg")
const tagArgsList = map(
  seqC(
    char("("),
    optionalSpaces,
    capture(sepBy(comma, tagArg), "args"),
    optionalSpaces,
    char(")"),
  ),
  (result) => result.args,
);

// The full tag: @name or @name(args)
const _tagParserInner = trace(
  "tagParser",
  seqC(
    set("type", "tag"),
    char("@"),
    capture(many1WithJoin(varNameChar), "name"),
    capture(
      or(tagArgsList, succeed([] as string[])),
      "arguments",
    ),
    optionalSemicolon,
  ),
);

export const tagParser = label("a tag", withLoc(_tagParserInner));
