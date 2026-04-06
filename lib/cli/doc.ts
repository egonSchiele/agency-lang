import { AgencyConfig } from "@/config.js";
import { generateAgency } from "@/backends/agencyGenerator.js";
import { parse, readFile } from "./commands.js";
import { findRecursively } from "./util.js";
import { variableTypeToString } from "@/backends/typescriptGenerator/typeToString.js";
import { TypeAlias, VariableType } from "@/types/typeHints.js";
import { FunctionDefinition, FunctionParameter } from "@/types/function.js";
import { GraphNodeDefinition } from "@/types/graphNode.js";
import { Literal, PromptSegment } from "@/types/literals.js";
import {
  heading,
  codeFence,
  bold,
  markdownTable,
  section,
} from "@/utils/markdown.js";
import * as fs from "fs";
import * as path from "path";

export function generateDoc(
  config: AgencyConfig,
  inputPath: string,
  outputDir: string,
): void {
  if (fs.statSync(inputPath).isDirectory()) {
    for (const { path: filePath } of findRecursively(inputPath)) {
      const relativePath = path.relative(inputPath, filePath);
      const outputPath = path.join(
        outputDir,
        relativePath.replace(/\.agency$/, ".md"),
      );
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      generateDocForFile(config, filePath, outputPath);
    }
  } else {
    const baseName = path.basename(inputPath).replace(/\.agency$/, ".md");
    const outputPath = path.join(outputDir, baseName);
    fs.mkdirSync(outputDir, { recursive: true });
    generateDocForFile(config, inputPath, outputPath);
  }
}

function generateDocForFile(
  config: AgencyConfig,
  filePath: string,
  outputPath: string,
): void {
  const contents = readFile(filePath);
  const program = parse(contents, config);

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

  const typeSection = generateTypeSection(typeAliases);
  if (typeSection) sections.push(typeSection);

  const functionSection = generateFunctionSection(functions);
  if (functionSection) sections.push(functionSection);

  const nodeSection = generateNodeSection(nodes);
  if (nodeSection) sections.push(nodeSection);

  fs.writeFileSync(outputPath, sections.join("\n\n") + "\n");
}


function formatType(type: VariableType | undefined | null): string {
  if (!type) return "";
  return variableTypeToString(type, {}).replace(/\s*\r?\n\s*/g, " ").trim();
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

function formatSegments(segments: PromptSegment[]): string {
  const inner = segments
    .map((s) => (s.type === "text" ? s.value : `\${...}`))
    .join("");
  return `"${inner}"`;
}

function formatDefaultValue(lit: Literal): string {
  switch (lit.type) {
    case "number":
      return lit.value;
    case "boolean":
      return String(lit.value);
    case "string":
    case "multiLineString":
      return formatSegments(lit.segments);
    case "variableName":
      return lit.value;
    default:
      return "";
  }
}

function generateParamTable(params: FunctionParameter[]): string | null {
  if (params.length === 0) return null;
  const rows = params.map((p) => [
    p.name,
    formatType(p.typeHint),
    p.defaultValue ? formatDefaultValue(p.defaultValue) : "",
  ]);
  return `${bold("Parameters:")}\n\n${markdownTable(["Name", "Type", "Default"], rows)}`;
}

function formatTypeAlias(alias: TypeAlias): string {
  const code = generateAgency({
    type: "agencyProgram",
    nodes: [alias],
  });
  return section(heading(3, alias.aliasName), codeFence(code));
}

function generateTypeSection(aliases: TypeAlias[]): string | null {
  if (aliases.length === 0) return null;
  return section(heading(2, "Types"), ...aliases.map(formatTypeAlias));
}

function generateFunctionSection(
  fns: FunctionDefinition[],
): string | null {
  if (fns.length === 0) return null;
  const parts = fns.map((fn) => {
    const sig = formatSignature(fn.functionName, fn.parameters, fn.returnType);
    return section(
      heading(3, fn.functionName),
      codeFence(sig),
      fn.docString ? fn.docString.value : null,
      generateParamTable(fn.parameters),
      fn.returnType ? `${bold("Returns:")} ${formatType(fn.returnType)}` : null,
    );
  });
  return section(heading(2, "Functions"), ...parts);
}

function generateNodeSection(
  nodes: GraphNodeDefinition[],
): string | null {
  if (nodes.length === 0) return null;
  const parts = nodes.map((node) => {
    const sig = formatSignature(node.nodeName, node.parameters, node.returnType);
    return section(
      heading(3, node.nodeName),
      codeFence(sig),
      generateParamTable(node.parameters),
      node.returnType ? `${bold("Returns:")} ${formatType(node.returnType)}` : null,
    );
  });
  return section(heading(2, "Nodes"), ...parts);
}
