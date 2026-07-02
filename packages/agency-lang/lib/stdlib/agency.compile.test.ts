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
    const result = _compile("node main() { return 42 }");
    expect(typeof result.moduleId).toBe("string");
    expect(result.code).toContain("main"); // transpiled JS text
    expect((result as any).path).toBeUndefined(); // no file reference
    // No module-specific artifact under .agency-tmp. Deliberately NOT a
    // whole-directory before/after comparison: other tests write their own
    // temp dirs there concurrently, which would make that flaky.
    const tmpRoot = join(process.cwd(), ".agency-tmp");
    const entries = existsSync(tmpRoot) ? readdirSync(tmpRoot) : [];
    const mentionsModule = entries.filter((entry) => {
      const dir = join(tmpRoot, entry);
      try {
        return readdirSync(dir).some((f) => f.includes(result.moduleId));
      } catch {
        return entry.includes(result.moduleId);
      }
    });
    expect(mentionsModule).toEqual([]);
  });
});
