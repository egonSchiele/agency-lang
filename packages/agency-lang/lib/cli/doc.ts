import { AgencyConfig } from "@/config.js";
import { AgencyGenerator, generateAgency } from "@/backends/agencyGenerator.js";
import { parse, readFile } from "./commands.js";
import { findRecursively } from "./util.js";
import { variableTypeToString } from "@/backends/typescriptGenerator/typeToString.js";
import { AgencyMultiLineComment, AgencyProgram, Assignment } from "@/types.js";
import type { Tag } from "@/types/tag.js";
import { TypeAlias, VariableType } from "@/types/typeHints.js";
import { EffectDeclaration } from "@/types/effectDeclaration.js";
import { FunctionDefinition, FunctionParameter } from "@/types/function.js";
import { GraphNodeDefinition } from "@/types/graphNode.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit, GLOBAL_SCOPE_KEY } from "@/compilationUnit.js";
import { typeCheck } from "@/typeChecker/index.js";
import type { InterruptEffect } from "@/symbolTable.js";
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
  // transitive interrupt effects each function/node may throw. We
  // intentionally ignore type errors here — the doc command should
  // produce output even for files that don't fully type-check.
  let interruptEffectsByFunction: Record<string, InterruptEffect[]> = {};
  try {
    const result = typeCheck(program, ctx.config, info);
    interruptEffectsByFunction = result.interruptEffectsByFunction;
  } catch {
    // Fall back to no interrupt info if the type checker crashes.
  }

  const typeAliases: TypeAlias[] = [];
  const effectDecls: EffectDeclaration[] = [];
  for (const node of program.nodes) {
    if (node.type === "typeAlias") {
      typeAliases.push(node);
    } else if (node.type === "effectDeclaration") {
      effectDecls.push(node);
    }
  }
  const constants = collectExportedConstants(program);

  const title = path.basename(filePath).replace(/\.agency$/, "");
  const safeName = title.replace(/["\\\n]/g, "");
  const fmLines = [`name: "${safeName}"`];
  const description = moduleDescription(program.docComment);
  if (description) {
    fmLines.push(`description: "${description}"`);
  }
  const frontmatter = `---\n${fmLines.join("\n")}\n---`;
  const sections: string[] = [frontmatter, heading(1, title)];

  // Page-level "View source" link
  if (ctx.baseUrl && ctx.sourceRelPath) {
    // sections.push(`[View source](${ctx.baseUrl}/${toPosixPath(ctx.sourceRelPath)})`);
  }

  if (program.docComment) {
    const { body } = extractSummaryOverride(program.docComment.content);
    sections.push(formatDocComment({ ...program.docComment, content: body }));
  }

  const typeSection = generateTypeSection(typeAliases, ctx);
  if (typeSection) sections.push(typeSection);

  const effectSection = generateEffectSection(effectDecls, ctx);
  if (effectSection) sections.push(effectSection);

  const constantSection = generateConstantSection(constants, ctx);
  if (constantSection) sections.push(constantSection);

  const functions = Object.values(info.functionDefinitions);
  const functionSection = generateFunctionSection(
    functions,
    ctx,
    interruptEffectsByFunction,
  );
  if (functionSection) sections.push(functionSection);

  const nodeSection = generateNodeSection(
    info.graphNodes,
    ctx,
    interruptEffectsByFunction,
  );
  if (nodeSection) sections.push(nodeSection);
  const generatedOutput = sections.join("\n\n") + "\n";
  fs.writeFileSync(outputPath, postprocessDoc(generatedOutput));
}

function postprocessDoc(doc: string): string {
  return doc;
  // escape < and > for all xml
  // return doc.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

export function extractSummaryOverride(content: string): {
  override: string | null;
  body: string;
} {
  const lines = content.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) return { override: null, body: content };
  const first = lines[firstIdx].trim();
  if (/^@summary(\s+|$)/.test(first)) {
    const text = first.slice("@summary".length).trim();
    const rest = lines.slice(0, firstIdx).concat(lines.slice(firstIdx + 1));
    return {
      override: text === "" ? null : text,
      body: rest.join("\n"),
    };
  }
  return { override: null, body: content };
}

export function firstParagraph(body: string): string {
  const lines = body.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => line !== "");
  if (start === -1) return "";
  const afterLead = lines.slice(start);
  const end = afterLead.findIndex(
    (line) => line === "" || line.startsWith("```"),
  );
  const paragraph = end === -1 ? afterLead : afterLead.slice(0, end);
  return paragraph.join(" ").replace(/\s+/g, " ").trim();
}

