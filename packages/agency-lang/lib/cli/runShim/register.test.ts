import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeDeleteDirectoryWithin } from "../../utils.js";

const CHILD_TIMEOUT_MS = 10_000;

type Fixture = {
  root: string;
  outside: string;
  registerUrl: string;
  legacyUrl: string;
  program: string;
};

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "agency-loader-"));
  const packageRoot = path.join(root, "install", "node_modules", "agency-lang");
  const shimDir = path.join(packageRoot, "dist", "lib", "cli", "runShim");
  const outside = path.join(root, "outside");
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(outside);
  for (const filename of ["register.mjs", "resolver.mjs"]) {
    copyFileSync(fileURLToPath(new URL(filename, import.meta.url)), path.join(shimDir, filename));
  }
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "agency-lang",
      type: "module",
      exports: { ".": "./marker.mjs", "./runtime": "./marker.mjs" },
    }),
  );
  writeFileSync(path.join(packageRoot, "marker.mjs"), 'export const marker = "global-package";\n');
  const program = path.join(outside, "main.mjs");
  writeFileSync(
    program,
    [
      'import { marker } from "agency-lang";',
      'import { marker as runtimeMarker } from "agency-lang/runtime";',
      "console.log(`${marker}:${runtimeMarker}`);",
    ].join("\n"),
  );
  const legacyPath = path.join(outside, "legacy.mjs");
  writeFileSync(
    legacyPath,
    [
      'import nodeModule from "node:module";',
      "nodeModule.registerHooks = undefined;",
      "nodeModule.syncBuiltinESMExports();",
    ].join("\n"),
  );
  return {
    root,
    outside,
    registerUrl: pathToFileURL(path.join(shimDir, "register.mjs")).href,
    legacyUrl: pathToFileURL(legacyPath).href,
    program,
  };
}

describe("register.mjs", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    expect(safeDeleteDirectoryWithin(tmpdir(), fixture.root).success).toBe(true);
  });

  it.skipIf(typeof nodeModule.registerHooks !== "function")(
    "resolves a global installation without deprecated loader APIs",
    () => {
      const result = spawnSync(
        process.execPath,
        ["--throw-deprecation", `--import=${fixture.registerUrl}`, fixture.program],
        { cwd: fixture.outside, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("global-package:global-package");
      expect(result.stderr).not.toContain("DEP0205");
    },
  );

  it("resolves a global installation when registerHooks is unavailable", () => {
    const result = spawnSync(
      process.execPath,
      [`--import=${fixture.legacyUrl}`, `--import=${fixture.registerUrl}`, fixture.program],
      { cwd: fixture.outside, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("global-package:global-package");
  });
});
