import { AgencyObject, FunctionCall, PromptLiteral } from "../types.js";
import {
  capture,
  captureCaptures,
  char,
  failure,
  many1WithJoin,
  or,
  parseError,
  Parser,
  sepBy,
  seqC,
  seqR,
  set,
  spaces,
  str,
  success,
} from "tarsec";
import { valueAccessParser } from "./access.js";
import {
  booleanParser,
  literalParser,
  literalParserNoVarName,
  variableNameParser,
} from "./literals.js";
import { optionalSemicolon } from "./parserUtils.js";
import { comma, optionalSpaces, varNameChar } from "./utils.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";
import { binOpParser } from "./binop.js";

export const _functionCallParser: Parser<FunctionCall> = (input: string) => {
  const parser = seqC(
    set("type", "functionCall"),
    capture(many1WithJoin(varNameChar), "functionName"),
    char("("),
    optionalSpaces,
    capture(
      sepBy(
        comma,
        or(
          agencyArrayParser,
          agencyObjectParser,
          booleanParser,
          literalParserNoVarName,
          binOpParser,
          valueAccessParser,
          variableNameParser,
        ),
      ),
      "arguments",
    ),
    optionalSpaces,
    char(")"),
    optionalSemicolon,
  );
  return parser(input);
};

// functionCallParser is now just _functionCallParser (no async/sync wrappers - handled by valueAccessParser)
export const functionCallParser: Parser<FunctionCall> = _functionCallParser;

export const llmPromptFunctionCallParser: Parser<PromptLiteral> = (
  input: string,
) => {
  const parser = functionCallParser;
  const result = parser(input);
  if (!result.success) {
    return result;
  }
  const { functionName, arguments: args } = result.result;
  if (functionName !== "llm") {
    return failure(
      `Expected function name "llm", got "${functionName}"`,
      input,
    );
  }

  if (args.length === 0) {
    throw new Error(
      `llm function call must have at least one argument for the prompt.`,
    );
  }
  const promptArg = args[0];
  const promptArgIsPrompt =
    promptArg.type === "prompt" ||
    promptArg.type === "string" ||
    promptArg.type === "multiLineString" ||
    promptArg.type === "variableName"; // if variable name, assume its a string
  if (!promptArgIsPrompt) {
    throw new Error(`First argument to llm function must be a prompt literal.`);
  }
  const promptConfig = args[1];
  if (
    promptConfig &&
    promptConfig.type !== "agencyObject" &&
    promptConfig.type !== "variableName"
  ) {
    throw new Error(
      `Second argument to llm function must be an object literal or variable.`,
    );
  }

  return success(
    {
      type: "prompt",
      segments:
        promptArg.type === "variableName"
          ? [
              {
                type: "interpolation" as const,
                expression: promptArg,
              },
            ]
          : promptArg.segments,
      config: promptConfig as AgencyObject | undefined,
    },
    result.rest,
  );
};

export const streamingPromptLiteralParser: Parser<PromptLiteral> = (
  input: string,
) => {
  const parser = seqC(
    or(str("streaming"), str("stream")),
    spaces,
    captureCaptures(
      parseError(
        "expected an llm() call after `stream`",
        capture(llmPromptFunctionCallParser, "prompt"),
      ),
    ),
  );
  const result = parser(input);
  if (!result.success) {
    return result;
  }
  const { prompt } = result.result;
  return success({ ...prompt, isStreaming: true }, result.rest);
};