export function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/);
  return match ? match[0] : text;
}

export function sanitizeDescription(raw: string): string {
  return raw
    .replace(/["\\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^#{1,6}\s+/, "")
    .trim();
}

export function moduleDescription(
  comment: AgencyMultiLineComment | undefined,
): string | null {
  if (!comment) return null;
  const { override, body } = extractSummaryOverride(comment.content);
  const raw = override ?? firstSentence(firstParagraph(body));
  if (!raw) return null;
  const value = sanitizeDescription(raw);
  return value === "" ? null : value;
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
    ...aliases.filter(a => a.exported).map((a) => formatTypeAlias(a, ctx)),
  );
}

function formatEffectDeclaration(
  decl: EffectDeclaration,
  ctx: DocContext,
): string {
  const code = generateAgency({
    type: "agencyProgram",
    nodes: [decl],
  });
  return section(
    heading(3, decl.effect),
    decl.docComment ? formatDocComment(decl.docComment) : null,
    codeFence(code),
    sourceLink(decl.loc, ctx),
  );
}

function generateEffectSection(
  decls: EffectDeclaration[],
  ctx: DocContext,
): string | null {
  if (decls.length === 0) return null;
  return section(
    heading(2, "Effects"),
    ...decls.map((d) => formatEffectDeclaration(d, ctx)),
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

function formatThrows(kinds: InterruptEffect[] | undefined): string | null {
  if (!kinds || kinds.length === 0) return null;
  const formatted = kinds
    .map((k) => "`" + (k.effect || "unknown") + "`")
    .join(", ");
  return `${bold("Throws:")} ${formatted}`;
}

function generateFunctionSection(
  fns: FunctionDefinition[],
  ctx: DocContext,
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
): string | null {
  if (fns.length === 0) return null;
  const _parts = fns.map((fn) => {
    if (!fn.exported) return null; // skip non-exported functions
    // Underscore-prefixed exports are internal plumbing (e.g. `_guard`,
    // the guard construct's lowering target) — exported for the
    // compiler's sake, not the user's. Their story belongs in docs/dev.
    if (fn.functionName.startsWith("_")) return null;
    const sig = generator.signatureOf(fn);
    return section(
      heading(3, fn.functionName),
      codeFence(sig),
      fn.docString ? docStringText(fn.docString) : null,
      fn.docComment ? formatDocComment(fn.docComment) : null,
      generateParamTable(fn.parameters, ctx),
      fn.returnType
        ? `${bold("Returns:")} ${formatTypeLinked(fn.returnType, ctx)}`
        : null,
      formatThrows(interruptEffectsByFunction[fn.functionName]),
      sourceLink(fn.loc, ctx),
    );
  });
  const parts = _parts.filter((p): p is string => p !== null);
  return section(heading(2, "Functions"), ...parts);
}

function generateNodeSection(
  nodes: GraphNodeDefinition[],
  ctx: DocContext,
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
): string | null {
  if (nodes.length === 0) return null;
  const parts = nodes.map((node) => {
    const sig = generator.signatureOf(node);
    return section(
      heading(3, node.nodeName),
      codeFence(sig),
      node.docString ? docStringText(node.docString) : null,
      node.docComment ? formatDocComment(node.docComment) : null,
      generateParamTable(node.parameters, ctx),
      node.returnType
        ? `${bold("Returns:")} ${formatTypeLinked(node.returnType, ctx)}`
        : null,
      formatThrows(interruptEffectsByFunction[node.nodeName]),
      sourceLink(node.loc, ctx),
    );
  });
  return section(heading(2, "Nodes"), ...parts);
}
