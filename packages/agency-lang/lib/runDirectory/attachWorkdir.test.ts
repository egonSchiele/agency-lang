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
  it("copies the tree under workdir/<traceId>/ and writes a dated sidecar", () => {
    const dir = directoryWithTrace();
    const paths = runDirPaths(dir);
    const source = writeProject({ "out.txt": "hello", "nested/deep.txt": "x" });
    const plan = planWorkdirAttachment(
      readRunDirectory(dir, quiet),
      { traceId: "t1", sourceDir: source },
      paths,
    );
    expect(plan.status).toBe("add");
    applyWorkdirAttachment(paths, plan, "2026-08-18T01:02:03Z");
    expect(fs.readFileSync(path.join(paths.workdirDir, "t1", "nested", "deep.txt"), "utf8")).toBe(
      "x",
    );
    const sidecar = JSON.parse(fs.readFileSync(path.join(paths.workdirDir, "t1.json"), "utf8"));
    expect(sidecar).toEqual({ snapshotAt: "2026-08-18T01:02:03Z", source: path.resolve(source) });
  });

  it("refuses an unknown trace and a missing source", () => {
    const dir = directoryWithTrace();
    const paths = runDirPaths(dir);
    const source = writeProject({ "out.txt": "hello" });
    expect(() =>
      planWorkdirAttachment(
        readRunDirectory(dir, quiet),
        { traceId: "nope", sourceDir: source },
        paths,
      ),
    ).toThrow(WorkdirAttachmentError);
    expect(() =>
      planWorkdirAttachment(
        readRunDirectory(dir, quiet),
        { traceId: "t1", sourceDir: path.join(source, "missing") },
        paths,
      ),
    ).toThrow(WorkdirAttachmentError);
  });

  it("refuses a trace id that would place the workdir outside workdir/", () => {
    const dir = tempDir();
    fs.writeFileSync(runDirPaths(dir).statelog, agentStartLine("../escaped") + "\n");
    const paths = runDirPaths(dir);
    const source = writeProject({ "out.txt": "hello" });
    expect(() =>
      planWorkdirAttachment(
        readRunDirectory(dir, quiet),
        { traceId: "../escaped", sourceDir: source },
        paths,
      ),
    ).toThrow(/outside/);
    expect(fs.existsSync(path.join(dir, "escaped"))).toBe(false);
  });

  it("leaves the run directory itself out when it sits inside the tree being captured", () => {
    const source = writeProject({ "note.txt": "keep", "sub/deep.txt": "keep too" });
    const dir = path.join(source, "runs", "r1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(runDirPaths(dir).statelog, agentStartLine("t1") + "\n");
    const paths = runDirPaths(dir);
    const plan = planWorkdirAttachment(
      readRunDirectory(dir, quiet),
      { traceId: "t1", sourceDir: source },
      paths,
    );
    applyWorkdirAttachment(paths, plan, "2026-08-18T00:00:00.000Z");
    const captured = path.join(paths.workdirDir, "t1");
    expect(fs.readFileSync(path.join(captured, "note.txt"), "utf8")).toBe("keep");
    expect(fs.readFileSync(path.join(captured, "sub", "deep.txt"), "utf8")).toBe("keep too");
    expect(fs.existsSync(path.join(captured, "runs", "r1"))).toBe(false);
    expect(fs.existsSync(path.join(captured, "runs"))).toBe(true);
  });

  it("refuses to overwrite without replace, and replaces cleanly with it", () => {
    const dir = directoryWithTrace();
    const paths = runDirPaths(dir);
    const first = writeProject({ "a.txt": "1" });
    const firstPlan = planWorkdirAttachment(
      readRunDirectory(dir, quiet),
      { traceId: "t1", sourceDir: first },
      paths,
    );
    applyWorkdirAttachment(paths, firstPlan, "2026-08-18T00:00:00Z");

    const second = writeProject({ "b.txt": "2" });
    expect(() =>
      planWorkdirAttachment(
        readRunDirectory(dir, quiet),
        { traceId: "t1", sourceDir: second },
        paths,
      ),
    ).toThrow(/replace/);
    const replacePlan = planWorkdirAttachment(
      readRunDirectory(dir, quiet),
      { traceId: "t1", sourceDir: second, replace: true },
      paths,
    );
    expect(replacePlan.status).toBe("replace");
    applyWorkdirAttachment(paths, replacePlan, "2026-08-18T00:00:01Z");
    expect(fs.existsSync(path.join(paths.workdirDir, "t1", "a.txt"))).toBe(false);
    expect(fs.existsSync(path.join(paths.workdirDir, "t1", "b.txt"))).toBe(true);
  });
});
