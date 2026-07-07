import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256Text, type OptimizeTargetSet } from "./targets.js";
import { WorkspaceManager } from "./workspace.js";

describe("WorkspaceManager", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "wsm-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const sourceFor = (file: string, source: string, sha: string): OptimizeTargetSet => ({
    baseDir: root,
    entryFile: "a.agency",
    typeAliases: {},
    targets: [],
    files: { "a.agency": { file: "a.agency", absoluteFile: file, source, sha256: sha } },
  });

  it("gives each fork a distinct key (used as the EvalCache partition)", () => {
    const wsm = new WorkspaceManager();
    expect(wsm.fork().key).not.toBe(wsm.fork().key);
  });

  it("fork allocates no filesystem state — workspaces are pure cache identities now", () => {
    const wsm = new WorkspaceManager();
    const ws = wsm.fork();
    expect(ws).toEqual({ key: "ws-1" });
  });

  it("writeBack writes changed champion files back to source", () => {
    const file = path.join(root, "a.agency");
    fs.writeFileSync(file, "original");
    const wsm = new WorkspaceManager();
    wsm.writeBack(sourceFor(file, "original", sha256Text("original")), { "a.agency": "mutated" });
    expect(fs.readFileSync(file, "utf8")).toBe("mutated");
  });

  it("writeBack aborts when a source file changed on disk since discovery", () => {
    const file = path.join(root, "a.agency");
    fs.writeFileSync(file, "original");
    const wsm = new WorkspaceManager();
    // sha recorded at discovery no longer matches the on-disk content
    expect(() => wsm.writeBack(sourceFor(file, "stale", sha256Text("stale")), { "a.agency": "mutated" }))
      .toThrow(/modified externally/);
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });
});
