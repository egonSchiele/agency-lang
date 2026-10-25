import * as path from "path";
import {
  openValidatedClosure,
  validateClosure,
  withGeneratedEntry,
  type ValidatedClosure,
} from "../compiler/closureValidator.js";
import { compileValidatedClosure } from "../compiler/compileValidatedClosure.js";
import { getStdlibDir, isStdlibImport, resolveAgencyImportPath } from "../importPaths.js";
import { readText, wholePath } from "../host/node/nodeFiles.js";
import { generateAgency } from "../backends/agencyGenerator.js";
import { parseDescribedProgram, _parseAST } from "./agency.js";
import { _parseStatements } from "./template.js";
import { fillHoles } from "../runtime/template/fill.js";
import { isCode, kindOf, type Code } from "../runtime/template/code.js";
import { holeNames } from "../utils/holes.js";
import { declaredName } from "../types/hole.js";
import { isHidden } from "../utils/hiddenTag.js";
import { isFunctionTyped } from "../typeChecker/utils.js";
import type { AgencyNode, FunctionDefinition, ImportStatement } from "../types.js";

export type AgencySourceValue =
  | { kind: "module"; module: string }
  | { kind: "file"; dir: string; filename: string }
  | { kind: "source"; source: string | Code; dir?: string };

export type PreparedFunctions = {
  compiled: {
    moduleId: string;
    code: string;
    modules?: Record<string, string>;
    entryPath?: string;
  };
  exportNames: string[];
  sourceModule: string;
  invokeNode: "invokeLearned";
  metadataNode?: "describeLearned";
};

type ExportedFunction = {
  kind: "function";
  name: string;
  definition: FunctionDefinition;
  moduleId: string;
  originalName: string;
  callModuleId: string;
  callName: string;
};
type OtherExport = { kind: "node" | "unsupported"; name: string };
type ExportedItem = ExportedFunction | OtherExport;
type ResolvedSource = {
  closure: ValidatedClosure;
  entryId: string;
  sourceModule: string;
};

function sourceText(source: string | Code): string {
  if (typeof source === "string") return source;
  if (!isCode(source) || kindOf(source) !== "program") {
    throw new Error("Agency source must be text or a complete Template Agency program");
  }
  const holes = holeNames(source.nodes);
  if (holes.length > 0) throw new Error(`Agency source has unfilled holes: ${holes.join(", ")}`);
  return generateAgency(source);
}

