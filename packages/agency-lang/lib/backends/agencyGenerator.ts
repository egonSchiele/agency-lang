import {
  AgencyComment,
  AgencyMultiLineComment,
  AgencyNode,
  AgencyProgram,
  Assignment,
  DebuggerStatement,
  InterruptStatement,
  Literal,
  MultiLineStringLiteral,
  NewLine,
  ObjectProperty,
  ParallelBlock,
  Scope,
  ScopeType,
  SeqBlock,
  StringLiteral,
  TypeAlias,
  VariableType,
} from "../types.js";

import { AccessChainElement, ValueAccess } from "../types/access.js";
import { BlockArgument } from "../types/blockArgument.js";
import {
  AgencyArray,
  AgencyObject,
  AgencyObjectKV,
} from "../types/dataStructures.js";
import { FunctionCall, FunctionDefinition, FunctionParameter } from "../types/function.js";
import { GraphNodeDefinition, Visibility } from "../types/graphNode.js";
import { IfElse } from "../types/ifElse.js";
import {
  ImportNameType,
  ImportNodeStatement,
  ImportStatement,
} from "../types/importStatement.js";
import { MatchBlock } from "../types/matchBlock.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { GotoStatement } from "../types/gotoStatement.js";
import { ForLoop } from "../types/forLoop.js";
import { WhileLoop } from "../types/whileLoop.js";
import { variableTypeToString } from "./typescriptGenerator/typeToString.js";
import { AgencyConfig, BUILTIN_VARIABLES } from "@/config.js";
import { mergeDeep } from "@/utils.js";
import { MessageThread } from "@/types/messageThread.js";
import { Skill } from "@/types/skill.js";
import {
  BinOpArgument,
  BinOpExpression,
  Operator,
  PRECEDENCE,
} from "@/types/binop.js";
import { expressionToString } from "@/utils/node.js";
import { Keyword } from "@/types/keyword.js";
import { HandleBlock } from "@/types/handleBlock.js";
import { Tag } from "@/types/tag.js";
import { ClassDefinition, NewExpression } from "@/types/classDefinition.js";

export class AgencyGenerator {
  protected graphNodes: GraphNodeDefinition[] = [];
  protected generatedStatements: string[] = [];
  protected generatedTypeAliases: string[] = [];
  protected typeAliases: Record<string, VariableType> = {};
  protected functionsUsed: Set<string> = new Set();
  protected importNodes: ImportStatement[] = [];
  protected importedNodes: ImportNodeStatement[] = [];
  protected functionDefinitions: Record<string, FunctionDefinition> = {};
  protected currentScope: Scope[] = [{ type: "global" }];
  protected program: AgencyProgram | null = null;
  protected agencyConfig: AgencyConfig = {};

  private indentLevel: number = 0;
  private indentSize: number = 2;

  constructor(args: { config?: AgencyConfig } = {}) {
    this.agencyConfig = mergeDeep(this.configDefaults(), args.config || {});
    if (this.agencyConfig.verbose) {
      console.log("Generator config:", this.agencyConfig);
    }
  }

  configDefaults(): Partial<AgencyConfig> {
    return {};
  }

  generate(program: AgencyProgram): {
    output: string;
  } {
    this.program = program;
    // Pass 1: Collect all type aliases
    for (const node of program.nodes) {
      if (node.type === "typeAlias") {
        this.processTypeAlias(node);
      }
    }

    // Pass 2: Collect all node names
    for (const node of program.nodes) {
      if (node.type === "graphNode") {
        this.processGraphNodeName(node);
      }
    }

    // Pass 3: Collect all node imports
    for (const node of program.nodes) {
      if (node.type === "importNodeStatement") {
        this.importedNodes.push(node);
      }
    }

    // Pass 4: Generate code for tools
    for (const node of program.nodes) {
      if (node.type === "function") {
        this.generatedStatements.push(this.processTool(node));
        this.collectFunctionSignature(node);
      }
    }

    this.preprocessAST();

    // Types that should have a blank line before/after them at the top level
    const BLOCK_TYPES = new Set(["graphNode", "function", "typeAlias"]);
    const NO_SPACE_TYPES = new Set(["comment", "multiLineComment", "tag", "newLine"]);

    // Pass 5: Process all nodes and generate code
    const stmtPairs: { type: string; code: string }[] = [];
    for (const node of program.nodes) {
      const result = this.processNode(node);
      if (result !== "" || node.type === "newLine") {
        stmtPairs.push({ type: node.type, code: result });
      }
    }
    // Join top-level statements: blank line between block declarations,
    // single newline between simple statements
    const stmtLines: string[] = [];
    for (let i = 0; i < stmtPairs.length; i++) {
      if (i > 0) {
        const prev = stmtPairs[i - 1];
        const curr = stmtPairs[i];
        if (
          (BLOCK_TYPES.has(prev.type) && !NO_SPACE_TYPES.has(curr.type)) ||
          (BLOCK_TYPES.has(curr.type) && !NO_SPACE_TYPES.has(prev.type))
        ) {
          stmtLines.push(""); // blank line
        }
      }
      stmtLines.push(stmtPairs[i].code);
    }

    const output: string[] = [];

    this.addIfNonEmpty(this.sortAndRenderImports(), output);
    this.addIfNonEmpty(this.generatedTypeAliases.join("\n"), output);
    this.addIfNonEmpty(stmtLines.join("\n"), output);

    return {
      output: output.join("\n"),
    };
  }

