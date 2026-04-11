import { SpecialVar } from "@/types/specialVar.js";
import {
  AgencyComment,
  AgencyMultiLineComment,
  AgencyNode,
  AgencyProgram,
  Assignment,
  DebuggerStatement,
  Literal,
  MultiLineStringLiteral,
  NewLine,
  ObjectProperty,
  Scope,
  ScopeType,
  StringLiteral,
  TypeAlias,
  VariableType,
} from "../types.js";

import { AccessChainElement, ValueAccess } from "../types/access.js";
import { AgencyArray, AgencyObject, AgencyObjectKV } from "../types/dataStructures.js";
import { FunctionCall, FunctionDefinition } from "../types/function.js";
import { GraphNodeDefinition, Visibility } from "../types/graphNode.js";
import { IfElse } from "../types/ifElse.js";
import {
  ImportNameType,
  ImportNodeStatement,
  ImportStatement,
  ImportToolStatement,
} from "../types/importStatement.js";
import { MatchBlock } from "../types/matchBlock.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { UsesTool } from "../types/tools.js";
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

export class AgencyGenerator {
  protected graphNodes: GraphNodeDefinition[] = [];
  protected generatedStatements: string[] = [];
  protected generatedTypeAliases: string[] = [];
  protected typeAliases: Record<string, VariableType> = {};
  protected functionsUsed: Set<string> = new Set();
  protected importStatements: string[] = [];
  protected importedNodes: ImportNodeStatement[] = [];
  protected importedTools: ImportToolStatement[] = [];
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

    // Pass 3: Collect all node and tool imports
    for (const node of program.nodes) {
      if (node.type === "importNodeStatement") {
        this.importedNodes.push(node);
      } else if (node.type === "importToolStatement") {
        this.importedTools.push(node);
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
    const BLOCK_TYPES = new Set([
      "graphNode", "function", "typeAlias",
    ]);
    const NO_SPACE_TYPES = new Set([
      "comment", "multiLineComment"
    ]);

    // Pass 5: Process all nodes and generate code
    const stmtPairs: { type: string; code: string }[] = [];
    for (const node of program.nodes) {
      const result = this.processNode(node);
      if (result !== "") {
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
        if (BLOCK_TYPES.has(prev.type) || (BLOCK_TYPES.has(curr.type) && !NO_SPACE_TYPES.has(prev.type))) {
          stmtLines.push(""); // blank line
        }
      }
      stmtLines.push(stmtPairs[i].code);
    }

    const output: string[] = [];

    this.addIfNonEmpty(this.preprocess(), output);
    this.addIfNonEmpty(this.importStatements.join("\n"), output);
    this.addIfNonEmpty(this.generateImports(), output);
    this.addIfNonEmpty(this.generateBuiltins(), output);
    output.push(...this.generatedTypeAliases);
    output.push(stmtLines.join("\n"));
    this.addIfNonEmpty(this.postprocess(), output);
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
      case "debuggerStatement":
        return this.processDebuggerStatement(node);
      case "agencyArray":
        return this.processAgencyArray(node);
      case "agencyObject":
        return this.processAgencyObject(node);
      case "graphNode":
        return this.processGraphNode(node);
      case "usesTool":
        return this.processUsesTool(node);
      case "importStatement":
        this.importStatements.push(this.processImportStatement(node));
        return "";
      case "importNodeStatement":
        this.importStatements.push(this.processImportNodeStatement(node));
        return "";
      case "importToolStatement":
        this.importStatements.push(this.processImportToolStatement(node));
        return "";
      case "forLoop":
        return this.processForLoop(node);
      case "whileLoop":
        return this.processWhileLoop(node);
      case "ifElse":
        return this.processIfElse(node);
      case "specialVar":
        return this.processSpecialVar(node);
      case "newLine":
        return this.processNewLine(node);
      case "rawCode":
        return node.value;
      case "messageThread":
        return this.processMessageThread(node);
      case "handleBlock":
        return this.processHandleBlock(node);
      case "skill":
        return this.processSkill(node);
      case "binOpExpression":
        return this.processBinOpExpression(node);
      case "keyword":
        return this.processKeyword(node);
      case "placeholder":
        return "?";
      default:
        throw new Error(`Unhandled Agency node type: ${(node as any).type}`);
    }
  }

