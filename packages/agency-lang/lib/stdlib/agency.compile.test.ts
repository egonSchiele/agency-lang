import { describe, it, expect } from "vitest";
import { _compile } from "./agency.js";
import { readdirSync, existsSync } from "fs";
import { join } from "path";

describe("_compile", () => {
  it("returns code text and writes nothing to disk", () => {
    const tmpRoot = join(process.cwd(), ".agency-tmp");
    const before = existsSync(tmpRoot) ? readdirSync(tmpRoot) : [];
    const result = _compile("node main() { return 42 }");
    const after = existsSync(tmpRoot) ? readdirSync(tmpRoot) : [];
    expect(typeof result.moduleId).toBe("string");
    expect(result.code).toContain("main"); // transpiled JS text
    expect((result as any).path).toBeUndefined(); // no file reference
    expect(after).toEqual(before); // no temp-dir writes at compile time
  });
});
