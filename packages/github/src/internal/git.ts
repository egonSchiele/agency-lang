import { execFile } from "child_process";
import { promisify } from "util";
import { success, failure } from "agency-lang/runtime";
import type { Result } from "./result.js";

const execFileAsync = promisify(execFile);

export type GitOutput = { stdout: string; stderr: string };

export async function runGit(args: string[], opts?: { cwd?: string }): Promise<Result<GitOutput>> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: opts?.cwd });
    return success({ stdout, stderr }) as Result<GitOutput>;
  } catch (e) {
    console.error(`runGit failed: git ${args.join(" ")}:`, e);
    const err = e as { stderr?: string; message: string };
    return failure(`git ${args.join(" ")} failed: ${(err.stderr ?? err.message).trim()}`) as Result<GitOutput>;
  }
}

// Subset of git's ref-name rules sufficient to reject argument injection.
// See git-check-ref-format(1). We're stricter than git for safety.
// Notably: rejects names starting with `-`, `/`, or `.`, names containing
// `..`, `@{`, or `/.`, names ending with `/` or `.lock`.
const REF_NAME = /^(?!-)(?!\/)(?!\.)(?!.*\/$)(?!.*\.\.)(?!.*@\{)(?!.*\/\.)[A-Za-z0-9._/-]+(?<!\.lock)$/;

export function assertValidRefName(name: string): void {
  if (!name || !REF_NAME.test(name)) {
    throw new Error(`Invalid git ref name: ${JSON.stringify(name)}`);
  }
}
