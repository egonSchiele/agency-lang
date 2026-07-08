import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverOptimizeTargets } from "./targets.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-optimize-targets-"));
  tempDirs.push(dir);
  return dir;
}

function writeAgency(dir: string, relativePath: string, source: string): string {
  const file = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("discoverOptimizeTargets default base dir", () => {
  it("defaults to the closure's common ancestor when it lies outside cwd", () => {
    const dir = fs.realpathSync(makeTempDir());
    const entry = writeAgency(dir, "app/agent.agency", `
import { helper } from "../shared/prompts.agency"
node main() {}
`);
    writeAgency(dir, "shared/prompts.agency", `
optimize const prompt = "shared"
def helper() {
  return prompt
}
`);

    const targetSet = discoverOptimizeTargets(entry);

    expect(targetSet.baseDir).toBe(dir);
    expect(targetSet.entryFile).toBe("app/agent.agency");
    expect(Object.keys(targetSet.files).sort()).toEqual([
      "app/agent.agency",
      "shared/prompts.agency",
    ]);
  });

  it("defaults to cwd when the closure sits inside it", () => {
    const dir = fs.realpathSync(makeTempDir());
    const entry = writeAgency(dir, "nested/agent.agency", "optimize const prompt = \"hi\"\nnode main() {}\n");
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const targetSet = discoverOptimizeTargets(entry);

      expect(targetSet.baseDir).toBe(dir);
      expect(targetSet.entryFile).toBe("nested/agent.agency");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("discoverOptimizeTargets", () => {
  it("finds root, function-local, node-local, and imported optimize targets", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "foo.agency", `
import { helper } from "./helpers/prompts.agency"

optimize static const systemPrompt = "system"

def bar() {
  optimize const prompt = "function prompt"
}

node main() {
  optimize const nodePrompt = "node prompt"
}
`);
    writeAgency(dir, "helpers/prompts.agency", `
optimize const importedPrompt = "imported"
def helper() {
  return importedPrompt
}
`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });

    expect(targetSet.targets.map((target) => target.id)).toEqual([
      "foo.agency:bar:prompt",
      "foo.agency:global:systemPrompt",
      "foo.agency:main:nodePrompt",
      "helpers/prompts.agency:global:importedPrompt",
    ]);
    expect(targetSet.targets[0]).toMatchObject({
      id: "foo.agency:bar:prompt",
      kind: "variable",
      file: "foo.agency",
      scope: "bar",
      name: "prompt",
      valueKind: "string",
      value: "function prompt",
    });
    expect(Object.keys(targetSet.files).sort()).toEqual([
      "foo.agency",
      "helpers/prompts.agency",
    ]);
  });

  it("sorts targets by deterministic id", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "foo.agency", `
node zed() {
  optimize const z = "z"
}

optimize const a = "a"

def alpha() {
  optimize const b = "b"
}
`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });

    expect(targetSet.targets.map((target) => target.id)).toEqual([
      "foo.agency:alpha:b",
      "foo.agency:global:a",
      "foo.agency:zed:z",
    ]);
  });

  it("skips std, pkg, js, ts, and bare imports", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "foo.agency", `
import { read } from "std::fs"
import { helper } from "pkg::prompts"
import { jsHelper } from "./helper.js"
import { tsHelper } from "./helper.ts"
import { bare } from "bare.agency"

optimize const prompt = "root"
`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });

    expect(targetSet.targets.map((target) => target.id)).toEqual([
      "foo.agency:global:prompt",
    ]);
    expect(Object.keys(targetSet.files)).toEqual(["foo.agency"]);
  });

  it("handles import cycles once", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "a.agency", `
import { b } from "./b.agency"
optimize const aPrompt = "a"
`);
    writeAgency(dir, "b.agency", `
import { a } from "./a.agency"
optimize const bPrompt = "b"
`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });

    expect(targetSet.targets.map((target) => target.id)).toEqual([
      "a.agency:global:aPrompt",
      "b.agency:global:bPrompt",
    ]);
  });

  it("follows local named re-exports", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "main.agency", `
import { prompt } from "./lib.agency"
optimize const rootPrompt = "root"
`);
    writeAgency(dir, "lib.agency", `
export { prompt } from "./prompts.agency"
`);
    writeAgency(dir, "prompts.agency", `
optimize const prompt = "exported"
`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });

    expect(targetSet.targets.map((target) => target.id)).toEqual([
      "main.agency:global:rootPrompt",
      "prompts.agency:global:prompt",
    ]);
    expect(Object.keys(targetSet.files).sort()).toEqual([
      "lib.agency",
      "main.agency",
      "prompts.agency",
    ]);
  });

  it("follows local star re-exports", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "main.agency", `
import { prompt } from "./lib.agency"
`);
    writeAgency(dir, "lib.agency", `
export * from "./prompts.agency"
`);
    writeAgency(dir, "prompts.agency", `
optimize const prompt = "exported"
`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });

    expect(targetSet.targets.map((target) => target.id)).toEqual([
      "prompts.agency:global:prompt",
    ]);
  });

  it("collapses duplicate import spellings by canonical path", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "foo.agency", `
import { a } from "./shared.agency"
import { b } from "./nested/../shared.agency"
optimize const rootPrompt = "root"
`);
    writeAgency(dir, "shared.agency", `
optimize const sharedPrompt = "shared"
`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });

    expect(targetSet.targets.map((target) => target.id)).toEqual([
      "foo.agency:global:rootPrompt",
      "shared.agency:global:sharedPrompt",
    ]);
  });

  it("rejects nested-block optimize declarations", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "foo.agency", `
node main(flag: boolean) {
  if (flag) {
    optimize const prompt = "nested"
  }
}
`);

    expect(() => discoverOptimizeTargets(entry, { baseDir: dir })).toThrow(
      /nested block scopes are unsupported/i,
    );
  });

  it("rejects duplicate target ids", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "foo.agency", `
node main() {
  optimize const prompt = "first"
  optimize const prompt = "second"
}
`);

    expect(() => discoverOptimizeTargets(entry, { baseDir: dir })).toThrow(
      /duplicate optimize target id foo\.agency:main:prompt/i,
    );
  });

  it("requires an annotation for non-string literal initializers (v1)", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "foo.agency", `
node main() {
  optimize const temperature = 0.2
}
`);

    expect(() => discoverOptimizeTargets(entry, { baseDir: dir })).toThrow(
      /needs a type annotation/i,
    );
  });

  it("rejects non-literal initializers", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "foo.agency", `
def f(): number {
  return 1
}
optimize const x = f()
node main() {}
`);

    expect(() => discoverOptimizeTargets(entry, { baseDir: dir })).toThrow(
      /must be a literal/i,
    );
  });

  it("exposes aliases from the whole import closure, including imported ones", () => {
    const dir = fs.realpathSync(makeTempDir());
    writeAgency(dir, "types.agency", `export type Status = "pass" | "fail"\n`);
    const entry = writeAgency(dir, "agent.agency", `
import { Status } from "./types.agency"
optimize const status: Status = "pass"
node main() {}
`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });

    expect(targetSet.typeAliases.Status?.body.type).toBe("unionType");
  });

  it("keeps a bare string target freeform (constraint null)", () => {
    const dir = fs.realpathSync(makeTempDir());
    const entry = writeAgency(dir, "a.agency", `optimize const p = "hi \${x}"\nnode main() {}\n`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });
    const target = targetSet.targets.find((candidate) => candidate.name === "p")!;

    expect(target.declaredType).toBeNull();
    expect(target.valueKind).toBe("string");
    expect(target.value).toBe("hi ${x}");
  });

  it("treats a plain string annotation as freeform", () => {
    const dir = fs.realpathSync(makeTempDir());
    const entry = writeAgency(dir, "a.agency", `optimize const p: string = "hi"\nnode main() {}\n`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });

    expect(targetSet.targets[0].declaredType).toBeNull();
  });

  it("constrains an annotated boolean; value is the exact source text", () => {
    const dir = fs.realpathSync(makeTempDir());
    const entry = writeAgency(dir, "a.agency", `optimize const enabled: boolean = false\nnode main() {}\n`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });
    const target = targetSet.targets.find((candidate) => candidate.name === "enabled")!;

    expect(target.valueKind).toBe("literal");
    expect(target.value).toBe("false");
    expect(target.declaredType).toBe("boolean");
  });

  it("preserves quotes in a record target's value (formatter-exact rendering)", () => {
    const dir = fs.realpathSync(makeTempDir());
    const entry = writeAgency(dir, "a.agency", `type Person = { name: string; age: number }
optimize const person: Person = { name: "foo", age: 0 }
node main() {}
`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });
    const target = targetSet.targets.find((candidate) => candidate.name === "person")!;

    // Formatter-canonical (multi-line) rendering; the load-bearing property
    // is that string field values keep their quotes — `"foo"`, not `foo`.
    expect(target.value).toBe(`{\n  name: "foo",\n  age: 0\n}`);
    expect(target.value).toContain(`"foo"`);
    expect(target.declaredType).toBe("Person");
  });

  it("accepts a null initializer (variableName representation)", () => {
    const dir = fs.realpathSync(makeTempDir());
    const entry = writeAgency(dir, "a.agency", `optimize const x: number | null = null\nnode main() {}\n`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });
    const target = targetSet.targets.find((candidate) => candidate.name === "x")!;

    expect(target.value).toBe("null");
    expect(target.valueKind).toBe("literal");
  });

  it("BASELINE SELF-TEST: unconstrains a target whose own baseline fails its annotation", () => {
    const dir = fs.realpathSync(makeTempDir());
    // `NotDefined` is not in the closure — the original value cannot pass
    // the probe, so the target must become unconstrained rather than
    // un-mutatable. literal + null constraint = unconstrained, NOT freeform.
    const entry = writeAgency(dir, "a.agency", `optimize const x: NotDefined = 5\nnode main() {}\n`);

    const targetSet = discoverOptimizeTargets(entry, { baseDir: dir });
    const target = targetSet.targets.find((candidate) => candidate.name === "x")!;

    expect(target.declaredType).toBeNull();
    expect(target.valueKind).toBe("literal");
  });

  it("rejects legacy @optimize tags", () => {
    const dir = makeTempDir();
    const entry = writeAgency(dir, "foo.agency", `
node main() {
  @optimize
  const result = llm("hello")
}
`);

    expect(() => discoverOptimizeTargets(entry, { baseDir: dir })).toThrow(
      /@optimize\(\.\.\.\).*no longer supported/i,
    );
  });
});
