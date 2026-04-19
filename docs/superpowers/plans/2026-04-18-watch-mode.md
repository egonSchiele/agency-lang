# Watch Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--watch` flag to `agency compile` that watches input files/directories and recompiles `.agency` files on change.

**Architecture:** A new `lib/cli/watch.ts` module exports `watchAndCompile()`, which does an initial compile then sets up a chokidar v4 watcher. The existing compile command in `scripts/agency.ts` gains a `--watch` flag that delegates to this function.

**Tech Stack:** chokidar v4, vitest for tests

**Spec:** `docs/superpowers/specs/2026-04-18-watch-mode-design.md`

---

### Task 1: Install chokidar v4

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install chokidar**

```bash
pnpm add chokidar@^4
```

- [ ] **Step 2: Verify installation**

```bash
pnpm ls chokidar
```

Expected: chokidar 4.x listed

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "add chokidar v4 dependency for watch mode"
```

---

### Task 2: Write the watch module with tests (TDD)

**Files:**
- Create: `lib/cli/watch.ts`
- Test: `lib/cli/watch.test.ts`

**Context:** The existing `compile()` function in `lib/cli/commands.ts` has this signature:

```typescript
export function compile(
  config: AgencyConfig,
  inputFile: string,
  _outputFile?: string,
  options?: { ts?: boolean; symbolTable?: SymbolTable },
): string | null
```

It already handles directories (recursively finding `.agency` files). It throws on parse/compile errors.

- [ ] **Step 1: Write the failing test**

Create `lib/cli/watch.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock compile to avoid needing the full pipeline
vi.mock("@/cli/commands.js", () => ({
  compile: vi.fn(),
}));

// Mock chokidar
const mockOn = vi.fn().mockReturnThis();
const mockClose = vi.fn().mockResolvedValue(undefined);
vi.mock("chokidar", () => ({
  watch: vi.fn(() => ({
    on: mockOn,
    close: mockClose,
  })),
}));

import { watchAndCompile } from "./watch.js";
import { compile } from "@/cli/commands.js";
import chokidar from "chokidar";

