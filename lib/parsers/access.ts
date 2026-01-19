import { AgencyNode } from "@/types.js";
import {
  capture,
  char,
  failure,
  or,
  ParserResult,
  sepBy1,
  seqC,
  set,
  success,
} from "tarsec";
import {
  accessExpression,
  AccessExpression,
  IndexAccess,
} from "../types/access.js";
import { agencyArrayParser } from "./dataStructures.js";
import { functionCallParser } from "./functionCall.js";
import { literalParser, variableNameParser } from "./literals.js";

function createAccessExpression(arr: AgencyNode[]): AccessExpression {
  const expression = _createAccessExpression(arr);
  return expression as AccessExpression;
}
function _createAccessExpression(arr: AgencyNode[]): AgencyNode {
  if (arr.length < 1) {
    throw new Error(
      `Not enough items to create access expression: ${JSON.stringify(arr)}`
    );
  }
  if (arr.length === 1) {
    return arr[0];
  }
  if (arr.length > 1) {
    const head = arr.slice(0, -1);
    const last = arr.at(-1);
    switch (last?.type) {
      case "variableName":
        return accessExpression({
          type: "dotProperty",
          object: _createAccessExpression(head),
          propertyName: last.value,
        });
      case "functionCall":
        return accessExpression({
          type: "dotFunctionCall",
          object: _createAccessExpression(head),
          functionCall: last,
        });
      case "indexAccess":
        return accessExpression({
          type: "indexAccess",
          array: _createAccessExpression([...head, last.array]),
          index: last.index,
        });
      default:
        throw new Error(
          `unknown type ${last && last.type} in createAccessExpression`
        );
    }
  }
  throw new Error(`we should NEVER get here: ${JSON.stringify(arr)} `);
}

export function accessExpressionParser(
  input: string
): ParserResult<AccessExpression> {
  const parser = sepBy1(
    char("."),
    or(indexAccessParser, functionCallParser, variableNameParser)
  );
  const result = parser(input);
  if (result.success === false) {
    return result;
  }

  if (result.result.length < 2) {
    return failure("Didn't find property access or function call", input);
  }

  const access = createAccessExpression(result.result);
  return success(access, result.rest);
}

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