  addIfNonEmpty(str: string, lines: string[]): void {
    if (str.trim() !== "") {
      lines.push(str);
    }
  }

  protected preprocessAST(): void { }

  protected generateBuiltins(): string {
    return "";
  }

  protected generateImports(): string {
    return "";
  }

  protected preprocess(): string {
    return "";
  }

  protected postprocess(): string {
    return "";
  }

  protected collectFunctionSignature(node: FunctionDefinition): void {
    this.functionDefinitions[node.functionName] = node;
  }

  protected processGraphNodeName(node: GraphNodeDefinition): void { }

  public processNode(node: AgencyNode): string {
    switch (node.type) {
      case "typeAlias":
        return this.processTypeAlias(node);
      case "assignment":
        return this.processAssignment(node);
      case "function":
        return this.processFunctionDefinition(node);
      case "functionCall":
        return this.processFunctionCall(node);
      case "valueAccess":
        return this.processValueAccess(node);
      case "comment":
        return this.processComment(node);
      case "multiLineComment":
        return this.processMultiLineComment(node);
      case "matchBlock":
        return this.processMatchBlock(node);
      case "number":
      case "multiLineString":
      case "string":
      case "variableName":
      case "boolean":
      case "null":
        return this.generateLiteral(node);
      case "returnStatement":
        return this.processReturnStatement(node);
      case "gotoStatement":
        return this.processGotoStatement(node);
      case "debuggerStatement":
        return this.processDebuggerStatement(node);
      case "agencyArray":
        return this.processAgencyArray(node);
      case "agencyObject":
        return this.processAgencyObject(node);
      case "graphNode":
        return this.processGraphNode(node);
      case "importStatement":
        this.importNodes.push(node);
        return "";
      case "importNodeStatement":
        this.importedNodes.push(node);
        return "";
      case "forLoop":
        return this.processForLoop(node);
      case "whileLoop":
        return this.processWhileLoop(node);
      case "ifElse":
        return this.processIfElse(node);
      case "newLine":
        return this.processNewLine(node);
      case "rawCode":
        return node.value;
      case "messageThread":
        return this.processMessageThread(node);
      case "handleBlock":
        return this.processHandleBlock(node);
      case "withModifier":
        return `${this.processNode(node.statement)} with ${node.handlerName}`;
      case "skill":
        return this.processSkill(node);
      case "binOpExpression":
        return this.processBinOpExpression(node);
      case "keyword":
        return this.processKeyword(node);
      case "tag":
        return this.formatTag(node);
      case "tryExpression":
        // remove extra indentation
        return `try ${this.processNode(node.call).trim()}`;
      case "classDefinition":
        return this.processClassDefinition(node);
      case "newExpression":
        return this.processNewExpression(node);
      case "schemaExpression":
        return `schema(${variableTypeToString(node.typeArg, this.typeAliases)})`;
      case "regex":
        return `re/${node.pattern}/${node.flags}`;
      case "interruptStatement":
        return this.processInterruptStatement(node);
      case "parallelBlock":
        return this.processParallelBlock(node);
      case "seqBlock":
        return this.processSeqBlock(node);
      default:
        throw new Error(`Unhandled Agency node type: ${(node as any).type}`);
    }
  }

  protected processInterruptStatement(node: InterruptStatement): string {
    const args = this.renderArgList(node.arguments);
    if (node.kind === "unknown") {
      return this.indentStr(`interrupt${args}`);
    }
    return this.indentStr(`interrupt ${node.kind}${args}`);
  }

