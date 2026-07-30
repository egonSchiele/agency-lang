import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { parseTarget, resolveEvalRunTarget } from "./agentTarget.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
  // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("agent targets", () => {
  it("splits path from node on the last colon", () => {
    expect(parseTarget("a.agency:main")).toEqual({ filename: "a.agency", nodeName: "main" });
    expect(parseTarget("a.agency")).toEqual({ filename: "a.agency", nodeName: "" });
  });

  it("resolves file and directory agent targets", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-target-"));
    dirs.push(tmpDir);
    const file = path.join(tmpDir, "agent.agency");
    fs.writeFileSync(file, "node main() {}\n");
    const dir = path.join(tmpDir, "agent-dir");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "main.agency"), "node main() {}\n");

    expect(resolveEvalRunTarget(`${file}:evalMain`)).toEqual({ agentFile: file, node: "evalMain", label: `${file}:evalMain` });
    expect(resolveEvalRunTarget(file)).toEqual({ agentFile: file, node: "main", label: `${file}:main` });
    expect(resolveEvalRunTarget(dir)).toEqual({ agentFile: path.join(dir, "main.agency"), node: "main", label: `${path.join(dir, "main.agency")}:main` });
  });
});
