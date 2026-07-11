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

// A std::agency::run child whose interrupt nothing handles. The child's
// bash interrupt relays through the root chain (silent — the policy only
// covers std::run), the child pauses, and the interrupt bubbles up to the
// root CLI endpoint. There it is rejected (non-interactive), the child
// resumes with a failure Result — a rejection is not an abort — and returns
// a marker naming which decision it observed.
const SUBPROCESS_FIXTURE = `import { compile, run } from "std::agency"

node main() {
  const source = """
import { bash } from "std::shell"
node main() {
  let r = bash("echo hi")
  if (isFailure(r)) {
    return "child-saw-rejection"
  }
  return "child-saw-approval"
}
"""
  const compiled = compile(source)
  if (isFailure(compiled)) {
    print("COMPILE_FAILED")
    return ""
  }
  const result = run(compiled: compiled.value, node: "main")
  if (isSuccess(result)) {
    print("CHILD_RESULT: " + result.value.data)
  } else {
    print("CHILD_RUN_FAILED")
  }
}
`;

function makeDir(fixture: string = FIXTURE): string {
  const dir = mkdtempSync(path.join(tmpdir(), "runpol-spawn-"));
  writeFileSync(path.join(dir, "writer.agency"), fixture);
  return dir;
}

// The subprocess fixture must live INSIDE the package dir: the nested
// std::agency::run child materializes its compiled script under the parent's
// cwd, and from os.tmpdir() that script cannot resolve the `agency-lang`
// package (the CLI's resolver shim only covers the direct child).
function makeLocalDir(fixture: string): string {
  const dir = mkdtempSync(path.join(process.cwd(), ".runpol-spawn-"));
  writeFileSync(path.join(dir, "writer.agency"), fixture);
  return dir;
}

// Companion guard to rmTemp for makeLocalDir: only remove a direct
// `.runpol-spawn-*` child of the package dir.
function rmLocal(dir: string): void {
  const root = realpathSync(process.cwd());
  const resolved = realpathSync(dir);
  if (
    path.dirname(resolved) === root &&
    path.basename(resolved).startsWith(".runpol-spawn-")
  ) {
    rmSync(resolved, { recursive: true, force: true });
  }
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

  it("a subprocess interrupt nothing handles surfaces to the endpoint too", async () => {
    // std::agency::run child hits a bash interrupt with no handler anywhere;
    // the policy approves only std::run. The child interrupt must bubble to
    // the root endpoint (rejected here, prompted under --interactive), resume
    // the child with the rejection, and let the whole tree finish cleanly.
    const dir = makeLocalDir(SUBPROCESS_FIXTURE);
    try {
      const { stdout, code } = await runCli(dir, ["--approve", "std::run"]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/CHILD_RESULT: child-saw-rejection/);
    } finally {
      rmLocal(dir);
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
