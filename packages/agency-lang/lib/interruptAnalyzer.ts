import type { AgencyProgram, AgencyNode, Expression } from "./types.js";
import type { AgencyArray, AgencyObjectKV, SplatExpression } from "./types/dataStructures.js";
import type { FunctionCall } from "./types/function.js";
import type { FileSymbols } from "./symbolTable.js";
import { walkNodes } from "./utils/node.js";

export type FileInput = {
  symbols: FileSymbols;
  program: AgencyProgram;
};

type FunctionName = string;
type FilePath = string;

type KindsByFunction = Record<FunctionName, string[]>;
type KindsByFile = Record<FilePath, KindsByFunction>;
type CallGraph = Record<FunctionName, FunctionName[]>;
type CallGraphByFile = Record<FilePath, CallGraph>;
type AliasMap = Record<FunctionName, FunctionName>;

/**
 * Analyze all files and return new FileSymbols with interruptKinds populated
 * on every function and node symbol.
 */
export function analyzeInterrupts(
  files: Record<string, FileInput>,
): Record<string, FileSymbols> {
  const { kindsByFile, callGraphByFile, aliasMaps } = collectAll(files);
  resolveTransitiveInterrupts(kindsByFile, callGraphByFile, aliasMaps);
  return attachInterruptKinds(files, kindsByFile);
}

function collectAll(
  files: Record<string, FileInput>,
): { kindsByFile: KindsByFile; callGraphByFile: CallGraphByFile; aliasMaps: Record<string, AliasMap> } {
  const kindsByFile: KindsByFile = {};
  const callGraphByFile: CallGraphByFile = {};
  const aliasMaps: Record<string, AliasMap> = {};
  for (const [filePath, { program }] of Object.entries(files)) {
    const { kinds, callGraph } = collectFromProgram(program);
    kindsByFile[filePath] = kinds;
    callGraphByFile[filePath] = callGraph;
    aliasMaps[filePath] = buildAliasMap(program);
  }
  return { kindsByFile, callGraphByFile, aliasMaps };
}

function buildAliasMap(program: AgencyProgram): AliasMap {
  const aliasMap: AliasMap = {};
  for (const node of program.nodes) {
    if (node.type !== "importStatement") continue;
    for (const nameType of node.importedNames) {
      if (nameType.type !== "namedImport") continue;
      for (const [originalName, alias] of Object.entries(nameType.aliases)) {
        aliasMap[alias] = originalName;
      }
    }
  }
  return aliasMap;
}

function collectFromProgram(
  program: AgencyProgram,
): { kinds: KindsByFunction; callGraph: CallGraph } {
  const kinds: KindsByFunction = {};
  const callGraph: CallGraph = {};
  for (const node of program.nodes) {
    if (node.type !== "function" && node.type !== "graphNode") continue;
    const name = node.type === "function" ? node.functionName : node.nodeName;
    const collected = collectFromBody(node.body);
    kinds[name] = collected.interruptKinds;
    callGraph[name] = collected.callees;
  }
  return { kinds, callGraph };
}

function collectFromBody(
  body: AgencyNode[],
): { interruptKinds: string[]; callees: string[] } {
  const interruptKinds = new Set<string>();
  const callees = new Set<string>();
  for (const { node } of walkNodes(body)) {
    if (node.type === "interruptStatement") {
      interruptKinds.add(node.kind);
    } else if (node.type === "functionCall") {
      callees.add(node.functionName);
      if (node.functionName === "llm") {
        for (const name of extractToolsFromLlmCall(node, body)) {
          callees.add(name);
        }
      }
    } else if (node.type === "gotoStatement") {
      callees.add(node.nodeCall.functionName);
    }
  }
  return { interruptKinds: [...interruptKinds], callees: [...callees] };
}

function isSplatEntry(e: AgencyObjectKV | SplatExpression): e is SplatExpression {
  return "type" in e && e.type === "splat";
}

function extractToolsFromLlmCall(
  call: FunctionCall,
  enclosingBody: AgencyNode[],
): string[] {
  if (call.arguments.length < 2) return [];
  const optionsArg = call.arguments[1];
  if (optionsArg.type !== "agencyObject") return [];
  const toolsEntry = optionsArg.entries.find(
    (e) => !isSplatEntry(e) && e.key === "tools",
  );
  if (!toolsEntry || isSplatEntry(toolsEntry)) return [];
  return extractFunctionNamesFromArray(toolsEntry.value, enclosingBody);
}

