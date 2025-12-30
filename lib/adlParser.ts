import {
  alphanum,
  anyChar,
  capture,
  captureCaptures,
  char,
  digit,
  many,
  many1,
  many1Till,
  many1WithJoin,
  manyTill,
  or,
  sepBy,
  seqC,
  seqR,
  set,
  space,
  spaces,
  str,
  trace,
} from "tarsec";


const optionalSpaces = many(space);


const backtick = char("`");
export const promptParser = seqC(set("type", "prompt"), backtick, capture(manyTill(backtick), "text"), backtick);
export const numberParser = seqC(set("type", "number"), capture(many1(or(char("-"), char("."), digit)), "value"));
export const stringParser = seqC(
  set("type", "string"),
  char('"'),
  capture(manyTill(char('"')), "value"),
  char('"')
);
export const variableNameParser = trace("variableNameParser",
  seqC(set("type", "variableName"),
    capture(many1WithJoin(alphanum), "value")
  ));

export const literalParser = or(promptParser, numberParser, stringParser, variableNameParser);
export const assignmentParser = trace("assignmentParser", seqC(
  set("type", "assignment"),
  optionalSpaces,
  capture(many1Till(or(space, char("="))), "variableName"),
  optionalSpaces,
  char("="),
  optionalSpaces,
  capture(literalParser, "value")
));

export const functionBodyParser = trace("functionBodyParser", seqR(
  sepBy(spaces, or(assignmentParser, literalParser))
));

export const functionParser = trace("functionParser", seqC(
  str("def"),
  many1(space),
  capture(many1Till(char("(")), "functionName"),
  char("("),
  optionalSpaces,
  char(")"),
  optionalSpaces,
  char("{"),
  capture(functionBodyParser, "body"),
  optionalSpaces,
  char("}")
));

export const typeHintParser = trace("typeHintParser", seqC(
  set("type", "typeHint"),
  capture(many1Till(space), "variableName"),
  optionalSpaces,
  str("::"),
  optionalSpaces,
  capture(many1Till(space), "variableType")
));

export const adlParser = sepBy(spaces, trace("adlParser", or(typeHintParser, functionParser, assignmentParser)));
