import {
  ImportNodeStatement,
  ImportStatement,
} from "../types/importStatement.js";
import {
  alphanum,
  between,
  capture,
  char,
  many1Till,
  many1WithJoin,
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
import { optionalSpaces } from "./utils.js";

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
    capture(sepBy(char(","), many1WithJoin(alphanum)), "importedNodes"),
    optionalSpaces,
    char("}"),
    spaces,
    str("from"),
    spaces,
    oneOf(`'"`),
    capture(many1Till(oneOf(`'"`)), "agencyFile"),
    oneOf(`'"`),
    optionalSemicolon,
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
