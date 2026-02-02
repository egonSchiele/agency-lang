import { ImportStatement } from "../types/importStatement.js";
import {
  capture,
  many1Till,
  newline,
  oneOf,
  optional,
  Parser,
  seqC,
  set,
  spaces,
  str,
  trace,
} from "tarsec";
import { optionalSemicolon } from "./parserUtils.js";

export const importStatmentParser: Parser<ImportStatement> = trace(
  "importStatement",
  seqC(
    set("type", "importStatement"),
    str("import"),
    spaces,
    capture(many1Till(str("from")), "importedNames"),
    str("from"),
    spaces,
    capture(many1Till(oneOf(";\n")), "modulePath"),
    optionalSemicolon,
    optional(newline)
  )
);