  protected needsParensLeft(child: BinOpArgument, parentOp: Operator): boolean {
    if (child.type !== "binOpExpression") return false;
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


  protected isImportedTool(functionName: string): boolean {
    return this.importedTools
      .flatMap((node) => node.importedTools)
      .flatMap((n) => n.importedNames)
      .includes(functionName);
  }

  protected isAgencyFunction(
    functionName: string,
    context: "valueAccess" | "functionArg" | "topLevelStatement",
  ): boolean {
    if (context === "valueAccess") {
      return false;
    }
    return (
      !!this.functionDefinitions[functionName] ||
      this.isImportedTool(functionName)
    );
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
    return this.indentStr(`type ${node.aliasName} = ${aliasedTypeStr}`);
  }

  // Assignment and literals

  protected processAssignment(node: Assignment): string {
    const chainStr =
      node.accessChain
        ?.map((ce) => this.processAccessChainElement(ce))
        .join("") ?? "";
    const varName = node.typeHint
      ? `${node.variableName}${chainStr}: ${variableTypeToString(node.typeHint, this.typeAliases)}`
      : `${node.variableName}${chainStr}`;
    const sharedPrefix = node.shared ? "shared " : "";
    const declPrefix = node.declKind ? `${node.declKind} ` : "";
    let valueCode = this.processNode(node.value).trim();
    return this.indentStr(`${sharedPrefix}${declPrefix}${varName} = ${valueCode}`);
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
    const { functionName, body, parameters } = node;

    const params = parameters
      .map((p) => {
        const prefix = p.variadic ? "..." : "";
        const defaultSuffix = p.defaultValue
          ? ` = ${this.processNode(p.defaultValue).trim()}`
          : "";
        if (p.typeHint) {
          const typeStr = variableTypeToString(p.typeHint, this.typeAliases);
          return `${prefix}${p.name}: ${typeStr}${defaultSuffix}`;
        } else {
          return `${prefix}${p.name}${defaultSuffix}`;
        }
      })
      .join(", ");

    const returnTypeStr = node.returnType
      ? ": " + variableTypeToString(node.returnType, this.typeAliases)
      : "";

    let safePrefix = node.safe ? "safe " : "";

    const exportPrefix = node.exported ? "export " : "";

    let result = this.indentStr(
      `${exportPrefix}${safePrefix}def ${functionName}(${params})${returnTypeStr} {\n`,
    );

    this.increaseIndent();

    if (node.docString) {
      const docLines = [`"""`, ...node.docString.value.split("\n"), `"""`];
      const docStr = docLines.map((line) => this.indentStr(line)).join("\n");
      result += `${docStr}\n`;
    }

    const lines: string[] = [];
    for (const stmt of body) {
      lines.push(this.processNode(stmt));
    }
    const bodyCode = lines.filter(s => s !== "").join("\n").trimEnd() + "\n";
    result += bodyCode;

    this.decreaseIndent();

    result += this.indentStr(`}`);

    return result;
  }

  protected processFunctionCall(node: FunctionCall): string {
    const expr = this.generateFunctionCallExpression(node, "topLevelStatement");
    return this.indentStr(`${expr}`);
  }

  protected generateFunctionCallExpression(
    node: FunctionCall,
    context: "valueAccess" | "functionArg" | "topLevelStatement",
  ): string {
    const args = node.arguments.map((arg) => {
      if (arg.type === "namedArgument") {
        return `${arg.name}: ${this.processNode(arg.value).trim()}`;
      }
      if (arg.type === "splat") {
        return `...${this.processNode(arg.value).trim()}`;
      }
      return this.processNode(arg).trim();
    });
    let asyncPrefix = "";
    if (node.async === true) {
      asyncPrefix = "async ";
    } else if (node.async === false) {
      asyncPrefix = "await ";
    }

    let result = `${asyncPrefix}${node.functionName}(${args.join(", ")})`;

    if (node.block) {
      const block = node.block;
      let asClause = "as ";
      if (block.params.length === 1) {
        asClause = `as ${block.params[0].name} `;
      } else if (block.params.length > 1) {
        asClause = `as (${block.params.map((p) => p.name).join(", ")}) `;
      }

      this.increaseIndent();
      const bodyLines: string[] = [];
      for (const stmt of block.body) {
        bodyLines.push(this.processNode(stmt));
      }
      this.decreaseIndent();
      const bodyStr = bodyLines.filter((s) => s !== "").join("\n").trimEnd() + "\n";

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
    const inline = `[${items.join(", ")}]`;
    if (inline.length <= 80) return inline;
    this.increaseIndent();
    const indented = items.map((item) => this.indentStr(item));
    this.decreaseIndent();
    return `[\n${indented.join(",\n")}\n${this.indentStr("]")}`;
  }

  protected processAgencyObject(node: AgencyObject): string {
    this.increaseIndent();

    const entries = node.entries.map((entry) => {
      if ("type" in entry && entry.type === "splat") {
        return this.indentStr(`...${this.processNode(entry.value).trim()}`);
      }
      const kv = entry as AgencyObjectKV;
      const valueCode = this.processNode(kv.value).trim();
      return this.indentStr(`${kv.key}: ${valueCode}`);
    });
    this.decreaseIndent();
    if (entries.length === 0) {
      return `{}`;
    }
    let entriesStr = "\n" + entries.join(",\n") + "\n";

    return `{ ${entriesStr}` + this.indentStr("}");
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
    const lines: string[] = [];
    for (const stmt of node.body) {
      lines.push(this.processNode(stmt));
    }
    result += lines.filter(s => s !== "").join("\n").trimEnd() + "\n";
    this.decreaseIndent();

    result += this.indentStr(`}`);

    return result;
  }

  protected processWhileLoop(node: WhileLoop): string {
    const conditionCode = this.processNode(node.condition).trim();
    let result = this.indentStr(`while (${conditionCode}) {\n`);

    this.increaseIndent();
    const lines: string[] = [];
    for (const stmt of node.body) {
      lines.push(this.processNode(stmt));
    }
    result += lines.filter(s => s !== "").join("\n").trimEnd() + "\n";
    this.decreaseIndent();

    result += this.indentStr(`}`);

    return result;
  }

  protected processIfElse(node: IfElse): string {
    const conditionCode = this.processNode(node.condition).trim();
    const lines = [];
    lines.push(this.indentStr(`if (${conditionCode}) {\n`));

    const bodyLines: string[] = [];
    this.increaseIndent();
    for (const stmt of node.thenBody) {
      bodyLines.push(this.processNode(stmt));
    }
    this.decreaseIndent();
    lines.push(bodyLines.filter(s => s !== "").join("\n").trimEnd() + "\n");

    if (node.elseBody && node.elseBody.length > 0) {
      if (node.elseBody.length === 1 && node.elseBody[0].type === "ifElse") {
        const elseIfCode = this.processIfElse(node.elseBody[0] as IfElse);
        lines.push(this.indentStr(`} else ${elseIfCode.trimStart()}`));
        return lines.join("");
      } else {
        const elseBodyLines: string[] = [];
        lines.push(this.indentStr(`} else {\n`));
        this.increaseIndent();
        for (const stmt of node.elseBody) {
          elseBodyLines.push(this.processNode(stmt));
        }
        this.decreaseIndent();
        lines.push(elseBodyLines.filter(s => s !== "").join("\n").trimEnd() + "\n");
      }
    }

    lines.push(this.indentStr(`}`));
    return lines.join("");
  }

  protected processReturnStatement(node: ReturnStatement): string {
    const valueCode = this.processNode(node.value).trim();
    return this.indentStr(`return ${valueCode}`);
  }

  protected processDebuggerStatement(
    node: DebuggerStatement,
  ): string {
    return this.indentStr(
      node.label ? `debugger(${JSON.stringify(node.label)})` : "debugger()",
    );
  }

  // Utility methods

  protected processComment(node: AgencyComment): string {
    return this.indentStr(`//${node.content}`);
  }

  protected processMultiLineComment(node: AgencyMultiLineComment): string {
    return this.indentStr(`/*${node.content}*/`);
  }

  protected processImportStatement(node: ImportStatement): string {
    const importedNames = node.importedNames.map((name) =>
      this.processImportNameType(name),
    );
    const modulePath = node.modulePath.startsWith("std::")
      ? node.modulePath.replace(/\.agency$/, "")
      : node.modulePath;
    const str = this.indentStr(
      `import ${importedNames.join(", ")} from "${modulePath}"`,
    );
    return str;
  }

  protected processImportNameType(node: ImportNameType): string {
    switch (node.type) {
      case "namedImport": {
        const names = node.importedNames.map((name) =>
          node.safeNames?.includes(name) ? `safe ${name}` : name,
        );
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

  protected processImportToolStatement(node: ImportToolStatement): string {
    const toolNames = node.importedTools.flatMap((n) => n.importedNames);
    return `import tool { ${toolNames.join(", ")} } from "${node.agencyFile}"`;
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
    const { nodeName, body, parameters } = node;
    const params = parameters
      .map((p) =>
        p.typeHint
          ? `${p.name}: ${variableTypeToString(p.typeHint, this.typeAliases)}`
          : p.name,
      )
      .join(", ");
    const returnTypeStr = node.returnType
      ? ": " + variableTypeToString(node.returnType, this.typeAliases)
      : "";
    const visibilityStr = this.visibilityToString(node.visibility);
    let result = this.indentStr(
      `${visibilityStr}node ${nodeName}(${params})${returnTypeStr} {\n`,
    );

    this.increaseIndent();

    const lines: string[] = [];
    for (const stmt of body) {
      lines.push(this.processNode(stmt));
    }
    const bodyCode = lines.filter(s => s !== "").join("\n").trimEnd() + "\n";
    result += bodyCode;

    this.decreaseIndent();

    result += this.indentStr(`}`);
    return result;
  }

  protected processTool(node: FunctionDefinition): string {
    return "";
  }

  protected processUsesTool(node: UsesTool): string {
    return this.indentStr(`uses ${node.toolNames.join(", ")}`);
  }

  protected processSpecialVar(node: SpecialVar): string {
    return this.indentStr(
      `@${node.name} = ${this.processNode(node.value).trim()}`,
    );
  }

  protected processNewLine(_node: NewLine): string {
    return "";
  }

  protected processMessageThread(node: MessageThread): string {
    this.increaseIndent();
    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.processNode(stmt));
    }
    this.decreaseIndent();
    const bodyCodeStr = bodyCodes.filter(s => s !== "").join("\n").trimEnd() + "\n";
    const threadType = node.threadType;
    return this.indentStr(
      `${threadType} {\n${bodyCodeStr}${this.indentStr("}")}`,
    );
  }

  protected processHandleBlock(node: HandleBlock): string {
    this.increaseIndent();
    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.processNode(stmt));
    }
    this.decreaseIndent();
    const bodyCodeStr = bodyCodes.filter(s => s !== "").join("\n").trimEnd() + "\n";

    let handlerStr: string;
    if (node.handler.kind === "inline") {
      const paramStr = node.handler.param.typeHint
        ? `${node.handler.param.name}: ${variableTypeToString(node.handler.param.typeHint, this.typeAliases)}`
        : node.handler.param.name;
      this.increaseIndent();
      const handlerBodyCodes: string[] = [];
      for (const stmt of node.handler.body) {
        handlerBodyCodes.push(this.processNode(stmt));
      }
      this.decreaseIndent();
      const handlerBodyStr = handlerBodyCodes.filter(s => s !== "").join("\n").trimEnd() + "\n";
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

  protected processBinOpExpression(node: BinOpExpression): string {
    const left = this.processNode(node.left).trim();
    const right = this.processNode(node.right).trim();
    const wrappedLeft = this.needsParensLeft(node.left, node.operator)
      ? `(${left})`
      : left;
    const wrappedRight = this.needsParensRight(node.right, node.operator)
      ? `(${right})`
      : right;
    return this.indentStr(`${wrappedLeft} ${node.operator} ${wrappedRight}`);
  }

  protected processAccessChainElement(node: AccessChainElement): string {
    switch (node.kind) {
      case "property":
        return `.${node.name}`;
      case "index":
        return `[${this.processNode(node.index).trim()}]`;
      case "methodCall":
        return `.${this.generateFunctionCallExpression(node.functionCall, "valueAccess")}`;
      default:
        throw new Error(
          `Unknown access chain element kind: ${(node as any).kind}`,
        );
    }
  }

  protected processKeyword(node: Keyword): string {
    return this.indentStr(`${node.value}`);
  }
}

export function generateAgency(program: AgencyProgram): string {
  const generator = new AgencyGenerator();
  return generator.generate(program).output.trim();
}
