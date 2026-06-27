import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const enabled = process.env.AGENCY_LLM_INTEGRATION === "1";

describe.runIf(enabled)("agency agent --local-model (end-to-end)", () => {
  it("runs a one-shot prompt and exits 0", { timeout: 6 * 60_000 }, async () => {
    const { stdout, stderr } = await exec(
      "pnpm",
      ["run", "agency", "agent", "--local-model", "smollm2-135m", "--print", "Say hi."],
      { timeout: 5 * 60_000 },
    );
    // Shape-only: the model said something and the agent didn't error out.
    expect(stdout.length).toBeGreaterThan(0);
    expect(stderr).not.toMatch(/Error|Traceback/);
  });
});
