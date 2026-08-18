import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { applyCodeAttachment, CodeMismatchError, planCodeAttachment } from "./attachCode.js";
import { computeCodeIdentity } from "./codeIdentity.js";
import { readRunDirectory, runDirPaths } from "./runDir.js";
import { agentStartLine, tempDir, writeProject } from "./testFixtures.js";

function directoryWithTraceFor(project: string): { dir: string; entry: string } {
  const entry = path.join(project, "main.agency");
  const identity = computeCodeIdentity(entry);
  const dir = tempDir();
  fs.writeFileSync(runDirPaths(dir).statelog, agentStartLine("t1", identity) + "\n");
  return { dir, entry };
}

const quiet = { reportWarning: () => {} };

describe("code attachment", () => {
  it("stores a matching closure under code/<hash>/ and is idempotent", () => {
    const project = writeProject({
      "main.agency": 'import { f } from "./lib/util.agency"\nnode main() { return f() }\n',
      "lib/util.agency": 'export def f(): string { return "x" }\n',
    });
    const { dir, entry } = directoryWithTraceFor(project);
    const paths = runDirPaths(dir);
    const plan = planCodeAttachment(readRunDirectory(dir, quiet), entry, paths);
    expect(plan.status).toBe("add");
    applyCodeAttachment(paths, plan);
    const stored = path.join(paths.codeDir, plan.identity.closureHash);
    expect(fs.existsSync(path.join(stored, "main.agency"))).toBe(true);
    expect(fs.existsSync(path.join(stored, "lib", "util.agency"))).toBe(true);

    const again = planCodeAttachment(readRunDirectory(dir, quiet), entry, paths);
    expect(again.status).toBe("already-present");
  });

  it("refuses code no trace recorded, naming the recorded hashes", () => {
    const project = writeProject({ "main.agency": "node main() { return 1 }\n" });
    const { dir } = directoryWithTraceFor(project);
    const other = writeProject({ "main.agency": "node main() { return 2 }\n" });
    const paths = runDirPaths(dir);
    expect(() =>
      planCodeAttachment(readRunDirectory(dir, quiet), path.join(other, "main.agency"), paths),
    ).toThrow(CodeMismatchError);
    expect(fs.existsSync(paths.codeDir)).toBe(false);
  });

  it("refuses when the traces recorded no code at all", () => {
    const project = writeProject({ "main.agency": "node main() { return 1 }\n" });
    const dir = tempDir();
    fs.writeFileSync(runDirPaths(dir).statelog, agentStartLine("t1") + "\n");
    expect(() =>
      planCodeAttachment(
        readRunDirectory(dir, quiet),
        path.join(project, "main.agency"),
        runDirPaths(dir),
      ),
    ).toThrow(/none recorded/);
  });

  it("refuses a stored tree that is incomplete or corrupt", () => {
    const project = writeProject({ "main.agency": "node main() { return 1 }\n" });
    const { dir, entry } = directoryWithTraceFor(project);
    const paths = runDirPaths(dir);
    const plan = planCodeAttachment(readRunDirectory(dir, quiet), entry, paths);
    applyCodeAttachment(paths, plan);
    const stored = path.join(paths.codeDir, plan.identity.closureHash, "main.agency");
    fs.writeFileSync(stored, "node main() { return 999 }\n");
    expect(() => planCodeAttachment(readRunDirectory(dir, quiet), entry, paths)).toThrow(/corrupt/);
    fs.rmSync(stored);
    expect(() => planCodeAttachment(readRunDirectory(dir, quiet), entry, paths)).toThrow(
      /incomplete/,
    );
  });
});
