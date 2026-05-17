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

  it("rejects input whose extension is not .agency", async () => {
    const bad = path.join(workDir, "bogus.txt");
    fs.writeFileSync(bad, "irrelevant");
    await expect(
      pack({
        config: loadConfig(),
        inputFile: bad,
        outputFile: path.join(workDir, "out.js"),
        target: "node",
      }),
    ).rejects.toThrow(/must end in \.agency/);
    // Must NOT have touched the input.
    expect(fs.readFileSync(bad, "utf-8")).toBe("irrelevant");
  });

  it("rejects missing input file with a clear error", async () => {
    await expect(
      pack({
        config: loadConfig(),
        inputFile: path.join(workDir, "does-not-exist.agency"),
        outputFile: path.join(workDir, "out.js"),
        target: "node",
      }),
    ).rejects.toThrow(/input file not found/);
  });

  it("re-packing over an existing non-executable file leaves it executable", async () => {
    const src = path.join(workDir, "exec.agency");
    fs.writeFileSync(src, 'node main() { print("x") }\n');
    const out = path.join(workDir, "exec.js");
    fs.writeFileSync(out, "old contents", { mode: 0o644 });
    expect(fs.statSync(out).mode & 0o777).toBe(0o644);
    await pack({
      config: loadConfig(),
      inputFile: src,
      outputFile: out,
      target: "node",
    });
    expect(fs.statSync(out).mode & 0o777).toBe(0o755);
  }, 60000);

  it("cleans up the .__pack__.js entry temp file after success", async () => {
    const src = path.join(workDir, "cleanup.agency");
    fs.writeFileSync(src, 'node main() { print("c") }\n');
    const out = path.join(workDir, "cleanup.js");
    await pack({
      config: loadConfig(),
      inputFile: src,
      outputFile: out,
      target: "node",
    });
    expect(fs.existsSync(path.join(workDir, "cleanup.__pack__.js"))).toBe(false);
  }, 60000);

  it("cleans up transitive .js sidecars from recursive .agency imports", async () => {
    const subDir = path.join(workDir, "trans");
    fs.mkdirSync(subDir, { recursive: true });
    const helper = path.join(subDir, "helper.agency");
    const main = path.join(subDir, "trans.agency");
    fs.writeFileSync(
      helper,
      'export def greet(): string { return "hi from helper" }\n',
    );
    fs.writeFileSync(
      main,
      'import { greet } from "./helper.agency"\nnode main() { print(greet()) }\n',
    );
    const out = path.join(subDir, "bundle.js");
    await pack({
      config: loadConfig(),
      inputFile: main,
      outputFile: out,
      target: "node",
    });
    // The bundle should exist and contain the helper's behavior.
    expect(fs.existsSync(out)).toBe(true);
    // The transitive helper.js compile() created should be cleaned up.
    expect(fs.existsSync(path.join(subDir, "helper.js"))).toBe(false);
    // The transitive entry temp should also be cleaned up.
    expect(fs.existsSync(path.join(subDir, "trans.__pack__.js"))).toBe(false);
  }, 60000);

  it("does NOT delete a sibling .js that existed before pack ran", async () => {
    const src = path.join(workDir, "preserve.agency");
    fs.writeFileSync(src, 'node main() { print("p") }\n');
    const userJs = path.join(workDir, "preserve.js");
    // User has their own preserve.js (NOT the pack output, which is
    // a different path).
    fs.writeFileSync(userJs, "// user wrote me");
    const out = path.join(workDir, "preserve.bundle.js");
    await pack({
      config: loadConfig(),
      inputFile: src,
      outputFile: out,
      target: "node",
    });
    expect(fs.existsSync(userJs)).toBe(true);
    expect(fs.readFileSync(userJs, "utf-8")).toBe("// user wrote me");
  }, 60000);
});
