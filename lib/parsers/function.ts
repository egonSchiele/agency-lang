import { ADLNode, DocString, FunctionDefinition } from "@/types";
import {
  capture,
  char,
  debug,
  many1,
  many1Till,
  many1WithJoin,
  map,
  or,
  Parser,
  ParserResult,
  sepBy,
  seqC,
  set,
  space,
  spaces,
  str,
  succeed,
  trace,
} from "tarsec";
import { accessExpressionParser } from "./access";
import { assignmentParser } from "./assignment";
import { commentParser } from "./comment";
import { functionCallParser } from "./functionCall";
import { literalParser } from "./literals";
import { matchBlockParser } from "./matchBlock";
import { optionalSemicolon } from "./parserUtils";
import { typeAliasParser, typeHintParser } from "./typeHints";
import { comma, optionalSpaces, varNameChar } from "./utils";

const trim = (s: string) => s.trim();
export const docStringParser: Parser<DocString> = trace(
  "docStringParser",
  seqC(
    set("type", "docString"),
    str('"""'),
    capture(map(many1Till(str('"""')), trim), "value"),
    str('"""')
  )
);

export const functionBodyParser = trace(
  "functionBodyParser",
  (input: string): ParserResult<ADLNode[]> => {
    const parser: Parser<ADLNode[]> = sepBy(
      spaces,
      or(
        debug(typeAliasParser, "error in typeAliasParser"),
        debug(typeHintParser, "error in typeHintParser"),
        matchBlockParser,
        functionParser,
        accessExpressionParser,
        assignmentParser,
        functionCallParser,
        literalParser,
        commentParser
      )
    );

    const result = parser(input);
    return result;
    /*     if (result.success) {
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
    */
  }
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
    capture(sepBy(comma, many1WithJoin(varNameChar)), "parameters"),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    char("{"),
    optionalSpaces,
    capture(or(docStringParser, succeed(undefined)), "docString"),
    optionalSpaces,
    capture(functionBodyParser, "body"),
    optionalSpaces,
    char("}"),
    optionalSemicolon
  )
);
