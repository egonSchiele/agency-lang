import type { AgencyProgram, AgencyNode, Expression } from "./types.js";
import type { AgencyArray, AgencyObjectKV, SplatExpression } from "./types/dataStructures.js";
import type { FunctionCall } from "./types/function.js";
import type { FileSymbols } from "./symbolTable.js";
import { walkNodes } from "./utils/node.js";

export type FileInput = {
  symbols: FileSymbols;
  program: AgencyProgram;
};

/** Maps function/node name to its interrupt kind strings. */
type KindsByFunction = Record<string, string[]>;

/** Maps file path to its per-function interrupt kinds. */
type KindsByFile = Record<string, KindsByFunction>;

/** Maps function/node name to the names of functions it calls. */
type CallGraph = Record<string, string[]>;

/** Maps file path to its per-function call graph. */
type CallGraphByFile = Record<string, CallGraph>;

/** Maps local alias name to original function name. */
type AliasMap = Record<string, string>;

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

function addUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) {
    arr.push(value);
  }
}

function collectFromBody(
  body: AgencyNode[],
): { interruptKinds: string[]; callees: string[] } {
  const interruptKinds: string[] = [];
  const callees: string[] = [];
  for (const { node } of walkNodes(body)) {
    if (node.type === "interruptStatement") {
      addUnique(interruptKinds, node.kind);
    } else if (node.type === "functionCall") {
      addUnique(callees, node.functionName);
      if (node.functionName === "llm") {
        for (const name of extractToolsFromLlmCall(node, body)) {
          addUnique(callees, name);
        }
      }
    } else if (node.type === "gotoStatement") {
      addUnique(callees, node.nodeCall.functionName);
    }
  }
  return { interruptKinds, callees };
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

function resolveTransitiveInterrupts(
  kindsByFile: KindsByFile,
  callGraphByFile: CallGraphByFile,
  aliasMaps: Record<string, AliasMap>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [filePath, callGraph] of Object.entries(callGraphByFile)) {
      const kinds = kindsByFile[filePath];
      const aliasMap = aliasMaps[filePath] ?? {};
      for (const [funcName, callees] of Object.entries(callGraph)) {
        const currentKinds = kinds[funcName] ?? [];
        for (const calleeName of callees) {
          const resolved = resolveCalleeName(calleeName, aliasMap);
          const calleeKinds = lookupCalleeKinds(resolved, kinds, kindsByFile);
          for (const kind of calleeKinds) {
            if (!currentKinds.includes(kind)) {
              currentKinds.push(kind);
              changed = true;
            }
          }
        }
        kinds[funcName] = currentKinds;
      }
    }
  }
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
