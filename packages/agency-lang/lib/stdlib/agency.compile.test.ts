import { describe, it, expect } from "vitest";
import { _compile, _subprocessDepth } from "./agency.js";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { ThreadStore } from "../runtime/state/threadStore.js";

describe("_subprocessDepth", () => {
  it("reads ctx.subprocessDepth (the agency.ctx().subprocessDepth exposure)", () => {
    const ctx = new RuntimeContext({
      statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
      smoltalkDefaults: {},
      dirname: process.cwd(),
    });
    ctx.subprocessDepth = 3;
    const depth = runInTestContext(ctx, ctx.stateStack, new ThreadStore(), () => _subprocessDepth());
    expect(depth).toBe(3);
  });
});

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
