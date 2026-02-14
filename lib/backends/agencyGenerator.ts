import { SpecialVar } from "@/types/specialVar.js";
import {
  AgencyComment,
  AgencyProgram,
  Assignment,
  Literal,
  MultiLineStringLiteral,
  NewLine,
  PromptLiteral,
  StringLiteral,
  TypeAlias,
  TypeHint,
  VariableType,
} from "../types.js";

import { AwaitStatement } from "@/types/await.js";
import { TimeBlock } from "@/types/timeBlock.js";
import {
  AccessExpression,
  DotFunctionCall,
  DotProperty,
  IndexAccess,
} from "../types/access.js";
import { AgencyArray, AgencyObject } from "../types/dataStructures.js";
import { FunctionCall, FunctionDefinition } from "../types/function.js";
import { GraphNodeDefinition } from "../types/graphNode.js";
import { IfElse } from "../types/ifElse.js";
import {
  ImportNodeStatement,
  ImportStatement,
  ImportToolStatement,
} from "../types/importStatement.js";
import { MatchBlock } from "../types/matchBlock.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { UsesTool } from "../types/tools.js";
import { WhileLoop } from "../types/whileLoop.js";
import { BaseGenerator } from "./baseGenerator.js";
import { variableTypeToString } from "./typescriptGenerator/typeToString.js";
import { AgencyConfig } from "@/config.js";
import { MessageThread } from "@/types/messageThread.js";
import { Skill } from "@/types/skill.js";

export class AgencyGenerator extends BaseGenerator {
  private indentLevel: number = 0;
  private indentSize: number = 2;

  constructor(args: { config?: AgencyConfig } = {}) {
    super(args);
  }

  private indent(level = this.indentLevel): string {
    return " ".repeat(level * this.indentSize);
  }

  private increaseIndent(): void {
    this.indentLevel++;
  }

  private decreaseIndent(): void {
    this.indentLevel--;
  }

  // Lifecycle methods
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

  protected aliasedTypeToString(aliasedType: VariableType): string {
    if (aliasedType.type === "objectType") {
      const props = aliasedType.properties
        .map((prop) => {
          let str = `${this.indent(this.indentLevel + 1)}`;
          str += `${prop.key}: ${this.aliasedTypeToString(prop.value)}`;
          if (prop.description) {
            str += ` # ${prop.description}`;
          }
          return str;
        })
        .join(";\n");
      return `{\n${props}\n}`;
    }
    return variableTypeToString(aliasedType, this.typeAliases);
  }

  // Type system methods
  protected processTypeAlias(node: TypeAlias): string {
    this.typeAliases[node.aliasName] = node.aliasedType;
    const aliasedTypeStr = this.aliasedTypeToString(node.aliasedType);
    return this.indentStr(`type ${node.aliasName} = ${aliasedTypeStr}`);
  }

  protected processTypeHint(node: TypeHint): string {
    this.typeHints[node.variableName] = node.variableType;
    const typeStr = variableTypeToString(node.variableType, this.typeAliases);
    return this.indentStr(`${node.variableName} :: ${typeStr}`);
  }

  // Assignment and literals
  protected processAssignment(node: Assignment): string {
    const varName = node.typeHint
      ? `${node.variableName}: ${variableTypeToString(node.typeHint, this.typeAliases)}`
      : node.variableName;
    if (node.value.type === "timeBlock") {
      const code = this.processTimeBlock(node.value);
      return this.indentStr(`${varName} = ${code.trim()}\n`);
    }
    let valueCode = this.processNode(node.value).trim();
    return this.indentStr(`${varName} = ${valueCode}`);
  }

