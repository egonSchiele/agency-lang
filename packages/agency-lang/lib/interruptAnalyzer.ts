import type { AgencyProgram, AgencyNode } from "./types.js";
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

function collectCalleesInBody(body: AgencyNode[]): string[] {
  const callees: string[] = [];
  for (const { node } of walkNodes(body)) {
    if (node.type === "functionCall") {
      if (!callees.includes(node.functionName)) {
        callees.push(node.functionName);
      }
    } else if (node.type === "gotoStatement") {
      const name = node.nodeCall.functionName;
      if (!callees.includes(name)) {
        callees.push(name);
      }
    }
  }
  return callees;
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
