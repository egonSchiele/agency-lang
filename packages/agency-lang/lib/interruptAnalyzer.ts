import type { AgencyProgram, AgencyNode, Expression } from "./types.js";
import type { AgencyArray } from "./types/dataStructures.js";
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

/**
 * Analyze all files and return new FileSymbols with interruptKinds populated
 * on every function and node symbol.
 */
export function analyzeInterrupts(
  files: Record<string, FileInput>,
): Record<string, FileSymbols> {
  const { kindsByFile, callGraphByFile } = collectAll(files);
  resolveTransitiveInterrupts(kindsByFile, callGraphByFile);
  return attachInterruptKinds(files, kindsByFile);
}

function collectAll(
  files: Record<string, FileInput>,
): { kindsByFile: KindsByFile; callGraphByFile: CallGraphByFile } {
  const kindsByFile: KindsByFile = {};
  const callGraphByFile: CallGraphByFile = {};
  for (const [filePath, { program }] of Object.entries(files)) {
    const { kinds, callGraph } = collectFromProgram(program);
    kindsByFile[filePath] = kinds;
    callGraphByFile[filePath] = callGraph;
  }
  return { kindsByFile, callGraphByFile };
}

function collectFromProgram(
  program: AgencyProgram,
): { kinds: KindsByFunction; callGraph: CallGraph } {
  const kinds: KindsByFunction = {};
  const callGraph: CallGraph = {};
  for (const node of program.nodes) {
    if (node.type === "function") {
      kinds[node.functionName] = collectInterruptsInBody(node.body);
      callGraph[node.functionName] = collectCalleesInBody(node.body);
    } else if (node.type === "graphNode") {
      kinds[node.nodeName] = collectInterruptsInBody(node.body);
      callGraph[node.nodeName] = collectCalleesInBody(node.body);
    }
  }
  return { kinds, callGraph };
}

function collectInterruptsInBody(body: AgencyNode[]): string[] {
  const kinds: string[] = [];
  for (const { node } of walkNodes(body)) {
    if (node.type === "interruptStatement") {
      if (!kinds.includes(node.kind)) {
        kinds.push(node.kind);
      }
    }
  }
  return kinds;
}

function addCallee(callees: string[], name: string): void {
  if (!callees.includes(name)) {
    callees.push(name);
  }
}

function collectCalleesInBody(body: AgencyNode[]): string[] {
  const callees: string[] = [];
  for (const { node } of walkNodes(body)) {
    if (node.type === "functionCall") {
      addCallee(callees, node.functionName);
      if (node.functionName === "llm") {
        for (const name of extractToolsFromLlmCall(node, body)) {
          addCallee(callees, name);
        }
      }
    } else if (node.type === "gotoStatement") {
      addCallee(callees, node.nodeCall.functionName);
    }
  }
  return callees;
}

function extractToolsFromLlmCall(
  call: FunctionCall,
  enclosingBody: AgencyNode[],
): string[] {
  if (call.arguments.length < 2) return [];
  const optionsArg = call.arguments[1];
  if (optionsArg.type !== "agencyObject") return [];
  const toolsEntry = optionsArg.entries.find(
    (e) => !("type" in e && e.type === "splat") && (e as { key: string }).key === "tools",
  );
  if (!toolsEntry || ("type" in toolsEntry && toolsEntry.type === "splat")) return [];
  const toolsValue = (toolsEntry as { value: Expression }).value;
  return extractFunctionNamesFromArray(toolsValue, enclosingBody);
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

function resolveTransitiveInterrupts(
  kindsByFile: KindsByFile,
  callGraphByFile: CallGraphByFile,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [filePath, callGraph] of Object.entries(callGraphByFile)) {
      const kinds = kindsByFile[filePath];
      for (const [funcName, callees] of Object.entries(callGraph)) {
        const currentKinds = kinds[funcName] ?? [];
        for (const calleeName of callees) {
          const calleeKinds = kinds[calleeName] ?? [];
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
