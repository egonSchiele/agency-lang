import { ImportStatement } from "@/types/importStatement";
import { capture, many1Till, oneOf, Parser, seqC, set, spaces, str } from "tarsec";

export const importStatmentParser: Parser<ImportStatement> = seqC(
  set("type", "importStatement"),
  str("import"),
  spaces,
  capture(many1Till(str(" from")), "importedNames"),
  str(" from"),
  spaces,
  capture(many1Till(oneOf(";\n")), "modulePath"),
)