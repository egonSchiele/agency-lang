import {
  AgencyNode,
  DocString,
  FunctionDefinition,
  FunctionParameter,
  VariableType,
} from "../types.js";
import {
  capture,
  captureCaptures,
  char,
  debug,
  many1,
  many1Till,
  many1WithJoin,
  map,
  oneOf,
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
import { accessExpressionParser, indexAccessParser } from "./access.js";
import { assignmentParser } from "./assignment.js";
import { commentParser } from "./comment.js";
import { functionCallParser } from "./functionCall.js";
import { literalParser } from "./literals.js";
import { matchBlockParser } from "./matchBlock.js";
import { optionalSemicolon } from "./parserUtils.js";
import {
  typeAliasParser,
  typeHintParser,
  variableTypeParser,
} from "./typeHints.js";
import { comma, optionalSpaces, varNameChar } from "./utils.js";
import { GraphNodeDefinition } from "../types/graphNode.js";
import { returnStatementParser } from "./returnStatement.js";
import { usesToolParser } from "./tools.js";
import { WhileLoop } from "../types/whileLoop.js";
import { specialVarParser } from "./specialVar.js";

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

export const bodyParser = trace(
  "functionBodyParser",
  (input: string): ParserResult<AgencyNode[]> => {
    const parser: Parser<AgencyNode[]> = sepBy(
      spaces,
      or(
        usesToolParser,
        debug(typeAliasParser, "error in typeAliasParser"),
        debug(typeHintParser, "error in typeHintParser"),
        specialVarParser,
        returnStatementParser,
        whileLoopParser,
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
  }
);

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
        literalParser
      ),
      "condition"
    ),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    char("{"),
    spaces,
    capture(bodyParser, "body"),
    optionalSpaces,
    char("}")
  )
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
      capture(variableTypeParser, "typeHint")
    )
  );

export const functionParameterParser: Parser<FunctionParameter> = trace(
  "functionParameterParser",
  seqC(
    set("type", "functionParameter"),
    capture(many1WithJoin(varNameChar), "name")
  )
);

export const functionReturnTypeParser: Parser<VariableType> = trace(
  "functionReturnTypeParser",
  seqC(char(":"), optionalSpaces, captureCaptures(variableTypeParser))
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
    capture(
      sepBy(
        comma,
        or(functionParameterParserWithTypeHint, functionParameterParser)
      ),
      "parameters"
    ),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    capture(optional(functionReturnTypeParser), "returnType"),
    optionalSpaces,
    char("{"),
    optionalSpaces,
    capture(or(docStringParser, succeed(undefined)), "docString"),
    optionalSpaces,
    capture(bodyParser, "body"),
    optionalSpaces,
    char("}"),
    optionalSemicolon
  )
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
      or(sepBy(comma, many1WithJoin(varNameChar)), succeed([])),
      "parameters"
    ),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    char("{"),
    optionalSpaces,
    capture(bodyParser, "body"),
    optionalSpaces,
    char("}"),
    optionalSemicolon
  )
);
