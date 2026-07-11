import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtempSync, writeFileSync, existsSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const execFileAsync = promisify(execFile);

// End-to-end: run the BUILT CLI (`agency run <file> --reject/--approve ...`) and
// observe the program's own marker. A handler-rejected effect exits 0 and prints
// nothing on its own, so the fixture inspects the write Result and prints a marker.
const CLI = path.resolve("dist/scripts/agency.js");

// Remove a temp dir only after confirming it is a real subdirectory of the OS
// temp dir — a guard against ever recursively deleting something outside it.
// (std::policy's safeDeleteDirectory refuses paths outside the project root, so
// it can't be used here where the target is under os.tmpdir().)
function rmTemp(dir: string): void {
  const root = realpathSync(tmpdir());
  const resolved = realpathSync(dir);
  if (resolved !== root && resolved.startsWith(root + path.sep)) {
    rmSync(resolved, { recursive: true, force: true });
  }
}

const FIXTURE = `node main() {
  const r = write(filename: "policy-spawn-out.txt", content: "x", dir: ".")
  match (r) {
    success(_) => print("WRITE_OK")
    failure(_) => print("WRITE_REJECTED")
  }
}
`;

// Same write, but the program handles the interrupt itself. The policy layer
// must NOT override or prompt for an interrupt the code already settled.
const HANDLED_FIXTURE = `node main() {
  handle {
    const r = write(filename: "policy-spawn-out.txt", content: "x", dir: ".")
    match (r) {
      success(_) => print("WRITE_OK")
      failure(_) => print("WRITE_REJECTED")
    }
  } with approve
}
`;

function makeDir(fixture: string = FIXTURE): string {
  const dir = mkdtempSync(path.join(tmpdir(), "runpol-spawn-"));
  writeFileSync(path.join(dir, "writer.agency"), fixture);
  return dir;
}

async function runCli(dir: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI, "run", "writer.agency", ...args],
      { cwd: dir, timeout: 60_000 },
    );
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

// Requires the built CLI (`dist/scripts/agency.js`). `pnpm test:run` alone does
// not build `dist`, so skip in a clean checkout rather than hard-fail; CI builds
// (`make`) before running tests, so this suite runs there.
describe.skipIf(!existsSync(CLI))("agency run --policy flags (end-to-end)", () => {
  it("rejects std::write under --reject std::write (exit 0, observable marker)", async () => {
    const dir = makeDir();
    try {
      const { stdout, code } = await runCli(dir, ["--reject", "std::write"]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/WRITE_REJECTED/);
      expect(stdout).not.toMatch(/WRITE_OK/);
    } finally {
      rmTemp(dir);
    }
  });

  it("approves std::write under --approve std::write (flag flips behavior)", async () => {
    const dir = makeDir();
    try {
      const { stdout, code } = await runCli(dir, ["--approve", "std::write"]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/WRITE_OK/);
      expect(stdout).not.toMatch(/WRITE_REJECTED/);
    } finally {
      rmTemp(dir);
    }
  });

  it("an interrupt the code handles itself is NOT re-decided by --interactive", async () => {
    // The program's own `with approve` settles the interrupt, so it never
    // surfaces to the user endpoint. (Pre-endpoint behavior: the interactive
    // handler joined the chain, prompted on non-TTY stdin, and fail-closed
    // to reject — clobbering the code's approval.)
    const dir = makeDir(HANDLED_FIXTURE);
    try {
      const { stdout, code } = await runCli(dir, ["--interactive"]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/WRITE_OK/);
      expect(stdout).not.toMatch(/WRITE_REJECTED/);
    } finally {
      rmTemp(dir);
    }
  });

  it("a surfaced interrupt the policy does not cover is rejected and the run resumes", async () => {
    // --approve std::read covers nothing here; std::write surfaces to the
    // user endpoint, which (non-interactive) rejects it and resumes the run —
    // the program observes the failure Result and exits cleanly.
    const dir = makeDir();
    try {
      const { stdout, code } = await runCli(dir, ["--approve", "std::read"]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/WRITE_REJECTED/);
      expect(stdout).not.toMatch(/WRITE_OK/);
    } finally {
      rmTemp(dir);
    }
  });

  it("without any policy flag, an uncovered interrupt still reports unhandled", async () => {
    // No handler is installed when no flag is set (resolveRunPolicy returns null),
    // so the write propagates unhandled: reportUnhandledInterrupts prints the
    // handlers-guide message and exits non-zero — today's behavior, unchanged.
    const dir = makeDir();
    try {
      const { stdout, stderr, code } = await runCli(dir, []);
      expect(code).not.toBe(0);
      expect(stdout + stderr).toMatch(/was not handled/i);
    } finally {
      rmTemp(dir);
    }
  });
});
