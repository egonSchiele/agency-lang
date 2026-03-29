import {
  Parser,
  ParserResult,
  capture,
  char,
  digit,
  failure,
  letter,
  many,
  many1Till,
  many1WithJoin,
  manyWithJoin,
  map,
  noneOf,
  oneOf,
  optional,
  or,
  quotedString,
  sepBy,
  sepBy1,
  seq,
  seqC,
  set,
  str,
  success,
  trace,
} from "tarsec";
import {
  BooleanLiteral,
  InterpolationSegment,
  Literal,
  MultiLineStringLiteral,
  NumberLiteral,
  PromptSegment,
  StringLiteral,
  TextSegment,
  VariableNameLiteral,
} from "../types.js";
import { exprParser } from "./expression.js";
import {
  commaWithNewline,
  optionalSpaces,
  optionalSpacesOrNewline,
  plusSign,
  varNameChar,
} from "./utils.js";

export const stringTextSegmentParser: Parser<TextSegment> = map(
  many1Till(oneOf('"`$')),
  (text) => ({
    type: "text",
    value: text,
  }),
);

export const multiLineStringTextSegmentParser: Parser<TextSegment> = map(
  many1Till(or(str('"""'), char("$"))),
  (text) => ({
    type: "text",
    value: text,
  }),
);

export const interpolationSegmentParser: Parser<InterpolationSegment> = (
  input: string,
) => {
  const parser = seqC(
    char("$"),
    char("{"),
    capture(exprParser, "expression"),
    char("}"),
  );

  const result = parser(input);
  if (!result.success) {
    return result;
  }

  return success(
    {
      type: "interpolation" as const,
      expression: result.result.expression,
    },
    result.rest,
  );
};

const objectParser = (input: string): ParserResult<Record<string, any>> => {
  const kvParser = trace(
    "objectKVParser",
    seqC(
      optionalSpaces,
      optional(char('"')),
      capture(manyWithJoin(noneOf('":\n\t ')), "key"),
      optional(char('"')),
      optionalSpaces,
      char(":"),
      optionalSpaces,
      capture(
        or(literalParser, objectParser),
        // arrayParser,
        "value",
      ),
    ),
  );

  const arrayToObj = (arr: { key: string; value: any }[]) => {
    const obj: Record<string, any> = {};
    arr.forEach(({ key, value }) => {
      obj[key] = value;
    });
    return obj;
  };

  const parser = seq(
    [
      char("{"),
      optionalSpacesOrNewline,
      capture(map(sepBy(commaWithNewline, kvParser), arrayToObj), "entries"),
      optionalSpacesOrNewline,
      char("}"),
    ],
    (_, captures) => {
      return captures.entries;
    },
  );

  return parser(input);
};

export function numberParser(input: string): ParserResult<NumberLiteral> {
  const parser = seqC(
    set("type", "number"),
    capture(many1WithJoin(or(char("-"), char("."), digit)), "value"),
  );
  return parser(input);
}

export const simpleStringParser: Parser<StringLiteral> = seqC(
  set("type", "string"),
  oneOf('"`'),
  capture(
    map(stringTextSegmentParser, (x) => [x]),
    "segments",
  ),
  oneOf('"`'),
);

export const _stringParser: Parser<StringLiteral> = seqC(
  set("type", "string"),
  oneOf('"`'),
  capture(
    many(or(stringTextSegmentParser, interpolationSegmentParser)),
    "segments",
  ),
  oneOf('"`'),
);

export const stringParser: Parser<StringLiteral> = (input: string) => {
  const parser = sepBy1(plusSign, or(_stringParser, variableNameParser));
  const result = parser(input);
  if (!result.success) {
    return result;
  }

  const parsed = result.result;
  if (parsed.length === 1 && parsed[0].type === "variableName") {
    return failure("Expected string literal, got variable name", input);
  }

  const segments: (TextSegment | InterpolationSegment)[] = [];
  parsed.forEach((part) => {
    if (part.type === "string") {
      segments.push(...part.segments);
    } else if (part.type === "variableName") {
      segments.push({
        type: "interpolation",
        expression: part,
      });
    }
  });
  return success(
    {
      type: "string" as const,
      segments,
    },
    result.rest,
  );
};

export const multiLineStringParser: Parser<MultiLineStringLiteral> = seqC(
  set("type", "multiLineString"),
  str('"""'),
  capture(
    many(or(multiLineStringTextSegmentParser, interpolationSegmentParser)),
    "segments",
  ),
  str('"""'),
);

export const variableNameParser: Parser<VariableNameLiteral> = (
  input: string,
) => {
  const parser = seq(
    [
      set("type", "variableName"),
      capture(or(letter, char("_")), "init"),
      capture(manyWithJoin(varNameChar), "value"),
    ],
    (_, captures) => {
      return {
        type: "variableName" as const,
        value: `${captures.init}${captures.value}`,
      };
    },
  );

  return parser(input);
};

export function booleanParser(input: string): ParserResult<BooleanLiteral> {
  const parser = seqC(
    set("type", "boolean"),
    capture(
      or(
        map(str("true"), () => true),
        map(str("false"), () => false),
      ),
      "value",
    ),
  );
  return parser(input);
}

export const literalParser: Parser<Literal> = or(
  booleanParser,
  numberParser,
  multiLineStringParser,
  stringParser,
  variableNameParser,
);

export const literalParserNoVarName: Parser<Literal> = or(
  booleanParser,
  numberParser,
  multiLineStringParser,
  stringParser,
);

// no string concat, no prompt strings
export function simpleLiteralParser(input: string): ParserResult<Literal> {
  const parser = or(
    booleanParser,
    numberParser,
    _stringParser,
    variableNameParser,
  );
  return parser(input);
}
