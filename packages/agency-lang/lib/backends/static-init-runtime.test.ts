import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";
import { compile } from "@/cli/commands.js";
import { __resetModuleRegistry } from "@/runtime/initOrchestrator.js";

// Project-local scratch dir — must live inside the workspace so the
// generated `.js` files can resolve `agency-lang/stdlib/index.js`
// via the repo's node_modules. (`/tmp` has no node_modules.)
const SCRATCH_ROOT = path.resolve(__dirname, "../..", ".js-tmp/static-init-runtime");

beforeAll(() => {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
});

// Runtime-side coverage for the cross-module init subsystem (#232).
// Each describe block compiles a fresh module under a unique temp
// directory so module-level memoization in `__initVar` starts from a
// clean slate — these tests rely on observable counters that would
// be polluted by previously-loaded module instances.

const repoRoot = path.resolve(__dirname, "../..");
const sourceDir = path.join(
  repoRoot,
  "tests/agency/static-init-concurrent-runs",
);

/** Copy `static-init-concurrent-runs/{main.agency, counter.js}` into a
 *  fresh tmp dir, compile, and dynamically import. Each test gets its
 *  OWN module instance — that's the whole point: closure-scoped
 *  memoization in `__initVar` survives across calls to a single
 *  imported module, but a new `import()` produces a new closure. */
async function loadFreshModule(tmpDir: string): Promise<{
  /** Calls the compiled module's `main()` and unwraps `.data` (the
   *  user-visible return value; `runNode` wraps it alongside thread
   *  / token metadata). */
  main: () => Promise<unknown>;
  counterRead: () => number;
}> {
  fs.cpSync(sourceDir, tmpDir, { recursive: true });
  // Wipe any stale generated .js from the source dir copy so compile
  // really runs.
  const stale = path.join(tmpDir, "main.js");
  if (fs.existsSync(stale)) fs.rmSync(stale);
  compile({}, path.join(tmpDir, "main.agency"));
  // Reset the process-global init orchestrator registry IMMEDIATELY
  // before importing this fixture. The registry accumulates module
  // handles across every dynamic import in this vitest worker;
  // without clearing it, `__getRegisteredModules()` inside the
  // fresh module's `__initializeGlobals` would also iterate handles
  // from prior fixtures and re-run their `__initializeStatic` /
  // `__runImperatives`, polluting counters and traces.
  __resetModuleRegistry();
  const mod: any = await import(pathToFileURL(path.join(tmpDir, "main.js")).href);
  const counterMod: any = await import(
    pathToFileURL(path.join(tmpDir, "counter.js")).href
  );
  const main = async () => (await mod.main()).data;
  return { main, counterRead: counterMod.read };
}

describe("cross-module init — concurrent runs share memoization", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(SCRATCH_ROOT, "init-concurrent-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("two concurrent main() calls invoke the static-init compute exactly once", async () => {
    const { main, counterRead } = await loadFreshModule(tmpDir);
    const [a, b] = await Promise.all([main(), main()]);
    expect(a).toBe("init-call-1");
    expect(b).toBe("init-call-1");
    expect(counterRead()).toBe(1);
  });

  it("repeated sequential main() calls also share the memoized init", async () => {
    const { main, counterRead } = await loadFreshModule(tmpDir);
    expect(await main()).toBe("init-call-1");
    expect(await main()).toBe("init-call-1");
    expect(await main()).toBe("init-call-1");
    expect(counterRead()).toBe(1);
  });
});

describe("cross-module init — memoization persists across resume / repeat invocations", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(SCRATCH_ROOT, "init-resume-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // We don't drive `respondToInterrupts` here — the agency-agent's
  // resume path calls `__initializeGlobals(__ctx)` on every resume,
  // which in turn calls each module's `__initializeStatic(__ctx)`
  // again. The memoization invariant is that EVERY such re-call
  // resolves to the same cached promise without re-running the
  // compute body — same observable behavior as repeat main() calls,
  // exercised against the SAME runtime helper code path.
  it("calling main() many times in a row does not re-run static init", async () => {
    const { main, counterRead } = await loadFreshModule(tmpDir);
    // 10 sequential calls — simulating the resume codepath calling
    // __initializeGlobals (and therefore __initializeStatic) once
    // per resume cycle.
    for (let i = 0; i < 10; i++) {
      const v = await main();
      expect(v).toBe("init-call-1");
    }
    // If memoization were lost between calls (the regression we
    // worry about), the counter would equal 10 here.
    expect(counterRead()).toBe(1);
  });
});

