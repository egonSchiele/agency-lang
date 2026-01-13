import {
  SpecialVar,
  SpecialVarName,
  specialVarNames,
} from "@/types/specialVar.js";
import { capture, char, or, Parser, seqC, set, str } from "tarsec";
import { optionalSpaces } from "./utils.js";
import { literalParser } from "./literals.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";
import { optionalSemicolon } from "./parserUtils.js";

export const specialVarNameParser: Parser<SpecialVarName> = or(
  ...specialVarNames.map((name) => str(name))
);
export const specialVarParser: Parser<SpecialVar> = seqC(
  set("type", "specialVar"),
  char("@"),
  capture(specialVarNameParser, "name"),
  optionalSpaces,
  char("="),
  optionalSpaces,
  capture(or(agencyObjectParser, agencyArrayParser, literalParser), "value"),
  optionalSemicolon
);
