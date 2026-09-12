import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/scripts/agency.js");

const SOURCE = `import { args } from "std::system"

let status = "old"

node main(name: string = "before") {
  let mood = "sad"
  const id = checkpoint()
  print("CHECKPOINT_BEGIN")
  printJSON(getCheckpoint(id))
  print("CHECKPOINT_END")
  const argv = args()
  print("VALUES:" + mood + ":" + name + ":" + status + ":" + argv[0])
}
`;

const REINTERRUPT_SOURCE = `effect test::gate { label: string }

node main() {
  const id = checkpoint()
  print("CHECKPOINT_BEGIN")
  printJSON(getCheckpoint(id))
  print("CHECKPOINT_END")
  interrupt test::gate("pause", { label: "again" })
  print("AFTER_GATE")
}
`;

function checkpointFrom(output: string): string {
  const match = output.match(/CHECKPOINT_BEGIN\s*([\s\S]*?)\s*CHECKPOINT_END/);
  expect(match).not.toBeNull();
  return match![1];
}

function removeTemp(dir: string): void {
  const root = realpathSync(process.cwd());
  const resolved = realpathSync(dir);
  if (
    path.dirname(resolved) === root &&
    path.basename(resolved).startsWith(".agency-resume-spawn-")
  ) {
    rmSync(resolved, { recursive: true, force: true });
  }
}

async function invoke(dir: string, args: string[]) {
  try {
    const result = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: dir,
      timeout: 60_000,
    });
    return { ...result, code: 0 };
  } catch (error: any) {
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? 1 };
  }
}

describe.skipIf(!existsSync(CLI))("agency resume (end-to-end)", () => {
  it("resumes with all override buckets, program argv, and a complete trace", async () => {
    const dir = mkdtempSync(path.join(process.cwd(), ".agency-resume-spawn-"));
    try {
      writeFileSync(path.join(dir, "agent.agency"), SOURCE);
      const fresh = await invoke(dir, ["run", "--trace-file", "resume.trace", "agent.agency"]);
      expect(fresh.code, fresh.stderr).toBe(0);
      writeFileSync(path.join(dir, "checkpoint.json"), checkpointFrom(fresh.stdout));
      rmSync(path.join(dir, "resume.trace"));

      const resumed = await invoke(dir, [
        "resume",
        "checkpoint.json",
        "agent.agency",
        "--local-var",
        "mood=happy",
        "--arg",
        'name="Ada"',
        "--global-var",
        'status="ready"',
        "--program-arg",
        "hello",
        "--trace-file",
        "resume.trace",
      ]);

      expect(resumed.code, resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain("VALUES:happy:Ada:ready:hello");
      const trace = readFileSync(path.join(dir, "resume.trace"), "utf8");
      expect(trace).toMatch(/"type":"header"/);
      expect(trace).toMatch(/"type":"footer"/);
    } finally {
      removeTemp(dir);
    }
  }, 120_000);

  it("surfaces another interrupt, or handles it with the resumed root policy", async () => {
    const dir = mkdtempSync(path.join(process.cwd(), ".agency-resume-spawn-"));
    try {
      writeFileSync(path.join(dir, "agent.agency"), REINTERRUPT_SOURCE);
      const fresh = await invoke(dir, ["run", "agent.agency"]);
      expect(fresh.code).not.toBe(0);
      writeFileSync(path.join(dir, "checkpoint.json"), checkpointFrom(fresh.stdout));

      const unhandled = await invoke(dir, ["resume", "checkpoint.json", "agent.agency"]);
      expect(unhandled.code).not.toBe(0);
      expect(unhandled.stderr).toMatch(/was not handled/i);

      const approved = await invoke(dir, [
        "resume",
        "checkpoint.json",
        "agent.agency",
        "--approve",
        "test::gate",
      ]);
      expect(approved.code, approved.stderr).toBe(0);
      expect(approved.stdout).toContain("AFTER_GATE");
    } finally {
      removeTemp(dir);
    }
  }, 120_000);

  it("preserves --agency-only compilation refusal", async () => {
    const dir = mkdtempSync(path.join(process.cwd(), ".agency-resume-spawn-"));
    try {
      writeFileSync(path.join(dir, "checkpoint.json"), "{}");
      writeFileSync(path.join(dir, "helper.js"), "export const value = 1;\n");
      writeFileSync(
        path.join(dir, "agent.agency"),
        'import { value } from "./helper.js"\nnode main() { return value }\n',
      );

      const result = await invoke(dir, [
        "resume",
        "checkpoint.json",
        "agent.agency",
        "--agency-only",
      ]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/agency-only compile refused/i);
    } finally {
      removeTemp(dir);
    }
  }, 120_000);

  it("refuses a checkpoint after the Agency source changes", async () => {
    const dir = mkdtempSync(path.join(process.cwd(), ".agency-resume-spawn-"));
    try {
      writeFileSync(path.join(dir, "agent.agency"), SOURCE);
      const fresh = await invoke(dir, ["run", "agent.agency"]);
      expect(fresh.code, fresh.stderr).toBe(0);
      writeFileSync(path.join(dir, "checkpoint.json"), checkpointFrom(fresh.stdout));
      writeFileSync(path.join(dir, "agent.agency"), SOURCE.replace("VALUES:", "CHANGED:"));

      const resumed = await invoke(dir, ["resume", "checkpoint.json", "agent.agency"]);

      expect(resumed.code).not.toBe(0);
      expect(resumed.stderr).toMatch(/code .* has changed/i);
    } finally {
      removeTemp(dir);
    }
  }, 120_000);
});
