import process from "process";
import {
  AgencyComment,
  AgencyMultiLineComment,
  AgencyNode,
  AgencyProgram,
  Assignment,
  Comprehension,
  DebuggerStatement,
  Hole,
  InterruptStatement,
  Literal,
  MultiLineStringLiteral,
  NewLine,
  ObjectProperty,
  ObjectTypeTrivia,
  ParallelBlock,
  Scope,
  ScopeType,
  SeqBlock,
  StringLiteral,
  TypeAlias,
  VariableType,
  formatUnitLiteral,
} from "../types.js";

import { AccessChainElement, ValueAccess } from "../types/access.js";
import { declaredName } from "../types/hole.js";
import { LEGAL_IDENTIFIER } from "../parsers/parsers.js";
import { comprehensionPrefixString } from "../types/comprehension.js";
import { BlockArgument } from "../types/blockArgument.js";
import {
  AgencyArray,
  AgencyObject,
  AgencyObjectKV,
  Trivia,
} from "../types/dataStructures.js";
import {
  FunctionCall,
  FunctionDefinition,
  FunctionParameter,
} from "../types/function.js";
import { GraphNodeDefinition } from "../types/graphNode.js";
import { IfElse } from "../types/ifElse.js";
import {
  ImportNameType,
  ImportNodeStatement,
  ImportStatement,
} from "../types/importStatement.js";
import { ExportFromStatement } from "../types/exportFromStatement.js";
import { EffectDeclaration } from "../types/effectDeclaration.js";
import { MatchBlock } from "../types/matchBlock.js";
import { ReturnStatement } from "../types/returnStatement.js";
import { GotoStatement } from "../types/gotoStatement.js";
import { ForLoop } from "../types/forLoop.js";
import { WhileLoop } from "../types/whileLoop.js";
import { variableTypeToString, effectSetToSource } from "./typescriptGenerator/typeToString.js";
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
import { FinalizeBlock } from "@/types/finalizeBlock.js";
import { GuardBlock } from "@/types/guardBlock.js";
import { Tag } from "@/types/tag.js";
import { NewExpression } from "@/types/newExpression.js";
import {
  ArrayPattern,
  BindingPattern,
  MatchPattern,
  ObjectPattern,
  ObjectPatternProperty,
  ObjectPatternShorthand,
  RestPattern,
  ResultPattern,
  TypePattern,
  WildcardPattern,
} from "@/types/pattern.js";

// Escape the characters that have special meaning inside a string
// literal so the formatter's output round-trips through the parser.
// Mirror the escapes recognized by `stringTextSegmentParserFor` in
// `parsers.ts`. Only the *same* delimiter is escaped — the other two
// quote characters are left literal because Agency strings allow them
// to appear unescaped inside.
export function escapeStringText(s: string, delim: '"' | "'" | "`"): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === delim) {
      out += "\\" + delim;
      continue;
    }
    switch (c) {
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\0":
        out += "\\0";
        break;
      case "$":
        // Only `${` starts an interpolation. Escape a bare `$` only
        // when followed by `{` so a literal `$5` stays as `$5`.
        if (s[i + 1] === "{") {
          out += "\\$";
        } else {
          out += "$";
        }
        break;
      default:
        out += c;
    }
  }
  return out;
}

/** Re-escape `${` -> `\${` when printing a triple-quoted (raw) string's text.
 * The parser decodes `\${` -> a literal `${` text segment; without re-escaping
 * here, the formatter would emit a bare `${` and silently turn a literal back
 * into a live interpolation on the next parse. Everything else stays raw —
 * triple-quoted strings do not escape backslashes, newlines, or quotes. Uses
 * split/join so `$` in the replacement is not treated as a special pattern. */
function escapeMultiLineText(s: string): string {
  return s.split("${").join("\\${");
}

export class AgencyGenerator {
  protected graphNodes: GraphNodeDefinition[] = [];
  protected generatedStatements: string[] = [];
  protected generatedTypeAliases: string[] = [];
  protected typeAliases: Record<string, VariableType> = {};
  protected functionsUsed: Set<string> = new Set();
  protected importNodes: ImportStatement[] = [];
  protected importedNodes: ImportNodeStatement[] = [];
  /** Comments / blank lines at the very top of the file that must stay
   *  above the (sorted) imports block — e.g. file-level `// @tc-nocheck`,
   *  shebangs, module docstrings. Populated by `partitionImports()`. */
  protected importHeaderNodes: AgencyNode[] = [];
  /** Comments attached to each import statement (no blank line between
   *  them and the import). Travel with the import when imports get
   *  sorted, so `// @tc-ignore` above an import keeps suppressing it. */
  protected importAttachedComments: Map<
    ImportStatement | ImportNodeStatement,
    AgencyNode[]
  > = new Map();
  protected functionDefinitions: Record<string, FunctionDefinition> = {};
  protected currentScope: Scope[] = [{ type: "global" }];
  protected program: AgencyProgram | null = null;
  protected agencyConfig: AgencyConfig = {};

  private indentLevel: number = 0;
  private indentSize: number = 2;
  private debug: boolean = !!process.env.AGENCY_DEBUG;

  /**
   * When true, imports render in-place (in their original source position)
   * rather than being hoisted to the top of the file and sorted. Used by
   * `agency literate weave`, which needs to render the file in source
   * order so the prose / code alternation matches what the author wrote.
   */
  protected preserveOrder: boolean = false;

  constructor(args: { config?: AgencyConfig; preserveOrder?: boolean } = {}) {
    this.agencyConfig = mergeDeep(this.configDefaults(), args.config || {});
    this.preserveOrder = args.preserveOrder ?? false;
    if (this.agencyConfig.verbose) {
      console.log("Generator config:", this.agencyConfig);
    }
  }

