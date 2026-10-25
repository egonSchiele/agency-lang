import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { _prepareFunctions, type PreparedFunctions } from "./agencyFunctions.js";
import { _parseAST } from "./agency.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

const generatorCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../compiler/splice/runGenerator.js", () => ({
  runGenerator: () => {
    generatorCalls.count++;
    throw new Error("A supplied splice must never run during preparation");
  },
}));

const directories: string[] = [];
function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".prepare-functions-"));
  directories.push(dir);
  for (const [name, source] of Object.entries(files)) {
    const filename = path.join(dir, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, source);
  }
  return dir;
}

function executePrepared(
  prepared: PreparedFunctions,
  node: "invokeLearned" | "describeLearned",
  args: unknown[],
): unknown {
  const entryPath = prepared.compiled.entryPath ?? `${prepared.compiled.moduleId}.js`;
  const dir = fixture({
    ...prepared.compiled.modules,
    [entryPath]: prepared.compiled.code,
    "execute.mjs": `import { ${node} } from ${JSON.stringify(`./${entryPath}`)};
const result = await ${node}(...${JSON.stringify(args)});
process.stdout.write(JSON.stringify(result.data));`,
  });
  return JSON.parse(
    execFileSync(process.execPath, [path.join(dir, "execute.mjs")], {
      encoding: "utf8",
    }),
  );
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
  }
});

describe("function preparation", () => {
  it("compiles a def without a source node and retains the original module", () => {
    const prepared = _prepareFunctions(
      { kind: "source", source: "export def greet(name: string): string { return name }" },
      ["greet"],
    );
    expect(prepared.exportNames).toEqual(["greet"]);
    expect(prepared.invokeNode).toBe("invokeLearned");
    expect(prepared.sourceModule).toBe("");
    expect(prepared.metadataNode).toBeUndefined();
    expect(prepared.compiled.code).toContain("invokeLearned");
    expect(Object.values(prepared.compiled.modules ?? {}).join("\n")).toContain("greet");
  });

  it("preserves nested locations, private helpers, imported types, and local re-exports", () => {
    const dir = fixture({
      "nested/tools.agency":
        'import { Value, value } from "./helper.agency"\ndef privateValue(): Value { return value() }\nexport def getValue(): Value { return privateValue() }\n',
      "nested/helper.agency":
        'import { base } from "../base.agency"\nexport type Value = { count: number }\nexport def value(): Value { return { count: base() } }\n',
      "base.agency": "export def base(): number { return 17 }\n",
      "index.agency": 'export { getValue as renamed } from "./nested/tools.agency"\n',
    });
    const prepared = _prepareFunctions({ kind: "file", dir, filename: "index.agency" }, [
      "renamed",
    ]);
    expect(prepared.exportNames).toEqual(["renamed"]);
    expect(prepared.compiled.modules).toHaveProperty("nested/tools.js");
    expect(prepared.compiled.modules).toHaveProperty("nested/helper.js");
    expect(prepared.compiled.modules).toHaveProperty("base.js");
    fs.writeFileSync(path.join(dir, "base.agency"), "export def base(): number { return 99 }");
    fs.unlinkSync(path.join(dir, "nested/tools.agency"));
    expect(executePrepared(prepared, "invokeLearned", ["renamed", {}])).toEqual({ count: 17 });
  });

  it("prepares installed stdlib functions without reading them as supplied source", () => {
    const prepared = _prepareFunctions({ kind: "module", module: "std::data/finance/fred" }, [
      "fredSeriesInfo",
    ]);
    expect(prepared.sourceModule).toBe("std::data/finance/fred");
    expect(prepared.compiled.code).toContain("agency-lang/stdlib/data/finance/fred.js");
  });

  it("excludes hidden and internal functions from the default selection", () => {
    const prepared = _prepareFunctions(
      {
        kind: "source",
        source:
          "@hidden\nexport def hidden(): number { return 1 }\nexport def _internal(): number { return 2 }\nexport def visible(): number { return 3 }",
      },
      [],
    );
    expect(prepared.exportNames).toEqual(["visible"]);
  });

  it("refuses nodes and function-valued required parameters", () => {
    expect(() =>
      _prepareFunctions({ kind: "source", source: "export node start() { return 1 }" }, ["start"]),
    ).toThrow(/nodes are not supported/);
    expect(() =>
      _prepareFunctions(
        {
          kind: "source",
          source:
            "export def apply(callback: (value: number) -> number): number { return callback(1) }",
        },
        ["apply"],
      ),
    ).toThrow(/requires function parameter/);
  });

  it("rejects incomplete Code values", () => {
    const source = _parseAST("export def value(): number { return #number }");
    expect(() => _prepareFunctions({ kind: "source", source }, ["value"])).toThrow(
      /unfilled holes/,
    );
  });

  it("refuses splices before any generator executes", () => {
    const dir = fixture({
      "main.agency":
        'import { make } from "./generator.agency"\n$(make())\nexport def value(): number { return 1 }',
      "generator.agency":
        'import { Code } from "std::agency"\nexport def make(): Code { return [| export def injected(): number { return 2 } |] }',
    });
    const before = generatorCalls.count;
    expect(() =>
      _prepareFunctions({ kind: "file", dir, filename: "main.agency" }, ["value"]),
    ).toThrow(/compile-time splice/);
    expect(generatorCalls.count).toBe(before);
  });

  it("refuses foreign dependencies and globals outside the strict allowlist", () => {
    expect(() =>
      _prepareFunctions(
        { kind: "source", source: 'import fs from "fs"\nexport def value(): number { return 1 }' },
        ["value"],
      ),
    ).toThrow(/not Agency source/);
    expect(() =>
      _prepareFunctions(
        { kind: "source", source: "export def value(): any { return process.env }" },
        ["value"],
      ),
    ).toThrow(/process/);
  });

  it("refuses escaping and symlinked file inputs", () => {
    const dir = fixture({ "value.agency": "export def value(): number { return 1 }" });
    expect(() =>
      _prepareFunctions({ kind: "file", dir, filename: "../outside.agency" }, ["value"]),
    ).toThrow(/outside the sandbox/);
    fs.symlinkSync(path.join(dir, "value.agency"), path.join(dir, "link.agency"));
    expect(() =>
      _prepareFunctions({ kind: "file", dir, filename: "link.agency" }, ["value"]),
    ).toThrow(/symlink/);
  });
});
