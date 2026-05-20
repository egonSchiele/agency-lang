import { AgencyConfig } from "@/config.js";
import { AgencyGenerator, generateAgency } from "@/backends/agencyGenerator.js";
import { parse, readFile } from "./commands.js";
import { findRecursively } from "./util.js";
import { variableTypeToString } from "@/backends/typescriptGenerator/typeToString.js";
import { AgencyMultiLineComment, AgencyProgram, Assignment } from "@/types.js";
import type { Tag } from "@/types/tag.js";
import { TypeAlias, VariableType } from "@/types/typeHints.js";
import { FunctionDefinition, FunctionParameter } from "@/types/function.js";
import { GraphNodeDefinition } from "@/types/graphNode.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit, GLOBAL_SCOPE_KEY } from "@/compilationUnit.js";
import { typeCheck } from "@/typeChecker/index.js";
import type { InterruptKind } from "@/symbolTable.js";
import {
  heading,
  codeFence,
  bold,
  markdownTable,
  section,
} from "@/utils/markdown.js";
import { docStringText } from "@/utils/docStringText.js";
import * as fs from "fs";
import * as path from "path";

// Maps a symbol name to the relative .md path where it's documented
type SymbolRegistry = Record<string, string>;

type DocContext = {
  baseUrl?: string;
  sourceRelPath?: string;
  symbolRegistry: SymbolRegistry;
  currentMdPath?: string;
  config: AgencyConfig;
};