  protected trace(methodName: string, result: string): string {
    if (!this.debug || result === "") return result;
    return `[${methodName}]${result}[/${methodName}]`;
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

    // Partition the node stream: pull out the header (top-of-file
    // comments/blanks) and each import statement (with any comments
    // directly attached to it). This lets the imports block be sorted
    // while preserving `// @tc-ignore` / `// @tc-nocheck` placement.
    // Skipped in preserveOrder mode (literate weave) because the whole
    // point there is to leave nodes exactly where the author put them.
    if (!this.preserveOrder) {
      program.nodes = this.partitionImports(program.nodes);
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
    const NO_SPACE_TYPES = new Set([
      "comment",
      "multiLineComment",
      "tag",
      "newLine",
    ]);

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

    // In preserveOrder mode, imports already rendered in-place via
    // processNodeInner, so we skip both the top-of-file header reflow
    // and the sorted import block.
    if (!this.preserveOrder) {
      this.addIfNonEmpty(this.renderImportHeader(), output);
      this.addIfNonEmpty(this.sortAndRenderImports(), output);
    }
    this.addIfNonEmpty(this.generatedTypeAliases.join("\n"), output);
    this.addIfNonEmpty(stmtLines.join("\n"), output);

    return {
      output: output.join("\n"),
    };
  }

  /**
   * Split the node stream into three pieces:
   *
   *   1. `importHeaderNodes` — contiguous comments/blank lines at the
   *      very top of the file (before any code or any import-attached
   *      comment). These render unchanged above the sorted imports block.
   *   2. Imports + comments attached to each one — tracked in
   *      `importAttachedComments`. A comment is "attached" iff it sits
   *      directly above its import with no blank line between them. This
   *      keeps `// @tc-ignore` above an import even when the import is
   *      moved by sorting.
   *   3. Everything else — returned as the new node stream for the
   *      remaining passes to process normally.
   *
   * Imports themselves are kept in `program.nodes` (returned here) so the
   * existing collection pass for `importNodes` / `importedNodes` still
   * sees them. The render path skips them because `processNode` for an
   * import returns "".
   */
  private partitionImports(nodes: AgencyNode[]): AgencyNode[] {
    const isImport = (n: AgencyNode): boolean =>
      n.type === "importStatement" || n.type === "importNodeStatement";
    const isComment = (n: AgencyNode): boolean =>
      n.type === "comment" || n.type === "multiLineComment";

    // 1) Eat top-of-file header. The header is the contiguous run of
    //    comment lines at the very top, terminated by either:
    //      - a blank line (newLine) — included in the header so the
    //        visual separation between header and imports is preserved,
    //      - any other node (code, import) — header ends just before it.
    //
    //    A blank line *terminates* header eating. Comments below the
    //    blank line are NOT header; they participate in import-comment
    //    attachment instead. This is what lets a user park `// @tc-ignore`
    //    above an import: separate it from the header region with a
    //    blank line, and it travels with its import when imports are
    //    sorted.
    let i = 0;
    const header: AgencyNode[] = [];
    while (i < nodes.length) {
      const n = nodes[i];
      if (isComment(n)) {
        header.push(n);
        i++;
        continue;
      }
      if (n.type === "newLine") {
        header.push(n);
        i++;
        break; // blank line ends the header
      }
      break; // any other node — header ends here
    }

    // 2) Everything eaten as header stays at the top. We do NOT pop the
    //    trailing comments back to attach them to the first import: the
    //    whole contiguous top-of-file region is sacred (per spec: comments
    //    at the top of the file stay at the top). For `@tc-ignore` to
    //    travel with an import, the user separates it from the header
    //    region with a blank line.
    this.importHeaderNodes = header;

    // 3) Process the rest: for any imports, pull off their directly-
    //    preceding comments (no blank line between). Comments separated
    //    by a blank line stay in the stream.
    const rest: AgencyNode[] = [];
    let commentBuf: AgencyNode[] = [];
    while (i < nodes.length) {
      const n = nodes[i];
      if (isComment(n)) {
        commentBuf.push(n);
        i++;
        continue;
      }
      if (n.type === "newLine") {
        // Blank line — any buffered comments are not "attached" to a
        // following import; flush them back into the stream.
        rest.push(...commentBuf, n);
        commentBuf = [];
        i++;
        continue;
      }
      if (isImport(n)) {
        this.importAttachedComments.set(
          n as ImportStatement | ImportNodeStatement,
          commentBuf,
        );
        commentBuf = [];
        rest.push(n);
        i++;
        continue;
      }
      // Other code — comment buffer wasn't attached to an import.
      rest.push(...commentBuf, n);
      commentBuf = [];
      i++;
    }
    rest.push(...commentBuf);
    return rest;
  }

  /**
   * Render the top-of-file header (comments + blank lines that sit above
   * the imports block). Returns an empty string when there are none.
   */
  private renderImportHeader(): string {
    if (this.importHeaderNodes.length === 0) return "";
    const lines: string[] = [];
    for (const n of this.importHeaderNodes) {
      const code = this.processNode(n);
      if (code !== "" || n.type === "newLine") lines.push(code);
    }
    return lines.join("\n");
  }

  addIfNonEmpty(str: string, lines: string[]): void {
    if (str.trim() !== "") {
      lines.push(str);
    }
  }

  protected preprocessAST(): void {}

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
    this.functionDefinitions[declaredName(node.functionName)] = node;
  }

  protected processGraphNodeName(node: GraphNodeDefinition): void {}

  public processNode(node: AgencyNode): string {
    const result = this.processNodeInner(node);
    return this.trace(node.type, result);
  }

