import {
  SpecialVar,
  SpecialVarName,
  specialVarNames,
} from "@/types/specialVar.js";
import { capture, captureCaptures, char, or, parseError, Parser, seqC, set, str } from "tarsec";
import { exprParser } from "./expression.js";
import { optionalSpaces } from "./utils.js";
import { optionalSemicolon } from "./parserUtils.js";

export const specialVarNameParser: Parser<SpecialVarName> = or(
  ...specialVarNames.map((name) => str(name))
);
export const specialVarParser: Parser<SpecialVar> = seqC(
  set("type", "specialVar"),
  char("@"),
  capture(specialVarNameParser, "name"),
  captureCaptures(
    parseError(
      "expected `= value` after special variable @name",
      optionalSpaces,
      char("="),
      optionalSpaces,
      capture(exprParser, "value"),
      optionalSemicolon,
    ),
  )
);