describe("watchAndCompile", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-watch-test-"));
    fs.writeFileSync(path.join(tmpDir, "test.agency"), "node main() {}");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should do an initial compile of all inputs", async () => {
    await watchAndCompile({}, [tmpDir], { ts: false });

    expect(compile).toHaveBeenCalledWith({}, tmpDir, undefined, { ts: false });
  });

  it("should set up a chokidar watcher on inputs", async () => {
    await watchAndCompile({}, [tmpDir], { ts: false });

    expect(chokidar.watch).toHaveBeenCalledWith(
      [tmpDir],
      expect.objectContaining({
        ignored: expect.any(Function),
        ignoreInitial: true,
      }),
    );
  });

  it("should filter to only .agency files", async () => {
    await watchAndCompile({}, [tmpDir], { ts: false });

    const call = vi.mocked(chokidar.watch).mock.calls[0];
    const ignored = call[1]!.ignored as (path: string, stats?: fs.Stats) => boolean;

    // Directories should NOT be ignored (so we recurse into them)
    expect(ignored("src/", { isFile: () => false } as fs.Stats)).toBe(false);

    // .agency files should NOT be ignored
    expect(ignored("test.agency", { isFile: () => true } as fs.Stats)).toBe(false);

    // Non-.agency files SHOULD be ignored
    expect(ignored("test.js", { isFile: () => true } as fs.Stats)).toBe(true);
  });

  it("should recompile on change events", async () => {
    await watchAndCompile({}, [tmpDir], { ts: false });

    // Find the 'change' handler
    const changeCall = mockOn.mock.calls.find((c) => c[0] === "change");
    expect(changeCall).toBeDefined();
    const changeHandler = changeCall![1];

    // Simulate a change event
    vi.mocked(compile).mockClear();
    changeHandler("test.agency");
    vi.advanceTimersByTime(150);

    expect(compile).toHaveBeenCalledWith({}, "test.agency", undefined, {
      ts: false,
    });
  });

  it("should recompile on add events", async () => {
    await watchAndCompile({}, [tmpDir], { ts: false });

    const addCall = mockOn.mock.calls.find((c) => c[0] === "add");
    expect(addCall).toBeDefined();
    const addHandler = addCall![1];

    vi.mocked(compile).mockClear();
    addHandler("new-file.agency");
    vi.advanceTimersByTime(150);

    expect(compile).toHaveBeenCalledWith({}, "new-file.agency", undefined, {
      ts: false,
    });
  });

  it("should survive compilation errors", async () => {
    await watchAndCompile({}, [tmpDir], { ts: false });

    const changeCall = mockOn.mock.calls.find((c) => c[0] === "change");
    const changeHandler = changeCall![1];

    // Make compile throw
    vi.mocked(compile).mockImplementation(() => {
      throw new Error("parse error");
    });

    // Should not throw — advance timers to trigger the debounced compile
    changeHandler("bad.agency");
    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
  });

  it("should return a close function", async () => {
    const close = await watchAndCompile({}, [tmpDir], { ts: false });

    await close();
    expect(mockClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test:run lib/cli/watch.test.ts
```

Expected: FAIL — `watchAndCompile` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `lib/cli/watch.ts`:

```typescript
import { compile } from "@/cli/commands.js";
import { AgencyConfig } from "@/config.js";
import { color } from "@/utils/termcolors.js";
import chokidar from "chokidar";
import * as fs from "fs";

export async function watchAndCompile(
  config: AgencyConfig,
  inputs: string[],
  options: { ts?: boolean },
): Promise<() => Promise<void>> {
  // Initial compile
  for (const input of inputs) {
    compile(config, input, undefined, { ts: options.ts });
  }

  // Set up watcher
  const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  const DEBOUNCE_MS = 100;

  const watcher = chokidar.watch(inputs, {
    ignored: (filePath: string, stats?: fs.Stats) => {
      // Don't ignore directories — we need to recurse into them
      if (!stats?.isFile()) return false;
      return !filePath.endsWith(".agency");
    },
    ignoreInitial: true,
  });

  const recompile = (filePath: string) => {
    // Debounce per file
    if (debounceTimers[filePath]) {
      clearTimeout(debounceTimers[filePath]);
    }
    debounceTimers[filePath] = setTimeout(() => {
      try {
        compile(config, filePath, undefined, { ts: options.ts });
        console.log(color.green(`Recompiled ${filePath}`));
      } catch (err) {
        console.error(color.red(`Error compiling ${filePath}:`));
        console.error(err instanceof Error ? err.message : err);
      }
      delete debounceTimers[filePath];
    }, DEBOUNCE_MS);
  };

  watcher.on("change", recompile);
  watcher.on("add", recompile);

  console.log(color.cyan("Watching for changes..."));

  return async () => {
    await watcher.close();
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test:run lib/cli/watch.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/cli/watch.ts lib/cli/watch.test.ts
git commit -m "feat: add watchAndCompile module with tests"
```

---

### Task 3: Wire up the --watch flag in the CLI

**Files:**
- Modify: `scripts/agency.ts:52-63`

- [ ] **Step 1: Add the import**

At the top of `scripts/agency.ts`, add:

```typescript
import { watchAndCompile } from "@/cli/watch.js";
```

- [ ] **Step 2: Add --watch option and update the action**

Replace the compile command block (lines 52-63) with:

```typescript
program
  .command("compile")
  .alias("build")
  .description("Compile .agency file(s) or directory(s) to JavaScript")
  .argument("<inputs...>", "Paths to .agency input files or directories")
  .option("--ts", "Output .ts files with // @no-check header")
  .option("-w, --watch", "Watch for changes and recompile")
  .action(async (inputs: string[], opts: { ts?: boolean; watch?: boolean }) => {
    const config = getConfig();
    if (opts.watch) {
      const close = await watchAndCompile(config, inputs, { ts: opts.ts });
      process.on("SIGINT", async () => {
        await close();
        process.exit(0);
      });
    } else {
      for (const input of inputs) {
        compile(config, input, undefined, { ts: opts.ts });
      }
    }
  });
```

- [ ] **Step 3: Build and verify**

```bash
pnpm run build
```

Expected: clean build, no errors.

- [ ] **Step 4: Smoke test manually**

Create a temp `.agency` file and test the watch command:

```bash
echo 'node main() { let x = 1 }' > /tmp/test-watch.agency
```

Then in another terminal (or kill with Ctrl+C after verifying):

```bash
pnpm run agency compile --watch /tmp/test-watch.agency
```

Expected: compiles once, prints "Watching for changes...". Editing the file should print "Recompiled ...".

Note: this won't work if the file is outside the project directory (per CLAUDE.md — node_modules won't be found). Use a file within the project directory for the smoke test instead:

```bash
echo 'node main() { let x = 1 }' > test-watch-temp.agency
pnpm run agency compile --watch test-watch-temp.agency
```

Then edit `test-watch-temp.agency` in another terminal and verify recompilation. Clean up after:

```bash
rm test-watch-temp.agency test-watch-temp.js
```

- [ ] **Step 5: Commit**

```bash
git add scripts/agency.ts
git commit -m "feat: add --watch flag to compile command"
```

---

### Task 4: Run full test suite

- [ ] **Step 1: Run all unit tests**

```bash
pnpm test:run
```

Expected: all tests pass, no regressions.

- [ ] **Step 2: Commit if any fixups were needed**

Only if changes were made to fix test issues.