  private processNodeInner(node: AgencyNode): string {
    switch (node.type) {
      case "typeAlias":
        return this.processTypeAlias(node);
      case "effectDeclaration":
        return this.processEffectDeclaration(node);
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
      case "unitLiteral":
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
        if (this.preserveOrder) return this.processImportStatement(node);
        this.importNodes.push(node);
        return "";
      case "importNodeStatement":
        if (this.preserveOrder) return this.processImportNodeStatement(node);
        this.importedNodes.push(node);
        return "";
      case "exportFromStatement":
        return this.processExportFromStatement(node);
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
      case "finalizeBlock":
        return this.processFinalizeBlock(node);
      case "guardBlock":
        return this.processGuardBlock(node);
      case "comprehension":
        return this.processComprehension(node);
      case "withModifier":
        return `${this.processNode(node.statement)} with ${node.handlerName}`;
      case "staticStatement":
        return `static ${this.processNode(node.statement)}`;
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
      case "newExpression":
        return this.processNewExpression(node);
      case "schemaExpression":
        return `schema(${variableTypeToString(node.typeArg, this.typeAliases, true)})`;
      case "regex":
        return `re/${node.pattern}/${node.flags}`;
      case "interruptStatement":
        return this.processInterruptStatement(node);
      case "objectPattern":
      case "arrayPattern":
      case "restPattern":
      case "wildcardPattern":
      case "resultPattern":
        return this.formatPattern(node);
      case "isExpression":
        return `${this.processNode(node.expression).trim()} is ${this.formatPattern(node.pattern)}`;
      case "parallelBlock":
        return this.processParallelBlock(node);
      case "seqBlock":
        return this.processSeqBlock(node);
      case "hole":
        return this.formatHole(node);
      default:
        throw new Error(`Unhandled Agency node type: ${(node as any).type}`);
    }
  }

  protected formatHole(node: Hole): string {
    const sigil = node.splice ? "#..." : "#";
    // A name outside the identifier grammar must print back with quotes
    // or the round trip breaks.
    const name = LEGAL_IDENTIFIER.test(node.name) ? node.name : `"${node.name}"`;
    const annotation = node.typeAnnotation
      ? `: ${variableTypeToString(node.typeAnnotation, this.typeAliases, true)}`
      : "";
    return `${sigil}${name}${annotation}`;
  }

  protected processInterruptStatement(node: InterruptStatement): string {
    const args = this.renderArgList(node.arguments);
    // `raise` lowers to an interruptStatement; viaRaise drives the keyword.
    const keyword = node.viaRaise ? "raise" : "interrupt";
    if (node.effect === "unknown") {
      return this.indentStr(`${keyword}${args}`);
    }
    return this.indentStr(`${keyword} ${node.effect}${args}`);
  }

