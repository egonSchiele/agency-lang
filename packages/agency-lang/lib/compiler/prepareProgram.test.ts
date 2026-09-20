import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { ImportResolutionError } from "../importResolutionError.js";
import { safeDeleteDirectory } from "../utils.js";
import { walkNodesArray } from "../utils/node.js";
import { prepareProgram, throwImportFailures, type PrepareOptions } from "./prepareProgram.js";

let dir: string;

beforeEach(() => {
  dir = path.join(process.cwd(), ".agency-tmp", `prepare-${nanoid()}`);
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  safeDeleteDirectory(dir, false);
});

function write(name: string, source: string): string {
  const target = path.join(dir, name);
  fs.writeFileSync(target, source, "utf-8");
  return target;
}

function prepare(name: string, source: string, options?: PrepareOptions) {
  return prepareProgram(source, write(name, source), {}, options);
}

function stages(result: ReturnType<typeof prepareProgram>): string[] {
  return result.diagnostics.map((found) => found.stage);
}

function importCodes(result: ReturnType<typeof prepareProgram>): (string | undefined)[] {
  return result.diagnostics.map((found) =>
    found.stage === "imports" && found.error instanceof ImportResolutionError
      ? found.error.code
      : undefined,
  );
}

const HELPER = `export def helper(): string {\n  return "hi"\n}\n\ndef hidden(): string {\n  return "no"\n}\n`;

describe("prepareProgram", () => {
  it("resolves imports, so an imported function lands in the compilation unit", () => {
    write("helper.agency", HELPER);
    const result = prepare(
      "main.agency",
      `import { helper } from "./helper.agency"\n\nnode main() {\n  print(helper())\n}\n`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.keys(result.info.importedFunctions)).toContain("helper");
    expect(result.diagnostics).toEqual([]);
  });

  it("lifts a callback block to a top-level function", () => {
    const result = prepare(
      "main.agency",
      `node main() {\n  callback("onNodeStart") as data {\n    print(data.nodeName)\n  }\n}\n`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const topLevelFunctions = result.program.nodes.filter((node) => node.type === "function");
    expect(topLevelFunctions).toHaveLength(1);
  });

  it("reports a parse failure with its position", () => {
    const result = prepare("main.agency", `node main( {\n`);
    expect(result.ok).toBe(false);
    expect(stages(result)).toEqual(["parse"]);
  });

  describe("a bad import", () => {
    const source = `import { hidden } from "./helper.agency"\n\nnode main() {\n  print(hidden())\n}\n`;

    beforeEach(() => {
      write("helper.agency", HELPER);
    });

    it("stops the pipeline by default", () => {
      const result = prepare("main.agency", source);
      expect(result.ok).toBe(false);
      expect(stages(result)).toEqual(["imports"]);
      expect(() => throwImportFailures(result.diagnostics)).toThrow(/not exported/);
    });

    it("carries the type checker's code for the same mistake", () => {
      const missingModule = `import { helper } from "./nope.agency"\n\nnode main() {\n  print(1)\n}\n`;
      expect(importCodes(prepare("main.agency", source))).toEqual(["AG4010"]);
      expect(importCodes(prepare("other.agency", missingModule))).toEqual(["AG4009"]);
    });

    it("is reported and passed over under keepGoing", () => {
      const result = prepare("main.agency", source, { keepGoing: true });
      expect(result.ok).toBe(true);
      expect(stages(result)).toEqual(["imports"]);
    });
  });

  describe("import test", () => {
    const source = `import test { hidden } from "./helper.agency"\n\nnode main() {\n  print(hidden())\n}\n`;

    beforeEach(() => {
      write("helper.agency", HELPER);
    });

    it("is refused by default", () => {
      expect(stages(prepare("main.agency", source))).toEqual(["imports"]);
    });

    it("is honored when the caller allows it", () => {
      const result = prepare("main.agency", source, { allowTestImports: true });
      expect(result.ok).toBe(true);
      expect(result.diagnostics).toEqual([]);
    });
  });

  describe("vet", () => {
    it("refuses the program as written, before anything else runs", () => {
      const result = prepare("main.agency", `node main() {\n  print(1)\n}\n`, {
        vet: () => ["no", "never"],
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual([
        { stage: "vet", message: "no" },
        { stage: "vet", message: "never" },
      ]);
    });

    it("runs once on the parse and once after splices expand", () => {
      let calls = 0;
      const result = prepare("main.agency", `node main() {\n  print(1)\n}\n`, {
        vet: () => {
          calls += 1;
          return [];
        },
      });
      expect(result.ok).toBe(true);
      expect(calls).toBe(2);
    });
  });

  describe("splices", () => {
    // `refuseSplices` fails every splice before its generator is looked up.
    // gen.agency still has to exist, or its import fails as well.
    beforeEach(() => {
      write("gen.agency", `export def makeGreet(): number {\n  return 1\n}\n`);
    });

    const host = `import { makeGreet } from "./gen.agency"\n\n$( makeGreet() )\n\nnode main() {\n  print(1)\n}\n`;

    it("stops at a splice that will not expand", () => {
      const result = prepareProgram(host, write("host.agency", host), { refuseSplices: true });
      expect(result.ok).toBe(false);
      expect(stages(result)).toEqual(["splice"]);
    });

    it("keeps the unexpanded program under keepGoing", () => {
      const result = prepareProgram(
        host,
        write("host.agency", host),
        { refuseSplices: true },
        { keepGoing: true },
      );
      expect(result.ok).toBe(true);
      expect(stages(result)).toEqual(["splice"]);
    });
  });

  describe("applyTemplate: false", () => {
    const source = `import { map } from "std::index"\n\ndef map(): number {\n  return 1\n}\n\nnode main() {\n  print(map())\n}\n`;

    it("adds the prelude import to the program instead of the text", () => {
      const result = prepare("main.agency", `node main() {\n  print(1)\n}\n`, {
        applyTemplate: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(Object.keys(result.info.importedFunctions)).toContain("print");
      expect(result.parsed.nodes.some((node) => node.type === "importStatement")).toBe(false);
    });

    it("leaves `parsed` as written when a shadowed prelude name is pruned", () => {
      const result = prepare("main.agency", source, { applyTemplate: false });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const importedNames = (program: typeof result.program) =>
        walkNodesArray(program.nodes)
          .map(({ node }) => node)
          .filter((node) => node.type === "importStatement" && node.modulePath === "std::index")
          .flatMap((node) => (node.type === "importStatement" ? node.importedNames : []))
          .flatMap((spec) => (spec.type === "namedImport" ? spec.importedNames : []));
      expect(importedNames(result.parsed)).toContain("map");
    });
  });
});
