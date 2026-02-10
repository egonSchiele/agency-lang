import { AgencyObject, FunctionCall, PromptLiteral } from "../types.js";
import {
  capture,
  char,
  failure,
  many1WithJoin,
  or,
  Parser,
  sepBy,
  seqC,
  seqR,
  set,
  spaces,
  str,
  success,
} from "tarsec";
import { accessExpressionParser, indexAccessParser } from "./access.js";
import { literalParser, promptParser } from "./literals.js";
import { optionalSemicolon } from "./parserUtils.js";
import { comma, optionalSpaces, varNameChar } from "./utils.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";

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
          indexAccessParser,
          functionCallParser,
          accessExpressionParser,
          literalParser,
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

export const asyncFunctionCallParser: Parser<FunctionCall> = (
  input: string,
) => {
  const parser = seqC(
    str("async"),
    spaces,
    capture(_functionCallParser, "functionCall"),
  );
  const result = parser(input);
  if (!result.success) {
    return result;
  }
  const { functionCall } = result.result;
  return success({ ...functionCall, async: true }, result.rest);
};

export const syncFunctionCallParser: Parser<FunctionCall> = (input: string) => {
  const parser = seqC(
    or(str("sync"), str("await")),
    spaces,
    capture(_functionCallParser, "functionCall"),
  );
  const result = parser(input);
  if (!result.success) {
    return result;
  }
  const { functionCall } = result.result;
  return success({ ...functionCall, async: false }, result.rest);
};

export const functionCallParser: Parser<FunctionCall> = or(
  asyncFunctionCallParser,
  syncFunctionCallParser,
  _functionCallParser, // default to async if no keyword is provided
);

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
  if (promptConfig && promptConfig.type !== "agencyObject") {
    throw new Error(
      `Second argument to llm function must be an object literal for configuration.`,
    );
  }

  return success(
    {
      type: "prompt",
      segments:
        promptArg.type === "variableName"
          ? [
              {
                type: "interpolation",
                variableName: promptArg.value,
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
    capture(or(promptParser, llmPromptFunctionCallParser), "prompt"),
  );
  const result = parser(input);
  if (!result.success) {
    return result;
  }
  const { prompt } = result.result;
  return success({ ...prompt, isStreaming: true }, result.rest);
};
