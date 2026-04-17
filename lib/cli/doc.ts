import { AgencyConfig } from "@/config.js";
import { AgencyGenerator, generateAgency } from "@/backends/agencyGenerator.js";
import { parse, readFile } from "./commands.js";
import { findRecursively } from "./util.js";
import { variableTypeToString } from "@/backends/typescriptGenerator/typeToString.js";
import { AgencyMultiLineComment, AgencyProgram } from "@/types.js";
import { TypeAlias, VariableType } from "@/types/typeHints.js";
import { FunctionDefinition, FunctionParameter } from "@/types/function.js";
import { GraphNodeDefinition } from "@/types/graphNode.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import {
  heading,
  codeFence,
  bold,
  markdownTable,
  section,
} from "@/utils/markdown.js";
import * as fs from "fs";
import * as path from "path";

// Maps a symbol name to the relative .md path where it's documented
type SymbolRegistry = Record<string, string>;

type DocContext = {
  baseUrl?: string;
  sourceRelPath?: string;
  symbolRegistry: SymbolRegistry;
  currentMdPath?: string;
};

export function generateDoc(
  config: AgencyConfig,
  inputPath: string,
  outputDir: string,
): void {
  const baseUrl = config.doc?.baseUrl;

  if (fs.statSync(inputPath).isDirectory()) {
    // First pass: parse all files and build symbol registry
    const symbolRegistry: SymbolRegistry = {};
    const files = [...findRecursively(inputPath)];
    const parsedPrograms = new Map<string, { program: AgencyProgram; relativePath: string; mdRelPath: string }>();

    for (const { path: filePath } of files) {
      const relativePath = path.relative(inputPath, filePath);
      const mdRelPath = relativePath.replace(/\.agency$/, ".md");
      const contents = readFile(filePath);
      const program = parse(contents, config);

      parsedPrograms.set(filePath, { program, relativePath, mdRelPath });

      for (const node of program.nodes) {
        if (node.type === "typeAlias") {
          symbolRegistry[node.aliasName] = mdRelPath;
        } else if (node.type === "function") {
          symbolRegistry[node.functionName] = mdRelPath;
        } else if (node.type === "graphNode") {
          symbolRegistry[node.nodeName] = mdRelPath;
        }
      }
    }

    // Second pass: generate docs (reusing parsed programs)
    for (const [filePath, { program, relativePath, mdRelPath }] of parsedPrograms) {
      const outputPath = path.join(outputDir, mdRelPath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      generateDocForFile(config, filePath, outputPath, {
        baseUrl,
        sourceRelPath: relativePath,
        symbolRegistry,
        currentMdPath: mdRelPath,
      }, program);
    }
  } else {
    const baseName = path.basename(inputPath).replace(/\.agency$/, ".md");
    const outputPath = path.join(outputDir, baseName);
    fs.mkdirSync(outputDir, { recursive: true });
    generateDocForFile(config, inputPath, outputPath, {
      baseUrl,
      sourceRelPath: path.basename(inputPath),
      symbolRegistry: {},
    });
  }
}

function generateDocForFile(
  config: AgencyConfig,
  filePath: string,
  outputPath: string,
  ctx: DocContext,
  preParsed?: AgencyProgram,
): void {
  const program = preParsed ?? parse(readFile(filePath), config);

  // Run doc comment attachment so docComment fields are populated
  const preprocessor = new TypescriptPreprocessor(program, config);
  preprocessor.attachDocComments();

  const typeAliases: TypeAlias[] = [];
  const functions: FunctionDefinition[] = [];
  const nodes: GraphNodeDefinition[] = [];

  for (const node of program.nodes) {
    switch (node.type) {
      case "typeAlias":
        typeAliases.push(node);
        break;
      case "function":
        functions.push(node);
        break;
      case "graphNode":
        nodes.push(node);
        break;
    }
  }

  const title = path.basename(filePath).replace(/\.agency$/, "");
  const sections: string[] = [heading(1, title)];

  // Page-level "View source" link
  if (ctx.baseUrl && ctx.sourceRelPath) {
    sections.push(`[View source](${ctx.baseUrl}/${ctx.sourceRelPath})`);
  }

  if (program.docComment) {
    sections.push(formatDocComment(program.docComment));
  }

  const typeSection = generateTypeSection(typeAliases, ctx);
  if (typeSection) sections.push(typeSection);

  const functionSection = generateFunctionSection(functions, ctx);
  if (functionSection) sections.push(functionSection);

  const nodeSection = generateNodeSection(nodes, ctx);
  if (nodeSection) sections.push(nodeSection);

  fs.writeFileSync(outputPath, sections.join("\n\n") + "\n");
}


function formatType(type: VariableType | undefined | null): string {
  if (!type) return "";
  return variableTypeToString(type, {}).replace(/\s*\r?\n\s*/g, " ").trim();
}

function formatTypeLinked(
  type: VariableType | undefined | null,
  ctx: DocContext,
): string {
  if (!type) return "";
  const plain = formatType(type);
  if (type.type !== "typeAliasVariable") return plain;

  const name = type.aliasName;
  const targetMdPath = ctx.symbolRegistry[name];
  if (!targetMdPath) return plain;

  if (targetMdPath === ctx.currentMdPath) {
    // Same file — anchor link
    return `[${name}](#${name.toLowerCase()})`;
  }

  // Cross-file — relative link to the other doc page
  const from = path.dirname(ctx.currentMdPath || "");
  const rel = path.relative(from, targetMdPath);
  return `[${name}](${rel}#${name.toLowerCase()})`;
}

function sourceLink(loc: { line: number } | undefined, ctx: DocContext): string {
  if (!ctx.baseUrl || !ctx.sourceRelPath || !loc) return "";
  return ` [source](${ctx.baseUrl}/${ctx.sourceRelPath}#L${loc.line})`;
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
  const src = sourceLink(alias.loc, ctx);
  return section(
    heading(3, alias.aliasName) + src,
    alias.docComment ? formatDocComment(alias.docComment) : null,
    codeFence(code),
  );
}

function generateTypeSection(aliases: TypeAlias[], ctx: DocContext): string | null {
  if (aliases.length === 0) return null;
  return section(heading(2, "Types"), ...aliases.map((a) => formatTypeAlias(a, ctx)));
}

function generateFunctionSection(
  fns: FunctionDefinition[],
  ctx: DocContext,
): string | null {
  if (fns.length === 0) return null;
  const parts = fns.map((fn) => {
    const sig = formatSignature(fn.functionName, fn.parameters, fn.returnType);
    const src = sourceLink(fn.loc, ctx);
    return section(
      heading(3, fn.functionName) + src,
      codeFence(sig),
      fn.docString ? fn.docString.value : null,
      fn.docComment ? formatDocComment(fn.docComment) : null,
      generateParamTable(fn.parameters, ctx),
      fn.returnType ? `${bold("Returns:")} ${formatTypeLinked(fn.returnType, ctx)}` : null,
    );
  });
  return section(heading(2, "Functions"), ...parts);
}

function generateNodeSection(
  nodes: GraphNodeDefinition[],
  ctx: DocContext,
): string | null {
  if (nodes.length === 0) return null;
  const parts = nodes.map((node) => {
    const sig = formatSignature(node.nodeName, node.parameters, node.returnType);
    const src = sourceLink(node.loc, ctx);
    return section(
      heading(3, node.nodeName) + src,
      codeFence(sig),
      node.docString ? node.docString.value : null,
      node.docComment ? formatDocComment(node.docComment) : null,
      generateParamTable(node.parameters, ctx),
      node.returnType ? `${bold("Returns:")} ${formatTypeLinked(node.returnType, ctx)}` : null,
    );
  });
  return section(heading(2, "Nodes"), ...parts);
}