  protected needsParensLeft(child: BinOpArgument, parentOp: Operator): boolean {
    if (child.type !== "binOpExpression") return false;
    // For right-associative ops like **, (2 ** 3) ** 4 needs parens on the left
    if (parentOp === "**") return PRECEDENCE[child.operator] <= PRECEDENCE[parentOp];
    return PRECEDENCE[child.operator] < PRECEDENCE[parentOp];
  }

  protected needsParensRight(
    child: BinOpArgument,
    parentOp: Operator,
  ): boolean {
    if (child.type !== "binOpExpression") return false;
    return PRECEDENCE[child.operator] <= PRECEDENCE[parentOp];
  }

  protected startScope(scope: Scope): void {
    this.currentScope.push(scope);
  }

  protected endScope(): void {
    this.currentScope.pop();
  }

  protected getCurrentScope(): Scope {
    return this.currentScope[this.currentScope.length - 1];
  }

  protected isAgencyFunction(
    functionName: string,
    context: "valueAccess" | "functionArg" | "topLevelStatement",
  ): boolean {
    if (context === "valueAccess") {
      return false;
    }
    return !!this.functionDefinitions[functionName];
  }

  // Indent helpers

  private indent(level = this.indentLevel): string {
    return " ".repeat(level * this.indentSize);
  }

  private increaseIndent(): void {
    this.indentLevel++;
  }

  private decreaseIndent(): void {
    this.indentLevel--;
  }

  private indentStr(str: string): string {
    return `${this.indent()}${str}`;
  }

  // Wrapping helpers

  private wrapList(
    items: string[],
    prefix: string,
    open: string,
    close: string,
    suffix: string = "",
  ): string {
    const inline = `${prefix}${open}${items.join(", ")}${close}${suffix}`;
    if (this.indentStr(inline).length <= 80) return inline;
    this.increaseIndent();
    const lines = items.map((item) => this.indentStr(`${item},`));
    this.decreaseIndent();
    return `${prefix}${open}\n${lines.join("\n")}\n${this.indent()}${close}${suffix}`;
  }

  private renderParams(parameters: FunctionParameter[]): string[] {
    return parameters.map((p) => {
      const prefix = p.variadic ? "..." : "";
      const defaultSuffix = p.defaultValue
        ? ` = ${this.processNode(p.defaultValue).trim()}`
        : "";
      if (p.typeHint) {
        const typeStr = variableTypeToString(p.typeHint, this.typeAliases);
        const bang = p.validated ? "!" : "";
        return `${prefix}${p.name}: ${typeStr}${bang}${defaultSuffix}`;
      } else {
        return `${prefix}${p.name}${defaultSuffix}`;
      }
    });
  }

  // Type system methods

  private stringifyProp(prop: ObjectProperty): string {
    const isUnionWithUndefined =
      prop.value.type === "unionType" &&
      prop.value.types.some(
        (t) => t.type === "primitiveType" && t.value === "undefined",
      );

    if (isUnionWithUndefined) {
      const nonUndefinedTypes = (prop.value as any).types.filter(
        (t: VariableType) =>
          !(t.type === "primitiveType" && t.value === "undefined"),
      );
      const unionWithoutUndefined: VariableType =
        nonUndefinedTypes.length === 1
          ? nonUndefinedTypes[0]
          : { type: "unionType", types: nonUndefinedTypes };
      let str = `${prop.key}?: ${variableTypeToString(unionWithoutUndefined, this.typeAliases)}`;
      if (prop.description) {
        str += ` # ${prop.description}`;
      }
      return str;
    }

    let str = `${prop.key}: ${variableTypeToString(prop.value, this.typeAliases)}`;
    if (prop.description) {
      str += ` # ${prop.description}`;
    }
    return str;
  }

  protected aliasedTypeToString(aliasedType: VariableType): string {
    if (aliasedType.type === "objectType") {
      this.increaseIndent();
      let result =
        "{\n" +
        aliasedType.properties
          .map((prop) => {
            return this.indentStr(this.stringifyProp(prop));
          })
          .join(";\n") +
        "\n";

      this.decreaseIndent();
      result += this.indentStr("}");
      return result;
    }
    return variableTypeToString(aliasedType, this.typeAliases);
  }

  protected processTypeAlias(node: TypeAlias): string {
    this.typeAliases[node.aliasName] = node.aliasedType;
    const aliasedTypeStr = this.aliasedTypeToString(node.aliasedType);
    const exportPrefix = node.exported ? "export " : "";
    return (
      this.formatDocComment(node) +
      this.indentStr(
        `${exportPrefix}type ${node.aliasName} = ${aliasedTypeStr}`,
      )
    );
  }

  // Assignment and literals

