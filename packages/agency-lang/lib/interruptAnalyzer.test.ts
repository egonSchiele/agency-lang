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

  describe("block arguments", () => {
    it("attributes trailing block interrupts to the calling function", () => {
      const files = analyze(`
        def doWork(items: string[], block: (string) => any): any[] {
          return []
        }
        node main() {
          const result = doWork(["a"]) as item {
            interrupt myapp::process("Process item?")
            return item
          }
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["myapp::process"]);
      expect(interruptKindsFor(files, "doWork")).toEqual([]);
    });

    it("attributes inline block interrupts to the calling function", () => {
      const files = analyze(`
        def doWork(items: string[], block: (string) => any): any[] {
          return []
        }
        node main() {
          const result = doWork(["a"], \\item -> interrupt myapp::process("Process?"))
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["myapp::process"]);
      expect(interruptKindsFor(files, "doWork")).toEqual([]);
    });
  });

  describe("transitive propagation", () => {
    it("propagates interrupt kinds through function calls", () => {
      const files = analyze(`
        def deploy() {
          interrupt myapp::deploy("Deploy?")
        }
        def orchestrate() {
          deploy()
        }
      `);
      expect(interruptKindsFor(files, "orchestrate")).toEqual(["myapp::deploy"]);
    });

    it("propagates through multiple levels", () => {
      const files = analyze(`
        def deploy() {
          interrupt myapp::deploy("Deploy?")
        }
        def orchestrate() {
          deploy()
        }
        node main() {
          orchestrate()
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["myapp::deploy"]);
    });

    it("propagates through node-to-node calls", () => {
      const files = analyze(`
        node checkout() {
          interrupt payment::charge("Charge?")
        }
        node main() {
          return checkout()
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["payment::charge"]);
    });

    it("unions interrupt kinds from multiple callees", () => {
      const files = analyze(`
        def deploy() {
          interrupt myapp::deploy("Deploy?")
        }
        def notify() {
          interrupt myapp::notify("Notify?")
        }
        def orchestrate() {
          deploy()
          notify()
        }
      `);
      expect(interruptKindsFor(files, "orchestrate")).toEqual([
        "myapp::deploy",
        "myapp::notify",
      ]);
    });

    it("handles cycles (mutual recursion)", () => {
      const files = analyze(`
        def ping(n: number) {
          interrupt myapp::ping("ping")
          pong(n)
        }
        def pong(n: number) {
          interrupt myapp::pong("pong")
          ping(n)
        }
      `);
      expect(interruptKindsFor(files, "ping")).toEqual(["myapp::ping", "myapp::pong"]);
      expect(interruptKindsFor(files, "pong")).toEqual(["myapp::ping", "myapp::pong"]);
    });
  });

  describe("llm tools analysis", () => {
    it("collects interrupt kinds from tools in llm() call", () => {
      const files = analyze(`
        def deploy() {
          interrupt myapp::deploy("Deploy?")
        }
        def cleanup() {
          interrupt myapp::cleanup("Clean?")
        }
        node main() {
          const result = llm("do stuff", { tools: [deploy, cleanup] })
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual([
        "myapp::cleanup",
        "myapp::deploy",
      ]);
    });

    it("traces tools variable to array literal", () => {
      const files = analyze(`
        def deploy() {
          interrupt myapp::deploy("Deploy?")
        }
        node main() {
          const tools = [deploy]
          const result = llm("do stuff", { tools: tools })
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["myapp::deploy"]);
    });

    it("handles llm() with no tools option", () => {
      const files = analyze(`
        node main() {
          const result = llm("do stuff")
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual([]);
    });

    it("handles llm() with tools containing partial applications", () => {
      const files = analyze(`
        def deploy(env: string) {
          interrupt myapp::deploy("Deploy?")
        }
        node main() {
          const result = llm("do stuff", { tools: [deploy.partial(env: "prod")] })
        }
      `);
      expect(interruptKindsFor(files, "main")).toEqual(["myapp::deploy"]);
    });
  });

  describe("interrupts in control flow", () => {
    it("collects interrupts inside if/else branches", () => {
      const files = analyze(`
        def riskyOp(flag: boolean) {
          if (flag) {
            interrupt myapp::deploy("Deploy?")
          } else {
            interrupt myapp::rollback("Rollback?")
          }
        }
      `);
      expect(interruptKindsFor(files, "riskyOp")).toEqual([
        "myapp::deploy",
        "myapp::rollback",
      ]);
    });

    it("collects interrupts inside loops", () => {
      const files = analyze(`
        def processAll(items: string[]) {
          for (item in items) {
            interrupt myapp::process("Process item?")
          }
        }
      `);
      expect(interruptKindsFor(files, "processAll")).toEqual(["myapp::process"]);
    });
  });

  describe("combined direct and transitive", () => {
    it("collects both direct and transitive interrupt kinds", () => {
      const files = analyze(`
        def deploy() {
          interrupt myapp::deploy("Deploy?")
        }
        def orchestrate() {
          interrupt myapp::start("Starting?")
          deploy()
        }
      `);
      expect(interruptKindsFor(files, "orchestrate")).toEqual([
        "myapp::deploy",
        "myapp::start",
      ]);
    });
  });
});
