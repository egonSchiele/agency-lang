import { ADLNode, FunctionDefinition } from "@/types";
import {
  capture,
  char,
  many1,
  many1Till,
  or,
  Parser,
  ParserResult,
  sepBy,
  seqC,
  set,
  space,
  spaces,
  str,
  trace,
} from "tarsec";
import { assignmentParser } from "./assignment";
import { functionCallParser } from "./functionCall";
import { literalParser } from "./literals";
import { matchBlockParser } from "./matchBlock";
import { typeAliasParser, typeHintParser } from "./typeHints";
import { optionalSpaces } from "./utils";
import { deepCopy } from "@/utils";

export const functionBodyParser = (input: string): ParserResult<ADLNode[]> => {
  const parser: Parser<ADLNode[]> = sepBy(
    spaces,
    or(
      typeAliasParser,
      typeHintParser,
      matchBlockParser,
      functionParser,
      assignmentParser,
      functionCallParser,
      literalParser
    )
  );

  const result = parser(input);
  if (result.success) {
    const newResult = deepCopy(result.result);
    const lastNode = newResult.at(-1);
    if (lastNode && lastNode.type !== "returnStatement") {
      newResult[newResult.length - 1] = {
        type: "returnStatement",
        value: lastNode,
      };
    }
    return {
      ...result,
      result: newResult,
    };
  } else {
    return result;
  }
};

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
