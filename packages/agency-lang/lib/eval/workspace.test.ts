import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { Workspace, type SeededSeed } from "./workspace.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
  // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  dirs.push(tempDir);
  return tempDir;
}

/** A project with an entry agent importing one helper, plus junk that must NOT be seeded. */
function makeProject(): { baseDir: string; seed: SeededSeed } {
  const baseDir = tmp();
  fs.mkdirSync(path.join(baseDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(baseDir, "lib", "helper.agency"), "export def helper(): string { return \"hi\" }\n");
  fs.writeFileSync(path.join(baseDir, "agent.agency"), "import { helper } from \"./lib/helper.agency\"\nnode main() {}\n");
  fs.writeFileSync(path.join(baseDir, "junk.bin"), Buffer.alloc(2 * 1024 * 1024));
  const seed: SeededSeed = {
    kind: "seeded",
    baseDir,
    agentRelPath: "agent.agency",
    closureFiles: [path.join(baseDir, "agent.agency"), path.join(baseDir, "lib", "helper.agency")],
  };
  return { baseDir, seed };
}

function totalBytes(dir: string): number {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.statSync(path.join(entry.parentPath, entry.name)).size)
    .reduce((sum, size) => sum + size, 0);
}

describe("Workspace.create", () => {
  it("seeds only the closure, at project-relative paths, and compiles the entry", () => {
    const { seed } = makeProject();
    const workdirPath = path.join(tmp(), "workdir");

    const workspace = Workspace.create({ workdirPath, seed, config: {} });

    expect(fs.existsSync(path.join(workdirPath, "agent.agency"))).toBe(true);
    expect(fs.existsSync(path.join(workdirPath, "lib", "helper.agency"))).toBe(true);
    expect(fs.existsSync(path.join(workdirPath, "junk.bin"))).toBe(false);
    expect(fs.existsSync(workspace.compiledEntryPath)).toBe(true);
    expect(workspace.seededFiles).toEqual(["agent.agency", path.join("lib", "helper.agency")]);
  });

  it("seeds agency.json and .env from baseDir when present", () => {
    const { baseDir, seed } = makeProject();
    fs.writeFileSync(path.join(baseDir, "agency.json"), "{}");
    fs.writeFileSync(path.join(baseDir, ".env"), "KEY=value\n");
    const workdirPath = path.join(tmp(), "workdir");

    Workspace.create({ workdirPath, seed, config: {} });

    expect(fs.existsSync(path.join(workdirPath, "agency.json"))).toBe(true);
    expect(fs.existsSync(path.join(workdirPath, ".env"))).toBe(true);
  });

  it("copies test files to the workdir root alongside the closure", () => {
    const { seed } = makeProject();
    const filesDir = tmp();
    fs.mkdirSync(path.join(filesDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(filesDir, "data", "report.txt"), "q3 numbers");
    const workdirPath = path.join(tmp(), "workdir");

    const workspace = Workspace.create({ workdirPath, seed: { ...seed, filesDir }, config: {} });

    expect(fs.readFileSync(path.join(workdirPath, "data", "report.txt"), "utf8")).toBe("q3 numbers");
    expect(workspace.seededFiles).toContain(path.join("data", "report.txt"));
  });

  it("errors on a test-file/closure collision, naming the path and both sources", () => {
    const { seed } = makeProject();
    const filesDir = tmp();
    fs.mkdirSync(path.join(filesDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(filesDir, "lib", "helper.agency"), "node main() {}\n");
    const workdirPath = path.join(tmp(), "workdir");

    expect(() => Workspace.create({ workdirPath, seed: { ...seed, filesDir }, config: {} }))
      .toThrow(/lib\/helper\.agency.*test files.*agent/s);
  });

  it("applies overlayFiles last, over a closure file, and refuses escapes", () => {
    const { seed } = makeProject();

    const workspace = Workspace.create({
      workdirPath: path.join(tmp(), "workdir"), seed, config: {},
      overlayFiles: { "lib/helper.agency": "export def helper(): string { return \"mutated\" }\n" },
    });
    expect(fs.readFileSync(path.join(workspace.workdirPath, "lib", "helper.agency"), "utf8")).toContain("mutated");

    expect(() => Workspace.create({
      workdirPath: path.join(tmp(), "w2"), seed, config: {},
      overlayFiles: { "../escape.txt": "nope" },
    })).toThrow(/escapes the workdir/);
  });

  it("legacy cloneDir mode copies the directory wholesale (working_dir compatibility)", () => {
    const { baseDir, seed } = makeProject();
    const workdirPath = path.join(tmp(), "workdir");

    Workspace.create({
      workdirPath,
      seed: { kind: "legacyClone", baseDir, agentRelPath: seed.agentRelPath, cloneDir: baseDir },
      config: {},
    });

    expect(fs.existsSync(path.join(workdirPath, "junk.bin"))).toBe(true);
  });

  it("size guard: a seeded workdir stays under 1 MB even in a 2 MB project", () => {
    const { seed } = makeProject();
    const filesDir = tmp();
    fs.writeFileSync(path.join(filesDir, "fixture.txt"), "small");
    const workdirPath = path.join(tmp(), "workdir");

    Workspace.create({ workdirPath, seed: { ...seed, filesDir }, config: {} });

    expect(totalBytes(workdirPath)).toBeLessThan(1024 * 1024);
  });
});
