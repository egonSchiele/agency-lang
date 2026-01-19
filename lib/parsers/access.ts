import {
  accessExpression,
  AccessExpression,
  DotFunctionCall,
  DotProperty,
  IndexAccess,
} from "../types/access.js";
import {
  capture,
  char,
  failure,
  many1WithJoin,
  noneOf,
  or,
  Parser,
  ParserResult,
  sepBy1,
  seqC,
  set,
  success,
} from "tarsec";
import { agencyArrayParser } from "./dataStructures.js";
import { functionCallParser } from "./functionCall.js";
import { literalParser, variableNameParser } from "./literals.js";
import { optionalSemicolon } from "./parserUtils.js";
import { varNameChar } from "./utils.js";
import { AgencyNode } from "@/types.js";

function createAccessExpression(arr: AgencyNode[]): AccessExpression {
  //console.log(JSON.stringify(arr))
  if (arr.length < 1) {
    throw new Error(`Not enough items to create access expression: ${JSON.stringify(arr)}`);
  }
  if (arr.length === 1) {
    return accessExpression(arr[0] as any);
  }
  if (arr.length > 1) {
    const head = arr.slice(0, -1);
    const last = arr.at(-1);
    switch (last?.type) {
      case "variableName":
        return accessExpression({
          type: "dotProperty",
          object: createAccessExpression(head),
          propertyName: last.value
        })
      case "functionCall":
        return accessExpression({
          type: "dotFunctionCall",
          object: createAccessExpression(head),
          functionCall: last
        })
      case "indexAccess":
        throw new Error("indexAccess not supported yet")
      /* return accessExpression({
        type: "indexAccess",
        array: {
          type: "dotProperty",
          object: createAccessExpression(head),
          propertyName: last.array
        },
        index: last.index
      }); */
      default:
        throw new Error(`unknown type ${last && last.type} in createAccessExpression`)
    }
  }
  throw new Error(`we should NEVER get here: ${JSON.stringify(arr)} `)
}


export function accessExpressionParser(input: string): ParserResult<AccessExpression> {
  const parser = sepBy1(char("."), or(functionCallParser, indexAccessParser, variableNameParser))
  const result = parser(input);
  if (result.success === false) {
    return result;
  }

  if (result.result.length < 2) {
    return failure("Didn't find property access or function call", input);
  }

  //console.log(JSON.stringify(result, null, 2));
  //console.log("======================")
  const access = createAccessExpression(result.result);
  //console.log("======================")
  //console.log(JSON.stringify(access, null, 2));
  //
  return success(access, result.rest);

  /*
   [
      {
        "type": "variableName",
        "value": "foo"
      },
      {
        "type": "functionCall",
        "functionName": "bar",
        "arguments": []
      },
      {
        "type": "indexAccess",
        "array": {
          "type": "variableName",
          "value": "baz"
        },
        "index": {
          "type": "number",
          "value": "2"
        }
      },
      {
        "type": "variableName",
        "value": "foo"
      }
    ],
    */

  /*   const parser2 = seqC(
      set("type", "dotProperty"),
      capture(or(literalParser, functionCallParser), "object"),
      char("."),
      capture(many1WithJoin(varNameChar), "propertyName")
    );
  
    return parser2(input); */
};
export const indexAccessParser = (input: string): ParserResult<IndexAccess> => {
  const parser = seqC(
    set("type", "indexAccess"),
    capture(or(agencyArrayParser, functionCallParser, literalParser), "array"),
    char("["),
    capture(or(functionCallParser, literalParser), "index"),
    char("]")
  );

  return parser(input);
};

/*
export const dotFunctionCallParser = (
  input: string
): ParserResult<DotFunctionCall> => {
  const parser = seqC(
    set("type", "dotFunctionCall"),
    capture(or(functionCallParser, literalParser), "object"),
    char("."),
    capture(functionCallParser, "functionCall")
  );

  return parser(input);
}; */

/* export const accessExpressionParser: Parser<AccessExpression> = seqC(
  set("type", "accessExpression"),
  capture(
    or(dotFunctionCallParser, dotPropertyParser, indexAccessParser),
    "expression"
  ),
  optionalSemicolon
);
 */