  protected processAssignment(node: Assignment): string {
    const tags = this.formatAttachedTags(node);
    const chainStr =
      node.accessChain
        ?.map((ce) => this.processAccessChainElement(ce))
        .join("") ?? "";
    const bangSuffix = node.validated ? "!" : "";
    const varName = node.typeHint
      ? `${node.variableName}${chainStr}: ${variableTypeToString(node.typeHint, this.typeAliases)}${bangSuffix}`
      : `${node.variableName}${chainStr}`;
    const staticPrefix = node.static ? "static " : "";
    const declPrefix = node.declKind ? `${node.declKind} ` : "";
    let valueCode =
      node.value.type === "binOpExpression"
        ? this.processBinOpExpression(node.value, true).trim()
        : this.processNode(node.value).trim();
    return (
      tags +
      this.indentStr(`${staticPrefix}${declPrefix}${varName} = ${valueCode}`)
    );
  }

  protected generateLiteral(literal: Literal): string {
    switch (literal.type) {
      case "number":
        return literal.value;
      case "string":
        return this.generateStringLiteral(literal);
      case "variableName":
        return literal.value;
      case "multiLineString":
        return this.generateMultiLineStringLiteral(literal);
      case "boolean":
        return literal.value ? "true" : "false";
      case "null":
        return "null";
      default:
        return "";
    }
  }

  private generateStringLiteral(node: StringLiteral): string {
    let result = '"';
    for (const segment of node.segments) {
      if (segment.type === "text") {
        result += segment.value;
      } else if (segment.type === "interpolation") {
        result += `\${${expressionToString(segment.expression)}}`;
      }
    }
    result += '"';
    return result;
  }

  private generateMultiLineStringLiteral(node: MultiLineStringLiteral): string {
    let result = '"""';
    for (const segment of node.segments) {
      if (segment.type === "text") {
        result += segment.value;
      } else if (segment.type === "interpolation") {
        result += `\${${expressionToString(segment.expression)}}`;
      }
    }
    result += '"""';
    return result
      .split("\n")
      .map((line) => this.indentStr(line))
      .join("\n");
  }

  // Function methods

  protected processFunctionDefinition(node: FunctionDefinition): string {
    const tags = this.formatAttachedTags(node);
    const { functionName, body, parameters } = node;

    const returnTypeBang = node.returnTypeValidated ? "!" : "";
    const returnTypeStr = node.returnType
      ? ": " + variableTypeToString(node.returnType, this.typeAliases) + returnTypeBang
      : "";

    const prefixes: string[] = [];
    if (node.exported) prefixes.push("export");
    if (node.safe) prefixes.push("safe");
    node.callback ? prefixes.push("callback") : prefixes.push("def");

    const prefix = `${prefixes.join(" ")} ${functionName}`;
    const renderedParams = this.renderParams(parameters);
    const signature = this.wrapList(renderedParams, prefix, "(", ")", `${returnTypeStr} {`);

    let result = this.indentStr(`${signature}\n`);

    this.increaseIndent();

    if (node.docString) {
      const lines = node.docString.value.split("\n").map(l => l.trim());
      const docLines = [`"""`, ...lines, `"""`];
      const docStr = docLines.map((line) => this.indentStr(line)).join("\n");
      result += `${docStr}\n`;
    }

    const bodyStr = this.renderBody(body);
    if (bodyStr.trim() !== "") {
      result += bodyStr;
    }

    this.decreaseIndent();

    result += this.indentStr(`}`);

    return this.formatDocComment(node) + tags + result;
  }

  protected processFunctionCall(node: FunctionCall): string {
    const tags = this.formatAttachedTags(node);
    const expr = this.generateFunctionCallExpression(node, "topLevelStatement");
    return tags + this.indentStr(`${expr}`);
  }

  // Render each argument to a string array
  protected renderArgs(args: FunctionCall["arguments"], block?: BlockArgument): string[] {
    const rendered = args.map((arg) => {
      if (arg.type === "namedArgument") {
        return `${arg.name}: ${this.processNode(arg.value).trim()}`;
      }
      if (arg.type === "splat") {
        return `...${this.processNode(arg.value).trim()}`;
      }
      return this.processNode(arg).trim();
    });
    if (block?.inline) {
      const returnStmt = block.body[0] as ReturnStatement;
      const exprStr = this.processNode(returnStmt.value!).trim();
      let params = "";
      if (block.params.length === 1) {
        params = block.params[0].name;
      } else if (block.params.length > 1) {
        params = `(${block.params.map((p) => p.name).join(", ")})`;
      }
      rendered.push(`\\${params} -> ${exprStr}`);
    }
    return rendered;
  }