export function generateDoc(
  config: AgencyConfig,
  inputPath: string,
  outputDir: string,
  ignoreDirs: string[] = [],
  baseUrlOverride?: string,
): void {
  const rawBaseUrl = baseUrlOverride || config.doc?.baseUrl;
  const baseUrl = rawBaseUrl?.replace(/\/+$/, "");

  if (fs.statSync(inputPath).isDirectory()) {
    // First pass: parse and preprocess all files, build symbol registry
    const symbolRegistry: SymbolRegistry = {};
    const files = [...findRecursively(inputPath, ".agency", [], ignoreDirs)];
    const parsedPrograms = new Map<
      string,
      { program: AgencyProgram; relativePath: string; mdRelPath: string }
    >();

    for (const { path: filePath } of files) {
      const relativePath = path.relative(inputPath, filePath);
      const mdRelPath = relativePath.replace(/\.agency$/, ".md");
      const contents = readFile(filePath);
      const program = preprocessProgram(parse(contents, config), config);

      parsedPrograms.set(filePath, { program, relativePath, mdRelPath });

      const info = buildCompilationUnit(program);
      for (const name of Object.keys(info.functionDefinitions)) {
        symbolRegistry[name] = mdRelPath;
      }
      for (const node of info.graphNodes) {
        symbolRegistry[node.nodeName] = mdRelPath;
      }
      for (const name of Object.keys(
        info.typeAliases.get(GLOBAL_SCOPE_KEY) ?? {},
      )) {
        symbolRegistry[name] = mdRelPath;
      }
      for (const c of collectExportedConstants(program)) {
        symbolRegistry[c.variableName] = mdRelPath;
      }
    }

    // Second pass: generate docs (reusing parsed programs)
    for (const [
      filePath,
      { program, relativePath, mdRelPath },
    ] of parsedPrograms) {
      const outputPath = path.join(outputDir, mdRelPath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      generateDocForFile(
        filePath,
        outputPath,
        {
          baseUrl,
          sourceRelPath: relativePath,
          symbolRegistry,
          currentMdPath: mdRelPath,
          config,
        },
        program,
      );
    }
  } else {
    const baseName = path.basename(inputPath).replace(/\.agency$/, ".md");
    const outputPath = path.join(outputDir, baseName);
    fs.mkdirSync(outputDir, { recursive: true });
    const program = preprocessProgram(
      parse(readFile(inputPath), config),
      config,
    );
    generateDocForFile(
      inputPath,
      outputPath,
      {
        baseUrl,
        sourceRelPath: path.basename(inputPath),
        symbolRegistry: {},
        config,
      },
      program,
    );
  }
}

function preprocessProgram(
  program: AgencyProgram,
  config: AgencyConfig,
): AgencyProgram {
  const preprocessor = new TypescriptPreprocessor(program, config);
  preprocessor.attachDocComments();
  // Attach `@validate(...)` / `@jsonSchema(...)` / other tags onto their
  // target nodes (type aliases, functions, etc.) so the rendered code
  // block in the docs includes those annotations.
  preprocessor.attachTags();
  return program;
}

function generateDocForFile(
  filePath: string,
  outputPath: string,
  ctx: DocContext,
  program: AgencyProgram,
): void {
  const info = buildCompilationUnit(program);

  // Run the type checker (without a SymbolTable) to compute the
  // transitive interrupt kinds each function/node may throw. We
  // intentionally ignore type errors here — the doc command should
  // produce output even for files that don't fully type-check.
  let interruptKindsByFunction: Record<string, InterruptKind[]> = {};
  try {
    const result = typeCheck(program, ctx.config, info);
    interruptKindsByFunction = result.interruptKindsByFunction;
  } catch {
    // Fall back to no interrupt info if the type checker crashes.
  }

  const typeAliases: TypeAlias[] = [];
  for (const node of program.nodes) {
    if (node.type === "typeAlias") {
      typeAliases.push(node);
    }
  }
  const constants = collectExportedConstants(program);

  const title = path.basename(filePath).replace(/\.agency$/, "");
  const sections: string[] = [heading(1, title)];

  // Page-level "View source" link
  if (ctx.baseUrl && ctx.sourceRelPath) {
    // sections.push(`[View source](${ctx.baseUrl}/${toPosixPath(ctx.sourceRelPath)})`);
  }

  if (program.docComment) {
    sections.push(formatDocComment(program.docComment));
  }

  const typeSection = generateTypeSection(typeAliases, ctx);
  if (typeSection) sections.push(typeSection);

  const constantSection = generateConstantSection(constants, ctx);
  if (constantSection) sections.push(constantSection);

  const functions = Object.values(info.functionDefinitions);
  const functionSection = generateFunctionSection(
    functions,
    ctx,
    interruptKindsByFunction,
  );
  if (functionSection) sections.push(functionSection);

  const nodeSection = generateNodeSection(
    info.graphNodes,
    ctx,
    interruptKindsByFunction,
  );
  if (nodeSection) sections.push(nodeSection);

  fs.writeFileSync(outputPath, sections.join("\n\n") + "\n");
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

function formatType(type: VariableType | undefined | null): string {
  if (!type) return "";
  return variableTypeToString(type, {})
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
}

function formatTypeLinked(
  type: VariableType | undefined | null,
  ctx: DocContext,
): string {
  if (!type) return "";
  const plain = formatType(type);
  if (type.type !== "typeAliasVariable") return "`" + plain + "`";

  const name = type.aliasName;
  const targetMdPath = ctx.symbolRegistry[name];
  if (!targetMdPath) return "`" + plain + "`";

  if (targetMdPath === ctx.currentMdPath) {
    return `[${name}](#${name.toLowerCase()})`;
  }

  const from = path.dirname(ctx.currentMdPath || "");
  const rel = path.relative(from, targetMdPath);
  return `[${name}](${toPosixPath(rel)}#${name.toLowerCase()})`;
}

function sourceLink(
  loc: { line: number } | undefined,
  ctx: DocContext,
): string {
  if (!ctx.baseUrl || !ctx.sourceRelPath || !loc) return "";
  return `([source](${ctx.baseUrl}/${toPosixPath(ctx.sourceRelPath)}#L${loc.line + 1}))`;
}

function formatSignature(
  name: string,
  params: FunctionParameter[],
  returnType?: VariableType | null,
): string {
  const paramStr = params
    .map((p) => {
      const prefix = p.variadic ? "..." : "";
      const typeStr = p.typeHint ? `: ${formatType(p.typeHint)}` : "";
      return `${prefix}${p.name}${typeStr}`;
    })
    .join(", ");
  const retStr = returnType ? `: ${formatType(returnType)}` : "";
  return `${name}(${paramStr})${retStr}`;
}

const generator = new AgencyGenerator();

function formatDefaultValue(node: FunctionParameter["defaultValue"]): string {
  if (!node) return "";
  return generator.processNode(node).trim();
}

function generateParamTable(
  params: FunctionParameter[],
  ctx: DocContext,
): string | null {
  if (params.length === 0) return null;
  const rows = params.map((p) => [
    p.name,
    p.typeHint ? formatTypeLinked(p.typeHint, ctx) : "",
    formatDefaultValue(p.defaultValue),
  ]);
  return `${bold("Parameters:")}\n\n${markdownTable(["Name", "Type", "Default"], rows)}`;
}

function formatDocComment(comment: AgencyMultiLineComment): string {
  return comment.content.trim();
}

function formatTypeAlias(alias: TypeAlias, ctx: DocContext): string {
  const code = generateAgency({
    type: "agencyProgram",
    nodes: [alias],
  });
  return section(
    heading(3, alias.aliasName),
    alias.docComment ? formatDocComment(alias.docComment) : null,
    codeFence(code),
    formatValidatorsAndSchema(alias.tags),
    sourceLink(alias.loc, ctx),
  );
}

function generateTypeSection(
  aliases: TypeAlias[],
  ctx: DocContext,
): string | null {
  if (aliases.length === 0) return null;
  return section(
    heading(2, "Types"),
    ...aliases.map((a) => formatTypeAlias(a, ctx)),
  );
}

/**
 * Format the runtime validators + JSON-schema annotations attached to a
 * type alias (or any other tagged target). Returns `null` if no
 * `@validate(...)` or `@jsonSchema(...)` tags are present so callers
 * can elide the section.
 */
function formatValidatorsAndSchema(tags: Tag[] | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  const parts: string[] = [];

  const validators: string[] = [];
  for (const t of tags) {
    if (t.name !== "validate") continue;
    for (const arg of t.arguments) {
      validators.push("`" + generator.processNode(arg).trim() + "`");
    }
  }
  if (validators.length > 0) {
    parts.push(`${bold("Validators:")} ${validators.join(", ")}`);
  }

  const jsonSchemaTag = tags.find((t) => t.name === "jsonSchema");
  if (jsonSchemaTag) {
    const arg = jsonSchemaTag.arguments[0];
    if (arg) {
      const rendered = generator.processNode(arg).trim();
      parts.push(`${bold("JSON Schema metadata:")}\n\n${codeFence(rendered, "agency")}`);
    }
  }

  return parts.length === 0 ? null : parts.join("\n\n");
}

function collectExportedConstants(program: AgencyProgram): Assignment[] {
  const out: Assignment[] = [];
  for (const node of program.nodes) {
    if (
      node.type === "assignment" &&
      node.exported &&
      node.declKind === "const"
    ) {
      out.push(node as Assignment);
    }
  }
  return out;
}

function formatConstant(c: Assignment, ctx: DocContext): string {
  // Render the declaration via the agency generator so it picks up any
  // attached `@validate(...)` / `@jsonSchema(...)` tags and the doc
  // comment.
  const code = generateAgency({
    type: "agencyProgram",
    nodes: [c],
  });
  return section(
    heading(3, c.variableName),
    codeFence(code),
    c.typeHint
      ? `${bold("Type:")} ${formatTypeLinked(c.typeHint, ctx)}`
      : null,
    formatValidatorsAndSchema(c.tags),
    sourceLink(c.loc, ctx),
  );
}

function generateConstantSection(
  constants: Assignment[],
  ctx: DocContext,
): string | null {
  if (constants.length === 0) return null;
  return section(
    heading(2, "Constants"),
    ...constants.map((c) => formatConstant(c, ctx)),
  );
}

function formatThrows(kinds: InterruptKind[] | undefined): string | null {
  if (!kinds || kinds.length === 0) return null;
  const formatted = kinds
    .map((k) => "`" + (k.kind || "unknown") + "`")
    .join(", ");
  return `${bold("Throws:")} ${formatted}`;
}

function generateFunctionSection(
  fns: FunctionDefinition[],
  ctx: DocContext,
  interruptKindsByFunction: Record<string, InterruptKind[]>,
): string | null {
  if (fns.length === 0) return null;
  const parts = fns.map((fn) => {
    const sig = formatSignature(fn.functionName, fn.parameters, fn.returnType);
    return section(
      heading(3, fn.functionName),
      codeFence(sig),
      fn.docString ? docStringText(fn.docString) : null,
      fn.docComment ? formatDocComment(fn.docComment) : null,
      generateParamTable(fn.parameters, ctx),
      fn.returnType
        ? `${bold("Returns:")} ${formatTypeLinked(fn.returnType, ctx)}`
        : null,
      formatThrows(interruptKindsByFunction[fn.functionName]),
      sourceLink(fn.loc, ctx),
    );
  });
  return section(heading(2, "Functions"), ...parts);
}

function generateNodeSection(
  nodes: GraphNodeDefinition[],
  ctx: DocContext,
  interruptKindsByFunction: Record<string, InterruptKind[]>,
): string | null {
  if (nodes.length === 0) return null;
  const parts = nodes.map((node) => {
    const sig = formatSignature(
      node.nodeName,
      node.parameters,
      node.returnType,
    );
    return section(
      heading(3, node.nodeName),
      codeFence(sig),
      node.docString ? docStringText(node.docString) : null,
      node.docComment ? formatDocComment(node.docComment) : null,
      generateParamTable(node.parameters, ctx),
      node.returnType
        ? `${bold("Returns:")} ${formatTypeLinked(node.returnType, ctx)}`
        : null,
      formatThrows(interruptKindsByFunction[node.nodeName]),
      sourceLink(node.loc, ctx),
    );
  });
  return section(heading(2, "Nodes"), ...parts);
}
