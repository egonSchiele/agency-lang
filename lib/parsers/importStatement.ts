import {
  ImportNodeStatement,
  ImportStatement,
  ImportToolStatement,
} from "../types/importStatement.js";
import {
  alphanum,
  between,
  capture,
  char,
  many1Till,
  many1WithJoin,
  map,
  newline,
  oneOf,
  optional,
  or,
  Parser,
  sepBy,
  sepBy1,
  seqC,
  set,
  spaces,
  str,
  trace,
} from "tarsec";
import { optionalSemicolon } from "./parserUtils.js";
import { comma, optionalSpaces } from "./utils.js";

// Helper parser for quoted file paths - supports both single and double quotes
const doubleQuotedPath: Parser<{ path: string }> = seqC(
  char('"'),
  capture(many1Till(char('"')), "path"),
  char('"'),
);

const singleQuotedPath: Parser<{ path: string }> = seqC(
  char("'"),
  capture(many1Till(char("'")), "path"),
  char("'"),
);

const quotedPath: Parser<string> = map(
  or(doubleQuotedPath, singleQuotedPath),
  (res) => res.path,
);

export const importNodeStatmentParser: Parser<ImportNodeStatement> = trace(
  "importNodeStatement",
  seqC(
    set("type", "importNodeStatement"),
    str("import"),
    spaces,
    or(str("nodes"), str("node")),
    spaces,
    char("{"),
    optionalSpaces,
    capture(sepBy1(comma, many1WithJoin(alphanum)), "importedNodes"),
    optionalSpaces,
    char("}"),
    spaces,
    str("from"),
    spaces,
    capture(quotedPath, "agencyFile"),
    optionalSemicolon,
    optional(newline),
  ),
);
export const importToolStatmentParser: Parser<ImportToolStatement> = trace(
  "importToolStatement",
  seqC(
    set("type", "importToolStatement"),
    str("import"),
    spaces,
    or(str("tools"), str("tool")),
    spaces,
    char("{"),
    optionalSpaces,
    capture(sepBy1(comma, many1WithJoin(alphanum)), "importedTools"),
    optionalSpaces,
    char("}"),
    spaces,
    str("from"),
    spaces,
    capture(quotedPath, "agencyFile"),
    optionalSemicolon,
    optional(newline),
  ),
);
export const importStatmentParser: Parser<ImportStatement> = trace(
  "importStatement",
  seqC(
    set("type", "importStatement"),
    str("import"),
    spaces,
    capture(many1Till(str("from")), "importedNames"),
    str("from"),
    spaces,
    oneOf(`'"`),
    capture(many1Till(oneOf(`'"`)), "modulePath"),
    oneOf(`'"`),
    optionalSemicolon,
    optional(newline),
  ),
);
