import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileSource } from "../compiler/compile.js";
import { sha256Text } from "../utils/hash.js";

const FILE = path.join(os.tmpdir(), "agency-modhash-itest.agency");

function emittedHash(source: string): string {
  fs.writeFileSync(FILE, source, "utf-8");
  const compiled = compileSource(source, { sourcePath: FILE });
  if (!compiled.success) {
    throw new Error("compile failed: " + JSON.stringify(compiled.errors));
  }
  const registration = compiled.code.match(/registerModuleSourceHash\([^,]+,\s*"([0-9a-f]{64})"\)/);
  if (!registration) {
    throw new Error("no registerModuleSourceHash emission found");
  }
  return registration[1];
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
    expect(emittedHash(BASE)).toBe(sha256Text(BASE));
  });

  it("a source change (any change, comments included) changes the hash", () => {
    const changed = BASE.replace("return n * 2", "return n * 3");
    expect(emittedHash(changed)).toBe(sha256Text(changed));
    expect(emittedHash(changed)).not.toBe(sha256Text(BASE));
  });
});
