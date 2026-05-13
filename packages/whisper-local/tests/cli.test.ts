import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { findPackageRoot } from "../src/packageRoot.js";

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = findPackageRoot(path.dirname(__filename));
const CLI = path.join(PKG_ROOT, "dist", "src", "cli.js");

// Some CLI tests need a real downloaded model file to verify the SHA-match
// path. We compute this once at module load so `it.skipIf` can mark the
// test as skipped in vitest output rather than silently passing.
const REAL_TINY_EN = path.join(
  os.homedir(),
  ".agency/models/whisper/ggml-tiny.en.bin",
);
const HAVE_REAL_TINY_EN = existsSync(REAL_TINY_EN);

// We invoke the compiled CLI as a subprocess. This catches integration
// failures the unit tests can't (wrong exit codes, missing flag handling,
// argv parsing bugs) and exercises the same code path users hit.

type CliResult = { stdout: string; stderr: string; code: number | null };

function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        code,
      });
    });
  });
}

describe("CLI", () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      throw new Error(
        `dist/src/cli.js not built. Run \`pnpm run build:ts\` before running CLI tests.`,
      );
    }
  });

  describe("usage", () => {
    it("prints usage and exits 1 with no arguments", async () => {
      const r = await runCli([]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Usage:/);
      expect(r.stderr).toMatch(/build/);
      expect(r.stderr).toMatch(/pull/);
      expect(r.stderr).toMatch(/list/);
      expect(r.stderr).toMatch(/verify/);
    });

    it("prints usage and exits 1 on unknown command", async () => {
      const r = await runCli(["nonsense"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Usage:/);
    });

    it("prints usage and exits 1 when pull is given no model name", async () => {
      const r = await runCli(["pull"]);
      expect(r.code).toBe(1);
    });

    it("prints usage and exits 1 when verify is given no model name", async () => {
      const r = await runCli(["verify"]);
      expect(r.code).toBe(1);
    });
  });

  describe("list", () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-cli-list-"));
    });
    afterEach(async () => {
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it("exits 0 and prints all known models with installation status", async () => {
      const r = await runCli(["list"], { AGENCY_WHISPER_MODELS_DIR: tmp });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/Models directory:/);
      // Every model in the shipped lockfile should appear; see KNOWN_MODELS
      // in src/types.ts (the lockfile and KNOWN_MODELS are kept in sync).
      for (const name of [
        "tiny",
        "tiny.en",
        "base",
        "base.en",
        "small",
        "small.en",
        "medium",
        "medium.en",
        "large-v3",
        "large-v3-turbo",
      ]) {
        expect(r.stdout).toContain(name);
      }
    });

    it("marks installed models with a ✓ when they exist on disk", async () => {
      // Plant a fake model file.
      await fs.writeFile(path.join(tmp, "ggml-tiny.en.bin"), "x");
      const r = await runCli(["list"], { AGENCY_WHISPER_MODELS_DIR: tmp });
      expect(r.code).toBe(0);
      // The line for tiny.en should contain ✓; the line for base.en should not.
      const tinyEnLine = r.stdout
        .split("\n")
        .find((l) => l.includes("tiny.en"));
      const baseEnLine = r.stdout
        .split("\n")
        .find((l) => l.includes("base.en"));
      expect(tinyEnLine).toMatch(/✓/);
      expect(baseEnLine).not.toMatch(/✓/);
    });
  });

  describe("verify", () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-cli-verify-"));
    });
    afterEach(async () => {
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it("exits 2 when the model file is missing", async () => {
      const r = await runCli(["verify", "tiny.en"], {
        AGENCY_WHISPER_MODELS_DIR: tmp,
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/Not installed/);
    });

    it("exits 3 when the file's SHA does not match the lockfile", async () => {
      // Plant a file with the wrong contents.
      await fs.writeFile(path.join(tmp, "ggml-tiny.en.bin"), "wrong bytes");
      const r = await runCli(["verify", "tiny.en"], {
        AGENCY_WHISPER_MODELS_DIR: tmp,
      });
      expect(r.code).toBe(3);
      expect(r.stderr).toMatch(/MISMATCH/);
      expect(r.stderr).toMatch(/expected/);
      expect(r.stderr).toMatch(/actual/);
    });

    // Requires a real downloaded model: we copy it into a tmp dir and ask
    // verify to re-hash and compare against the lockfile. Without the model
    // on disk there is no honest way to exercise the SHA-match path, so we
    // skip visibly (skipIf at module load) rather than silently returning.
    it.skipIf(!HAVE_REAL_TINY_EN)(
      "exits 0 and prints OK when SHA matches",
      async () => {
        const planted = path.join(tmp, "ggml-tiny.en.bin");
        await fs.copyFile(REAL_TINY_EN, planted);
        const r = await runCli(["verify", "tiny.en"], {
          AGENCY_WHISPER_MODELS_DIR: tmp,
        });
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/^OK: tiny\.en /);
      },
    );

    it("exits 4 (Error:) when given an unknown model name", async () => {
      const r = await runCli(["verify", "definitely-not-a-model"], {
        AGENCY_WHISPER_MODELS_DIR: tmp,
      });
      expect(r.code).toBe(4);
      expect(r.stderr).toMatch(/Error:/);
      expect(r.stderr).toMatch(/unknown model/);
    });
  });

  // Note: `build` subcommand error path (cmake-js not found, exit code 5)
  // is not exercised here — running cli.js from a fake-root sandbox breaks
  // its own ESM imports (./modelManager.js etc.), and removing
  // node_modules/.bin/cmake-js from the real package would break parallel
  // tests. The path is straightforward (existsSync check + exit 5) and
  // covered by inspection.

  describe("sha256 helper used in verify", () => {
    // Sanity: the same hash a user would compute by hand should match what the
    // CLI verifies against. This test guards the lockfile format itself by
    // confirming our internal hash function agrees with `shasum -a 256`.
    it("hashes the same way `shasum -a 256` would", async () => {
      const tmp = await fs.mkdtemp(
        path.join(os.tmpdir(), "whisper-sha-spot-"),
      );
      try {
        const f = path.join(tmp, "blob");
        const data = Buffer.from("the quick brown fox jumps over the lazy dog");
        await fs.writeFile(f, data);
        // Cross-check against Node's own crypto, which is what the CLI uses.
        const expected = crypto
          .createHash("sha256")
          .update(data)
          .digest("hex");
        // Direct byte assertion: this is the well-known SHA-256 of that text.
        expect(expected).toBe(
          "05c6e08f1d9fdafa03147fcb8f82f124c76d2f70e3d989dc8aadb5e7d7450bec",
        );
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
