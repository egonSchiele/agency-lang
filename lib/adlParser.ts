import {
  alphanum,
  capture,
  char,
  digit,
  many,
  many1,
  many1Till,
  many1WithJoin,
  manyTill,
  map,
  or,
  Parser,
  sepBy,
  seqC,
  seqR,
  set,
  space,
  spaces,
  str,
  trace,
} from "tarsec";
import {
  ADLNode,
  ADLProgram,
  ArrayType,
  Assignment,
  FunctionCall,
  FunctionDefinition,
  InterpolationSegment,
  Literal,
  NumberLiteral,
  PrimitiveType,
  PromptLiteral,
  PromptSegment,
  StringLiteral,
  TextSegment,
  TypeHint,
  VariableNameLiteral,
  VariableType,
} from "./types";

const optionalSpaces = many(space);

const backtick = char("`");

// Helper to parse the content between backticks and build segments
function parsePromptContent(input: string): {
  success: boolean;
  segments: PromptSegment[];
  remaining: string;
} {
  const segments: PromptSegment[] = [];
  let current = input;
  let textBuffer = "";

  while (current.length > 0 && !current.startsWith("`")) {
    if (current.startsWith("#{")) {
      // Save any accumulated text first
      if (textBuffer.length > 0) {
        segments.push({ type: "text", value: textBuffer });
        textBuffer = "";
      }

      // Parse interpolation
      current = current.slice(2); // Skip #{
      let varName = "";
      while (current.length > 0 && current[0] !== "}") {
        if (/[a-zA-Z0-9]/.test(current[0])) {
          varName += current[0];
          current = current.slice(1);
        } else {
          return { success: false, segments: [], remaining: current };
        }
      }

      if (current.length === 0 || current[0] !== "}") {
        return { success: false, segments: [], remaining: current };
      }

      current = current.slice(1); // Skip }
      segments.push({ type: "interpolation", variableName: varName });
    } else {
      // Regular character - add to text buffer
      textBuffer += current[0];
      current = current.slice(1);
    }
  }

  // Save any remaining text
  if (textBuffer.length > 0) {
    segments.push({ type: "text", value: textBuffer });
  }

  return { success: true, segments, remaining: current };
}

// Main prompt parser using the custom content parser
export const promptParser: Parser<PromptLiteral> = (input: string) => {
  // Parse opening backtick
  const backtickResult = backtick(input);
  if (!backtickResult.success) {
    return backtickResult as any;
  }

  // Parse content
  const contentResult = parsePromptContent(backtickResult.remaining);
  if (!contentResult.success) {
    return { success: false, expected: "valid prompt content", remaining: contentResult.remaining };
  }

  // Parse closing backtick
  const closingBacktickResult = backtick(contentResult.remaining);
  if (!closingBacktickResult.success) {
    return closingBacktickResult as any;
  }

  return {
    success: true,
    result: {
      type: "prompt" as const,
      segments: contentResult.segments,
    },
    remaining: closingBacktickResult.remaining,
  };
};
export const numberParser: Parser<NumberLiteral> = seqC(
  set("type", "number"),
  capture(many1WithJoin(or(char("-"), char("."), digit)), "value")
);
export const stringParser: Parser<StringLiteral> = seqC(
  set("type", "string"),
  char('"'),
  capture(manyTill(char('"')), "value"),
  char('"')
);
export const variableNameParser: Parser<VariableNameLiteral> = trace(
  "variableNameParser",
  seqC(set("type", "variableName"), capture(many1WithJoin(alphanum), "value"))
);

export const literalParser: Parser<Literal> = or(
  promptParser,
  numberParser,
  stringParser,
  variableNameParser
);
export const assignmentParser: Parser<Assignment> = trace(
  "assignmentParser",
  seqC(
    set("type", "assignment"),
    optionalSpaces,
    capture(many1Till(or(space, char("="))), "variableName"),
    optionalSpaces,
    char("="),
    optionalSpaces,
    capture(literalParser, "value")
  )
);

export const functionBodyParser = trace(
  "functionBodyParser",
  sepBy(spaces, or(assignmentParser, literalParser))
);

export const functionParser: Parser<FunctionDefinition> = trace(
  "functionParser",
  seqC(
    set("type", "function"),
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
  )
);

export const primitiveTypeParser: Parser<PrimitiveType> = seqC(
  set("type", "primitiveType"),
  capture(or(str("number"), str("string"), str("boolean")), "value")
);
export const arrayTypeParser: Parser<ArrayType> = seqC(
  set("type", "arrayType"),
  str("array"),
  char("<"),
  capture(primitiveTypeParser, "elementType"),
  char(">")
);

export const variableTypeParser: Parser<VariableType> = or(
  primitiveTypeParser,
  arrayTypeParser
);

export const typeHintParser: Parser<TypeHint> = seqC(
  set("type", "typeHint"),
  capture(many1Till(space), "variableName"),
  optionalSpaces,
  str("::"),
  optionalSpaces,
  capture(variableTypeParser, "variableType")
);

export const functionCallParser: Parser<FunctionCall> = seqC(
  set("type", "functionCall"),
  capture(many1Till(char("(")), "functionName"),
  char("("),
  optionalSpaces,
  capture(
    sepBy(
      seqR(optionalSpaces, char(","), optionalSpaces),
      many1WithJoin(alphanum)
    ),
    "arguments"
  ),
  optionalSpaces,
  char(")")
);

export const adlNode: Parser<ADLNode[]> = sepBy(
  spaces,
  trace(
    "adlParser",
    or(typeHintParser, functionParser, assignmentParser, functionCallParser)
  )
);

export const adlParser: Parser<ADLProgram> = seqC(
  set("type", "adlProgram"),
  capture(adlNode, "nodes")
);
