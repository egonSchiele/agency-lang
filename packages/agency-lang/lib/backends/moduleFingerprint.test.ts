import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileSource } from "../compiler/compile.js";
import { sha256Text } from "../utils/hash.js";
import { generateTypeScript } from "./typescriptGenerator.js";
import { parseAgency } from "../parser.js";

const FILE = path.join(os.tmpdir(), "agency-modfp-itest.agency");

const REGISTRATION =
  /\n__registerModuleFingerprint\("([^"]+)", "([0-9a-f]{64})", import\.meta\.url\);\n$/;

function generate(source: string): string {
  const parsed = parseAgency(source, {}, true);
  if (!parsed.success) {
    throw new Error("parse failed");
  }
  return generateTypeScript(parsed.result, {}, undefined, "mod.agency", undefined, undefined, true);
}

const BASE = `
export node main(x: number) {
  const doubled = double(x)
  const ok = interrupt("proceed?")
  return doubled
}
def double(n: number): number {
  return n * 2
}
`;

describe("module fingerprint emission", () => {
  it("appends a registration whose hash covers the printed output before it", () => {
    const code = generate(BASE);
    const registration = code.match(REGISTRATION);
    if (!registration) {
      throw new Error("no __registerModuleFingerprint emission found");
    }
    expect(registration[1]).toBe("mod.agency");
    const withoutRegistration = code.slice(0, code.length - registration[0].length);
    expect(registration[2]).toBe(sha256Text(withoutRegistration));
  });

  it("identical input generates identical bytes (incremental emit stays byte-identical)", () => {
    expect(generate(BASE)).toBe(generate(BASE));
  });

  it("a code change changes the fingerprint", () => {
    const changedHash = generate(BASE.replace("return n * 2", "return n * 3")).match(REGISTRATION);
    const baseHash = generate(BASE).match(REGISTRATION);
    expect(changedHash![2]).not.toBe(baseHash![2]);
  });

  it("compileSource programs register no fingerprint (no stable module identity)", () => {
    fs.writeFileSync(FILE, BASE, "utf-8");
    const compiled = compileSource(BASE, { sourcePath: FILE });
    if (!compiled.success) {
      throw new Error("compile failed: " + JSON.stringify(compiled.errors));
    }
    expect(compiled.code).not.toContain("__registerModuleFingerprint(");
  });
});
