import {
  capture,
  captureCaptures,
  char,
  debug,
  fail,
  failure,
  many,
  parseError,
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
  success,
  trace,
  newline,
} from "tarsec";
import {
  AccessChainElement,
  AgencyNode,
  Assignment,
  DocString,
  FunctionDefinition,
  FunctionParameter,
  VariableType,
} from "../types.js";
import { GraphNodeDefinition, Visibility } from "../types/graphNode.js";
import { ForLoop } from "../types/forLoop.js";
import { WhileLoop } from "../types/whileLoop.js";
import { IfElse } from "../types/ifElse.js";
import { _valueAccessParser, valueAccessParser } from "./access.js";
import { commentParser } from "./comment.js";
import { functionCallParser } from "./functionCall.js";
import { booleanParser, literalParser, literalParserNoVarName } from "./literals.js";
import { matchBlockParser } from "./matchBlock.js";
import { optionalSemicolon } from "./parserUtils.js";
import { returnStatementParser } from "./returnStatement.js";
import { specialVarParser } from "./specialVar.js";
import { usesToolParser } from "./tools.js";
import {
  typeAliasParser,
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
import { binOpParser } from "./binop.js";
import { multiLineCommentParser } from "./multiLineComment.js";
import { keywordParser } from "./keyword.js";
import { HandleBlock } from "@/types/handleBlock.js";
import { WithModifier } from "@/types/withModifier.js";
import { debuggerParser } from "./debuggerStatement.js";
import { exprParser } from "./expression.js";
import { withLoc } from "./loc.js";
import { label } from "tarsec";

const _assignmentParserInner: Parser<Assignment> = (input: string) => {
  const parser = trace(
    "assignmentParser",
    seqC(
      set("type", "assignment"),
      optionalSpaces,
      optional(
        captureCaptures(
          seqC(
            capture(or(str("let"), str("const")), "declKind"),
            spaces,
          ),
        ),
      ),
      capture(_valueAccessParser, "target"),
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
      capture(or(messageThreadParser, exprParser), "value"),
      optionalSemicolon,
      optionalSpacesOrNewline,
    ),
  );
  const result = parser(input);
  if (!result.success) return result;

  const target = result.result.target;
  let variableName: string;
  let accessChain: AccessChainElement[] | undefined;

  if (target.type === "variableName") {
    variableName = target.value;
  } else if (target.type === "valueAccess") {
    if (target.base.type !== "variableName") {
      return failure(
        "assignment target must start with a variable name",
        input,
      );
    }
    variableName = target.base.value;
    accessChain = target.chain;
  } else {
    return failure("invalid assignment target", input);
  }

  const parsed = result.result as any;

  // Reject let/const with access chains (e.g., "let obj.x = 1")
  if (parsed.declKind && accessChain) {
    return failure(
      "cannot use 'let' or 'const' with property/index assignment",
      input,
    );
  }

  const { target: _target, value, ...rest } = parsed;
  const out: Assignment = { ...rest, variableName, value, accessChain };
  return success(out, result.rest);
};
export const assignmentParser: Parser<Assignment> = label("an assignment", withLoc(_assignmentParserInner));

export const sharedAssignmentParser: Parser<Assignment> = (input: string) => {
  const parser = seqC(str("shared"), spaces, captureCaptures(assignmentParser));
  const result = parser(input);
  if (!result.success) return result;
  if (!result.result.declKind) {
    return failure("shared requires 'let' or 'const' (e.g., 'shared let x = 1')", input);
  }
  return success({ ...result.result, shared: true }, result.rest);
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
  const bodyNodeParser = or(
    keywordParser,
    usesToolParser,
    debug(typeAliasParser, "error in typeAliasParser"),
    specialVarParser,
    returnStatementParser,
    forLoopParser,
    whileLoopParser,
    matchBlockParser,
    ifParser,
    messageThreadParser,
    handleBlockParser,
    debuggerParser,
    multiLineCommentParser,
    skillParser,
    withModifierParser,
    assignmentParser,
    binOpParser,
    booleanParser,
    valueAccessParser,
    literalParser,
    commentParser,
    newLineParser,
  );
  const parser = trace(
    "functionBodyParser",
    many(
      map(
        seqC(capture(bodyNodeParser, "node"), optionalSpacesOrNewline),
        (result) => result.node,
      ),
    ),
  );
  return parser(input);
};

export const _messageThreadParser: Parser<MessageThread> = trace(
  "_messageThreadParser",
  seqC(
    set("type", "messageThread"),
    str("thread"),
    set("threadType", "thread"),
    optionalSpaces,
    char("{"),
    captureCaptures(
      parseError(
        "expected block body followed by `}`",
        spaces,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSpacesOrNewline,
      ),
    ),
  ),
);
export const _submessageThreadParser: Parser<MessageThread> = trace(
  "_submessageThreadParser",
  seqC(
    set("type", "messageThread"),
    str("subthread"),
    set("threadType", "subthread"),
    optionalSpaces,
    char("{"),
    captureCaptures(
      parseError(
        "expected block body followed by `}`",
        spaces,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSpacesOrNewline,
      ),
    ),
  ),
);
export const messageThreadParser: Parser<MessageThread> = or(
  _messageThreadParser,
  _submessageThreadParser,
);

const inlineHandlerParser: Parser<HandleBlock["handler"]> = (input) => {
  const parser = seqC(
    set("kind", "inline"),
    char("("),
    optionalSpaces,
    capture(functionParameterParser, "param"),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    captureCaptures(
      parseError(
        "expected `{` to open handler body",
        char("{"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSpacesOrNewline,
      ),
    ),
  );
  return parser(input);
};

const functionRefHandlerParser: Parser<HandleBlock["handler"]> = (input) => {
  const parser = seqC(
    set("kind", "functionRef"),
    capture(many1WithJoin(varNameChar), "functionName"),
    optionalSpacesOrNewline,
  );
  return parser(input);
};

export const handleBlockParser: Parser<HandleBlock> = trace(
  "handleBlockParser",
  seqC(
    set("type", "handleBlock"),
    str("handle"),
    optionalSpaces,
    captureCaptures(
      parseError(
        "expected `{` to open handle block body",
        char("{"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
      ),
    ),
    optionalSpacesOrNewline,
    str("with"),
    optionalSpaces,
    capture(or(inlineHandlerParser, functionRefHandlerParser), "handler"),
  ),
);

export const withModifierParser: Parser<WithModifier> = (input: string) => {
  // Try to parse an assignment or a bare function call as the inner statement.
  const stmtResult = or(assignmentParser, functionCallParser)(input);
  if (!stmtResult.success) return failure("expected statement before 'with'", input);

  // Look for "with <builtin>" on remaining input.
  // assignmentParser consumes trailing whitespace, so rest starts at "with...".
  // functionCallParser does NOT consume trailing whitespace, so we need optionalSpaces first.
  const modParser = seqC(
    optionalSpaces,
    str("with"),
    spaces,
    capture(or(str("approve"), str("reject"), str("propagate")), "handlerName"),
    optionalSpacesOrNewline,
  );
  const modResult = modParser(stmtResult.rest);
  if (!modResult.success) return failure("expected 'with approve/reject/propagate'", input);

  return success(
    {
      type: "withModifier" as const,
      statement: stmtResult.result,
      handlerName: modResult.result.handlerName as WithModifier["handlerName"],
    },
    modResult.rest,
  );
};

const elseClauseParser: Parser<AgencyNode[]> = (input: string) => {
  const parser = seqC(optionalSpaces, str("else"), optionalSpaces);
  const prefixResult = parser(input);
  if (!prefixResult.success) return prefixResult;

  // Try parsing "else if" (another ifParser)
  const elseIfResult = ifParser(prefixResult.rest);
  if (elseIfResult.success) {
    return success([elseIfResult.result], elseIfResult.rest);
  }

  // Otherwise parse "else { body }"
  const elseBlockParser = seqC(
    char("{"),
    optionalSpacesOrNewline,
    capture(bodyParser, "body"),
    optionalSpacesOrNewline,
    char("}"),
    optionalSpacesOrNewline,
  );
  const blockResult = elseBlockParser(prefixResult.rest);
  if (!blockResult.success) return blockResult;
  return success(blockResult.result.body, blockResult.rest);
};

const _ifParserInner: Parser<IfElse> = (input: string) => {
  const parser = trace(
    "ifParser",
    seqC(
      set("type", "ifElse"),
      str("if"),
      optionalSpaces,
      char("("),
      optionalSpaces,
      capture(exprParser, "condition"),
      optionalSpaces,
      char(")"),
      optionalSpaces,
      captureCaptures(
        parseError(
          "expected `{` to open if block body",
          char("{"),
          optionalSpacesOrNewline,
          capture(bodyParser, "thenBody"),
          optionalSpacesOrNewline,
          char("}"),
          optionalSpacesOrNewline,
        ),
      ),
    ),
  );
  const result = parser(input);
  if (!result.success) return result;

  // Try to parse an optional else clause
  const elseResult = elseClauseParser(result.rest);
  if (elseResult.success) {
    return success(
      { ...result.result, elseBody: elseResult.result },
      elseResult.rest,
    );
  }

  return result;
};
export const ifParser: Parser<IfElse> = label("an if statement", withLoc(_ifParserInner));

export const whileLoopParser: Parser<WhileLoop> = label("a while loop", withLoc(trace(
  "whileLoopParser",
  seqC(
    set("type", "whileLoop"),
    str("while"),
    optionalSpaces,
    char("("),
    optionalSpaces,
    capture(exprParser, "condition"),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    captureCaptures(
      parseError(
        "expected `{` to open while loop body",
        char("{"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSpacesOrNewline,
      ),
    ),
  ),
)));

export const forLoopParser: Parser<ForLoop> = label("a for loop", withLoc(trace(
  "forLoopParser",
  seqC(
    set("type", "forLoop"),
    str("for"),
    optionalSpaces,
    char("("),
    optionalSpaces,
    capture(many1WithJoin(varNameChar), "itemVar"),
    optional(
      captureCaptures(
        seqC(
          optionalSpaces,
          char(","),
          optionalSpaces,
          capture(many1WithJoin(varNameChar), "indexVar"),
        ),
      ),
    ),
    optionalSpaces,
    str("in"),
    spaces,
    capture(exprParser, "iterable"),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    captureCaptures(
      parseError(
        "expected `{` to open for loop body",
        char("{"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSpacesOrNewline,
      ),
    ),
  ),
)));

// Parses: name, name: type, name = default, name: type = default
export const functionParameterParser = trace(
  "functionParameterParser",
  seqC(
    set("type", "functionParameter"),
    capture(many1WithJoin(varNameChar), "name"),
    optional(
      captureCaptures(
        seqC(
          optionalSpaces,
          char(":"),
          optionalSpaces,
          capture(variableTypeParser, "typeHint"),
        ),
      ),
    ),
    optional(
      captureCaptures(
        seqC(
          optionalSpaces,
          str("="),
          optionalSpaces,
          capture(or(agencyArrayParser, agencyObjectParser, literalParserNoVarName), "defaultValue"),
        ),
      ),
    ),
  ),
);

// Parses: ...name, ...name: type
export const variadicParameterParser: Parser<FunctionParameter> = trace(
  "variadicParameterParser",
  map(
    seqC(
      set("type", "functionParameter"),
      str("..."),
      capture(many1WithJoin(varNameChar), "name"),
      optional(
        captureCaptures(
          seqC(
            optionalSpaces,
            char(":"),
            optionalSpaces,
            capture(variableTypeParser, "typeHint"),
          ),
        ),
      ),
    ),
    (result) => ({ ...result, variadic: true }),
  ),
);

export const functionReturnTypeParser: Parser<VariableType> = trace(
  "functionReturnTypeParser",
  seqC(
    char(":"),
    optionalSpaces,
    captureCaptures(
      or(variableTypeParser, parseError("Invalid return type", fail("error"))),
    ),
  ),
);

const _baseFunctionParser: Parser<FunctionDefinition> = trace(
  "_baseFunctionParser",
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
        or(variadicParameterParser, functionParameterParser),
      ),
      "parameters",
    ),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    capture(optional(functionReturnTypeParser), "returnType"),
    captureCaptures(
      parseError(
        "Expected function body",
        optionalSpacesOrNewline,
        char("{"),
        optionalSpacesOrNewline,
        capture(or(docStringParser, succeed(undefined)), "docString"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSemicolon,
      ),
    ),
  ),
);

const exportKeywordParser: Parser<boolean> = or(
  map(seqC(str("export"), spaces), () => true),
  succeed(false),
);

const safeKeywordParser: Parser<boolean> = or(
  map(seqC(str("safe"), spaces), () => true),
  succeed(false),
);

const _functionParserInner: Parser<FunctionDefinition> = (input: string) => {
  const exportResult = exportKeywordParser(input);
  if (!exportResult.success) return exportResult;
  const isExported = exportResult.result;

  const safeResult = safeKeywordParser(exportResult.rest);
  if (!safeResult.success) return safeResult;
  const isSafe = safeResult.result;

  const baseResult = _baseFunctionParser(safeResult.rest);
  if (!baseResult.success) return baseResult;

  const result = { ...baseResult.result };
  if (isExported) result.exported = true;
  if (isSafe) result.safe = true;

  // Validate parameter ordering: required → optional (with defaults) → variadic
  const params = result.parameters;
  let seenOptional = false;
  for (let i = 0; i < params.length; i++) {
    if (params[i].variadic) {
      if (i !== params.length - 1) {
        return failure(
          `Variadic parameter '${params[i].name}' must be the last parameter`,
          input,
        );
      }
    } else if (params[i].defaultValue) {
      seenOptional = true;
    } else if (seenOptional) {
      return failure(
        `Required parameter '${params[i].name}' cannot follow optional parameter`,
        input,
      );
    }
  }

  return { ...baseResult, result };
};
export const functionParser: Parser<FunctionDefinition> = label("a function definition", withLoc(_functionParserInner));

const visibilityParser: Parser<Visibility> = or(
  str("public" as const),
  str("private" as const),
  succeed(undefined),
);

export const graphNodeParser: Parser<GraphNodeDefinition> = label("a node definition", withLoc(trace(
  "graphNodeParser",
  seqC(
    set("type", "graphNode"),
    capture(visibilityParser, "visibility"),
    optionalSpaces,
    str("node"),
    many1(space),
    capture(many1Till(char("(")), "nodeName"),
    char("("),
    optionalSpaces,
    capture(
      sepBy(
        comma,
        functionParameterParser,
      ),
      "parameters",
    ),
    optionalSpaces,
    char(")"),
    optionalSpaces,
    capture(optional(functionReturnTypeParser), "returnType"),
    captureCaptures(
      parseError(
        "expected node body",
        optionalSpacesOrNewline,
        char("{"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
        optionalSemicolon,
      ),
    ),
  ),
)));