describe("cross-module init — backward-compat guard for pre-fix .js modules", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(SCRATCH_ROOT, "init-backcompat-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Simulates a `pkg::` or relative import whose source module was
  // compiled BEFORE this PR landed and therefore never exported
  // `__init_X`. Importer codegen emits an import-time check; an
  // undefined `__init_X` binding should crash with a pointed error
  // naming the offending module rather than a generic TypeError at
  // first use.
  it("throws a clear 'compiled with an older agency-lang' error at module load when the dep is missing __init_X", async () => {
    const src = path.join(
      repoRoot,
      "tests/agency/static-init-cross-module",
    );
    fs.cpSync(src, tmpDir, { recursive: true });
    // Make sure compile actually runs (no stale .js).
    for (const f of ["main.js", "shared.js"]) {
      const p = path.join(tmpDir, f);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
    compile({}, path.join(tmpDir, "main.agency"));

    // Strip every `__init_*` symbol from `shared.js` to simulate the
    // older codegen shape: rewrite the `export { ... }` list to drop
    // `__init_*` names, and delete the `const __init_X = __initVar(...)`
    // declarations. (Leaving them undefined inside the exporter would
    // be even more realistic, but stripping the export is enough to
    // make ESM hand back `undefined` to the importer.)
    const sharedPath = path.join(tmpDir, "shared.js");
    let sharedSrc = fs.readFileSync(sharedPath, "utf-8");
    sharedSrc = sharedSrc.replace(
      /^\s*__init_[A-Za-z0-9_]+,?\s*$/gm,
      "",
    );
    fs.writeFileSync(sharedPath, sharedSrc);

    let caught: Error | null = null;
    try {
      // See note in `loadFreshModule` re: clearing the process-global
      // init registry before importing a fresh fixture.
      __resetModuleRegistry();
      await import(pathToFileURL(path.join(tmpDir, "main.js")).href);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/older agency-lang version/);
    expect(caught!.message).toMatch(/cross-module init export for "AGENCY_DIR"/);
    expect(caught!.message).toMatch(/Rebuild .* with the current toolchain/);
  });
});

describe("cross-module init — trace captures populated static state", () => {
  let tmpDir: string;
  let tracePath: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(SCRATCH_ROOT, "init-trace-"));
    tracePath = path.join(tmpDir, "out.agencytrace");
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("static state captured via writeStaticStateToTrace reflects the populated cross-module value", async () => {
    // Copy the function-mediated fixture (has an importer reading a
    // cross-module function-initialized static — closest match to
    // the plan's "trace shows VERSION = '1.0.0' not undefined"
    // requirement).
    const src = path.join(
      repoRoot,
      "tests/agency/static-init-function-mediated",
    );
    fs.cpSync(src, tmpDir, { recursive: true });
    for (const f of ["main.js", "lib.js"]) {
      const p = path.join(tmpDir, f);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
    compile({}, path.join(tmpDir, "main.agency"));
    // See note in `loadFreshModule` re: clearing the process-global
    // init registry before importing a fresh fixture.
    __resetModuleRegistry();
    const mod: any = await import(
      pathToFileURL(path.join(tmpDir, "main.js")).href
    );
    mod.__setTraceFile(tracePath);
    await mod.main();

    // Read the trace file. The format is one JSON object per line;
    // we only care about lines with a `staticState` field. Each
    // module writes one such line at the end of its
    // `__initializeStatic`.
    const lines = fs
      .readFileSync(tracePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const staticStateLines = lines
      .map((l) => JSON.parse(l))
      .filter((j) => j.type === "static-state");
    // Both `lib.agency` and `main.agency` should have written a
    // static-state line. Confirm BASE shows as populated, not undef.
    const allValues = staticStateLines.flatMap((j) => Object.entries(j.values));
    const baseEntry = allValues.find(([k]) => k === "BASE");
    expect(baseEntry).toBeDefined();
    expect(baseEntry?.[1]).toBe("/lib/base");
    // FULL is in main.agency's static state and must also be
    // populated — would be "undefined/full" before the fix.
    const fullEntry = allValues.find(([k]) => k === "FULL");
    expect(fullEntry).toBeDefined();
    expect(fullEntry?.[1]).toBe("/lib/base/full");
  });
});
