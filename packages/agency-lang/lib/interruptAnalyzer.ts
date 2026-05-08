import type { AgencyProgram, AgencyNode } from "./types.js";
import type { FileSymbols, InterruptKind } from "./symbolTable.js";
import { walkNodes } from "./utils/node.js";

export type FileInput = {
  symbols: FileSymbols;
  program: AgencyProgram;
};

/** Maps function/node name to its interrupt kind strings. */
type KindsByFunction = Record<string, string[]>;

/** Maps file path to its per-function interrupt kinds. */
type KindsByFile = Record<string, KindsByFunction>;

/**
 * Analyze all files and return new FileSymbols with interruptKinds populated
 * on every function and node symbol.
 */
export function analyzeInterrupts(
  files: Record<string, FileInput>,
): Record<string, FileSymbols> {
  const kindsByFile = collectAllDirectInterrupts(files);
  return attachInterruptKinds(files, kindsByFile);
}

function collectAllDirectInterrupts(
  files: Record<string, FileInput>,
): KindsByFile {
  const result: KindsByFile = {};
  for (const [filePath, { program }] of Object.entries(files)) {
    result[filePath] = collectDirectInterrupts(program);
  }
  return result;
}

function collectDirectInterrupts(program: AgencyProgram): KindsByFunction {
  const result: KindsByFunction = {};
  for (const node of program.nodes) {
    if (node.type === "function") {
      result[node.functionName] = collectInterruptsInBody(node.body);
    } else if (node.type === "graphNode") {
      result[node.nodeName] = collectInterruptsInBody(node.body);
    }
  }
  return result;
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
