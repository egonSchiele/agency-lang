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
    targets: [],
    files: { "a.agency": { file: "a.agency", absoluteFile: file, source, sha256: sha } },
  });

  it("forks a source dir into an isolated copy; edits do not touch the source", () => {
    const src = path.join(root, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "agent.agency"), "node main() {}\n");
    const wsm = new WorkspaceManager(path.join(root, "ws"));
    const ws = wsm.fork(src);
    expect(wsm.read(ws, "agent.agency")).toContain("node main()");
    wsm.write(ws, "agent.agency", "node main() { 1 }\n");
    expect(fs.readFileSync(path.join(src, "agent.agency"), "utf8")).not.toContain("{ 1 }");
  });

  it("applyFiles writes a file map into the workspace", () => {
    const src = path.join(root, "src");
    fs.mkdirSync(src);
    const wsm = new WorkspaceManager(path.join(root, "ws"));
    const ws = wsm.fork(src);
    wsm.applyFiles(ws, { "a/b.agency": "node main() {}\n" });
    expect(wsm.read(ws, "a/b.agency")).toContain("node main()");
  });

  it("gives each fork a distinct key", () => {
    const src = path.join(root, "src");
    fs.mkdirSync(src);
    const wsm = new WorkspaceManager(path.join(root, "ws"));
    expect(wsm.fork(src).key).not.toBe(wsm.fork(src).key);
  });

  it("fork skips heavy directories like node_modules", () => {
    const src = path.join(root, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "agent.agency"), "node main() {}\n");
    fs.mkdirSync(path.join(src, "node_modules"));
    fs.writeFileSync(path.join(src, "node_modules", "big.js"), "x");
    const ws = new WorkspaceManager(path.join(root, "ws")).fork(src);
    expect(fs.existsSync(path.join(ws.dir, "agent.agency"))).toBe(true);
    expect(fs.existsSync(path.join(ws.dir, "node_modules"))).toBe(false);
  });

  it("forks when the workspace root lives inside the source dir (runs/ under the package)", () => {
    // Mirrors the real layout: agent at the package root, runsDir = <root>/runs/optimize.
    fs.writeFileSync(path.join(root, "agent.agency"), "node main() {}\n");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "big.js"), "x");
    fs.mkdirSync(path.join(root, "runs"), { recursive: true });
    fs.writeFileSync(path.join(root, "runs", "stale.txt"), "old");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "agency-lang" }));

    const wsm = new WorkspaceManager(path.join(root, "runs", "optimize", "r", "ws"));
    const ws = wsm.fork(root);

    expect(fs.existsSync(path.join(ws.dir, "agent.agency"))).toBe(true);
    expect(fs.existsSync(path.join(ws.dir, "node_modules"))).toBe(false); // excluded
    expect(fs.existsSync(path.join(ws.dir, "runs"))).toBe(false);          // excluded → no self-copy
    // package.json excluded so the agent's `agency-lang` self-import climbs to the real package root.
    expect(fs.existsSync(path.join(ws.dir, "package.json"))).toBe(false);
  });

  it("forks when the workspace root is inside a custom-named runs dir (--runs-dir optimize-runs)", () => {
    // Reproduces the integration-test layout: agent at the base dir, but the
    // runs dir is named "optimize-runs", not "runs". The fork must still skip
    // the subtree containing the workspace root or cpSync self-copies.
    fs.writeFileSync(path.join(root, "agent.agency"), "node main() {}\n");
    fs.mkdirSync(path.join(root, "optimize-runs"), { recursive: true });
    fs.writeFileSync(path.join(root, "optimize-runs", "stale.txt"), "old");

    const wsm = new WorkspaceManager(path.join(root, "optimize-runs", "smoke", "ws"));
    const ws = wsm.fork(root);

    expect(fs.existsSync(path.join(ws.dir, "agent.agency"))).toBe(true);
    expect(fs.existsSync(path.join(ws.dir, "optimize-runs"))).toBe(false); // skipped → no self-copy
  });

  it("refuses paths that escape the workspace (traversal / absolute)", () => {
    const src = path.join(root, "src");
    fs.mkdirSync(src);
    const wsm = new WorkspaceManager(path.join(root, "ws"));
    const ws = wsm.fork(src);
    expect(() => wsm.write(ws, "../escape.txt", "x")).toThrow(/escapes the workspace/);
    expect(() => wsm.read(ws, "../../etc/passwd")).toThrow(/escapes the workspace/);
  });

  it("writeBack writes changed champion files back to source", () => {
    const file = path.join(root, "a.agency");
    fs.writeFileSync(file, "original");
    const wsm = new WorkspaceManager(path.join(root, "ws"));
    wsm.writeBack(sourceFor(file, "original", sha256Text("original")), { "a.agency": "mutated" });
    expect(fs.readFileSync(file, "utf8")).toBe("mutated");
  });

  it("writeBack aborts when a source file changed on disk since discovery", () => {
    const file = path.join(root, "a.agency");
    fs.writeFileSync(file, "original");
    const wsm = new WorkspaceManager(path.join(root, "ws"));
    // sha recorded at discovery no longer matches the on-disk content
    expect(() => wsm.writeBack(sourceFor(file, "stale", sha256Text("stale")), { "a.agency": "mutated" }))
      .toThrow(/modified externally/);
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });
});
