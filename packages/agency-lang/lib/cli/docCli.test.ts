import { describe, expect, test, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { DOC_LOCK_NAME } from "./docLedger.js";

// Subprocess tests through the compiled CLI: these behaviors (process.exit
// paths, environment capture at module load) cannot be exercised
// in-process. CI builds dist before running vitest (`make` precedes
// `pnpm test:run` in the unit job).

const CLI = path.join(process.cwd(), "dist", "scripts", "agency.js");
const dirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return fs.realpathSync(d);
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function runDoc(args: string[], env: Record<string, string> = {}): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [CLI, "doc", ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { status: err.status ?? -1, stderr: err.stderr?.toString() ?? "" };
  }
}

describe.skipIf(!fs.existsSync(CLI))("doc CLI subprocess behavior", () => {
  test("a parse error exits non-zero WITHOUT leaving a stale lock", () => {
    const inputDir = tmp("agency-doccli-in-");
    fs.writeFileSync(path.join(inputDir, "bad.agency"), "def {{{{ definitely not agency\n");
    const out = tmp("agency-doccli-out-");
    const r = runDoc([inputDir, "-o", out]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Failed to parse/);
    // The load-bearing assertion: the lock was released despite the exit,
    // so the next run (after the user fixes the file) is not refused.
    expect(fs.existsSync(path.join(out, DOC_LOCK_NAME))).toBe(false);
    fs.writeFileSync(path.join(inputDir, "bad.agency"), "export def ok(): number { return 1 }\n");
    expect(runDoc([inputDir, "-o", out]).status).toBe(0);
    expect(fs.existsSync(path.join(out, "bad.md"))).toBe(true);
  });

  test("rendering is AGENCY_DEBUG-independent: warm cache under debug equals a cold debug run", () => {
    const inputDir = tmp("agency-doccli-in-");
    fs.writeFileSync(
      path.join(inputDir, "a.agency"),
      `export type Foo = { a: number }\nexport def a(f: Foo): number { return 1 }\n`,
    );
    const warm = tmp("agency-doccli-warm-");
    expect(runDoc([inputDir, "-o", warm]).status).toBe(0); // cache built WITHOUT debug
    expect(runDoc([inputDir, "-o", warm], { AGENCY_DEBUG: "1" }).status).toBe(0); // warm, WITH debug
    const cold = tmp("agency-doccli-cold-");
    expect(runDoc([inputDir, "-o", cold], { AGENCY_DEBUG: "1" }).status).toBe(0); // cold, WITH debug
    const read = (d: string) => fs.readFileSync(path.join(d, "a.md"), "utf-8");
    expect(read(warm)).toBe(read(cold));
    // And neither contains generator trace markers.
    expect(read(cold)).not.toMatch(/\[processTypeAlias\]|\[\/[A-Za-z]+\]/);
  });
});
