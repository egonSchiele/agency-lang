import { SpecialVar } from "@/types/specialVar.js";
import {
  AgencyComment,
  AgencyProgram,
  Assignment,
  Literal,
  PromptLiteral,
  TypeAlias,
  TypeHint,
  VariableType,
} from "../types.js";

import {
  AccessExpression,
  DotFunctionCall,
  DotProperty,
  IndexAccess,
} from "../types/access.js";
import { AgencyArray, AgencyObject } from "../types/dataStructures.js";
import { FunctionCall, FunctionDefinition } from "../types/function.js";
import { GraphNodeDefinition } from "../types/graphNode.js";
import { ImportStatement } from "../types/importStatement.js";
import { MatchBlock } from "../types/matchBlock.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { UsesTool } from "../types/tools.js";
import { WhileLoop } from "../types/whileLoop.js";
import { BaseGenerator } from "./baseGenerator.js";
import { variableTypeToString } from "./typescriptGenerator/typeToString.js";
import { TimeBlock } from "@/types/timeBlock.js";
import { AwaitStatement } from "@/types/await.js";

export class AgencyGenerator extends BaseGenerator {
  private indentLevel: number = 0;
  private indentSize: number = 2;

  constructor() {
    super();
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
    return this.indentStr(`type ${node.aliasName} = ${aliasedTypeStr}\n`);
  }

  protected processTypeHint(node: TypeHint): string {
    this.typeHints[node.variableName] = node.variableType;
    const typeStr = variableTypeToString(node.variableType, this.typeAliases);
    return this.indentStr(`${node.variableName} :: ${typeStr}\n`);
  }

  // Assignment and literals
  protected processAssignment(node: Assignment): string {
    if (node.value.type === "timeBlock") {
      const code = this.processTimeBlock(node.value);
      return this.indentStr(`${node.variableName} = ${code.trim()}\n`);
    }
    const valueCode = this.processNode(node.value).trim();
    return this.indentStr(`${node.variableName} = ${valueCode}\n`);
  }

  protected processTimeBlock(
    node: TimeBlock
  ): string {
    this.increaseIndent();
    const bodyCodes: string[] = [];
    for (const stmt of node.body) {
      bodyCodes.push(this.processNode(stmt));
    }
    this.decreaseIndent();
    const bodyCodeStr = bodyCodes.join("");
    return `time {\n${bodyCodeStr}${this.indentStr("}")}\n`;
  }

  protected generateLiteral(literal: Literal): string {
    switch (literal.type) {
      case "number":
        return literal.value;
      case "string":
        // Escape backslashes and quotes
        const escaped = literal.value;
        return `"${escaped}"`;
      case "variableName":
        return literal.value;
      case "multiLineString":
        const escapedMultiLine = literal.value;
        return `"""${escapedMultiLine}"""`;
      case "prompt":
        return this.generatePromptLiteral(literal);
      default:
        return "";
    }
  }

  private generatePromptLiteral(node: PromptLiteral): string {
    let result = "`";
    for (const segment of node.segments) {
      if (segment.type === "text") {
        result += segment.value;
      } else if (segment.type === "interpolation") {
        result += `\${${segment.variableName}}`;
      }
    }
    result += "`";
    return result;
  }

  protected processPromptLiteral(
    variableName: string,
    node: PromptLiteral
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

    // Start function definition
    let result = this.indentStr(
      `def ${functionName}(${params})${returnTypeStr} {\n`
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
    result += this.indentStr(`}\n\n`);

    return result;
  }

  protected processFunctionCall(node: FunctionCall): string {
    const expr = this.generateFunctionCallExpression(node);
    return this.indentStr(`${expr}\n`);
  }

  protected generateFunctionCallExpression(node: FunctionCall): string {
    const args = node.arguments.map((arg) => {
      return this.processNode(arg).trim();
    });
    return `${node.functionName}(${args.join(", ")})`;
  }

  // Data structures
  protected processAgencyArray(node: AgencyArray): string {
    const items = node.items.map((item) => {
      return this.processNode(item).trim();
    });
    return `[${items.join(", ")}]`;
  }

  protected processAgencyObject(node: AgencyObject): string {
    const entries = node.entries.map((entry) => {
      const valueCode = this.processNode(entry.value).trim();
      return `${entry.key}: ${valueCode}`;
    });
    return `{${entries.join(", ")}}`;
  }

  // Access expressions
  protected processAccessExpression(node: AccessExpression): string {
    switch (node.expression.type) {
      case "dotProperty":
        return this.processDotProperty(node.expression);
      case "indexAccess":
        return this.processIndexAccess(node.expression);
      case "dotFunctionCall":
        return this.processDotFunctionCall(node.expression);
    }
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
      node.functionCall
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

    result += this.indentStr(`}\n`);

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

  protected processReturnStatement(node: ReturnStatement): string {
    const valueCode = this.processNode(node.value).trim();
    return this.indentStr(`return ${valueCode}\n`);
  }

  // Utility methods
  protected processComment(node: AgencyComment): string {
    return this.indentStr(`//${node.content}\n`);
  }

  protected processImportStatement(node: ImportStatement): string {
    return this.indentStr(
      `import ${node.importedNames}from ${node.modulePath}`
    );
  }

  protected processGraphNode(node: GraphNodeDefinition): string {
    // Graph nodes use similar syntax to functions
    const { nodeName, body, parameters } = node;

    const params = parameters.join(", ");
    const returnTypeStr = node.returnType
      ? ": " + variableTypeToString(node.returnType, this.typeAliases)
      : "";
    let result = this.indentStr(
      `node ${nodeName}(${params})${returnTypeStr} {\n`
    );

    this.increaseIndent();
    this.functionScopedVariables = [...parameters];

    const lines: string[] = [];
    for (const stmt of body) {
      lines.push(this.processNode(stmt));
    }
    const bodyCode = lines.join("").trimEnd() + "\n";
    result += bodyCode;

    this.functionScopedVariables = [];
    this.decreaseIndent();

    result += this.indentStr(`}\n\n`);

    return result;
  }

  protected processTool(node: FunctionDefinition): string {
    // For agency code, tools are just functions
    // No special formatting needed
    return "";
  }

  protected processUsesTool(node: UsesTool): string {
    // Track tool usage but don't generate code
    this.toolsUsed.push(node.toolName);
    return this.indentStr(`+${node.toolName}\n`);
  }

  protected processSpecialVar(node: SpecialVar): string {
    return this.indentStr(
      `@${node.name} = ${this.processNode(node.value).trim()}\n`
    );
  }

  private indentStr(str: string): string {
    return `${this.indent()}${str}`;
  }
  protected processAwaitStatement(node: AwaitStatement): string {
    const code = this.processNode(node.expression);
    return this.indentStr(`await ${code.trim()}\n`);
  }
}

export function generateAgency(program: AgencyProgram): string {
  const generator = new AgencyGenerator();
  return generator.generate(program).output.trim();
}
