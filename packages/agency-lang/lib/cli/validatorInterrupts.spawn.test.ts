import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtempSync, writeFileSync, existsSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const execFileAsync = promisify(execFile);

// End-to-end: run the BUILT CLI with --approve/--reject and observe the
// program's marker. These scenarios cannot live in the tests/agency harness:
// an interrupt raised INSIDE a validator does not halt the program (it comes
// back from the validator's invoke as a value), so the interruptHandlers
// answering loop never sees it — only a run-level policy can answer it.
// Same harness pattern as runPolicy.spawn.test.ts.
const CLI = path.resolve("dist/scripts/agency.js");

function rmTemp(dir: string): void {
  const root = realpathSync(tmpdir());
  const resolved = realpathSync(dir);
  if (resolved !== root && resolved.startsWith(root + path.sep)) {
    rmSync(resolved, { recursive: true, force: true });
  }
}

const HEAD = `effect app::confirm { q: string }

def asky(value: number): Result<number> {
  interrupt app::confirm("check this value", { q: "\${value}" })
  return success(value)
}

@validate(asky)
type Checked = number

def armChecked(x: any): string {
  return match(x) {
    a: Checked => "checked:\${a}"
    _ => "other"
  }
}

def isChecked(x: any): string {
  if (x is Checked) {
    return "yes"
  }
  return "no"
}

def bangChecked(x: number): string {
  const a: Checked! = x
  if (a is failure(why)) {
    return "bang-failure"
  }
  return "bang-ok:\${a.value}"
}
`;

const ARM_FIXTURE = `${HEAD}
node main() {
  const outcome = try armChecked(7)
  if (outcome is failure(why)) {
    print("MARK:propagated")
    return ""
  }
  print("MARK:" + outcome.value)
}
`;

const IS_FIXTURE = `${HEAD}
node main() {
  const outcome = try isChecked(7)
  if (outcome is failure(why)) {
    print("MARK:propagated")
    return ""
  }
  print("MARK:" + outcome.value)
}
`;

const BANG_FIXTURE = `${HEAD}
node main() {
  print("MARK:" + bangChecked(7))
}
`;

// The type test sits directly in the node body: the refusal unwinds into the
// graph-node catch, not the function catch template, and must be handled
// there identically (no crash log, refusal as the result).
const NODE_INLINE_FIXTURE = `${HEAD}
node main() {
  const out = match(7) {
    a: Checked => "checked:\${a}"
    _ => "other"
  }
  print("MARK:" + out)
  return out
}
`;

// The enclosing function ran destructive work before the refused test: the
// unwrapped refusal must carry THIS frame's destructive flag (authoritative
// for retry gating), folded in by the boundary stamp.
const DESTRUCTIVE_FIXTURE = `${HEAD}
def checkAfterDestructive(x: any): string {
  destructive {
    print("side-effect")
  }
  return armChecked(x)
}

node main() {
  const outcome = try checkAfterDestructive(7)
  if (outcome is failure(why)) {
    print("MARK:destructive:\${outcome.destructiveRan}")
    return ""
  }
  print("MARK:" + outcome.value)
}
`;

function makeDir(fixture: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "valint-spawn-"));
  writeFileSync(path.join(dir, "prog.agency"), fixture);
  return dir;
}

async function runCli(dir: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI, "run", "prog.agency", ...args],
      { cwd: dir, timeout: 60_000 },
    );
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

// Requires the built CLI; skip in a clean checkout (CI runs `make` first).
describe.skipIf(!existsSync(CLI))("validator interrupts (end-to-end)", () => {
  it("an approved validator interrupt resumes and the arm matches", async () => {
    const dir = makeDir(ARM_FIXTURE);
    try {
      const { stdout } = await runCli(dir, ["--approve", "app::confirm"]);
      expect(stdout).toMatch(/MARK:checked:7/);
    } finally {
      rmTemp(dir);
    }
  });

  it("an approved validator interrupt resumes and the is test passes", async () => {
    const dir = makeDir(IS_FIXTURE);
    try {
      const { stdout } = await runCli(dir, ["--approve", "app::confirm"]);
      expect(stdout).toMatch(/MARK:yes/);
    } finally {
      rmTemp(dir);
    }
  });

  it("a refused validator interrupt stays a visible failure through bang", async () => {
    const dir = makeDir(BANG_FIXTURE);
    try {
      const { stdout } = await runCli(dir, ["--reject", "app::confirm"]);
      expect(stdout).toMatch(/MARK:bang-failure/);
    } finally {
      rmTemp(dir);
    }
  });

  it("a refused validator interrupt propagates from a match arm (wildcard must not run)", async () => {
    const dir = makeDir(ARM_FIXTURE);
    try {
      const { stdout } = await runCli(dir, ["--reject", "app::confirm"]);
      expect(stdout).toMatch(/MARK:propagated/);
      expect(stdout).not.toMatch(/MARK:other/);
    } finally {
      rmTemp(dir);
    }
  });

  it("a refused validator interrupt propagates from an is test (else outcome must not run)", async () => {
    const dir = makeDir(IS_FIXTURE);
    try {
      const { stdout } = await runCli(dir, ["--reject", "app::confirm"]);
      expect(stdout).toMatch(/MARK:propagated/);
      expect(stdout).not.toMatch(/MARK:no\b/);
    } finally {
      rmTemp(dir);
    }
  });

  it("a refusal on a type test written directly in a node body is not a crash", async () => {
    const dir = makeDir(NODE_INLINE_FIXTURE);
    try {
      const { stdout, stderr } = await runCli(dir, ["--reject", "app::confirm"]);
      expect(stdout + stderr).not.toMatch(/crashed/);
      expect(stdout + stderr).not.toMatch(/InterruptRejectedError/);
      expect(stdout).not.toMatch(/MARK:other/);
    } finally {
      rmTemp(dir);
    }
  });

  it("the unwrapped refusal carries the enclosing frame's destructive flag", async () => {
    const dir = makeDir(DESTRUCTIVE_FIXTURE);
    try {
      const { stdout } = await runCli(dir, ["--reject", "app::confirm"]);
      expect(stdout).toMatch(/MARK:destructive:true/);
    } finally {
      rmTemp(dir);
    }
  });

  // KNOWN HOLE, pinned: with NO policy and no handler, the validator's
  // interrupt never surfaces at all — the question is never asked, and the
  // arm silently reads as no-match. Surfacing pending validator interrupts
  // needs the halt machinery a runtime helper cannot reach (the type-test
  // call is codegen-synthesized, invisible to hoistCalls). Tracked in
  // issue #724. Flip this expectation when that lands.
  it("PINNED HOLE: an unanswered validator interrupt is silently a no-match", async () => {
    const dir = makeDir(ARM_FIXTURE);
    try {
      const { stdout } = await runCli(dir, []);
      expect(stdout).toMatch(/MARK:other/);
    } finally {
      rmTemp(dir);
    }
  });
});
