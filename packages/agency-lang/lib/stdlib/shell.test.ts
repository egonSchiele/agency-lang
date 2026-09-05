import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __internal_exec, __internal_bash, _glob, _grep } from "./shell.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { _realDir } from "./contained.js";
import { safeDeleteDirectory } from "../utils.js";
import { findPackageRoot } from "../importPaths.js";

/**
 * Focused tests for the `~`-expansion + allow-list behavior on the
 * `cwd` argument of `_exec`/`_bash`. Uses the ctx-injected
 * `__internal_*` wrappers (same pattern as
 * lib/stdlib/abortable.test.ts) so the tests run without needing an
 * ALS frame installed.
 *
 * Regression target: before PR #222 the `cwd` was passed through to
 * `spawn()` literally — `cwd: "~/proj"` would fail with ENOENT.
 * After, `execImpl`/`bashImpl` route the cwd through
 * `resolveDir(cwd, allowed, "cwd")` which expands and
 * allow-list-checks before spawn.
 */

function makeMockCtx(): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: "/tmp",
  });
}

describe("_exec / _bash cwd ~ expansion", () => {
  let fakeHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shell-home-"));
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("_exec spawns inside the expanded ~ cwd", async () => {
    // `pwd` prints the cwd the child was launched in. If `~` wasn't
    // expanded, spawn() would throw ENOENT before pwd ever ran.
    const ctx = makeMockCtx();
    const result = await __internal_exec(
      ctx,
      new StateStack(),
      new ThreadStore(),
      "pwd",
      [],
      "~",
      0,
      "",
    );
    expect(result.exitCode).toBe(0);
    // realpath because /var/folders → /private/var/folders on macOS,
    // and the child's pwd reflects the realpath.
    expect(result.stdout.trim()).toBe(fs.realpathSync(fakeHome));
  });

  it("_bash spawns inside the expanded ~ cwd", async () => {
    const ctx = makeMockCtx();
    const result = await __internal_bash(
      ctx,
      new StateStack(),
      new ThreadStore(),
      "pwd",
      "~",
      0,
      "",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(fs.realpathSync(fakeHome));
  });

  it("_exec passes allow-list check when cwd is ~ and allowlist allows ~", async () => {
    // Cross product: tilde in cwd AND tilde in allowlist. `resolveDir`
    // expands both and `assertContained` should accept.
    const ctx = makeMockCtx();
    const result = await __internal_exec(
      ctx,
      new StateStack(),
      new ThreadStore(),
      "pwd",
      [],
      "~",
      0,
      "",
      { allowedPaths: ["~"] },
    );
    expect(result.exitCode).toBe(0);
  });

  it("_exec rejects ~ cwd when allowlist excludes home", async () => {
    // Sanity: the allow-list still enforces correctly under expansion.
    const ctx = makeMockCtx();
    await expect(
      __internal_exec(ctx, new StateStack(), new ThreadStore(), "pwd", [], "~", 0, "", {
        allowedPaths: ["/tmp/agency-disallowed-root-xyz"],
      }),
    ).rejects.toThrow(/not under/);
  });

  it("_exec with empty cwd inherits the parent process cwd (no migration regression)", async () => {
    // Before the migration, empty `cwd` meant "use spawn's default
    // (inherit parent cwd)". The migration introduced a `cwd ? ... : ""`
    // ternary; this test pins that empty-string sentinel still works.
    const ctx = makeMockCtx();
    const result = await __internal_exec(
      ctx,
      new StateStack(),
      new ThreadStore(),
      "pwd",
      [],
      "",
      0,
      "",
    );
    expect(result.exitCode).toBe(0);
    // Reflects process.cwd(), not fakeHome.
    expect(result.stdout.trim()).not.toBe(fs.realpathSync(fakeHome));
  });
});

/**
 * A missing spawn `cwd` used to surface as Node's cryptic
 * `spawn <cmd> ENOENT`. `resolveSpawnCwd` now validates existence first
 * and throws a clear, actionable message so an LLM agent can recover
 * (create the directory, then retry). Regression target: the agent
 * doing `setAgentCwd("/tmp/build")` before the `mkdir`.
 */
describe("_exec / _bash reject a nonexistent cwd with a clear error", () => {
  // Create the scratch dir INSIDE the project root so `safeDeleteDirectory`'s
  // containment guard accepts it (it refuses anything outside the project, so
  // a test can never delete the wrong thing).
  const projectRoot = fs.realpathSync(findPackageRoot(__dirname));
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(projectRoot, ".test-shell-cwd-"));
  });
  afterEach(() => {
    safeDeleteDirectory(tmp, false);
  });

  it("_bash throws 'does not exist', not 'spawn sh ENOENT'", async () => {
    const ctx = makeMockCtx();
    const missing = path.join(tmp, "not-created-yet");
    await expect(
      __internal_bash(ctx, new StateStack(), new ThreadStore(), "pwd", missing, 0, ""),
    ).rejects.toThrow(/Working directory does not exist/);
  });

  it("a corrupted cwd (leaked tool-call markup) gets the fix-the-call message, not a missing-directory one", async () => {
    const ctx = makeMockCtx();
    // The exact shape observed in the wild: the model leaked a fragment of
    // its own function-calling markup as the argument value.
    await expect(
      __internal_bash(ctx, new StateStack(), new ThreadStore(), "pwd", "</parameter>\n", 0, ""),
    ).rejects.toThrow(/corrupted tool-call argument.*working directory is unchanged/s);
  });

  it("_exec throws 'does not exist' for a missing cwd", async () => {
    const ctx = makeMockCtx();
    const missing = path.join(tmp, "nope");
    await expect(
      __internal_exec(ctx, new StateStack(), new ThreadStore(), "pwd", [], missing, 0, ""),
    ).rejects.toThrow(/Working directory does not exist/);
  });

  it("rejects a cwd that exists but is a file (not a directory)", async () => {
    const ctx = makeMockCtx();
    const file = path.join(tmp, "afile");
    fs.writeFileSync(file, "x");
    await expect(
      __internal_bash(ctx, new StateStack(), new ThreadStore(), "pwd", file, 0, ""),
    ).rejects.toThrow(/is not a directory/);
  });

  it("still runs normally when the cwd exists", async () => {
    const ctx = makeMockCtx();
    const result = await __internal_bash(
      ctx,
      new StateStack(),
      new ThreadStore(),
      "pwd",
      tmp,
      0,
      "",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(fs.realpathSync(tmp));
  });
});

