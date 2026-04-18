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
  it("should throw when skipping a required argument", () => {
    expect(() =>
      generateWithBuilder(`
def greet(name: string, greeting: string = "Hello") {
  print(name)
}
greet(greeting: "Hi")
`),
    ).toThrow("Missing required argument 'name' in call to 'greet'");
  });

  it("should throw on unknown named argument", () => {
    expect(() =>
      generateWithBuilder(`
def foo(a: string) {
  print(a)
}
foo(a: "hi", extra: "oops")
`),
    ).toThrow("Unknown named argument 'extra' in call to 'foo'");
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

  it("should accept reordered named arguments", () => {
    expect(() =>
      generateWithBuilder(`
def greet(name: string, greeting: string = "Hello") {
  print(name)
}
greet(greeting: "Hi", name: "world")
`),
    ).not.toThrow();
  });

  it("should throw on positional after named", () => {
    expect(() =>
      generateWithBuilder(`
def greet(name: string, greeting: string = "Hello") {
  print(name)
}
greet(name: "world", "Hi")
`),
    ).toThrow("Positional argument cannot follow a named argument");
  });

  it("should throw on duplicate named argument", () => {
    expect(() =>
      generateWithBuilder(`
def greet(name: string, greeting: string = "Hello") {
  print(name)
}
greet(name: "world", name: "other")
`),
    ).toThrow("Duplicate named argument 'name' in call to 'greet'");
  });

  it("should accept named args with block parameters", () => {
    expect(() =>
      generateWithBuilder(`
def twice(label: string, block: () => string): string {
  return block() + block()
}
twice(label: "test") as {
  return "hi"
}
`),
    ).not.toThrow();
  });
});

describe("Safe functions and methods", () => {
  it.each([
    { safe: true, methodName: "lookup", emitsRetryableFalse: false },
    { safe: false, methodName: "doSave", emitsRetryableFalse: true },
  ])("class method $methodName (safe=$safe) emitsRetryableFalse=$emitsRetryableFalse", ({ safe, methodName, emitsRetryableFalse }) => {
    const safeKeyword = safe ? "safe " : "";
    const code = `
import { saveItem } from "./tools.js"

class Svc {
  x: number

  ${safeKeyword}${methodName}(id: string): string {
    return saveItem(id)
  }
}
`;
    const output = generateWithBuilder(code);
    const methodMatch = output.match(new RegExp(`async ${methodName}\\([\\s\\S]*?finally`));
    expect(methodMatch).toBeTruthy();
    if (emitsRetryableFalse) {
      expect(methodMatch![0]).toContain("__retryable = false");
    } else {
      expect(methodMatch![0]).not.toContain("__retryable = false");
    }
  });

  it.each([
    { safe: true, funcName: "safeFnIf", emitsRetryableFalse: false, block: "if" },
    { safe: false, funcName: "unsafeFnIf", emitsRetryableFalse: true, block: "if" },
    { safe: true, funcName: "safeFnFor", emitsRetryableFalse: false, block: "for" },
    { safe: false, funcName: "unsafeFnFor", emitsRetryableFalse: true, block: "for" },
    { safe: true, funcName: "safeFnWhile", emitsRetryableFalse: false, block: "while" },
    { safe: false, funcName: "unsafeFnWhile", emitsRetryableFalse: true, block: "while" },
  ])("function $funcName with impure call in $block block (safe=$safe) emitsRetryableFalse=$emitsRetryableFalse", ({ safe, funcName, emitsRetryableFalse, block }) => {
    const safeKeyword = safe ? "safe " : "";
    const blocks: Record<string, string> = {
      "if": `if (shouldSave) {\n    return saveItem(id)\n  }`,
      "for": `for (item in items) {\n    saveItem(item)\n  }`,
      "while": `while (shouldSave) {\n    return saveItem(id)\n  }`,
    };
    const code = `
import { saveItem } from "./tools.js"

${safeKeyword}def ${funcName}(id: string, shouldSave: boolean, items: string[]): string {
  ${blocks[block]}
  return id
}
`;
    const output = generateWithBuilder(code);
    const funcMatch = output.match(new RegExp(`async function ${funcName}\\([\\s\\S]*?finally`));
    expect(funcMatch).toBeTruthy();
    if (emitsRetryableFalse) {
      expect(funcMatch![0]).toContain("__retryable = false");
    } else {
      expect(funcMatch![0]).not.toContain("__retryable = false");
    }
  });
});

describe("TypeName.schema access", () => {
  it("should throw on .schema for unrecognized type name", () => {
    expect(() =>
      generateWithBuilder(`
node main() {
  const schema = UnknownType.schema
}
`),
    ).toThrow("UnknownType");
  });

  it("should compile .schema for named type aliases", () => {
    expect(() =>
      generateWithBuilder(`
type Category = "bug" | "feature"
node main() {
  const schema = Category.schema
}
`),
    ).not.toThrow();
  });

  it("should compile .schema for builtin types", () => {
    expect(() =>
      generateWithBuilder(`
node main() {
  const schema = number.schema
}
`),
    ).not.toThrow();
  });
});

import { mapTypeToValidationSchema } from "./typescriptGenerator/typeToZodSchema.js";

describe("mapTypeToValidationSchema", () => {

  it("generates Result validation schema for bare Result", () => {
    const schema = mapTypeToValidationSchema(
      { type: "resultType", successType: { type: "primitiveType", value: "any" }, failureType: { type: "primitiveType", value: "any" } },
      {},
    );
    expect(schema).toContain("z.literal(true)");
    expect(schema).toContain("z.literal(false)");
  });

  it("generates Result validation schema with typed success", () => {
    const schema = mapTypeToValidationSchema(
      { type: "resultType", successType: { type: "primitiveType", value: "number" }, failureType: { type: "primitiveType", value: "string" } },
      {},
    );
    expect(schema).toContain("z.number()");
    expect(schema).toContain("z.literal(true)");
  });

  it("delegates non-Result types to mapTypeToZodSchema", () => {
    const schema = mapTypeToValidationSchema(
      { type: "primitiveType", value: "number" },
      {},
    );
    expect(schema).toBe("z.number()");
  });
});
