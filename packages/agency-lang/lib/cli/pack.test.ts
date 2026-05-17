import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { pack } from "./pack.js";
import { loadConfig } from "./commands.js";

describe("agency pack", () => {
  let workDir: string;
  beforeAll(() => {
    // Use realpath to avoid macOS /tmp -> /private/tmp symlink mismatch,
    // which would defeat the `argv[1] === fileURLToPath(import.meta.url)`
    // entry-point check in the compiled output.
    workDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agency-pack-")),
    );
  });
  afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

  it("produces a self-contained executable .js", async () => {
    const src = path.join(workDir, "hello.agency");
    fs.writeFileSync(src, 'node main() { print("hello from pack") }\n');
    const out = path.join(workDir, "hello.js");
    await pack({
      config: loadConfig(),
      inputFile: src,
      outputFile: out,
      target: "node",
    });

    expect(fs.existsSync(out)).toBe(true);
    const text = fs.readFileSync(out, "utf-8");
    expect(text.startsWith("#!/usr/bin/env node")).toBe(true);
    // No bare imports of agency-lang should remain in the bundle.
    expect(text).not.toMatch(/from\s+["']agency-lang/);

    // It should run under bare `node` from a directory with no
    // node_modules, producing the agent's output.
    const runDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agency-pack-run-")),
    );
    try {
      const copied = path.join(runDir, "hello.js");
      fs.copyFileSync(out, copied);
      const stdout = execFileSync(process.execPath, [copied], {
        encoding: "utf-8",
      });
      expect(stdout).toContain("hello from pack");
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  }, 60000);
});
