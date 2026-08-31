import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileSource } from "../compiler/compile.js";
import { sha256Text } from "../utils/hash.js";

const FILE = path.join(os.tmpdir(), "agency-modhash-itest.agency");

const REGISTRATION = /__registerModuleSourceHash\(("[^"]+"),\s*"([0-9a-f]{64})",\s*"[^"]+"\)/;

function compileToCode(source: string): string {
  fs.writeFileSync(FILE, source, "utf-8");
  const compiled = compileSource(source, { sourcePath: FILE });
  if (!compiled.success) {
    throw new Error("compile failed: " + JSON.stringify(compiled.errors));
  }
  return compiled.code;
}

function emittedRegistration(source: string): { moduleId: string; hash: string } {
  const registration = compileToCode(source).match(REGISTRATION);
  if (!registration) {
    throw new Error("no __registerModuleSourceHash emission found");
  }
  return { moduleId: JSON.parse(registration[1]), hash: registration[2] };
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

describe("module source hash emission", () => {
  it("emits sha256 of the exact compiled source", () => {
    expect(emittedRegistration(BASE).hash).toBe(sha256Text(BASE));
  });

  it("a source change (any change, comments included) changes the hash", () => {
    const changed = BASE.replace("return n * 2", "return n * 3");
    expect(emittedRegistration(changed).hash).toBe(sha256Text(changed));
    expect(emittedRegistration(changed).hash).not.toBe(sha256Text(BASE));
  });

  it("the moduleId is stable across compiles of the same path", () => {
    expect(emittedRegistration(BASE).moduleId).toBe(emittedRegistration(BASE).moduleId);
    expect(emittedRegistration(BASE).moduleId).not.toMatch(/^agency_/);
  });

  it("an anonymous string compile (no sourcePath) registers no hash", () => {
    const compiled = compileSource(BASE, {});
    if (!compiled.success) {
      throw new Error("compile failed: " + JSON.stringify(compiled.errors));
    }
    expect(compiled.code).not.toContain("__registerModuleSourceHash(");
  });
});
