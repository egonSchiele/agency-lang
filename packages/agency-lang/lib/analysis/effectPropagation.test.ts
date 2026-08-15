import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SymbolTable } from "../symbolTable.js";
import { makeAgencyTempDir } from "../utils/agencyTempDir.js";
import { safeDeleteDirectory } from "../utils.js";

let dir: string;
beforeEach(() => {
  dir = makeAgencyTempDir("effectprop");
});
afterEach(() => {
  safeDeleteDirectory(dir, false);
});

function write(name: string, source: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, source, "utf-8");
  return filePath;
}

function effectsIn(entry: string, file: string, name: string): string[] {
  const table = SymbolTable.build(entry, {});
  const sym = table.getFile(path.resolve(file))?.[name];
  if (!sym || (sym.kind !== "function" && sym.kind !== "node")) {
    throw new Error(`no callable symbol '${name}' in ${file}`);
  }
  return (sym.interruptEffects ?? []).map((entry) => entry.effect).sort();
}

function effectsOf(entry: string, name: string): string[] {
  return effectsIn(entry, entry, name);
}

const RISKY = `export def h(): string {\n  return read("data.txt")\n}\n`;

describe("effect propagation across files", () => {
  it("carries an effect from a helper that wraps a stdlib call", () => {
    write("helper.agency", RISKY);
    const main = write(
      "main.agency",
      `import { h } from "./helper.agency"\nexport def caller(): string {\n  return h()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual(["std::read"]);
  });

  it("carries an effect into a graph node, which is the reported bug", () => {
    write("helper.agency", RISKY);
    const main = write(
      "main.agency",
      `import { h } from "./helper.agency"\nnode main() {\n  const x = h()\n}\n`,
    );
    expect(effectsOf(main, "main")).toEqual(["std::read"]);
  });

  it("carries an effect through a chain of two helpers", () => {
    write(
      "helper.agency",
      `export def inner(): string {\n  return read("data.txt")\n}\n` +
        `export def outer(): string {\n  return inner()\n}\n`,
    );
    const main = write(
      "main.agency",
      `import { outer } from "./helper.agency"\nexport def caller(): string {\n  return outer()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual(["std::read"]);
  });

  it("carries std::guard out of a helper that uses a guard block", () => {
    write(
      "helper.agency",
      `export def h(): string {\n  const r = guard(cost: $0.50) {\n    return "hi"\n  }\n  return "done"\n}\n`,
    );
    const main = write(
      "main.agency",
      `import { h } from "./helper.agency"\nexport def caller(): string {\n  return h()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual(["std::guard"]);
  });

  it("leaves _guard itself reporting std::guard", () => {
    // _guard has no `interrupt` in its body; its label comes from the seed
    // table. Recomputing direct effects from a body walk would erase it and
    // silently remove cost caps from every consumer.
    const main = write("main.agency", `export def caller(): string {\n  return "hi"\n}\n`);
    const table = SymbolTable.build(main, {});
    const stdlib = table
      .filePaths()
      .find((file) => file.endsWith(path.join("stdlib", "index.agency")));
    expect(stdlib).toBeDefined();
    const sym = table.getFile(stdlib as string)?.["_guard"];
    const labels =
      sym && (sym.kind === "function" || sym.kind === "node")
        ? (sym.interruptEffects ?? []).map((entry) => entry.effect)
        : [];
    expect(labels).toContain("std::guard");
  });

  it("follows a renamed import", () => {
    write("helper.agency", RISKY);
    const main = write(
      "main.agency",
      `import { h as g } from "./helper.agency"\nexport def caller(): string {\n  return g()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual(["std::read"]);
  });

  it("follows an imported node", () => {
    write("worker.agency", `node work() {\n  const x = read("data.txt")\n}\n`);
    const main = write(
      "main.agency",
      `import node { work } from "./worker.agency"\nnode main() {\n  goto work()\n}\n`,
    );
    expect(effectsOf(main, "main")).toEqual(["std::read"]);
  });

  it("does not confuse two reachable files that define the same name", () => {
    // Both files must be reachable, or the crawl never parses the risky one and
    // the test would pass under a resolver that ignored file identity.
    write("risky.agency", RISKY);
    write("safe.agency", `export def h(): string {\n  return "nothing"\n}\n`);
    const main = write(
      "main.agency",
      `import { h } from "./safe.agency"\n` +
        `import { h as riskyH } from "./risky.agency"\n` +
        `export def caller(): string {\n  return h()\n}\n` +
        `export def other(): string {\n  return riskyH()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual([]);
    expect(effectsOf(main, "other")).toEqual(["std::read"]);
  });

  it("does not give a clean callee its caller's effects", () => {
    write("helper.agency", `export def clean(): string {\n  return "hi"\n}\n`);
    const main = write(
      "main.agency",
      `import { clean } from "./helper.agency"\n` +
        `export def risky(): string {\n  read("x")\n  return clean()\n}\n`,
    );
    expect(effectsIn(main, path.join(dir, "helper.agency"), "clean")).toEqual([]);
  });

  it("terminates on an import cycle and still propagates", () => {
    write(
      "a.agency",
      `import { b } from "./b.agency"\nexport def a(): string {\n  return b()\n}\n`,
    );
    write(
      "b.agency",
      `import { a } from "./a.agency"\nexport def b(): string {\n  return read("x")\n}\n`,
    );
    expect(effectsOf(path.join(dir, "a.agency"), "a")).toEqual(["std::read"]);
  });

  it("survives a file in the crawl that does not parse", () => {
    // The crawl is deliberately best-effort, and the editor hits half-typed
    // files constantly. The pass must not throw where the crawl kept going.
    write("broken.agency", `export def oops(: {{{\n`);
    write("helper.agency", RISKY);
    const main = write(
      "main.agency",
      `import { h } from "./helper.agency"\n` +
        `import { oops } from "./broken.agency"\n` +
        `export def caller(): string {\n  return h()\n}\n`,
    );
    expect(() => effectsOf(main, "caller")).not.toThrow();
    expect(effectsOf(main, "caller")).toEqual(["std::read"]);
  });
});

describe("imports that cannot be resolved", () => {
  it("keeps propagating the rest of a file alongside an uninstalled pkg import", () => {
    // resolveAgencyImportPath throws for an uninstalled package. The crawl
    // skips that import and keeps going, so the pass must too, or one missing
    // dependency would blank out every other import in the same file.
    write("helper.agency", RISKY);
    const main = write(
      "main.agency",
      `import { h } from "./helper.agency"\n` +
        `import { thing } from "pkg::@definitely/not-installed-xyz"\n` +
        `export def caller(): string {\n  return h()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual(["std::read"]);
  });
});

describe("re-exported names", () => {
  const barrels: { label: string; barrel: string; importName: string }[] = [
    {
      label: "a named re-export",
      barrel: `export { h } from "./helper.agency"\n`,
      importName: "h",
    },
    {
      label: "a renamed re-export",
      barrel: `export { h as g } from "./helper.agency"\n`,
      importName: "g",
    },
    {
      label: "a star re-export",
      barrel: `export * from "./helper.agency"\n`,
      importName: "h",
    },
  ];

  for (const { label, barrel, importName } of barrels) {
    it(`follows ${label}`, () => {
      write("helper.agency", RISKY);
      write("barrel.agency", barrel);
      const main = write(
        "main.agency",
        `import { ${importName} } from "./barrel.agency"\n` +
          `export def caller(): string {\n  return ${importName}()\n}\n`,
      );
      expect(effectsOf(main, "caller")).toEqual(["std::read"]);
    });
  }

  it("follows two re-export hops", () => {
    write("helper.agency", RISKY);
    write("inner.agency", `export { h } from "./helper.agency"\n`);
    write("outer.agency", `export { h } from "./inner.agency"\n`);
    const main = write(
      "main.agency",
      `import { h } from "./outer.agency"\nexport def caller(): string {\n  return h()\n}\n`,
    );
    expect(effectsOf(main, "caller")).toEqual(["std::read"]);
  });

  it("records the effect on the barrel's own symbol too", () => {
    // buildCompilationUnit seeds from the barrel's symbols when a file imports
    // from it, so the barrel's copy has to be right, not only the origin's.
    write("helper.agency", RISKY);
    const barrel = write("barrel.agency", `export { h } from "./helper.agency"\n`);
    expect(effectsOf(barrel, "h")).toEqual(["std::read"]);
  });
});
