import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtempSync, writeFileSync, existsSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const execFileAsync = promisify(execFile);

// End-to-end: run the BUILT CLI and observe the budget-exceeded exit code
// and message. Mirrors runPolicy.spawn.test.ts's harness.
const CLI = path.resolve("dist/scripts/agency.js");

function rmTemp(dir: string): void {
  const root = realpathSync(tmpdir());
  const resolved = realpathSync(dir);
  if (resolved !== root && resolved.startsWith(root + path.sep)) {
    rmSync(resolved, { recursive: true, force: true });
  }
}

// Sleeps far past the tiny time budget the tests set. The direction is
// jitter-safe: the EXPECTED outcome is the trip, and a slow runner only
// makes the sleep overshoot harder.
const SLEEPER = `node main() {
  sleep(2s)
  return "done"
}
`;

// The tripping work sits inside a USER guard block whose own (time) guard
// has plenty of budget. The user boundary owns only its OWN guardId, so it
// must NOT absorb the root budget's trip — the trip propagates to the
// compiled entry and exits 3. If the boundary wrongly converted it, the
// program would print GUARD_ABSORBED and exit 0.
const GUARDED_SLEEPER = `import { guard } from "std::thread"

node main() {
  const inner = guard(time: 60s) as {
    sleep(2s)
    return "inner done"
  }
  if (isFailure(inner)) {
    print("GUARD_ABSORBED:\${inner.error.type}")
    return "absorbed"
  }
  return inner.value
}
`;

function makeDir(fixture: string = SLEEPER): string {
  const dir = mkdtempSync(path.join(tmpdir(), "budget-spawn-"));
  writeFileSync(path.join(dir, "sleeper.agency"), fixture);
  return dir;
}

async function runCli(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI, "run", "sleeper.agency", ...args],
      { cwd: dir, timeout: 60_000, env: { ...process.env, ...env } },
    );
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

// Requires the built CLI; skip in a clean checkout (CI runs make first).
describe.skipIf(!existsSync(CLI))("root budget (end-to-end)", () => {
  it("--max-time flag trips the root guard: exit 3 + overrun message", async () => {
    const dir = makeDir();
    try {
      const r = await runCli(dir, ["--max-time", "100ms"]);
      expect(r.stderr).toMatch(/Exceeded time limit/);
      expect(r.code).toBe(3);
    } finally {
      rmTemp(dir);
    }
  }, 90_000);

  it("a user guard() boundary does not absorb the root budget's trip", async () => {
    const dir = makeDir(GUARDED_SLEEPER);
    try {
      const r = await runCli(dir, ["--max-time", "100ms"]);
      expect(r.stdout).not.toMatch(/GUARD_ABSORBED/);
      expect(r.stderr).toMatch(/Exceeded time limit/);
      expect(r.code).toBe(3);
    } finally {
      rmTemp(dir);
    }
  }, 90_000);

  it("a bare unitless --max-time is a usage error (exit 2)", async () => {
    const dir = makeDir();
    try {
      const r = await runCli(dir, ["--max-time", "300"]);
      expect(r.stderr + r.stdout).toMatch(/max-time/);
      expect(r.code).toBe(2);
    } finally {
      rmTemp(dir);
    }
  }, 90_000);

  it("an inherited AGENCY_MAX_TIME does not leak when the flag is absent", async () => {
    // The env var is an internal carrier from the CLI to its spawned
    // child, not a user-facing knob: `agency run` clears-then-sets it,
    // exactly like AGENCY_RUN_POLICY. A stale value from the parent
    // shell must not constrain the run — the 2s sleeper completes.
    const dir = makeDir();
    try {
      const r = await runCli(dir, [], { AGENCY_MAX_TIME: "100" });
      expect(r.stderr).not.toMatch(/Exceeded time limit/);
      expect(r.code).toBe(0);
    } finally {
      rmTemp(dir);
    }
  }, 90_000);
});