function stdlibFile(moduleName: string): string {
  if (!isStdlibImport(moduleName)) throw new Error("Module sources must name a std:: module");
  const filename = resolveAgencyImportPath(moduleName, "");
  const relative = path.relative(getStdlibDir(), filename);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Module '${moduleName}' is outside the standard library`);
  }
  return filename;
}

function resolveSource(source: AgencySourceValue): ResolvedSource {
  if (source.kind === "module") {
    const entryId = stdlibFile(source.module);
    // Installed stdlib code is trusted. The generated adapter imports it;
    // supplied source and local dependencies still use the normal validator.
    return {
      closure: validateClosure({ entry: { source: "" }, dir: "" }),
      entryId,
      sourceModule: source.module,
    };
  }
  if (source.kind === "file") {
    const closure = validateClosure({ entry: { file: source.filename }, dir: source.dir });
    const entryId = openValidatedClosure(closure).entryModuleId;
    return { closure, entryId, sourceModule: entryId };
  }
  if (source.kind === "source") {
    const closure = validateClosure({
      entry: { source: sourceText(source.source) },
      dir: source.dir ?? "",
    });
    return {
      closure,
      entryId: openValidatedClosure(closure).entryModuleId,
      sourceModule: "<source>",
    };
  }
  throw new Error("Agency source kind must be module, file, or source");
}

/** Inspect only already validated local bytes. Unlike describe(), this walk
 * never enters the effect compiler, so it cannot expand supplied splices. */
function exportedItems(resolved: ResolvedSource): ExportedItem[] {
  const snapshot = openValidatedClosure(resolved.closure);
  const cache: Record<string, ExportedItem[]> = Object.create(null);
  const visiting: string[] = [];
  const readProgram = (moduleId: string) => {
    const captured = snapshot.modules[moduleId];
    if (captured) return parseDescribedProgram(captured.source);
    const relative = path.relative(getStdlibDir(), moduleId);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Module '${moduleId}' is outside the validated closure`);
    }
    const located = wholePath(moduleId);
    return parseDescribedProgram(readText(located.root, located.target));
  };
  const resolveImport = (moduleId: string, imported: string): string => {
    if (isStdlibImport(imported)) return stdlibFile(imported);
    const base = moduleId.startsWith("<entry:")
      ? path.join(snapshot.root ?? "", "entry.agency")
      : moduleId;
    return resolveAgencyImportPath(imported, base);
  };
  const visit = (moduleId: string): ExportedItem[] => {
    if (Object.hasOwn(cache, moduleId)) return cache[moduleId];
    if (visiting.includes(moduleId)) throw new Error(`Circular re-export through '${moduleId}'`);
    visiting.push(moduleId);
    const out: ExportedItem[] = [];
    for (const node of readProgram(moduleId).nodes) {
      if (node.type === "exportFromStatement") {
        const inherited = visit(resolveImport(moduleId, node.modulePath));
        const chosen =
          node.body.kind === "starExport"
            ? inherited
            : node.body.names.flatMap((name) => {
                const entry = inherited.find((item) => item.name === name);
                if (!entry) return [];
                const body = node.body;
                if (body.kind !== "namedExport") return [];
                return [{ ...entry, name: body.aliases[name] ?? name }];
              });
        for (const entry of chosen) {
          if (entry.name.startsWith("_")) continue;
          out.push(
            entry.kind === "function"
              ? { ...entry, callModuleId: moduleId, callName: entry.name }
              : entry,
          );
        }
        continue;
      }
      if (node.type === "function" && node.exported) {
        const name = declaredName(node.functionName);
        if (!name.startsWith("_") && !isHidden(node.tags)) {
          out.push({
            kind: "function",
            name,
            definition: node,
            moduleId,
            originalName: name,
            callModuleId: moduleId,
            callName: name,
          });
        }
      } else if (node.type === "graphNode" && node.exported) {
        out.push({ kind: "node", name: declaredName(node.nodeName) });
      } else if (node.type === "typeAlias" && node.exported) {
        out.push({ kind: "unsupported", name: node.aliasName });
      } else if (node.type === "assignment" && node.exported) {
        out.push({ kind: "unsupported", name: node.variableName });
      }
    }
    visiting.pop();
    cache[moduleId] = out;
    return out;
  };
  return visit(resolved.entryId);
}

function selectFunctions(items: ExportedItem[], names: string[]): ExportedFunction[] {
  const selectedNames =
    names.length === 0
      ? items.filter((item) => item.kind === "function").map((item) => item.name)
      : names;
  if (selectedNames.length === 0) throw new Error("No public exported functions were selected");
  return selectedNames.map((name, index) => {
    if (selectedNames.indexOf(name) !== index)
      throw new Error(`Export '${name}' was selected more than once`);
    const item = items.find((candidate) => candidate.name === name);
    if (!item) throw new Error(`Public exported function '${name}' was not found`);
    if (item.kind === "node")
      throw new Error(`Export '${name}' is a node; nodes are not supported`);
    if (item.kind !== "function") throw new Error(`Export '${name}' is not an Agency def`);
    if (item.definition.markers?.handoff)
      throw new Error(`Export '${name}' is a handoff function, which is not supported`);
    const requiredFunction = item.definition.parameters.find(
      (param) => isFunctionTyped(param) && param.defaultValue === undefined && !param.variadic,
    );
    if (requiredFunction)
      throw new Error(
        `Export '${name}' requires function parameter '${requiredFunction.name}', which is not supported`,
      );
    return item;
  });
}

function importedPath(moduleId: string, closure: ValidatedClosure): string {
  const captured = openValidatedClosure(closure).modules[moduleId];
  if (captured) return `./${captured.relPath}`;
  return `std::${path
    .relative(getStdlibDir(), moduleId)
    .split(path.sep)
    .join("/")
    .replace(/\.agency$/, "")}`;
}