  // Format args as inline parenthesized list (no wrapping — used by access chain callers)
  protected renderArgList(args: FunctionCall["arguments"], block?: BlockArgument): string {
    const rendered = this.renderArgs(args, block);
    return `(${rendered.join(", ")})`;
  }

  protected generateFunctionCallExpression(
    node: FunctionCall,
    context: "valueAccess" | "functionArg" | "topLevelStatement",
  ): string {
    let asyncPrefix = "";
    if (node.async === true) {
      asyncPrefix = "async ";
    } else if (node.async === false) {
      asyncPrefix = "await ";
    }

    const block = node.block;
    const inlineBlock = block?.inline ? block : undefined;
    const rendered = this.renderArgs(node.arguments, inlineBlock);
    let result = this.wrapList(rendered, `${asyncPrefix}${node.functionName}`, "(", ")", "");

    if (block && !block.inline) {
      let asClause = "as ";
      if (block.params.length === 1) {
        asClause = `as ${block.params[0].name} `;
      } else if (block.params.length > 1) {
        asClause = `as (${block.params.map((p) => p.name).join(", ")}) `;
      }

      this.increaseIndent();
      const bodyStr = this.renderBody(block.body);
      this.decreaseIndent();

      result += ` ${asClause}{\n${bodyStr}${this.indentStr("}")}`;
    }

    return result;
  }

  // Data structures

  protected processAgencyArray(node: AgencyArray): string {
    const items = node.items.map((item) => {
      if (item.type === "splat") {
        return `...${this.processNode(item.value).trim()}`;
      }
      return this.processNode(item).trim();
    });
    return this.wrapList(items, "", "[", "]");
  }

  protected processAgencyObject(node: AgencyObject): string {
    this.increaseIndent();

    const entries = node.entries.map((entry) => {
      if ("type" in entry && entry.type === "splat") {
        return this.indentStr(`...${this.processNode(entry.value).trim()}`);
      }
      const kv = entry as AgencyObjectKV;
      const valueCode = this.processNode(kv.value).trim();
      return this.indentStr(`${this.addQuotesToKey(kv.key)}: ${valueCode}`);
    });
    this.decreaseIndent();
    if (entries.length === 0) {
      return `{}`;
    }
    let entriesStr = "\n" + entries.join(",\n") + "\n";

    return `{${entriesStr}` + this.indentStr("}");
  }

