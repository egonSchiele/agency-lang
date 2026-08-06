// Shared utilities for integration tests.
// Each integration test creates a fresh project in a temp directory,
// installs Agency from a tarball, and verifies user-facing workflows.

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

// The single process boundary for the integration tests. It is the only layer
// that knows about spawnSync, the default timeout, environment merging, spawn
// errors, and exact-status enforcement. Callers declare the expected status
// rather than bypassing the helper for failure cases, and always get stdout and
// stderr back separately. On a spawn error or wrong status it throws with the
// captured streams and status attached, so callers can log on failure.
export function runProcess(
  executable,
  args,
  { expectedStatus = 0, cwd, input, env, timeout = DEFAULT_COMMAND_TIMEOUT_MS } = {},
) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout,
    input,
    stdio: ["pipe", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const command = [executable, ...args].join(" ");

  if (result.error) {
    const error = new Error(
      `Command failed to start: ${command}\n${result.error.message}\n${stdout}${stderr}`,
    );
    error.cause = result.error;
    error.stdout = stdout;
    error.stderr = stderr;
    error.status = result.status;
    error.signal = result.signal;
    throw error;
  }
  if (result.status !== expectedStatus) {
    const error = new Error(
      `Expected exit ${expectedStatus}, got ${result.status}: ${command}\n${stdout}${stderr}`,
    );
    error.stdout = stdout;
    error.stderr = stderr;
    error.status = result.status;
    error.signal = result.signal;
    throw error;
  }

  return { status: result.status, stdout, stderr, signal: result.signal };
}

// Run the installed `agency` CLI in `dir`. `--no-install` forbids an npm
// registry fallback, so a missing local bin is a real failure rather than a
// silent download. Thin wrapper over the generic runProcess boundary.
export function runInstalledAgency(dir, args, opts = {}) {
  return runProcess("npx", ["--no-install", "agency", ...args], { ...opts, cwd: dir });
}

// --- Shared file / JSONL helpers (used by cli-main and cli-tier2) ---

export function normalizeNewline(text) {
  return text.replace(/\r\n/g, "\n");
}

export function normalizeOptionalFinalNewline(text) {
  return normalizeNewline(text).replace(/\n*$/, "\n");
}

export function readText(path) {
  return normalizeNewline(readFileSync(path, "utf8"));
}

export function assertFile(path, message) {
  assert(existsSync(path), message || `Expected file to exist: ${path}`);
}

// Read a `.jsonl` file into an array of parsed objects, one per non-empty line.
export function readJsonLines(path) {
  return readText(path)
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

// Compare two files. By default strict (line-for-line, trailing newlines kept);
// pass `{ normalizeTrailingNewline: true }` to collapse trailing-newline
// differences before comparing.
export function assertFileEquals(actualPath, expectedPath, opts = {}) {
  const normalize = opts.normalizeTrailingNewline
    ? normalizeOptionalFinalNewline
    : normalizeNewline;
  const actual = normalize(readFileSync(actualPath, "utf8"));
  const expected = normalize(readFileSync(expectedPath, "utf8"));
  assert(
    actual === expected,
    `Expected ${actualPath} to match ${expectedPath}\n--- actual ---\n${actual}\n--- expected ---\n${expected}`,
  );
}

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