  protected processTimeBlock(node: TimeBlock): string {
    this.increaseIndent();
    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.processNode(stmt));
    }
    this.decreaseIndent();
    const bodyCodeStr = bodyCodes.join("");
    const timeBlockName = node.printTime ? "printTime" : "time";
    return this.indentStr(
      `${timeBlockName} {\n${bodyCodeStr}${this.indentStr("}")}`,
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
      case "prompt":
        return this.indentStr(this.generatePromptLiteral(literal));
      default:
        return "";
    }
  }

  private generatePromptLiteral(node: PromptLiteral): string {
    let result = "";
    if (node.isStreaming) {
      result += "stream ";
    }
    result += 'llm("';
    for (const segment of node.segments) {
      if (segment.type === "text") {
        result += segment.value;
      } else if (segment.type === "interpolation") {
        result += `\${${segment.variableName}}`;
      }
    }

    if (node.config) {
      const objCode = this.processAgencyObject(node.config);
      result += `", ${objCode})`;
    } else {
      result += `")`;
    }
    return result;
  }

  private generateStringLiteral(node: StringLiteral): string {
    let result = '"';
    for (const segment of node.segments) {
      if (segment.type === "text") {
        result += segment.value;
      } else if (segment.type === "interpolation") {
        result += `\${${segment.variableName}}`;
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
        result += `\${${segment.variableName}}`;
      }
    }
    result += '"""';
    return result
      .split("\n")
      .map((line) => this.indentStr(line))
      .join("\n");
  }

  protected processPromptLiteral(
    variableName: string,
    variableType: VariableType | undefined,
    node: PromptLiteral,
  ): string {
    // For agency code, prompts are just part of assignments
    // This shouldn't be called directly, but return empty string
    return "";
  }

  // Function methods
  protected processFunctionDefinition(node: FunctionDefinition): string {
    const { functionName, body, parameters } = node;

    // Build parameter list
    const params = parameters
      .map((p) => {
        if (p.typeHint) {
          const typeStr = variableTypeToString(p.typeHint, this.typeAliases);
          return `${p.name}: ${typeStr}`;
        } else {
          return p.name;
        }
      })
      .join(", ");

    const returnTypeStr = node.returnType
      ? ": " + variableTypeToString(node.returnType, this.typeAliases)
      : "";

    let asyncPrefix = "";
    if (node.async === true) {
      asyncPrefix = "async ";
    } else if (node.async === false) {
      asyncPrefix = "sync ";
    }

    // Start function definition
    let result = this.indentStr(
      `${asyncPrefix}def ${functionName}(${params})${returnTypeStr} {\n`,
    );

    // Process body with increased indentation
    this.increaseIndent();

    if (node.docString) {
      const docLines = [`"""`, node.docString.value, `"""`]
        .map((line) => this.indentStr(line))
        .join("\n");
      result += `${docLines}\n`;
    }

    this.functionScopedVariables = [...parameters.map((p) => p.name)];

    const lines: string[] = [];
    for (const stmt of body) {
      lines.push(this.processNode(stmt));
    }
    const bodyCode = lines.join("").trimEnd() + "\n";
    result += bodyCode;

    this.functionScopedVariables = [];
    this.decreaseIndent();

    // Close function
    result += this.indentStr(`}`);

    return result;
  }

  protected processFunctionCall(node: FunctionCall): string {
    const expr = this.generateFunctionCallExpression(node);
    return this.indentStr(`${expr}`);
  }

  protected generateFunctionCallExpression(node: FunctionCall): string {
    const args = node.arguments.map((arg) => {
      return this.processNode(arg).trim();
    });
    let asyncPrefix = "";
    if (node.async === true) {
      asyncPrefix = "async ";
    } else if (node.async === false) {
      asyncPrefix = "await ";
    }

    return `${asyncPrefix}${node.functionName}(${args.join(", ")})`;
  }

  // Data structures
  protected processAgencyArray(node: AgencyArray): string {
    const items = node.items.map((item) => {
      return this.processNode(item).trim();
    });
    return `[${items.join(", ")}]`;
  }

  protected processAgencyObject(node: AgencyObject): string {
    this.increaseIndent();

    const entries = node.entries.map((entry) => {
      const valueCode = this.processNode(entry.value).trim();
      return this.indentStr(`${entry.key}: ${valueCode}`);
    });
    this.decreaseIndent();
    if (entries.length === 0) {
      return `{}`;
    }
    let entriesStr = "\n" + entries.join(",\n") + "\n";

    return `{ ${entriesStr}` + this.indentStr("}");
  }

  // Access expressions
  protected processAccessExpression(node: AccessExpression): string {
    let code = "";
    switch (node.expression.type) {
      case "dotProperty":
        code = this.processDotProperty(node.expression);
        break;
      case "indexAccess":
        code = this.processIndexAccess(node.expression);
        break;
      case "dotFunctionCall":
        code = this.processDotFunctionCall(node.expression);
        break;
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

  protected processDotProperty(node: DotProperty): string {
    let objectCode = this.processNode(node.object);
    objectCode = objectCode.trim();
    return `${objectCode}.${node.propertyName}`;
  }

  protected processIndexAccess(node: IndexAccess): string {
    const arrayCode = this.processNode(node.array).trim();
    const indexCode = this.processNode(node.index).trim();
    return `${arrayCode}[${indexCode}]`;
  }

  protected processDotFunctionCall(node: DotFunctionCall): string {
    const objectCode = this.processNode(node.object).trim();
    const functionCallCode = this.generateFunctionCallExpression(
      node.functionCall,
    );
    return `${objectCode}.${functionCallCode}`;
  }

  // Control flow
  protected processMatchBlock(node: MatchBlock): string {
    const exprCode = this.processNode(node.expression).trim();
    let result = this.indentStr(`match(${exprCode}) {\n`);

    this.increaseIndent();

    for (const caseNode of node.cases) {
      // Handle comments within cases
      if (caseNode.type === "comment") {
        result += this.processComment(caseNode);
        continue;
      }

      // Format case value (pattern)
      const pattern =
        caseNode.caseValue === "_"
          ? "_"
          : this.processNode(caseNode.caseValue).trim();

      // Format body (action)
      const bodyCode = this.processNode(caseNode.body).trim();

      result += this.indentStr(`${pattern} => ${bodyCode}\n`);
    }

    this.decreaseIndent();

    result += this.indentStr(`}`);

    return result;
  }

  protected processWhileLoop(node: WhileLoop): string {
    const conditionCode = this.processNode(node.condition).trim();
    let result = this.indentStr(`while (${conditionCode}) {\n`);

    this.increaseIndent();

    for (const stmt of node.body) {
      result += this.processNode(stmt);
    }

    this.decreaseIndent();

    result += this.indentStr(`}\n`);

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
    lines.push(bodyLines.join("").trimEnd() + "\n");

    const elseBodyLines: string[] = [];
    if (node.elseBody && node.elseBody.length > 0) {
      lines.push(this.indentStr(`} else {\n`));
      this.increaseIndent();
      for (const stmt of node.elseBody) {
        elseBodyLines.push(this.processNode(stmt));
      }
      this.decreaseIndent();
      lines.push(elseBodyLines.join("").trimEnd() + "\n");
    }

    lines.push(this.indentStr(`}`));
    return lines.join("");
  }

  protected processReturnStatement(node: ReturnStatement): string {
    const valueCode = this.processNode(node.value).trim();
    return this.indentStr(`return ${valueCode}`);
  }

  // Utility methods
  protected processComment(node: AgencyComment): string {
    return this.indentStr(`//${node.content}`);
  }

  protected processImportStatement(node: ImportStatement): string {
    const str = this.indentStr(
      `import ${node.importedNames}from "${node.modulePath}"`,
    );
    return str;
  }

  protected processImportNodeStatement(node: ImportNodeStatement): string {
    return `import node { ${node.importedNodes.join(", ")} } from "${node.agencyFile}"`;
  }

  protected processImportToolStatement(node: ImportToolStatement): string {
    return `import tool { ${node.importedTools.join(", ")} } from "${node.agencyFile}"`;
  }

  protected processGraphNode(node: GraphNodeDefinition): string {
    // Graph nodes use similar syntax to functions
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
    let result = this.indentStr(
      `node ${nodeName}(${params})${returnTypeStr} {\n`,
    );

    this.increaseIndent();
    this.functionScopedVariables = parameters.map((p) => p.name);

    const lines: string[] = [];
    for (const stmt of body) {
      lines.push(this.processNode(stmt));
    }
    const bodyCode = lines.join("").trimEnd() + "\n";
    result += bodyCode;

    this.functionScopedVariables = [];
    this.decreaseIndent();

    result += this.indentStr(`}`);
    return result;
  }

  protected processTool(node: FunctionDefinition): string {
    // For agency code, tools are just functions
    // No special formatting needed
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

  private indentStr(str: string): string {
    return `${this.indent()}${str}`;
  }
  protected processAwaitStatement(node: AwaitStatement): string {
    const code = this.processNode(node.expression);
    return this.indentStr(`await ${code.trim()}`);
  }

  protected processNewLine(_node: NewLine): string {
    return "\n";
  }

  protected processMessageThread(node: MessageThread): string {
    this.increaseIndent();
    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.processNode(stmt));
    }
    this.decreaseIndent();
    const bodyCodeStr = bodyCodes.join("");
    const threadType = node.subthread ? "subthread" : "thread";
    return this.indentStr(
      `${threadType} {\n${bodyCodeStr}${this.indentStr("}")}`,
    );
  }

  protected processSkill(node: Skill): string {
    return this.indentStr(`skill "${node.filepath}"`);
  }
}

export function generateAgency(program: AgencyProgram): string {
  const generator = new AgencyGenerator();
  return generator.generate(program).output.trim();
}
