import { execFile } from "child_process";
import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { expect } from "vitest";
import { safeDeleteDirectoryWithin } from "../utils.js";

/** Shared setup for the tests that run the BUILT CLI as a child process. */

const execFileAsync = promisify(execFile);

export const CLI = path.resolve("dist/scripts/agency.js");

/** True when the CLI has been built. The spawn tests skip in a clean
 *  checkout; CI runs make first. */
export const cliIsBuilt = existsSync(CLI);

export type CliRun = { stdout: string; stderr: string; code: number };

/** Run the built CLI in `dir` and return its output and exit code. The
 *  60-second timeout kills a child that hangs. */
export async function runAgency(
  dir: string,
  cliArgs: string[],
  env: Record<string, string>,
): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...cliArgs], {
      cwd: dir,
      timeout: 60_000,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

/** Run `agency agent` with scripted model replies. It gets a throwaway HOME
 *  and agent home inside `dir`, and placeholder API keys, so the router's
 *  default model applies the same way with or without real keys. */
export async function runAgentWithMocks(
  dir: string,
  args: string[],
  mocks: Record<string, unknown[]>,
): Promise<CliRun> {
  const home = path.join(dir, "home");
  const agentHome = path.join(home, ".agency-agent");
  return runAgency(dir, ["agent", "--agent-home", agentHome, ...args], {
    HOME: home,
    ANTHROPIC_API_KEY: "test-key",
    OPENROUTER_API_KEY: "test-key",
    AGENCY_LLM_MOCKS: JSON.stringify(mocks),
  });
}

/** A fresh folder under the system temp folder. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Delete a folder made by `makeTempDir`. */
export function removeTempDir(dir: string): void {
  const result = safeDeleteDirectoryWithin(tmpdir(), dir);
  expect(result.success).toBe(true);
}

/** The router's scripted answer that sends a turn to the coordinator. */
export const ROUTE_TO_COORDINATOR = {
  decide: {
    answer: { type: "choice", choice: "coordinator", confidence: 0.9, probabilities: {} },
  },
};
