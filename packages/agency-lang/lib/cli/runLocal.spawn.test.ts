import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { existsSync, mkdtempSync, rmSync, realpathSync } from "fs";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/scripts/agency.js");

// The temp dir must live INSIDE the package: the fake plugin does
// `import { BaseClient } from "smoltalk"`, and Node resolves that bare
// specifier by walking up from the plugin file — from the OS tmpdir there is
// no node_modules with smoltalk. Same pattern as runPolicy.spawn.test.ts.
function makeLocalDir(): string {
  return mkdtempSync(path.join(process.cwd(), ".run-local-"));
}

// Only ever remove a direct `.run-local-*` child of the package dir.
function rmLocal(dir: string): void {
  const root = realpathSync(process.cwd());
  const resolved = realpathSync(dir);
  if (
    path.dirname(resolved) === root &&
    path.basename(resolved).startsWith(".run-local-")
  ) {
    rmSync(resolved, { recursive: true, force: true });
  }
}

const FAKE = `import { BaseClient } from "smoltalk";
export class LlamaCPP extends BaseClient {
  async textSync() { return { success: true, value: { output: "local-model-reply", toolCalls: [] } }; }
}
export async function resolveModel(target, dir) { return target; }
`;

const PROGRAM = `node main(): string {
  const reply: string = llm("say something")
  print(reply)
  return reply
}
`;

// Requires the built CLI (`dist/scripts/agency.js`). `pnpm test:run` alone does
// not build `dist`, so skip in a clean checkout rather than hard-fail; CI
// builds (`make`) before running tests, so this suite runs there.
describe.skipIf(!existsSync(CLI))("agency run --local (end-to-end)", () => {
  it("routes the programs llm() call to the local provider", async () => {
    // The chain this pins: the parent resolves ./model.gguf through the fake
    // plugin's resolveModel, folds { model, explicitProvider: "llama-cpp" }
    // into baked config, the child's bootstrap hook loads the fake from the
    // inherited env var, and the program's llm() call lands on it. No
    // network, no real model.
    const dir = makeLocalDir();
    try {
      fs.writeFileSync(path.join(dir, "fake-plugin.mjs"), FAKE);
      fs.writeFileSync(path.join(dir, "model.gguf"), "not a real model");
      fs.writeFileSync(path.join(dir, "prog.agency"), PROGRAM);
      const { stdout } = await execFileAsync(
        process.execPath,
        [CLI, "run", "--local", "./model.gguf", "prog.agency"],
        {
          cwd: dir,
          timeout: 120_000,
          env: {
            ...process.env,
            AGENCY_LLAMA_PROVIDER_MODULE: path.join(dir, "fake-plugin.mjs"),
          },
        },
      );
      expect(stdout).toContain("local-model-reply");
    } finally {
      rmLocal(dir);
    }
  }, 150_000);

  it("rejects --local together with --model before doing any work (exit 2)", async () => {
    const dir = makeLocalDir();
    try {
      fs.writeFileSync(path.join(dir, "prog.agency"), PROGRAM);
      // No env override on purpose: the exclusion check must fire before the
      // gate, the download, and compilation.
      const r = await execFileAsync(
        process.execPath,
        [CLI, "run", "--local", "x.gguf", "--model", "gpt-4o-mini", "prog.agency"],
        { cwd: dir, timeout: 60_000 },
      ).then(
        () => ({ code: 0, stderr: "" }),
        (e: { code?: number; stderr?: string }) => ({
          code: e.code ?? 1,
          stderr: String(e.stderr ?? ""),
        }),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("not both");
    } finally {
      rmLocal(dir);
    }
  }, 60_000);
});
