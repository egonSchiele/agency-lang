import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { collectProgramInfo } from "@/programInfo.js";
import { printTs } from "../ir/prettyPrint.js";
import fs from "fs";
import path from "path";

interface FixturePair {
  name: string;
  agencyPath: string;
  mtsPath: string;
  agencyContent: string;
  expectedTS: string;
}

function discoverFixtures(fixtureDir: string): FixturePair[] {
  const fixtures: FixturePair[] = [];

  function scanDirectory(dir: string, relativePath: string = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        scanDirectory(fullPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith(".agency")) {
        const baseName = entry.name.replace(".agency", "");
        const mtsPath = path.join(dir, `${baseName}.mjs`);

        if (fs.existsSync(mtsPath)) {
          const nameWithoutExt = relativePath
            ? `${relativePath}/${baseName}`
            : baseName;

          try {
            fixtures.push({
              name: nameWithoutExt,
              agencyPath: fullPath,
              mtsPath: mtsPath,
              agencyContent: fs.readFileSync(fullPath, "utf-8"),
              expectedTS: fs.readFileSync(mtsPath, "utf-8"),
            });
          } catch (error) {
            console.error(
              `Cannot read fixture ${fullPath}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        } else {
          console.warn(`Warning: No corresponding .mjs file for ${fullPath}`);
        }
      }
    }
  }

  scanDirectory(fixtureDir);
  return fixtures.sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeWhitespace(code: string): string {
  return (
    code
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n\n\n+/g, "\n\n")
      .trim()
      .concat("\n")
  );
}

export function generateWithBuilder(agencySource: string, moduleId: string = "test.agency"): string {
  const parseResult = parseAgency(agencySource, {}, false);
  if (!parseResult.success) {
    throw new Error(`Failed to parse: ${parseResult.message}`);
  }
  const info = collectProgramInfo(parseResult.result);
  const preprocessor = new TypescriptPreprocessor(parseResult.result, {}, info);
  const preprocessedProgram = preprocessor.preprocess();
  const builder = new TypeScriptBuilder(undefined, info, moduleId);
  const ir = builder.build(preprocessedProgram);
  return printTs(ir);
}

const FIXTURES_DIR = path.resolve(
  __dirname,
  "../../tests/typescriptBuilder",
);

describe("TypeScript Builder Integration Tests", () => {
  const fixtures = discoverFixtures(FIXTURES_DIR);

  if (fixtures.length === 0) {
    it("should find test fixtures (add .agency + .mjs pairs to tests/typescriptBuilder/)", () => {
      // No fixtures yet — this is expected initially.
      // Add .agency files and run `make builder-fixtures` to generate .mjs files.
      expect(true).toBe(true);
    });
    return;
  }

  describe.each(fixtures)(
    "Fixture: $name",
    ({ name, agencyPath, agencyContent, expectedTS }) => {
      it("should generate correct TypeScript output", () => {
        let generatedTS: string;
        try {
          generatedTS = generateWithBuilder(agencyContent, name + ".agency");
        } catch (error) {
          throw new Error(
            `Failed to generate TypeScript for fixture: ${name}\nFile: ${agencyPath}\nError: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        expect(normalizeWhitespace(generatedTS)).toBe(
          normalizeWhitespace(expectedTS),
        );
      });
    },
  );
});

describe("Named argument validation", () => {
  it("should throw on mismatched named argument", () => {
    expect(() =>
      generateWithBuilder(`
def greet(name: string, greeting: string = "Hello") {
  print(name)
}
greet(greeting: "Hi")
`),
    ).toThrow("Named argument 'greeting' does not match parameter 'name' at position 1");
  });

  it("should throw on named argument beyond parameter list", () => {
    expect(() =>
      generateWithBuilder(`
def foo(a: string) {
  print(a)
}
foo(a: "hi", extra: "oops")
`),
    ).toThrow("Named argument 'extra' at position 2 is beyond the parameter list");
  });

  it("should accept correct named arguments", () => {
    expect(() =>
      generateWithBuilder(`
def greet(name: string, greeting: string = "Hello") {
  print(name)
}
greet(name: "world", greeting: "Hi")
`),
    ).not.toThrow();
  });
});

describe("Safe class methods", () => {
  it("safe method does not emit __retryable = false for impure calls", () => {
    const code = `
import { saveItem } from "./tools.js"

class Svc {
  x: number

  safe lookup(id: string): string {
    return saveItem(id)
  }
}
`;
    const output = generateWithBuilder(code);
    // The method body should NOT contain __retryable = false
    // Extract just the lookup method body
    const methodMatch = output.match(/async lookup\([\s\S]*?finally/);
    expect(methodMatch).toBeTruthy();
    expect(methodMatch![0]).not.toContain("__retryable = false");
  });

  it("non-safe method emits __retryable = false for impure calls", () => {
    const code = `
import { saveItem } from "./tools.js"

class Svc {
  x: number

  doSave(id: string): string {
    return saveItem(id)
  }
}
`;
    const output = generateWithBuilder(code);
    const methodMatch = output.match(/async doSave\([\s\S]*?finally/);
    expect(methodMatch).toBeTruthy();
    expect(methodMatch![0]).toContain("__retryable = false");
  });
});
