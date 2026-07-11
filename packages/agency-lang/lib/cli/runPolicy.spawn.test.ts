import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const execFileAsync = promisify(execFile);

// End-to-end: run the BUILT CLI (`agency run <file> --reject/--approve ...`) and
// observe the program's own marker. A handler-rejected effect exits 0 and prints
// nothing on its own, so the fixture inspects the write Result and prints a marker.
const CLI = path.resolve("dist/scripts/agency.js");

const FIXTURE = `node main() {
  const r = write(filename: "policy-spawn-out.txt", content: "x", dir: ".")
  match (r) {
    success(_) => print("WRITE_OK")
    failure(_) => print("WRITE_REJECTED")
  }
}
`;

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "runpol-spawn-"));
  writeFileSync(path.join(dir, "writer.agency"), FIXTURE);
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

describe("agency run --policy flags (end-to-end)", () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      throw new Error(`built CLI not found at ${CLI} — run \`make\` first`);
    }
  });

  it("rejects std::write under --reject std::write (exit 0, observable marker)", async () => {
    const dir = makeDir();
    try {
      const { stdout, code } = await runCli(dir, ["--reject", "std::write"]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/WRITE_REJECTED/);
      expect(stdout).not.toMatch(/WRITE_OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
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
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
