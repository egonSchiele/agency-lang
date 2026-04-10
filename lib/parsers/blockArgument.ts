import {
  capture,
  char,
  many1WithJoin,
  Parser,
  ParserResult,
  sepBy,
  seqC,
  set,
  spaces,
  str,
  success,
  trace,
} from "tarsec";
import { BlockArgument } from "../types/blockArgument.js";
import { FunctionParameter } from "../types/function.js";
import { bodyParser } from "./function.js";
import { comma, optionalSpaces, optionalSpacesOrNewline, varNameChar } from "./utils.js";

// Parse a single block parameter (just a name, no type annotation — types come from the function signature)
const blockParamParser: Parser<FunctionParameter> = trace(
  "blockParamParser",
  seqC(
    set("type", "functionParameter"),
    capture(many1WithJoin(varNameChar), "name"),
  ),
);

// Parse block parameters after "as":
//   as item { ... }           — single param
//   as (prev, attempt) { ... } — multiple params
//   as { ... }                — no params
const blockParamsParser: Parser<FunctionParameter[]> = (input: string): ParserResult<FunctionParameter[]> => {
  // Try multiple params: (a, b, c)
  const multiParser = seqC(
    char("("),
    optionalSpaces,
    capture(sepBy(comma, blockParamParser), "params"),
    optionalSpaces,
    char(")"),
  );
  const multiResult = multiParser(input);
  if (multiResult.success) {
    return success(multiResult.result.params, multiResult.rest);
  }

  // Try single param: identifier (but not "{" which means no params)
  const singleResult = blockParamParser(input);
  if (singleResult.success) {
    return success([singleResult.result], singleResult.rest);
  }

  // No params — return empty array
  return success([], input);
};

// Parse a block argument. Always requires "as" keyword:
//   as params { body }     — with params
//   as { body }            — no params
export const blockArgumentParser: Parser<BlockArgument> = trace(
  "blockArgumentParser",
  seqC(
    set("type", "blockArgument"),
    str("as"),
    spaces,
    capture(blockParamsParser, "params"),
    optionalSpaces,
    char("{"),
    optionalSpacesOrNewline,
    capture(bodyParser, "body"),
    optionalSpacesOrNewline,
    char("}"),
  ),
);
