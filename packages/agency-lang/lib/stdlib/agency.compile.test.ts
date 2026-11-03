import { describe, it, expect, afterEach } from "vitest";
import {
  _compile,
  _subprocessDepth,
  compileWithTrustedModules,
  effectiveTrustedModules,
} from "./agency.js";
import { readdirSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { setSubprocessRunInfo } from "../runtime/subprocessRunInfo.js";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { ThreadStore } from "../runtime/state/threadStore.js";

describe("_subprocessDepth", () => {
  it("reads ctx.subprocessDepth (the agency.ctx().subprocessDepth exposure)", () => {
    const ctx = new RuntimeContext({
      statelogConfig: {
        host: "",
        apiKey: "",
        projectId: "",
        debugMode: false,
        observability: false,
      },
      smoltalkDefaults: {},
      dirname: process.cwd(),
    });
    ctx.subprocessDepth = 3;
    const depth = runInTestContext(ctx, ctx.stateStack, new ThreadStore(), () =>
      _subprocessDepth(),
    );
    expect(depth).toBe(3);
  });
});

function makeContext(trustedModules: { source: string; compiled: string }[] = []) {
  return new RuntimeContext({
    statelogConfig: {
      host: "",
      apiKey: "",
      projectId: "",
      debugMode: false,
      observability: false,
    },
    smoltalkDefaults: {},
    dirname: process.cwd(),
    trustedModules,
  });
}

describe("effectiveTrustedModules", () => {
  afterEach(() => setSubprocessRunInfo({ depth: 0 }));

  it("at the root, resolves the config list against the working directory", () => {
    const base = realpathSync(mkdtempSync(join(process.cwd(), ".etm-")));
    try {
      mkdirSync(join(base, "src"));
      mkdirSync(join(base, "dist"));
      const ctx = makeContext([
        {
          source: relative(process.cwd(), join(base, "src")),
          compiled: relative(process.cwd(), join(base, "dist")),
        },
      ]);
      expect(effectiveTrustedModules(ctx)).toEqual([
        { source: join(base, "src"), compiled: join(base, "dist") },
      ]);
    } finally {
      safeDeleteDirectoryWithin(process.cwd(), base);
    }
  });

  it("at the root, throws naming an entry that does not resolve", () => {
    const ctx = makeContext([{ source: "no-such-dir-src", compiled: "no-such-dir-dist" }]);
    expect(() => effectiveTrustedModules(ctx)).toThrow(/no-such-dir-src/);
  });

  it("in a subprocess, returns the seeded list and ignores the config", () => {
    const seeded = [{ source: "/seeded/src", compiled: "/seeded/dist" }];
    setSubprocessRunInfo({ depth: 1, trustedModules: seeded });
    const ctx = makeContext([{ source: "no-such-dir-src", compiled: "no-such-dir-dist" }]);
    ctx.subprocessDepth = 1;
    expect(effectiveTrustedModules(ctx)).toEqual(seeded);
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

describe("compile and trusted modules", () => {
  it("compileWithTrustedModules uses the list, and the public _compile never does", () => {
    const dir = realpathSync(mkdtempSync(join(process.cwd(), ".ctm-")));
    try {
      mkdirSync(join(dir, "tools"));
      writeFileSync(join(dir, "tools", "helper.js"), "export const shout = (t) => t;\n");
      writeFileSync(
        join(dir, "tools", "tools.agency"),
        'import { shout } from "./helper.js"\nexport def shoutViaJs(text: string): string { return shout(text) }\n',
      );
      writeFileSync(join(dir, "tools", "tools.js"), "export {};\n");
      const source =
        'import { shoutViaJs } from "./tools/tools.agency"\nexport node main(): string { return shoutViaJs("hi") }\n';
      const trusted = [{ source: join(dir, "tools"), compiled: join(dir, "tools") }];
      const program = compileWithTrustedModules(source, dir, false, trusted);
      expect(program.trustedModules).toEqual([join(dir, "tools", "tools.js")]);
      expect(() => _compile(source, dir)).toThrow(/only .agency files may be imported/);
    } finally {
      safeDeleteDirectoryWithin(process.cwd(), dir);
    }
  });
});