describe("_glob and symlinks", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agency-glob-symlink-"));
    fs.mkdirSync(path.join(root, "real"));
    fs.writeFileSync(path.join(root, "real", "a.md"), "a");
    fs.symlinkSync(path.join(root, "real", "a.md"), path.join(root, "real", "link.md"));
  });

  afterEach(async () => {
    await safeDeleteDirectory(root);
  });

  it("leaves symlinked entries out", async () => {
    expect(await _glob(root, "real", "*.md", 100)).toEqual(["a.md"]);
    expect(await _glob(path.join(root, "real"), ".", "*.md", 100)).toEqual(["a.md"]);
  });

  it("refuses a symlinked search dir below the root", async () => {
    fs.symlinkSync(path.join(root, "real"), path.join(root, "linked"));
    await expect(_glob(root, "linked", "*.md", 100)).rejects.toThrow(/is a symlink/);
  });

  it("refuses a link in the root spelling; the wrapper resolves that before the interrupt", async () => {
    fs.symlinkSync(path.join(root, "real"), path.join(root, "linked"));
    const linked = path.join(root, "linked");
    await expect(_glob(linked, ".", "*.md", 100)).rejects.toThrow(/symlink/);
    expect(await _glob(_realDir(linked), ".", "*.md", 100)).toEqual(["a.md"]);
  });
});

describe("symlinked search dirs are refused by every walker", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agency-walk-symlink-"));
    fs.mkdirSync(path.join(root, "real"));
    fs.writeFileSync(path.join(root, "real", "a.md"), "needle");
    fs.symlinkSync(path.join(root, "real"), path.join(root, "linked"));
  });

  afterEach(async () => {
    await safeDeleteDirectory(root);
  });

  const needle = {
    pattern: "needle",
    flags: "",
    ignoreCase: false,
    wholeWord: false,
    filesOnly: false,
    invert: false,
  };

  it("_grep refuses a symlinked search dir below the root", async () => {
    await expect(_grep(root, "linked", needle, 10)).rejects.toThrow(/is a symlink/);
    const real = await _grep(root, "real", needle, 10);
    expect(real.length).toBe(1);
  });

  it("_glob returns nothing for a non-positive maxResults", async () => {
    expect(await _glob(root, "real", "*.md", 0)).toEqual([]);
    expect(await _glob(root, "real", "*.md", -3)).toEqual([]);
  });
});

