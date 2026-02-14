import { TimeBlock } from "@/types/timeBlock.js";
import {
  capture,
  captureCaptures,
  char,
  debug,
  many,
  many1,
  many1Till,
  many1WithJoin,
  map,
  optional,
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
import {
  AgencyNode,
  Assignment,
  DocString,
  FunctionDefinition,
  FunctionParameter,
  VariableType,
} from "../types.js";
import { GraphNodeDefinition } from "../types/graphNode.js";
import { WhileLoop } from "../types/whileLoop.js";
import { IfElse } from "../types/ifElse.js";
import { accessExpressionParser, indexAccessParser } from "./access.js";
import { commentParser } from "./comment.js";
import {
  functionCallParser,
  llmPromptFunctionCallParser,
  streamingPromptLiteralParser,
} from "./functionCall.js";
import { literalParser, promptParser } from "./literals.js";
import { matchBlockParser } from "./matchBlock.js";
import { optionalSemicolon } from "./parserUtils.js";
import { returnStatementParser } from "./returnStatement.js";
import { specialVarParser } from "./specialVar.js";
import { usesToolParser } from "./tools.js";
import {
  typeAliasParser,
  typeHintParser,
  variableTypeParser,
} from "./typeHints.js";
import {
  comma,
  optionalSpaces,
  optionalSpacesOrNewline,
  varNameChar,
} from "./utils.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";
import { newLineParser } from "./newline.js";
import { MessageThread } from "@/types/messageThread.js";
import { skillParser } from "./skill.js";

export const assignmentParser: Parser<Assignment> = (input: string) => {
  const parser = trace(
    "assignmentParser",
    seqC(
      set("type", "assignment"),
      optionalSpaces,
      capture(many1WithJoin(varNameChar), "variableName"),
      optionalSpaces,
      optional(
        captureCaptures(
          seqC(
            char(":"),
            optionalSpaces,
            capture(variableTypeParser, "typeHint"),
          ),
        ),
      ),
      optionalSpaces,
      char("="),
      optionalSpaces,
      capture(
        or(
          timeBlockParser,
          messageThreadParser,
          promptParser,
          streamingPromptLiteralParser,
          llmPromptFunctionCallParser,
          functionCallParser,
          indexAccessParser,
          accessExpressionParser,
          agencyArrayParser,
          agencyObjectParser,
          literalParser,
        ),
        "value",
      ),
      optionalSemicolon,
    ),
  );
  return parser(input);
};

const trim = (s: string) => s.trim();
export const docStringParser: Parser<DocString> = trace(
  "docStringParser",
  seqC(
    set("type", "docString"),
    str('"""'),
    capture(map(many1Till(str('"""')), trim), "value"),
    str('"""'),
  ),
);

export const bodyParser = (input: string): ParserResult<AgencyNode[]> => {
  const parser = trace(
    "functionBodyParser",
    many(
      or(
        usesToolParser,
        debug(typeAliasParser, "error in typeAliasParser"),
        debug(typeHintParser, "error in typeHintParser"),
        specialVarParser,
        returnStatementParser,
        whileLoopParser,
        matchBlockParser,
        streamingPromptLiteralParser,
        ifParser,
        timeBlockParser,
        messageThreadParser,
        skillParser,
        functionParser,
        accessExpressionParser,
        assignmentParser,
        llmPromptFunctionCallParser,
        functionCallParser,
        literalParser,
        commentParser,
        newLineParser,
      ),
    ),
  );
  return parser(input);
};

export const _timeBlockParser: Parser<TimeBlock> = trace(
  "timeBlockParser",
  seqC(
    set("type", "timeBlock"),
    str("time"),
    optionalSpaces,
    char("{"),
    spaces,
    capture(bodyParser, "body"),
    optionalSpacesOrNewline,
    char("}"),
  ),
);
export const _messageThreadParser: Parser<MessageThread> = trace(
  "_messageThreadParser",
  seqC(
    set("type", "messageThread"),
    str("thread"),
    set("subthread", false),
    optionalSpaces,
    char("{"),
    spaces,
    capture(bodyParser, "body"),
    optionalSpacesOrNewline,
    char("}"),
  ),
);
export const _submessageThreadParser: Parser<MessageThread> = trace(
  "_submessageThreadParser",
  seqC(
    set("type", "messageThread"),
    str("subthread"),
    set("subthread", true),
    optionalSpaces,
    char("{"),
    spaces,
    capture(bodyParser, "body"),
    optionalSpacesOrNewline,
    char("}"),
  ),
);

export const messageThreadParser: Parser<MessageThread> = or(
  _messageThreadParser,
  _submessageThreadParser,
);

export const printTimeBlockParser: Parser<TimeBlock> = trace(
  "timeBlockParser",
  map(
    seqC(
      set("type", "timeBlock"),
      str("printTime"),
      optionalSpaces,
      char("{"),
      spaces,
      capture(bodyParser, "body"),
      optionalSpacesOrNewline,
      char("}"),
    ),
    (result) => ({
      ...result,
      printTime: true,
    }),
  ),
);

export const timeBlockParser: Parser<TimeBlock> = or(
  printTimeBlockParser,
  _timeBlockParser,
);

/* const elseClauseParser: Parser<AgencyNode[]> = seqC(
  str("else"),
  optionalSpaces,
  char("{"),
  spaces,
  captureCaptures(bodyParser),
  optionalSpaces,
  char("}"),
);

export const ifElseParser: Parser<IfElse> = (input: string) => {
  const parser = trace(
    "ifElseParser",
    seqC(
      set("type", "ifElse"),
      str("if"),
      optionalSpaces,
      char("("),
      optionalSpaces,
      capture(
        or(
          indexAccessParser,
          functionCallParser,
          accessExpressionParser,
          literalParser,
        ),
        "condition",
      ),
      optionalSpaces,
      char(")"),
      optionalSpaces,
      char("{"),
      spaces,
      capture(bodyParser, "thenBody"),
      optionalSpaces,
      char("}"),
      optionalSpaces,
      capture(optional(elseClauseParser), "elseBody"),
    ),
  );
  return parser(input);
}; */

export const ifParser: Parser<IfElse> = (input: string) => {
  const parser = trace(
    "ifParser",
    seqC(
      set("type", "ifElse"),
      str("if"),
      optionalSpaces,
      char("("),
      optionalSpaces,
      capture(
        or(accessExpressionParser, functionCallParser, literalParser),
        "condition",
      ),
      optionalSpaces,
      char(")"),
      optionalSpaces,
      char("{"),
      spaces,
      capture(bodyParser, "thenBody"),
      optionalSpaces,
      char("}"),
    ),
  );
  return parser(input);
};

export const whileLoopParser: Parser<WhileLoop> = trace(
  "whileLoopParser",
  seqC(
    set("type", "whileLoop"),
    str("while"),
    optionalSpaces,
    char("("),
    optionalSpaces,
    capture(
      or(
        indexAccessParser,
        functionCallParser,
        accessExpressionParser,
        literalParser,
      ),
      "condition",
    ),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    char("{"),
    spaces,
    capture(bodyParser, "body"),
    optionalSpaces,
    char("}"),
  ),
);

export const functionParameterParserWithTypeHint: Parser<FunctionParameter> =
  trace(
    "functionParameterParserWithTypeHint",
    seqC(
      set("type", "functionParameter"),
      capture(many1WithJoin(varNameChar), "name"),
      optionalSpaces,
      char(":"),
      optionalSpaces,
      capture(variableTypeParser, "typeHint"),
    ),
  );

export const functionParameterParser: Parser<FunctionParameter> = trace(
  "functionParameterParser",
  seqC(
    set("type", "functionParameter"),
    capture(many1WithJoin(varNameChar), "name"),
  ),
);

export const functionReturnTypeParser: Parser<VariableType> = trace(
  "functionReturnTypeParser",
  seqC(char(":"), optionalSpaces, captureCaptures(variableTypeParser)),
);

export const _functionParser: Parser<FunctionDefinition> = trace(
  "_functionParser",
  seqC(
    set("type", "function"),
    str("def"),
    many1(space),
    capture(many1Till(char("(")), "functionName"),
    char("("),
    optionalSpaces,
    capture(
      sepBy(
        comma,
        or(functionParameterParserWithTypeHint, functionParameterParser),
      ),
      "parameters",
    ),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    capture(optional(functionReturnTypeParser), "returnType"),
    optionalSpaces,
    char("{"),
    optionalSpacesOrNewline,
    capture(or(docStringParser, succeed(undefined)), "docString"),
    optionalSpacesOrNewline,
    capture(bodyParser, "body"),
    optionalSpaces,
    char("}"),
    optionalSemicolon,
  ),
);

export const asyncFunctionParser: Parser<FunctionDefinition> = (
  input: string,
) => {
  const parser = trace(
    "asyncFunctionParser",
    seqC(str("async"), spaces, captureCaptures(_functionParser)),
  );
  const mappedParser = map(parser, (result) => ({
    ...result,
    async: true,
  }));
  return mappedParser(input);
};

export const syncFunctionParser: Parser<FunctionDefinition> = (
  input: string,
) => {
  const parser = trace(
    "syncFunctionParser",
    seqC(str("sync"), spaces, captureCaptures(_functionParser)),
  );
  const mappedParser = map(parser, (result) => ({
    ...result,
    async: false,
  }));
  return mappedParser(input);
};

export const functionParser: Parser<FunctionDefinition> = or(
  asyncFunctionParser,
  syncFunctionParser,
  _functionParser, // default to async if no keyword is provided
);

export const graphNodeParser: Parser<GraphNodeDefinition> = trace(
  "graphNodeParser",
  seqC(
    set("type", "graphNode"),
    str("node"),
    many1(space),
    capture(many1Till(char("(")), "nodeName"),
    char("("),
    optionalSpaces,
    capture(
      sepBy(
        comma,
        or(functionParameterParserWithTypeHint, functionParameterParser),
      ),
      "parameters",
    ),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    capture(optional(functionReturnTypeParser), "returnType"),
    optionalSpaces,
    char("{"),
    optionalSpacesOrNewline,
    capture(bodyParser, "body"),
    optionalSpaces,
    char("}"),
    optionalSemicolon,
  ),
);
