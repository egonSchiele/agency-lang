import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareRunDir } from "./runWorkdir.js";

describe("prepareRunDir", () => {
  let root: string;
  let seed: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "prd-"));
    seed = path.join(root, "proj");
    fs.mkdirSync(path.join(seed, "demo"), { recursive: true });
    fs.writeFileSync(path.join(seed, "agent.agency"), "node main() { return 1 }\n");
    fs.writeFileSync(path.join(seed, "demo", "data.txt"), "original\n");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("seeds the workdir, applies overlay, and compiles the entry in place", () => {
    const workdir = path.join(root, "wd");
    const prepared = prepareRunDir(
      { seedDir: seed, agentRelPath: "agent.agency", overlayFiles: { "demo/data.txt": "patched\n" } },
      workdir,
      {},
    );

    // overlay applied on top of the seeded copy
    expect(fs.readFileSync(path.join(workdir, "demo", "data.txt"), "utf8")).toBe("patched\n");
    // compiled entry lives inside the workdir, next to its source
    expect(prepared.compiledEntryPath).toBe(path.join(workdir, "agent.js"));
    expect(fs.existsSync(prepared.compiledEntryPath)).toBe(true);
    expect(prepared.workdirPath).toBe(workdir);
  });

  it("refuses overlay keys that escape the workdir (traversal / absolute)", () => {
    const workdir = path.join(root, "wd-escape");
    const outside = path.join(root, "outside.txt");
    expect(() =>
      prepareRunDir(
        { seedDir: seed, agentRelPath: "agent.agency", overlayFiles: { "../outside.txt": "x" } },
        workdir,
        {},
      ),
    ).toThrow(/escapes the workdir/);
    expect(() =>
      prepareRunDir(
        { seedDir: seed, agentRelPath: "agent.agency", overlayFiles: { [outside]: "x" } },
        path.join(root, "wd-escape-abs"),
        {},
      ),
    ).toThrow(/escapes the workdir/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("works without an overlay", () => {
    const workdir = path.join(root, "wd2");
    const prepared = prepareRunDir(
      { seedDir: seed, agentRelPath: "agent.agency" },
      workdir,
      {},
    );

    expect(fs.readFileSync(path.join(workdir, "demo", "data.txt"), "utf8")).toBe("original\n");
    expect(fs.existsSync(prepared.compiledEntryPath)).toBe(true);
  });
});
