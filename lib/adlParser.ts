import {
  anyChar,
  capture,
  char,
  many,
  many1,
  many1Till,
  manyTill,
  or,
  seqC,
  space,
  spaces,
  str,
} from "tarsec";

export const functionParser = seqC(
  str("def"),
  many1(space),
  capture(many1Till(char("(")), "functionName"),
  char("("),
  many(space),
  char(")"),
  spaces,
  char("{"),
  manyTill(char("}")),
  char("}")
);

export const adlParser = or(functionParser);
