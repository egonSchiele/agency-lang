import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import {
  applyWorkdirAttachment,
  planWorkdirAttachment,
  WorkdirAttachmentError,
} from "./attachWorkdir.js";
import { readRunDirectory, runDirPaths } from "./runDir.js";
import { agentStartLine, tempDir, writeProject } from "./testFixtures.js";

const quiet = { reportWarning: () => {} };

function directoryWithTrace(): string {
  const dir = tempDir();
  fs.writeFileSync(runDirPaths(dir).statelog, agentStartLine("t1") + "\n");
  return dir;
}

describe("workdir attachment", () => {
  it("copies the tree under workdir/ and writes a dated sidecar", () => {
    const dir = directoryWithTrace();
    const paths = runDirPaths(dir);
    const source = writeProject({ "out.txt": "hello", "nested/deep.txt": "x" });
    const plan = planWorkdirAttachment(readRunDirectory(dir, quiet), { sourceDir: source }, paths);
    expect(plan.status).toBe("add");
    applyWorkdirAttachment(paths, plan, "2026-08-18T01:02:03Z");
    expect(fs.readFileSync(path.join(paths.workdirDir, "nested", "deep.txt"), "utf8")).toBe("x");
    const sidecar = JSON.parse(fs.readFileSync(paths.workdirSidecar, "utf8"));
    expect(sidecar).toEqual({ snapshotAt: "2026-08-18T01:02:03Z", source: path.resolve(source) });
  });

  it("refuses a directory with no trace and a missing source", () => {
    const empty = tempDir();
    const source = writeProject({ "out.txt": "hello" });
    expect(() =>
      planWorkdirAttachment(
        readRunDirectory(empty, quiet),
        { sourceDir: source },
        runDirPaths(empty),
      ),
    ).toThrow(WorkdirAttachmentError);
    const dir = directoryWithTrace();
    expect(() =>
      planWorkdirAttachment(
        readRunDirectory(dir, quiet),
        { sourceDir: path.join(source, "missing") },
        runDirPaths(dir),
      ),
    ).toThrow(WorkdirAttachmentError);
  });

  it("leaves the run directory (and an excluded group) out when they sit inside the tree being captured", () => {
    const source = writeProject({
      "note.txt": "keep",
      "sub/deep.txt": "keep too",
      "runs/other/statelog.jsonl": "",
    });
    const dir = path.join(source, "runs", "r1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(runDirPaths(dir).statelog, agentStartLine("t1") + "\n");
    const paths = runDirPaths(dir);
    const plan = planWorkdirAttachment(
      readRunDirectory(dir, quiet),
      { sourceDir: source, excludeDir: path.join(source, "runs") },
      paths,
    );
    applyWorkdirAttachment(paths, plan, "2026-08-18T00:00:00.000Z");
    const captured = paths.workdirDir;
    expect(fs.readFileSync(path.join(captured, "note.txt"), "utf8")).toBe("keep");
    expect(fs.readFileSync(path.join(captured, "sub", "deep.txt"), "utf8")).toBe("keep too");
    expect(fs.existsSync(path.join(captured, "runs"))).toBe(false);
  });

  it("refuses to overwrite without replace, and replaces cleanly with it", () => {
    const dir = directoryWithTrace();
    const paths = runDirPaths(dir);
    const first = writeProject({ "a.txt": "1" });
    const firstPlan = planWorkdirAttachment(
      readRunDirectory(dir, quiet),
      { sourceDir: first },
      paths,
    );
    applyWorkdirAttachment(paths, firstPlan, "2026-08-18T00:00:00Z");

    const second = writeProject({ "b.txt": "2" });
    expect(() =>
      planWorkdirAttachment(readRunDirectory(dir, quiet), { sourceDir: second }, paths),
    ).toThrow(/replace/);
    const replacePlan = planWorkdirAttachment(
      readRunDirectory(dir, quiet),
      { sourceDir: second, replace: true },
      paths,
    );
    expect(replacePlan.status).toBe("replace");
    applyWorkdirAttachment(paths, replacePlan, "2026-08-18T00:00:01Z");
    expect(fs.existsSync(path.join(paths.workdirDir, "a.txt"))).toBe(false);
    expect(fs.existsSync(path.join(paths.workdirDir, "b.txt"))).toBe(true);
  });
});
