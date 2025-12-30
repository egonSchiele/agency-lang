import {
  anyChar,
  capture,
  captureCaptures,
  char,
  digit,
  many,
  many1,
  many1Till,
  manyTill,
  or,
  seqC,
  seqR,
  set,
  space,
  spaces,
  str,
} from "tarsec";





const backtick = char("`");
export const promptParser = seqC(set("type", "prompt"), backtick, capture(manyTill(backtick), "text"), backtick);
export const numberParser = seqC(set("type", "number"), capture(many1(or(char("-"), char("."), digit)), "value"));
export const stringParser = seqC(
  set("type", "string"),
  char('"'),
  capture(manyTill(char('"')), "value"),
  char('"')
);
export const variableNameParser = seqC(set("type", "variableName"), capture(many1Till(space), "value"));

export const literalParser = or(promptParser, numberParser, stringParser, variableNameParser);
export const assignmentParser = seqC(
  set("type", "assignment"),
  many(space),
  capture(many1Till(or(space, char("="))), "variableName"),
  many(space),
  char("="),
  many(space),
  capture(literalParser, "value")
);
export const functionBodyParser = seqR(
  many(assignmentParser)
);

export const functionParser = seqC(
  str("def"),
  many1(space),
  capture(many1Till(char("(")), "functionName"),
  char("("),
  many(space),
  char(")"),
  many(space),
  char("{"),
  capture(functionBodyParser, "body"),
  many(space),
  char("}")
);

export const adlParser = many1(or(functionParser, assignmentParser));
