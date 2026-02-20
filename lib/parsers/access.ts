import { AgencyNode, FunctionCall, VariableNameLiteral } from "@/types.js";
import {
  capture,
  char,
  failure,
  many,
  or,
  Parser,
  ParserResult,
  seqC,
  set,
  spaces,
  str,
  success,
} from "tarsec";
import { AccessChainElement, ValueAccess } from "../types/access.js";
import { _functionCallParser } from "./functionCall.js";
import { literalParser, variableNameParser } from "./literals.js";
import { optionalSpaces } from "./utils.js";
import { oneOfStr } from "./parserUtils.js";

// Parse a single chain element: .method(), .property, or [index]
const dotMethodCallParser = (
  input: string,
): ParserResult<AccessChainElement> => {
  // First try: . followed by functionCall (name + parens)
  const dotResult = char(".")(input);
  if (!dotResult.success) return failure("expected dot", input);

  const fcResult = _functionCallParser(dotResult.rest);
  if (fcResult.success) {
    return success(
      { kind: "methodCall" as const, functionCall: fcResult.result },
      fcResult.rest,
    );
  }

  // Second try: . followed by just a property name
  const nameResult = variableNameParser(dotResult.rest);
  if (nameResult.success) {
    return success(
      { kind: "property" as const, name: nameResult.result.value },
      nameResult.rest,
    );
  }

  return failure("expected property name or method call after dot", input);
};

const indexChainParser = (input: string): ParserResult<AccessChainElement> => {
  const parser = seqC(
    set("kind", "index" as const),
    char("["),
    optionalSpaces,
    capture(
      or(_functionCallParser, variableNameParser, literalParser),
      "index",
    ),
    optionalSpaces,
    char("]"),
  );

  const result = parser(input);
  return result;
};

const chainElementParser: Parser<AccessChainElement> = or(
  dotMethodCallParser,
  indexChainParser,
);

export const _valueAccessParser = (
  input: string,
): ParserResult<VariableNameLiteral | FunctionCall | ValueAccess> => {
  const parser = seqC(
    capture(or(_functionCallParser, variableNameParser), "base"),
    capture(many(chainElementParser), "chain"),
  );
  const result = parser(input);
  if (!result.success)
    return failure("expected value access expression", input);

  const base = result.result.base;
  const chain = result.result.chain;

  if (chain.length === 0) {
    // No chain, return base directly
    return success(base, result.rest);
  } else {
    // Return ValueAccess with base and chain
    return success(
      {
        type: "valueAccess" as const,
        base,
        chain,
      },
      result.rest,
    );
  }
};

export const asyncValueAccessParser = (
  input: string,
): ParserResult<FunctionCall | ValueAccess | VariableNameLiteral> => {
  const parser = seqC(
    str("async"),
    spaces,
    capture(_valueAccessParser, "access"),
  );
  const result = parser(input);
  if (!result.success) return failure("expected async keyword", input);

  return success({ ...result.result.access, async: true }, result.rest);
};

export const syncValueAccessParser = (
  input: string,
): ParserResult<FunctionCall | ValueAccess | VariableNameLiteral> => {
  const parser = seqC(
    oneOfStr(["sync", "await"]),
    spaces,
    capture(_valueAccessParser, "access"),
  );
  const result = parser(input);
  if (!result.success) return failure("expected sync/await keyword", input);

  return success({ ...result.result.access, async: false }, result.rest);
};

export const valueAccessParser: Parser<
  VariableNameLiteral | FunctionCall | ValueAccess
> = or(asyncValueAccessParser, syncValueAccessParser, _valueAccessParser);
