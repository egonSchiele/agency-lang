// Shared utilities for integration tests.
// Each integration test creates a fresh project in a temp directory,
// installs Agency from a tarball, and verifies user-facing workflows.

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

export function createTempProject(name) {
  const dir = mkdtempSync(join(tmpdir(), `agency-integration-${name}-`));
  console.log(`[${name}] Created temp project at ${dir}`);
  return dir;
}

export function initProject(dir) {
  run(dir, "npm init -y");
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.type = "module";
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

export function installTarball(dir, tarballPath) {
  run(dir, `npm install ${tarballPath}`);
}

export function installDev(dir, ...packages) {
  run(dir, `npm install --save-dev ${packages.join(" ")}`);
}

export function writeFile(dir, relativePath, content) {
  const fullPath = join(dir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

export function run(dir, command, opts = {}) {
  const { expectFail = false, timeout = 120_000 } = opts;
  console.log(`[run] ${command}`);
  try {
    const output = execSync(command, {
      cwd: dir,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
    });
    if (expectFail) {
      throw new Error(`Expected command to fail but it succeeded: ${command}`);
    }
    return output;
  } catch (err) {
    if (expectFail) return err.stderr || err.stdout || "";
    const error = new Error(`Command failed: ${command}`);
    error.stdout = err.stdout;
    error.stderr = err.stderr;
    throw error;
  }
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(`[ASSERT FAILED] ${message}`);
  }
}

export function assertIncludes(haystack, needle, message) {
  assert(
    haystack.includes(needle),
    message || `Expected output to include "${needle}" but got:\n${haystack}`
  );
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
  console.log(`[cleanup] Removed ${dir}`);
}

// Runs a test in an isolated temp project with tarball installed.
// Handles setup, cleanup on success, and preserves dir on failure.
export function withTestProject(name, fn) {
  const tarball = resolve(process.argv[2] || "");
  if (!tarball) {
    console.error(`Usage: node ${process.argv[1]} <path-to-tarball>`);
    process.exit(1);
  }
  const dir = createTempProject(name);
  try {
    initProject(dir);
    installTarball(dir, tarball);
    fn(dir, tarball);
    console.log(`=== ${name} test passed ===`);
    cleanup(dir);
  } catch (err) {
    console.error(`${name} test failed:`, err);
    console.error("Temp directory preserved at:", dir);
    process.exit(1);
  }
}

// Writes and compiles the standard hello.agency fixture.
export function writeHelloAgency(dir) {
  writeFile(dir, "hello.agency", `node main(name: string) {
  return "Hello, " + name + "!"
}
`);
  run(dir, "npx agency compile hello.agency");
}

// Writes an entry point that imports a compiled node, calls it, and asserts the result.
export function writeHelloEntryPoint(dir, filename, arg, marker) {
  writeFile(dir, filename, `import { main } from "./hello.js";
const result = await main("${arg}");
const value = result?.data ?? result;
if (value !== "Hello, ${arg}!") {
  console.error("Expected 'Hello, ${arg}!' but got:", JSON.stringify(result, null, 2));
  process.exit(1);
}
console.log("${marker}");
`);
}

export function getTarballPath() {
  const path = process.argv[2];
  if (!path) {
    console.error(`Usage: node ${process.argv[1]} <path-to-tarball>`);
    process.exit(1);
  }
  return path;
}
