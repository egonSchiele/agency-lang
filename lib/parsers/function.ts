import { AgencyNode, DocString, FunctionDefinition } from "@/types";
import {
  capture,
  char,
  debug,
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
import { accessExpressionParser } from "./access";
import { assignmentParser } from "./assignment";
import { commentParser } from "./comment";
import { functionCallParser } from "./functionCall";
import { literalParser } from "./literals";
import { matchBlockParser } from "./matchBlock";
import { optionalSemicolon } from "./parserUtils";
import { typeAliasParser, typeHintParser } from "./typeHints";
import { comma, optionalSpaces, varNameChar } from "./utils";
import { GraphNodeDefinition } from "@/types/graphNode";
import { returnStatementParser } from "./returnStatement";
import { usesToolParser } from "./tools";
import { bodyParser } from "./body";

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