  private addQuotesToKey(key: string): string {
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
      return key;
    }
    return `"${key}"`;
  }

  // Access expressions

  protected processValueAccess(node: ValueAccess): string {
    let code = this.processNode(node.base).trim();
    for (const element of node.chain) {
      code += this.processAccessChainElement(element);
    }
    return this.indentStr(this.asyncAwaitPrefix(code, node.async));
  }

  protected asyncAwaitPrefix(code: string, async?: boolean): string {
    if (async === true) {
      return `async ${code}`;
    } else if (async === false) {
      return `await ${code}`;
    }
    return code;
  }

  // Control flow

  protected processMatchBlock(node: MatchBlock): string {
    const exprCode = this.processNode(node.expression).trim();
    let result = this.indentStr(`match(${exprCode}) {\n`);

    this.increaseIndent();

    for (const caseNode of node.cases) {
      if (caseNode.type === "comment") {
        result += this.processComment(caseNode);
        continue;
      }

      if (caseNode.type === "newLine") {
        result += this.processNewLine(caseNode);
        continue
      }

      const pattern =
        caseNode.caseValue === "_"
          ? "_"
          : this.processNode(caseNode.caseValue).trim();

      const bodyCode = this.processNode(caseNode.body).trim();

      result += this.indentStr(`${pattern} => ${bodyCode}\n`);
    }

    this.decreaseIndent();

    result += this.indentStr(`}`);

    return result;
  }

  protected processForLoop(node: ForLoop): string {
    const iterableCode = this.processNode(node.iterable).trim();
    const vars = node.indexVar
      ? `${node.itemVar}, ${node.indexVar}`
      : node.itemVar;
    let result = this.indentStr(`for (${vars} in ${iterableCode}) {\n`);

    this.increaseIndent();
    result += this.renderBody(node.body);
    this.decreaseIndent();

    result += this.indentStr(`}`);

    return result;
  }

  protected processWhileLoop(node: WhileLoop): string {
    const conditionCode = this.processNode(node.condition).trim();
    let result = this.indentStr(`while (${conditionCode}) {\n`);

    this.increaseIndent();
    result += this.renderBody(node.body);
    this.decreaseIndent();

    result += this.indentStr(`}`);

    return result;
  }

  protected processIfElse(node: IfElse): string {
    const conditionCode = this.processNode(node.condition).trim();
    const lines = [];
    lines.push(this.indentStr(`if (${conditionCode}) {\n`));

    this.increaseIndent();
    lines.push(this.renderBody(node.thenBody));
    this.decreaseIndent();

    if (node.elseBody && node.elseBody.length > 0) {
      if (node.elseBody.length === 1 && node.elseBody[0].type === "ifElse") {
        const elseIfCode = this.processIfElse(node.elseBody[0] as IfElse);
        lines.push(this.indentStr(`} else ${elseIfCode.trimStart()}`));
        return lines.join("");
      } else {
        lines.push(this.indentStr(`} else {\n`));
        this.increaseIndent();
        lines.push(this.renderBody(node.elseBody));
        this.decreaseIndent();
      }
    }

    lines.push(this.indentStr(`}`));
    return lines.join("");
  }

  protected processReturnStatement(node: ReturnStatement): string {
    if (!node.value) return this.indentStr("return");
    const valueCode = this.processNode(node.value).trim();
    return this.indentStr(`return ${valueCode}`);
  }

  protected processGotoStatement(node: GotoStatement): string {
    const callCode = this.processNode(node.nodeCall).trim();
    return this.indentStr(`goto ${callCode}`);
  }

  protected processDebuggerStatement(node: DebuggerStatement): string {
    return this.indentStr(
      node.label ? `debugger(${JSON.stringify(node.label)})` : "debugger()",
    );
  }

  // Utility methods

  protected processComment(node: AgencyComment): string {
    return this.indentStr(`//${node.content}`);
  }

  protected processMultiLineComment(node: AgencyMultiLineComment): string {
    if (node.isDoc) {
      return this.indentStr(`/**${node.content}*/`);
    }
    return this.indentStr(`/*${node.content}*/`);
  }

  protected formatDocComment(node: { docComment?: AgencyMultiLineComment }): string {
    if (!node.docComment) return "";
    return this.processMultiLineComment(node.docComment) + "\n";
  }

  protected processImportStatement(node: ImportStatement): string {
    const modulePath = node.modulePath.startsWith("std::")
      ? node.modulePath.replace(/\.agency$/, "")
      : node.modulePath;
    const suffix = ` from "${modulePath}"`;

    // For single named import, use wrapList
    if (node.importedNames.length === 1 && node.importedNames[0].type === "namedImport") {
      const namedImport = node.importedNames[0];
      const names = namedImport.importedNames.map((name) => {
        const alias = namedImport.aliases[name];
        const base = alias ? `${name} as ${alias}` : name;
        return namedImport.safeNames?.includes(name) ? `safe ${base}` : base;
      });
      return this.indentStr(this.wrapList(names, "import ", "{ ", " }", suffix));
    }

    // Default/namespace/mixed imports — always inline
    const importedNames = node.importedNames.map((name) =>
      this.processImportNameType(name),
    );
    return this.indentStr(`import ${importedNames.join(", ")}${suffix}`);
  }

  protected processImportNameType(node: ImportNameType): string {
    switch (node.type) {
      case "namedImport": {
        const names = node.importedNames.map((name) => {
          const alias = node.aliases[name];
          const base = alias ? `${name} as ${alias}` : name;
          return node.safeNames?.includes(name) ? `safe ${base}` : base;
        });
        return `{ ${names.join(", ")} }`;
      }
      case "namespaceImport":
        return `* as ${node.importedNames}`;
      case "defaultImport":
        return `${node.importedNames}`;
    }
  }

  protected processImportNodeStatement(node: ImportNodeStatement): string {
    return `import node { ${node.importedNodes.join(", ")} } from "${node.agencyFile}"`;
  }

  private sortAndRenderImports(): string {
    type ImportEntry = { modulePath: string; render: () => string };

    const stdlib: ImportEntry[] = [];
    const packages: ImportEntry[] = [];
    const relative: ImportEntry[] = [];

    for (const node of this.importNodes) {
      const entry: ImportEntry = { modulePath: node.modulePath, render: () => this.processImportStatement(node) };
      if (node.modulePath.startsWith("std::")) {
        stdlib.push(entry);
      } else if (node.modulePath.startsWith("pkg::")) {
        packages.push(entry);
      } else {
        relative.push(entry);
      }
    }

    for (const node of this.importedNodes) {
      relative.push({ modulePath: node.agencyFile, render: () => this.processImportNodeStatement(node) });
    }

    const sort = (arr: ImportEntry[]) =>
      arr.sort((a, b) => a.modulePath.localeCompare(b.modulePath));
    sort(stdlib);
    sort(packages);
    sort(relative);

    const groups = [stdlib, packages, relative]
      .filter((g) => g.length > 0)
      .map((g) => g.map((e) => e.render()).join("\n"));
    return groups.join("\n\n");
  }


  protected visibilityToString(vis: Visibility): string {
    switch (vis) {
      case "public":
        return "public ";
      case "private":
        return "private ";
      case undefined:
        return "";
    }
  }

  protected processGraphNode(node: GraphNodeDefinition): string {
    const tags = this.formatAttachedTags(node);
    const { nodeName, body, parameters } = node;
    const returnTypeBang = node.returnTypeValidated ? "!" : "";
    const returnTypeStr = node.returnType
      ? ": " + variableTypeToString(node.returnType, this.typeAliases) + returnTypeBang
      : "";
    const visibilityStr = this.visibilityToString(node.visibility);
    const prefix = `${visibilityStr}node ${nodeName}`;
    const renderedParams = this.renderParams(parameters);
    const signature = this.wrapList(renderedParams, prefix, "(", ")", `${returnTypeStr} {`);

    let result = this.indentStr(`${signature}\n`);

    this.increaseIndent();

    if (node.docString) {
      const lines = node.docString.value.split("\n").map(l => l.trim());
      const docLines = [`"""`, ...lines, `"""`];
      const docStr = docLines.map((line) => this.indentStr(line)).join("\n");
      result += `${docStr}\n`;
    }

    result += this.renderBody(body);

    this.decreaseIndent();

    result += this.indentStr(`}`);
    return this.formatDocComment(node) + tags + result;
  }

  protected processClassDefinition(node: ClassDefinition): string {
    const extendsStr = node.parentClass ? ` extends ${node.parentClass}` : "";
    let result = this.indentStr(`class ${node.className}${extendsStr} {\n`);
    this.increaseIndent();

    // Fields
    for (const field of node.fields) {
      result += this.indentStr(
        `${field.name}: ${variableTypeToString(field.typeHint, this.typeAliases)}\n`,
      );
    }

    // Methods (constructor is auto-generated, not formatted)
    for (const method of node.methods) {
      const params = method.parameters
        .map((p) => {
          if (p.typeHint) {
            const bang = p.validated ? "!" : "";
            return `${p.name}: ${variableTypeToString(p.typeHint, this.typeAliases)}${bang}`;
          }
          return p.name;
        })
        .join(", ");
      const returnTypeStr = `: ${variableTypeToString(method.returnType, this.typeAliases)}`;
      result +=
        "\n" + this.indentStr(`${method.name}(${params})${returnTypeStr} {\n`);
      this.increaseIndent();
      result += this.renderBody(method.body);
      this.decreaseIndent();
      result += this.indentStr(`}\n`);
    }

    this.decreaseIndent();
    result += this.indentStr(`}`);
    return result;
  }

  protected processNewExpression(node: NewExpression): string {
    const args = node.arguments.map((a) => this.processNode(a)).join(", ");
    return `new ${node.className}(${args})`;
  }

  protected processTool(node: FunctionDefinition): string {
    return "";
  }


  protected processNewLine(_node: NewLine): string {
    return "";
  }

  protected renderBody(body: AgencyNode[]): string {
    const lines: string[] = [];
    for (const stmt of body) {
      const line = this.processNode(stmt);
      if (line !== "" || stmt.type === "newLine") {
        lines.push(line);
      }
    }
    return lines.join("\n").trimEnd() + "\n";
  }

  protected processMessageThread(node: MessageThread): string {
    this.increaseIndent();
    const bodyCodeStr = this.renderBody(node.body);
    this.decreaseIndent();
    const threadType = node.threadType;
    return this.indentStr(
      `${threadType} {\n${bodyCodeStr}${this.indentStr("}")}`,
    );
  }

  protected processParallelBlock(node: ParallelBlock): string {
    this.increaseIndent();
    const bodyCodeStr = this.renderBody(node.body);
    this.decreaseIndent();
    return this.indentStr(
      `parallel {\n${bodyCodeStr}${this.indentStr("}")}`,
    );
  }

  protected processSeqBlock(node: SeqBlock): string {
    this.increaseIndent();
    const bodyCodeStr = this.renderBody(node.body);
    this.decreaseIndent();
    return this.indentStr(
      `seq {\n${bodyCodeStr}${this.indentStr("}")}`,
    );
  }

  protected processHandleBlock(node: HandleBlock): string {
    this.increaseIndent();
    const bodyCodeStr = this.renderBody(node.body);
    this.decreaseIndent();

    let handlerStr: string;
    if (node.handler.kind === "inline") {
      const handlerBang = node.handler.param.validated ? "!" : "";
      const paramStr = node.handler.param.typeHint
        ? `${node.handler.param.name}: ${variableTypeToString(node.handler.param.typeHint, this.typeAliases)}${handlerBang}`
        : node.handler.param.name;
      this.increaseIndent();
      const handlerBodyStr = this.renderBody(node.handler.body);
      this.decreaseIndent();
      handlerStr = `(${paramStr}) {\n${handlerBodyStr}${this.indentStr("}")}`;
    } else {
      handlerStr = node.handler.functionName;
    }

    return this.indentStr(
      `handle {\n${bodyCodeStr}${this.indentStr("}")} with ${handlerStr}`,
    );
  }

  protected processSkill(node: Skill): string {
    return this.indentStr(`skill "${node.filepath}"`);
  }

  protected processBinOpExpression(
    node: BinOpExpression,
    assigned: boolean = false,
  ): string {
    const op = node.operator;

    // Unary prefix operators: !x, typeof x, void x
    if (op === "!" || op === "typeof" || op === "void") {
      const operand = this.processNode(node.right).trim();
      const sep = op === "!" ? "" : " ";
      const result = `${op}${sep}${operand}`;
      return assigned ? result : this.indentStr(result);
    }

    // Postfix operators: x++, x--
    if (op === "++" || op === "--") {
      const operand = this.processNode(node.left).trim();
      const result = `${operand}${op}`;
      return assigned ? result : this.indentStr(result);
    }

    const leftStr = this.processNode(node.left).trim();
    const rightStr = this.processNode(node.right).trim();
    const left = this.needsParensLeft(node.left, op) ? `(${leftStr})` : leftStr;
    const right = this.needsParensRight(node.right, op) ? `(${rightStr})` : rightStr;
    const inline = `${left} ${op} ${right}`;

    // For pipe chains, break into multiple lines if the inline version is too long
    if (op === "|>" && inline.length > 80) {
      const segments = this.flattenPipeChain(node);
      const multiline = segments.join(`\n${this.indent()}|> `);
      return assigned ? multiline : this.indentStr(multiline);
    }

    return assigned ? inline : this.indentStr(inline);
  }

  private flattenPipeChain(node: BinOpExpression): string[] {
    const segments: string[] = [];
    let current: BinOpArgument = node;
    while (current.type === "binOpExpression" && current.operator === "|>") {
      segments.unshift(this.processNode(current.right).trim());
      current = current.left;
    }
    segments.unshift(this.processNode(current).trim());
    return segments;
  }

  protected processAccessChainElement(node: AccessChainElement): string {
    const dot = node.optional ? "?." : ".";
    switch (node.kind) {
      case "property":
        return `${dot}${node.name}`;
      case "index": {
        const inner = this.processNode(node.index).trim();
        return node.optional ? `?.[${inner}]` : `[${inner}]`;
      }
      case "slice": {
        const start = node.start ? this.processNode(node.start).trim() : "";
        const end = node.end ? this.processNode(node.end).trim() : "";
        const inner = `${start}:${end}`;
        return node.optional ? `?.[${inner}]` : `[${inner}]`;
      }
      case "methodCall":
        return `${dot}${this.generateFunctionCallExpression(node.functionCall, "valueAccess")}`;
      case "call":
        return `${node.optional ? "?." : ""}${this.renderArgList(node.arguments, node.block)}`;
      default:
        throw new Error(
          `Unknown access chain element kind: ${(node as any).kind}`,
        );
    }
  }

  protected formatTag(tag: Tag): string {
    if (tag.arguments.length === 0) {
      return this.indentStr(`@${tag.name}`);
    }
    const args = tag.arguments.map((arg: string) => {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(arg)) {
        return arg;
      }
      return JSON.stringify(arg);
    });
    return this.indentStr(`@${tag.name}(${args.join(", ")})`);
  }

  protected formatAttachedTags(node: { tags?: Tag[] }): string {
    if (!node.tags?.length) return "";
    return node.tags.map((tag: Tag) => this.formatTag(tag)).join("\n") + "\n";
  }

  protected processKeyword(node: Keyword): string {
    return this.indentStr(`${node.value}`);
  }
}

export function generateAgency(program: AgencyProgram): string {
  const generator = new AgencyGenerator();
  return generator.generate(program).output
    .trim()
    .replace(/[ \t]+$/gm, "")
    + "\n";
}
