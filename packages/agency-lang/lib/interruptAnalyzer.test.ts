import { describe, it, expect } from "vitest";
import { parseAgency } from "./parser.js";
import { classifySymbols } from "./symbolTable.js";
import type { FileSymbols, FunctionSymbol, NodeSymbol } from "./symbolTable.js";
import { analyzeInterrupts } from "./interruptAnalyzer.js";

type AnalyzedFiles = Record<string, FileSymbols>;

function analyze(source: string): AnalyzedFiles {
  const result = parseAgency(source, {});
  if (!result.success) throw new Error("Parse failed");
  const program = result.result;
  const symbols = classifySymbols(program);
  return analyzeInterrupts({
    "test.agency": { symbols, program },
  });
}

function isFunctionOrNode(sym: unknown): sym is FunctionSymbol | NodeSymbol {
  const s = sym as { kind?: string };
  return s?.kind === "function" || s?.kind === "node";
}

function interruptKindsFor(files: AnalyzedFiles, name: string): string[] {
  const sym = files["test.agency"][name];
  if (!isFunctionOrNode(sym)) return [];
  return (sym.interruptKinds ?? []).map((ik) => ik.kind).sort();
}

describe("interruptAnalyzer", () => {
  describe("direct collection", () => {
    it("collects structured interrupt kind from a function", () => {
      const files = analyze(`
        def deploy(env: string) {
          interrupt myapp::deploy("Deploy to env?")
          print("deploying")
        }
      `);
      expect(interruptKindsFor(files, "deploy")).toEqual(["myapp::deploy"]);
    });

    it("collects bare interrupt as unknown kind", () => {
      const files = analyze(`
        def confirm() {
          interrupt("Are you sure?")
        }
      `);
      expect(interruptKindsFor(files, "confirm")).toEqual(["unknown"]);
    });

    it("collects multiple interrupt kinds from one function", () => {
      const files = analyze(`
        def riskyOp() {
          interrupt myapp::deploy("Deploy?")
          interrupt myapp::notify("Notify?")
        }
      `);
      expect(interruptKindsFor(files, "riskyOp")).toEqual([
        "myapp::deploy",
        "myapp::notify",
      ]);
    });

    it("deduplicates interrupt kinds", () => {
      const files = analyze(`
        def loopy() {
          interrupt myapp::deploy("first")
          interrupt myapp::deploy("second")
        }
      `);
      expect(interruptKindsFor(files, "loopy")).toEqual(["myapp::deploy"]);
    });

    it("returns empty for functions with no interrupts", () => {
      const files = analyze(`
        def add(a: number, b: number): number {
          return a + b
        }
      `);
      expect(interruptKindsFor(files, "add")).toEqual([]);
    });

    it("collects interrupt kinds from a node", () => {
      const files = analyze(`
        node main() {
          interrupt std::read("Confirm?")
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["std::read"]);
    });
  });
});