function importFunction(
  moduleId: string,
  name: string,
  alias: string,
  closure: ValidatedClosure,
): AgencyNode {
  const declaration = _parseAST('import { sourceFunction as targetFunction } from "std::agency"')
    .nodes[0] as ImportStatement;
  declaration.modulePath = importedPath(moduleId, closure);
  declaration.importedNames = [
    { type: "namedImport", importedNames: [name], aliases: { [name]: alias } },
  ];
  return declaration;
}

function generateAdapter(
  selected: ExportedFunction[],
  closure: ValidatedClosure,
  includeMetadata: boolean,
): string {
  const imports: AgencyNode[] = [];
  const branches: AgencyNode[] = [];
  const metadataTargets: AgencyNode[] = [];
  for (const [index, item] of selected.entries()) {
    const alias = `learnedTarget${index}`;
    imports.push(importFunction(item.callModuleId, item.callName, alias, closure));
    const branch = fillHoles(
      _parseStatements("if (exportName == #name) { return _invokeLearned(#target, args) }"),
      {
        name: item.name,
        target: {
          type: "agencyProgram",
          kind: "expr",
          nodes: [{ type: "variableName", value: alias }],
        },
      },
    );
    branches.push(...branch.nodes);
    if (includeMetadata) {
      const metadataAlias = `learnedMetadata${index}`;
      imports.push(importFunction(item.moduleId, item.originalName, metadataAlias, closure));
      metadataTargets.push({ type: "variableName", value: metadataAlias });
    }
  }
  const template = _parseAST(`
import { _invokeLearned } from "std::agency"
export node invokeLearned(exportName: string, args: Record<string, any>): any {
  return failure("The requested function was not selected")
}
`);
  // These statements deliberately refer to the generated node's parameters.
  // Compose their ASTs directly: filling a statements hole would correctly
  // rename those binders to prevent the deliberate capture we need here.
  const entry = template.nodes.find((node) => node.type === "graphNode");
  if (!entry || entry.type !== "graphNode") throw new Error("Missing generated invocation node");
  entry.body.unshift(...branches);
  template.nodes.splice(1, 0, ...imports);
  if (includeMetadata) {
    const metadata = fillHoles(
      _parseAST(`
import { _describeLearned } from "std::agency"
export node describeLearned(): any {
  return _describeLearned(#targets, #names, #callTargets)
}
`),
      {
        targets: {
          type: "agencyProgram",
          kind: "expr",
          nodes: [{ type: "agencyArray", items: metadataTargets }],
        },
        names: selected.map((item) => item.name),
        callTargets: {
          type: "agencyProgram",
          kind: "expr",
          nodes: [
            {
              type: "agencyArray",
              items: selected.map((_item, index) => ({
                type: "variableName",
                value: `learnedTarget${index}`,
              })),
            },
          ],
        },
      },
    );
    template.nodes.push(...metadata.nodes);
  }
  return generateAgency(template);
}

/** Prepare once; execution and metadata inspection both use this compiled
 * value, including every local dependency captured by the compiler. */
export function _prepareFunctions(
  source: AgencySourceValue,
  names: string[],
  includeMetadata = false,
): PreparedFunctions {
  const resolved = resolveSource(source);
  const selected = selectFunctions(exportedItems(resolved), names);
  const adapter = generateAdapter(selected, resolved.closure, includeMetadata);
  const compiled = compileValidatedClosure(withGeneratedEntry(resolved.closure, adapter), {
    enforceJsGlobals: true,
    fingerprintModuleIds: true,
  });
  if (!compiled.success) {
    throw new Error(
      `Cannot prepare exports ${selected.map((item) => item.name).join(", ")}:\n${compiled.errors.join("\n")}`,
    );
  }
  return {
    compiled: {
      moduleId: compiled.moduleId,
      code: compiled.code,
      ...(compiled.modules === undefined ? {} : { modules: compiled.modules }),
      ...(compiled.entryPath === undefined ? {} : { entryPath: compiled.entryPath }),
    },
    exportNames: selected.map((item) => item.name),
    sourceModule: resolved.sourceModule,
    invokeNode: "invokeLearned",
    ...(includeMetadata ? { metadataNode: "describeLearned" as const } : {}),
  };
}