describe("_grep honours .gitignore", () => {
  let root: string;
  const query = {
    pattern: "needle",
    flags: "",
    ignoreCase: false,
    wholeWord: false,
    filesOnly: true,
    invert: false,
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agency-grep-ignore-"));
    fs.writeFileSync(path.join(root, ".gitignore"), "*.js\nout/\n");
    fs.writeFileSync(path.join(root, "a.agency"), "needle\n");
    fs.writeFileSync(path.join(root, "a.js"), "needle\n");
    fs.mkdirSync(path.join(root, "out"));
    fs.writeFileSync(path.join(root, "out", "b.txt"), "needle\n");
    fs.mkdirSync(path.join(root, "keep"));
    fs.writeFileSync(path.join(root, "keep", ".gitignore"), "!*.js\n");
    fs.writeFileSync(path.join(root, "keep", "c.js"), "needle\n");
  });

  afterEach(async () => {
    await safeDeleteDirectory(root);
  });

  it("skips ignored files and directories, and lets a nested .gitignore un-ignore", async () => {
    const hits = (await _grep(root, ".", query, 100)) as string[];
    expect(hits.sort()).toEqual(["a.agency", "keep/c.js"]);
  });

  it("applies a .gitignore above the search root, up to the repository root", async () => {
    // The root .gitignore ignores *.js; the search starts in `keep`, whose
    // own .gitignore un-ignores it, and in `sub`, which has none.
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "d.js"), "needle\n");
    fs.writeFileSync(path.join(root, "sub", "d.txt"), "needle\n");
    const inSub = (await _grep(root, "sub", query, 100)) as string[];
    expect(inSub.sort()).toEqual(["d.txt"]);
    const inKeep = (await _grep(root, "keep", query, 100)) as string[];
    expect(inKeep.sort()).toEqual(["c.js"]);
  });

  it("does not follow a symlinked .gitignore below the root", async () => {
    // A link named .gitignore inside `sub` points at rules outside the root
    // that would ignore *.txt. It is a link below the root, so it is not read.
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "e.txt"), "needle\n");
    const outside = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "agency-gitignore-outside-"),
    );
    try {
      fs.writeFileSync(path.join(outside, "rules"), "*.txt\n");
      fs.symlinkSync(path.join(outside, "rules"), path.join(root, "sub", ".gitignore"));
      const hits = (await _grep(root, "sub", query, 100)) as string[];
      expect(hits).toEqual(["e.txt"]);
    } finally {
      await safeDeleteDirectory(outside);
    }
  });

  it("searches everything when respectGitignore is false", async () => {
    const hits = (await _grep(root, ".", query, 100, [], false)) as string[];
    expect(hits.sort()).toEqual(["a.agency", "a.js", "keep/c.js", "out/b.txt"]);
  });
});

describe("_grep stops at maxResults inside one file", () => {
  let root: string;
  const query = {
    pattern: "needle",
    flags: "",
    ignoreCase: false,
    wholeWord: false,
    filesOnly: false,
    invert: false,
  };
  const MATCHING_LINES = 5000;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agency-grep-cap-"));
    const lines = Array.from({ length: MATCHING_LINES }, (_, index) => `needle ${index}`);
    fs.writeFileSync(path.join(root, "big.txt"), lines.join("\n") + "\n");
    fs.writeFileSync(path.join(root, "other.txt"), "needle here\nnothing\n");
  });

  afterEach(async () => {
    await safeDeleteDirectory(root);
  });

  it("returns exactly maxResults matches from a file with far more", async () => {
    const hits = await _grep(root, ".", query, 3);
    expect(hits.length).toBe(3);
  });

  it("with filesOnly returns each file once and never more files than maxResults", async () => {
    const all = (await _grep(root, ".", { ...query, filesOnly: true }, 10)) as string[];
    expect(all.sort()).toEqual(["big.txt", "other.txt"]);
    const one = await _grep(root, ".", { ...query, filesOnly: true }, 1);
    expect(one.length).toBe(1);
  });

  it("with invert does not report the line after the final newline", async () => {
    const hits = await _grep(root, ".", { ...query, invert: true }, 100);
    expect(hits).toEqual([{ file: "other.txt", line: 2, text: "nothing" }]);
  });
});