function extractFunctionNamesFromArray(
  expr: Expression,
  enclosingBody: AgencyNode[],
): string[] {
  if (expr.type === "agencyArray") {
    return extractNamesFromArrayItems(expr);
  }
  if (expr.type === "variableName") {
    const resolved = traceVariableToArray(expr.value, enclosingBody);
    if (resolved) return extractNamesFromArrayItems(resolved);
  }
  return [];
}

function extractNamesFromArrayItems(arr: AgencyArray): string[] {
  const names: string[] = [];
  for (const item of arr.items) {
    if (item.type === "variableName") {
      names.push(item.value);
    } else if (item.type === "valueAccess" && item.base.type === "variableName") {
      // Handles deploy.partial(env: "prod") — base is the original function name
      names.push(item.base.value);
    }
  }
  return names;
}

function traceVariableToArray(
  varName: string,
  body: AgencyNode[],
): AgencyArray | null {
  for (const node of body) {
    if (
      node.type === "assignment" &&
      node.variableName === varName &&
      node.value.type === "agencyArray"
    ) {
      return node.value as AgencyArray;
    }
  }
  return null;
}

function resolveCalleeName(calleeName: string, aliasMap: AliasMap): string {
  return aliasMap[calleeName] ?? calleeName;
}

function lookupCalleeKinds(
  calleeName: string,
  localKinds: KindsByFunction,
  kindsByFile: KindsByFile,
): string[] {
  if (localKinds[calleeName]) return localKinds[calleeName];
  for (const fileKinds of Object.values(kindsByFile)) {
    if (fileKinds[calleeName]) return fileKinds[calleeName];
  }
  return [];
}

/**
 * Fixed-point iteration: for each function, union in the interrupt kinds of
 * all its callees. Repeat until no function gains new kinds. Converges because
 * sets only grow and the total number of distinct kinds is finite.
 */
function resolveTransitiveInterrupts(
  kindsByFile: KindsByFile,
  callGraphByFile: CallGraphByFile,
  aliasMaps: Record<FilePath, AliasMap>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [filePath, callGraph] of Object.entries(callGraphByFile)) {
      const kinds = kindsByFile[filePath];
      const aliasMap = aliasMaps[filePath] ?? {};
      for (const [funcName, callees] of Object.entries(callGraph)) {
        if (propagateFromCallees(funcName, callees, aliasMap, kinds, kindsByFile)) {
          changed = true;
        }
      }
    }
  }
}

function propagateFromCallees(
  funcName: FunctionName,
  callees: FunctionName[],
  aliasMap: AliasMap,
  localKinds: KindsByFunction,
  kindsByFile: KindsByFile,
): boolean {
  const currentKinds = localKinds[funcName] ?? [];
  let grew = false;
  for (const calleeName of callees) {
    const resolved = resolveCalleeName(calleeName, aliasMap);
    const calleeKinds = lookupCalleeKinds(resolved, localKinds, kindsByFile);
    for (const kind of calleeKinds) {
      if (!currentKinds.includes(kind)) {
        currentKinds.push(kind);
        grew = true;
      }
    }
  }
  localKinds[funcName] = currentKinds;
  return grew;
}

function attachInterruptKinds(
  files: Record<string, FileInput>,
  kindsByFile: KindsByFile,
): Record<string, FileSymbols> {
  const result: Record<string, FileSymbols> = {};
  for (const [filePath, { symbols }] of Object.entries(files)) {
    result[filePath] = attachKindsToSymbols(
      symbols,
      kindsByFile[filePath] ?? {},
    );
  }
  return result;
}

function attachKindsToSymbols(
  symbols: FileSymbols,
  kindsByFunction: KindsByFunction,
): FileSymbols {
  const result: FileSymbols = {};
  for (const [name, sym] of Object.entries(symbols)) {
    if (sym.kind === "function" || sym.kind === "node") {
      const kinds = kindsByFunction[name] ?? [];
      result[name] = {
        ...sym,
        interruptKinds: kinds.map((k) => ({ kind: k })),
      };
    } else {
      result[name] = sym;
    }
  }
  return result;
}
