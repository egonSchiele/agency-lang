import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __internal_exec, __internal_bash } from "./shell.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
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
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "shell-home-"));
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
      __internal_exec(
        ctx,
        new StateStack(),
        new ThreadStore(),
        "pwd",
        [],
        "~",
        0,
        "",
        { allowedPaths: ["/tmp/agency-disallowed-root-xyz"] },
      ),
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
      ctx, new StateStack(), new ThreadStore(), "pwd", tmp, 0, "",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(fs.realpathSync(tmp));
  });
});