  protected needsParensLeft(child: BinOpArgument, parentOp: Operator): boolean {
    if (child.type !== "binOpExpression") return false;
    // For right-associative ops like **, (2 ** 3) ** 4 needs parens on the left
    if (parentOp === "**")
      return PRECEDENCE[child.operator] <= PRECEDENCE[parentOp];
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
        const typeStr = variableTypeToString(
          p.typeHint,
          this.typeAliases,
          true,
        );
        const bang = p.validated ? "!" : "";
        return `${prefix}${p.name}: ${typeStr}${bang}${defaultSuffix}`;
      } else {
        return `${prefix}${p.name}${defaultSuffix}`;
      }
    });
  }

  // Type system methods

  private stringifyProp(prop: ObjectProperty): string {
    const isUnionWithNull =
      prop.value.type === "unionType" &&
      prop.value.types.some(
        (t) => t.type === "primitiveType" && t.value === "null",
      );

    if (isUnionWithNull) {
      const nonNullTypes = (prop.value as any).types.filter(
        (t: VariableType) =>
          !(t.type === "primitiveType" && t.value === "null"),
      );
      const unionWithoutNull: VariableType =
        nonNullTypes.length === 1
          ? nonNullTypes[0]
          : { type: "unionType", types: nonNullTypes };
      let str = `${prop.key}?: ${variableTypeToString(unionWithoutNull, this.typeAliases, true)}`;
      if (prop.description) {
        str += ` # ${prop.description}`;
      }
      return str;
    }

    let str = `${prop.key}: ${variableTypeToString(prop.value, this.typeAliases, true)}`;
    if (prop.description) {
      str += ` # ${prop.description}`;
    }
    return str;
  }

  // Append the comment/blank-line trivia anchored at `anchorIndex` to `lines`,
  // one rendered line per comment. Shared by object types and array/object
  // literals so all three preserve trivia identically. Accepts either
  // `ObjectTypeTrivia[]` or `Trivia[]` (structurally identical).
  protected emitTriviaAt(
    trivia: (ObjectTypeTrivia | Trivia)[] | undefined,
    anchorIndex: number,
    lines: string[],
  ): void {
    const match = (trivia ?? []).find((t) => t.anchorIndex === anchorIndex);
    for (const n of match?.comments ?? []) {
      if (n.type === "newLine") lines.push("");
      else if (n.type === "comment") lines.push(this.processComment(n));
      else lines.push(this.processMultiLineComment(n));
    }
  }

  protected aliasedTypeToString(aliasedType: VariableType): string {
    if (aliasedType.type === "objectType") {
      this.increaseIndent();
      const lines: string[] = [];
      const props = aliasedType.properties;
      for (let i = 0; i < props.length; i++) {
        this.emitTriviaAt(aliasedType.trivia, i, lines);
        // `@validate(...)` / `@jsonSchema(...)` annotations render on their
        // own lines above the property, matching source layout. `formatTag`
        // already applies the current (property-level) indentation.
        for (const tag of props[i].tags ?? []) {
          lines.push(this.formatTag(tag));
        }
        const sep = i === props.length - 1 ? "" : ";";
        lines.push(this.indentStr(this.stringifyProp(props[i])) + sep);
      }
      this.emitTriviaAt(aliasedType.trivia, props.length, lines);
      this.decreaseIndent();
      return "{\n" + lines.join("\n") + "\n" + this.indentStr("}");
    }
    return variableTypeToString(aliasedType, this.typeAliases, true);
  }

  protected processEffectDeclaration(node: EffectDeclaration): string {
    // Empty `{}` renders inline; non-empty payloads go through the shared
    // object-type renderer (which already decides inline vs. multi-line).
    const body =
      node.payloadType.properties.length === 0
        ? "{}"
        : this.aliasedTypeToString(node.payloadType);
    return (
      this.formatDocComment(node) +
      this.indentStr(`effect ${node.effect} ${body}`)
    );
  }

  protected processTypeAlias(node: TypeAlias): string {
    this.typeAliases[node.aliasName] = node.aliasedType;
    const aliasedTypeStr = this.aliasedTypeToString(node.aliasedType);
    const exportPrefix = node.exported ? "export " : "";
    // An effectSet declaration uses the `effectSet` keyword; its RHS is an
    // effect set rendered via `effectSetTypeToString` so `<*>` (stored as the
    // `any` primitive) round-trips as `<*>` rather than `any`.
    if (node.isEffectSet) {
      return (
        this.formatDocComment(node) +
        this.indentStr(
          `${exportPrefix}effectSet ${node.aliasName} = ${this.effectSetTypeToString(node.aliasedType)}`,
        )
      );
    }
    const typeParamsStr = this.formatTypeParams(node.typeParams);
    const valueParamsStr = this.formatValueParams(node.valueParams);
    const tags = this.formatAttachedTags(node);
    return (
      this.formatDocComment(node) +
      tags +
      this.indentStr(
        `${exportPrefix}type ${node.aliasName}${typeParamsStr}${valueParamsStr} = ${aliasedTypeStr}`,
      )
    );
  }

  /**
   * Format the `<T, U = string, ...>` chunk of a generic alias declaration.
   * Returns an empty string when there are no type params.
   */
  private formatTypeParams(params: TypeAlias["typeParams"]): string {
    if (!params || params.length === 0) return "";
    const parts = params.map((p) => {
      if (!p.default) return p.name;
      const def = variableTypeToString(p.default, this.typeAliases, true);
      return `${p.name} = ${def}`;
    });
    return `<${parts.join(", ")}>`;
  }

  /**
   * Format the `(low: number, high: number = 10)` chunk of a
   * value-parameterized alias declaration. Returns an empty string when
   * there are no value params.
   */
  private formatValueParams(params: TypeAlias["valueParams"]): string {
    if (!params || params.length === 0) return "";
    const parts = params.map((p) => {
      const typeStr = variableTypeToString(p.type, this.typeAliases, true);
      const base = `${p.name}: ${typeStr}`;
      if (p.default === undefined) return base;
      return `${base} = ${this.processNode(p.default).trim()}`;
    });
    return `(${parts.join(", ")})`;
  }

  // Assignment and literals

  protected processAssignment(node: Assignment): string {
    const tags = this.formatAttachedTags(node);
    const chainStr =
      node.accessChain
        ?.map((ce) => this.processAccessChainElement(ce))
        .join("") ?? "";
    const bangSuffix = node.validated ? "!" : "";
    // Destructuring pattern takes precedence over the bare variableName.
    const lhs = node.pattern
      ? this.formatPattern(node.pattern)
      : node.typeHint
        ? `${node.variableName}${chainStr}: ${variableTypeToString(node.typeHint, this.typeAliases, true)}${bangSuffix}`
        : `${node.variableName}${chainStr}`;
    const exportPrefix = node.exported ? "export " : "";
    const optimizePrefix = node.optimize ? "optimize " : "";
    const staticPrefix = node.static ? "static " : "";
    const declPrefix = node.declKind ? `${node.declKind} ` : "";
    let valueCode = "";
    if (node.value.type === "binOpExpression") {
      valueCode = this.processBinOpExpression(node.value, true).trim();
    } else if ((node.value as AgencyNode).type === "ifElse") {
      // An `ifElse` in value position is an `if ... then ... else` expression
      // (a statement `if` is never an assignment value), so print the
      // single-line `then` form rather than a braced block.
      valueCode = this.formatIfExpression(node.value as AgencyNode as IfElse);
    } else {
      valueCode = this.processNode(node.value).trim();
    }
    return (
      tags +
      this.indentStr(
        `${exportPrefix}${optimizePrefix}${staticPrefix}${declPrefix}${lhs} = ${valueCode}`,
      )
    );
  }

  /**
   * Format a pattern AST node back into Agency pattern syntax. Used by the
   * formatter (it sees the un-lowered AST). Handles binding patterns and
   * match patterns; for match patterns, literal sub-nodes are formatted via
   * the existing literal/expression code paths.
   */
  protected formatPattern(pattern: BindingPattern | MatchPattern): string {
    switch (pattern.type) {
      case "objectPattern":
        return this.formatObjectPattern(pattern);
      case "arrayPattern":
        return this.formatArrayPattern(pattern);
      case "restPattern":
        return `...${(pattern as RestPattern).identifier}`;
      case "wildcardPattern":
        return "_";
      case "resultPattern": {
        const rp = pattern as ResultPattern;
        return rp.binding === null ? rp.kind : `${rp.kind}(${rp.binding})`;
      }
      case "typePattern": {
        // After `is` the surrounding printer already wrote the operator, so
        // the test-only form is just the type. The bind-and-test form only
        // occurs in match arms, printed by formatArmCaseValue.
        const tp = pattern as TypePattern;
        const typeStr = variableTypeToString(tp.typeHint, this.typeAliases, true);
        return tp.pattern === null
          ? typeStr
          : `${this.formatPattern(tp.pattern)}: ${typeStr}`;
      }
      default:
        // variableName / literals — defer to existing rendering
        return this.processNode(pattern as AgencyNode).trim();
    }
  }

  /**
   * An arm's left side. Type patterns print differently here than after the
   * `is` operator: the test-only form needs the `is` keyword written out
   * (`is string =>`), and since `is Type` and `_: Type` parse to the same
   * node, `_: Type` intentionally normalizes to `is Type`.
   */
  private formatArmCaseValue(caseValue: MatchPattern): string {
    if (caseValue.type === "typePattern") {
      const tp = caseValue as TypePattern;
      return tp.pattern === null
        ? `is ${variableTypeToString(tp.typeHint, this.typeAliases, true)}`
        : this.formatPattern(tp);
    }
    return this.processNode(caseValue as AgencyNode).trim();
  }

  private formatObjectPattern(node: ObjectPattern): string {
    const parts = node.properties.map((p) => {
      if (p.type === "objectPatternShorthand") {
        return (p as ObjectPatternShorthand).name;
      }
      if (p.type === "restPattern") {
        return `...${p.identifier}`;
      }
      const prop = p as ObjectPatternProperty;
      // If the value is just `variableName` matching the key, emit shorthand.
      if (prop.value.type === "variableName" && prop.value.value === prop.key) {
        return prop.key;
      }
      return `${prop.key}: ${this.formatPattern(prop.value)}`;
    });
    return `{ ${parts.join(", ")} }`;
  }

  private formatArrayPattern(node: ArrayPattern): string {
    const parts = node.elements.map((el) => this.formatPattern(el));
    return `[${parts.join(", ")}]`;
  }

  protected generateLiteral(literal: Literal): string {
    switch (literal.type) {
      case "number":
        return literal.value;
      case "unitLiteral":
        return formatUnitLiteral(literal);
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
    const delim = node.delimiter ?? '"';
    let result = delim;
    for (const segment of node.segments) {
      if (segment.type === "text") {
        result += escapeStringText(segment.value, delim);
      } else if (segment.type === "interpolation") {
        // processNode (not expressionToString) so nested function calls with
        // block arguments and quoted string literals round-trip correctly.
        result += `\${${this.processNode(segment.expression).trim()}}`;
      }
    }
    result += delim;
    return result;
  }

  /**
   * Render a docstring body for re-emission under the formatter's
   * current indent level. Strips the common leading indentation
   * ("dedent") rather than every line's leading whitespace, so inner
   * structure — ```code fences```, indented bullet sub-items, sample
   * snippets — survives a round-trip. The caller wraps the returned
   * lines in `"""` ... `"""` and re-indents.
   */
  private formatDocStringLines(content: string): string[] {
    // Drop leading/trailing blank lines but PRESERVE indentation on
    // the lines themselves — `.trim()` would strip the first line's
    // leading spaces and skew the min-indent measurement below.
    const stripped = content.replace(/^\n+|\s+$/g, "");
    const rawLines = stripped.split("\n");
    const minIndent = rawLines
      .filter((l) => l.trim() !== "")
      .reduce((min, l) => {
        const leading = l.match(/^[ \t]*/)?.[0].length ?? 0;
        return leading < min ? leading : min;
      }, Infinity);
    const stripBy = minIndent === Infinity ? 0 : minIndent;
    return rawLines.map((l) => (l.trim() === "" ? "" : l.slice(stripBy)));
  }

  private generateMultiLineStringLiteral(node: MultiLineStringLiteral): string {
    let result = '"""';
    for (const segment of node.segments) {
      if (segment.type === "text") {
        result += escapeMultiLineText(segment.value);
      } else if (segment.type === "interpolation") {
        result += `\${${this.processNode(segment.expression).trim()}}`;
      }
    }
    result += '"""';
    return result;
    /* .split("\n")
      .map((line) => this.indentStr(line.trim()))
      .join("\n"); */
  }

  // Function methods

  // Delegates to `effectSetToSource` (the single source of truth); kept for
  // subclass call sites.
  protected effectSetTypeToString(type: VariableType): string {
    return effectSetToSource(type, this.typeAliases);
  }

  // Render a ` raises ...` clause for a def/node signature, or "" when absent.
  protected formatRaisesClause(raises: VariableType | undefined): string {
    if (!raises) return "";
    return ` raises ${this.effectSetTypeToString(raises)}`;
  }

  /** Build the signature line(s) for a `def`/`node` — the given `prefix`,
   *  wrapped params, return type, and `raises` clause — with `opener`
   *  appended (`" {"` for a full definition, `""` for a signature-only
   *  render). The params wrap onto their own lines via `wrapList` when they
   *  don't fit. */
  private buildSignature(
    prefix: string,
    node: FunctionDefinition | GraphNodeDefinition,
    opener: string,
  ): string {
    const returnTypeBang = node.returnTypeValidated ? "!" : "";
    const returnTypeStr = node.returnType
      ? ": " +
        variableTypeToString(node.returnType, this.typeAliases, true) +
        returnTypeBang
      : "";
    const raisesStr = this.formatRaisesClause(node.raises);
    return this.wrapList(
      this.renderParams(node.parameters),
      prefix,
      "(",
      ")",
      `${returnTypeStr}${raisesStr}${opener}`,
    );
  }

  /** The signature of a `def`/`node` with no keyword and no body — just
   *  `name(params): ReturnType raises <...>` — used by `agency doc`. Params
   *  wrap onto their own lines the same way the formatter wraps source, and
   *  the declared `raises` clause is included. */
  signatureOf(node: FunctionDefinition | GraphNodeDefinition): string {
    const name = declaredName(node.type === "function" ? node.functionName : node.nodeName);
    return this.buildSignature(name, node, "");
  }

  protected processFunctionDefinition(node: FunctionDefinition): string {
    const tags = this.formatAttachedTags(node);
    const { body } = node;

    const prefixes: string[] = [];
    if (node.exported) prefixes.push("export");
    if (node.markers?.destructive) prefixes.push("destructive");
    if (node.markers?.idempotent) prefixes.push("idempotent");
    prefixes.push("def");
    const prefix = `${prefixes.join(" ")} ${declaredName(node.functionName)}`;
    const signature = this.buildSignature(prefix, node, " {");

    let result = this.indentStr(`${signature}\n`);

    this.increaseIndent();

    if (node.docString) {
      let content = "";
      for (const seg of node.docString.segments) {
        if (seg.type === "text") {
          content += escapeMultiLineText(seg.value);
        } else {
          content += `\${${this.processNode(seg.expression).trim()}}`;
        }
      }
      const docLines = [`"""`, ...this.formatDocStringLines(content), `"""`];
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
  protected renderArgs(
    args: FunctionCall["arguments"],
    block?: BlockArgument,
  ): string[] {
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
  protected renderArgList(
    args: FunctionCall["arguments"],
    block?: BlockArgument,
  ): string {
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
    let result = this.wrapList(
      rendered,
      `${asyncPrefix}${declaredName(node.functionName)}`,
      "(",
      ")",
      "",
    );

    if (block && !block.inline) {
      let asClause = "as ";
      if (block.params.length < 1) {
        asClause = "";
      } else if (block.params.length === 1) {
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
    // With no interleaved comments, keep the compact `wrapList` formatting
    // (which may render on a single line). Trivia forces the multi-line form
    // so each comment gets its own line.
    if (!node.trivia?.length) {
      const items = node.items.map((item) => {
        if (item.type === "splat") {
          return `...${this.processNode(item.value).trim()}`;
        }
        return this.processNode(item).trim();
      });
      return this.wrapList(items, "", "[", "]");
    }

    this.increaseIndent();
    const lines: string[] = [];
    for (let i = 0; i < node.items.length; i++) {
      this.emitTriviaAt(node.trivia, i, lines);
      const item = node.items[i];
      const itemStr =
        item.type === "splat"
          ? `...${this.processNode(item.value).trim()}`
          : this.processNode(item).trim();
      const sep = i === node.items.length - 1 ? "" : ",";
      lines.push(this.indentStr(itemStr) + sep);
    }
    this.emitTriviaAt(node.trivia, node.items.length, lines);
    this.decreaseIndent();
    return "[\n" + lines.join("\n") + "\n" + this.indentStr("]");
  }

  protected processAgencyObject(node: AgencyObject): string {
    if (node.entries.length === 0 && !node.trivia?.length) {
      return `{}`;
    }
    this.increaseIndent();
    const lines: string[] = [];
    for (let i = 0; i < node.entries.length; i++) {
      this.emitTriviaAt(node.trivia, i, lines);
      const entry = node.entries[i];
      let entryStr: string;
      if ("type" in entry && entry.type === "splat") {
        entryStr = `...${this.processNode(entry.value).trim()}`;
      } else {
        const kv = entry as AgencyObjectKV;
        const valueCode = this.processNode(kv.value).trim();
        entryStr = kv.computedKey
          ? `[${this.processNode(kv.computedKey).trim()}]: ${valueCode}`
          : `${this.addQuotesToKey(kv.key)}: ${valueCode}`;
      }
      const sep = i === node.entries.length - 1 ? "" : ",";
      lines.push(this.indentStr(entryStr) + sep);
    }
    this.emitTriviaAt(node.trivia, node.entries.length, lines);
    this.decreaseIndent();
    return "{\n" + lines.join("\n") + "\n" + this.indentStr("}");
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
        result += this.processComment(caseNode) + "\n";
        continue;
      }

      if (caseNode.type === "newLine") {
        result += this.processNewLine(caseNode);
        continue;
      }

      const pattern =
        caseNode.caseValue === "_"
          ? "_"
          : this.formatArmCaseValue(caseNode.caseValue);

      const guardCode = caseNode.guard
        ? ` if (${this.processNode(caseNode.guard).trim()})`
        : "";

      // A one-statement body prints inline UNLESS the statement is itself a
      // matchBlock: the single-statement arm grammar only accepts
      // return/assignment/expression, so a nested match statement must print
      // in block form to re-parse.
      if (
        caseNode.body.length === 1 &&
        caseNode.body[0].type !== "matchBlock"
      ) {
        const stmt = caseNode.body[0];
        let stmtCode = this.processNode(stmt).trim();
        // `=> { ... }` is always parsed as a block, never an object literal
        // (JS-arrow rule — see matchArmBlockParser). An inline arm whose
        // sole statement is an object literal must therefore stay
        // parenthesized so it round-trips as an expression, not a block.
        if (stmt.type === "agencyObject") {
          stmtCode = `(${stmtCode})`;
        }
        result += this.indentStr(`${pattern}${guardCode} => ${stmtCode}\n`);
      } else {
        result += this.indentStr(`${pattern}${guardCode} => {\n`);
        this.increaseIndent();
        result += this.renderBody(caseNode.body);
        this.decreaseIndent();
        result += this.indentStr("}\n");
      }
    }

    this.decreaseIndent();

    result += this.indentStr(`}`);

    return result;
  }

  protected processForLoop(node: ForLoop): string {
    const iterableCode = this.processNode(node.iterable).trim();
    const itemVarStr =
      typeof node.itemVar === "string"
        ? node.itemVar
        : this.formatPattern(node.itemVar);
    const vars = node.indexVar ? `${itemVarStr}, ${node.indexVar}` : itemVarStr;
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
    const valueCode =
      (node.value as AgencyNode).type === "ifElse"
        ? this.formatIfExpression(node.value as AgencyNode as IfElse)
        : this.processNode(node.value).trim();
    return this.indentStr(`return ${valueCode}`);
  }

  /** Print an `if ... then ... else` expression (an `ifElse` in value position)
   *  as its single-line surface form so it round-trips through the parser. */
  protected formatIfExpression(node: IfElse): string {
    const cond = this.processNode(node.condition).trim();
    const thenCode = this.processNode(node.thenBody[0]).trim();
    const elseCode = this.processNode((node.elseBody ?? [])[0]).trim();
    return `if ${cond} then ${thenCode} else ${elseCode}`;
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
      if (node.isModuleDoc) {
        return this.indentStr(`/** @module${node.content}*/`);
      }
      return this.indentStr(`/**${node.content}*/`);
    }
    return this.indentStr(`/*${node.content}*/`);
  }

  protected formatDocComment(node: {
    docComment?: AgencyMultiLineComment;
  }): string {
    if (!node.docComment) return "";
    return this.processMultiLineComment(node.docComment) + "\n";
  }

  protected processImportStatement(node: ImportStatement): string {
    const modulePath = node.modulePath.startsWith("std::")
      ? node.modulePath.replace(/\.agency$/, "")
      : node.modulePath;
    const suffix = ` from "${modulePath}"`;
    // Test-only imports must round-trip: dropping `test` here would silently
    // turn a working test import into a "not exported" compile error.
    const importKeyword = node.testOnly ? "import test " : "import ";

    // For single named import, use wrapList
    if (
      node.importedNames.length === 1 &&
      node.importedNames[0].type === "namedImport"
    ) {
      const namedImport = node.importedNames[0];
      const names = namedImport.importedNames.map((entry) => {
        const name = declaredName(entry);
        const alias = namedImport.aliases[name];
        const base = alias ? `${name} as ${alias}` : name;
        return this.prefixMarkedName(
          name,
          base,
          namedImport.destructiveNames,
          namedImport.idempotentNames,
        );
      });
      return this.indentStr(
        this.wrapList(names, importKeyword, "{ ", " }", suffix),
      );
    }

    // Default/namespace/mixed imports — always inline
    const importedNames = node.importedNames.map((name) =>
      this.processImportNameType(name),
    );
    return this.indentStr(`${importKeyword}${importedNames.join(", ")}${suffix}`);
  }

  protected processImportNameType(node: ImportNameType): string {
    switch (node.type) {
      case "namedImport": {
        const names = node.importedNames.map((entry) => {
          const name = declaredName(entry);
          const alias = node.aliases[name];
          const base = alias ? `${name} as ${alias}` : name;
          return this.prefixMarkedName(
            name,
            base,
            node.destructiveNames,
            node.idempotentNames,
          );
        });
        return `{ ${names.join(", ")} }`;
      }
      case "namespaceImport":
        return `* as ${node.importedNames}`;
      case "defaultImport":
        return `${node.importedNames}`;
    }
  }

  /** Render an imported/re-exported name with its `destructive` or
   *  `idempotent` prefix. A name carries at most one marker. */
  private prefixMarkedName(
    name: string,
    base: string,
    destructiveNames?: string[],
    idempotentNames?: string[],
  ): string {
    if (destructiveNames?.includes(name)) {
      return `destructive ${base}`;
    }
    if (idempotentNames?.includes(name)) {
      return `idempotent ${base}`;
    }
    return base;
  }

  protected processImportNodeStatement(node: ImportNodeStatement): string {
    return `import node { ${node.importedNodes.join(", ")} } from "${node.agencyFile}"`;
  }

  protected processExportFromStatement(node: ExportFromStatement): string {
    if (node.body.kind === "starExport") {
      return this.indentStr(`export * from "${node.modulePath}"`);
    }
    const body = node.body;
    const items = body.names.map((name) => {
      const alias = body.aliases[name];
      const base = alias ? `${name} as ${alias}` : name;
      return this.prefixMarkedName(
        name,
        base,
        body.destructiveNames,
        body.idempotentNames,
      );
    });
    return this.indentStr(
      `export { ${items.join(", ")} } from "${node.modulePath}"`,
    );
  }

  private sortAndRenderImports(): string {
    type ImportEntry = { modulePath: string; render: () => string };

    const renderWithAttached = (
      node: ImportStatement | ImportNodeStatement,
      body: string,
    ): string => {
      const attached = this.importAttachedComments.get(node) ?? [];
      if (attached.length === 0) return body;
      const commentLines = attached.map((c) => this.processNode(c));
      return [...commentLines, body].join("\n");
    };

    const stdlib: ImportEntry[] = [];
    const packages: ImportEntry[] = [];
    const relative: ImportEntry[] = [];

    for (const node of this.importNodes) {
      const entry: ImportEntry = {
        modulePath: node.modulePath,
        render: () =>
          renderWithAttached(node, this.processImportStatement(node)),
      };
      if (node.modulePath.startsWith("std::")) {
        stdlib.push(entry);
      } else if (node.modulePath.startsWith("pkg::")) {
        packages.push(entry);
      } else {
        relative.push(entry);
      }
    }

    for (const node of this.importedNodes) {
      relative.push({
        modulePath: node.agencyFile,
        render: () =>
          renderWithAttached(node, this.processImportNodeStatement(node)),
      });
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

  protected processGraphNode(node: GraphNodeDefinition): string {
    const tags = this.formatAttachedTags(node);
    const { body } = node;
    const prefix = `${node.exported ? "export " : ""}node ${declaredName(node.nodeName)}`;
    const signature = this.buildSignature(prefix, node, " {");

    let result = this.indentStr(`${signature}\n`);

    this.increaseIndent();

    if (node.docString) {
      let content = "";
      for (const seg of node.docString.segments) {
        if (seg.type === "text") {
          content += escapeMultiLineText(seg.value);
        } else {
          content += `\${${this.processNode(seg.expression).trim()}}`;
        }
      }
      const docLines = [`"""`, ...this.formatDocStringLines(content), `"""`];
      const docStr = docLines.map((line) => this.indentStr(line)).join("\n");
      result += `${docStr}\n`;
    }

    result += this.renderBody(body);

    this.decreaseIndent();

    result += this.indentStr(`}`);
    return this.formatDocComment(node) + tags + result;
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
    const params = [];
    /*     label?: Expression | null;
    summarize?: Expression | null;
    continueExpr?: Expression | null;
    sessionExpr?: Expression | null;
    hidden?: Expression | null;
*/

    const paramConfig = {
      label: node.label,
      summarize: node.summarize,
      continue: node.continueExpr,
      session: node.sessionExpr,
      hidden: node.hidden,
    };

    for (const [key, value] of Object.entries(paramConfig)) {
      if (value) {
        params.push(`${key}: ${this.processNode(value).trim()}`);
      }
    }

    const paramsStr = params.length > 0 ? `(${params.join(", ")})` : "";

    return this.indentStr(
      `${threadType}${paramsStr} {\n${bodyCodeStr}${this.indentStr("}")}`,
    );
  }

  protected processParallelBlock(node: ParallelBlock): string {
    this.increaseIndent();
    const bodyCodeStr = this.renderBody(node.body);
    this.decreaseIndent();
    const sharedSuffix = node.shared
      ? `(shared: ${this.processNode(node.shared).trim()})`
      : "";
    return this.indentStr(
      `parallel${sharedSuffix} {\n${bodyCodeStr}${this.indentStr("}")}`,
    );
  }

  protected processSeqBlock(node: SeqBlock): string {
    this.increaseIndent();
    const bodyCodeStr = this.renderBody(node.body);
    this.decreaseIndent();
    const kw = node.destructive ? "destructive" : "seq";
    return this.indentStr(`${kw} {\n${bodyCodeStr}${this.indentStr("}")}`);
  }

  protected processHandleBlock(node: HandleBlock): string {
    this.increaseIndent();
    const bodyCodeStr = this.renderBody(node.body);
    this.decreaseIndent();

    let handlerStr: string;
    if (node.handler.kind === "inline") {
      const handlerBang = node.handler.param.validated ? "!" : "";
      const paramStr = node.handler.param.typeHint
        ? `${node.handler.param.name}: ${variableTypeToString(node.handler.param.typeHint, this.typeAliases, true)}${handlerBang}`
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

  /** Canonical form: no parens, and the binder prints through the same
   *  param renderer blocks use. A stray `as` with no binder (the shared
   *  grammar's no-param form) canonicalizes away — printing IS the
   *  migration, like guard's legacy `as`. */
  protected processFinalizeBlock(node: FinalizeBlock): string {
    this.increaseIndent();
    const bodyCodeStr = this.renderBody(node.body);
    this.decreaseIndent();
    const rendered = this.renderParams(node.params);
    let asClause = "";
    if (rendered.length === 1) {
      asClause = ` as ${rendered[0]}`;
    } else if (rendered.length > 1) {
      asClause = ` as (${rendered.join(", ")})`;
    }
    return this.indentStr(
      `finalize${asClause} {\n${bodyCodeStr}${this.indentStr("}")}`,
    );
  }

  /** Canonical form: the head prints through the same argument
   *  renderer function calls use (source order for free), parens
   *  always present, never a legacy `as` — printing old syntax through
   *  the generator IS the `as`-removal migration. */
  protected processGuardBlock(node: GuardBlock): string {
    this.increaseIndent();
    const bodyCodeStr = this.renderBody(node.body);
    this.decreaseIndent();
    const argsStr = this.renderArgList(
      node.arguments as FunctionCall["arguments"],
    );
    return this.indentStr(
      `guard${argsStr} {\n${bodyCodeStr}${this.indentStr("}")}`,
    );
  }

  protected processComprehension(node: Comprehension): string {
    const prefix = comprehensionPrefixString(node);
    const expr = this.processNode(node.expression).trim();
    const binder =
      typeof node.itemVar === "string"
        ? node.itemVar
        : this.processNode(node.itemVar).trim();
    const index = node.indexVar ? `, ${node.indexVar}` : "";
    const iterable = this.processNode(node.iterable).trim();
    const cond = node.condition
      ? ` if ${this.processNode(node.condition).trim()}`
      : "";
    return `${prefix}[${expr} for ${binder}${index} in ${iterable}${cond}]`;
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
    const right = this.needsParensRight(node.right, op)
      ? `(${rightStr})`
      : rightStr;
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
    const args = tag.arguments.map((arg) =>
      this.processNode(arg as AgencyNode).trim(),
    );
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

export function generateAgency(
  program: AgencyProgram,
  opts: { preserveOrder?: boolean } = {},
): string {
  const generator = new AgencyGenerator({ preserveOrder: opts.preserveOrder });
  return (
    generator
      .generate(program)
      .output.trim()
      .replace(/[ \t]+$/gm, "") + "\n"
  );
}

/**
 * Formatter-exact source rendering of a single expression — the same
 * renderer interpolations use, so string quotes and escapes are preserved.
 * NOT `expressionToString` (lib/utils/node.ts), which drops string quotes.
 */
export function generateExpression(expr: AgencyNode): string {
  return new AgencyGenerator({}).processNode(expr).trim();
}
