import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyProjectTree, PROJECT_COPY_EXCLUDES } from "./projectTree.js";

describe("copyProjectTree", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cpt-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("copies files but skips excluded entries and the dir containing dest", () => {
    const src = path.join(root, "src");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "a.txt"), "a");
    fs.writeFileSync(path.join(src, "sub", "b.txt"), "b");
    fs.mkdirSync(path.join(src, "node_modules"));
    fs.writeFileSync(path.join(src, "node_modules", "junk"), "x");
    // dest lives inside src under a top-level "runs" entry
    const dest = path.join(src, "runs", "wd");

    copyProjectTree(src, dest);

    expect(fs.readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("a");
    expect(fs.readFileSync(path.join(dest, "sub", "b.txt"), "utf8")).toBe("b");
    expect(fs.existsSync(path.join(dest, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "runs"))).toBe(false);
    expect(PROJECT_COPY_EXCLUDES).toContain("package.json");
  });

  it("skips a non-runs top-level entry that contains dest (custom runs-dir name)", () => {
    const src = path.join(root, "proj");
    fs.mkdirSync(path.join(src, "optimize-runs"), { recursive: true });
    fs.writeFileSync(path.join(src, "agent.agency"), "node main() { return 1 }\n");
    const dest = path.join(src, "optimize-runs", "smoke", "wd");

    copyProjectTree(src, dest);

    expect(fs.existsSync(path.join(dest, "agent.agency"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "optimize-runs"))).toBe(false);
  });

  it("excludes package.json so a copied agent's agency-lang self-import climbs out", () => {
    const src = path.join(root, "proj");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "package.json"), '{"name":"agency-lang"}');
    fs.writeFileSync(path.join(src, "agent.agency"), "node main() { return 1 }\n");
    const dest = path.join(root, "wd");

    copyProjectTree(src, dest);

    expect(fs.existsSync(path.join(dest, "agent.agency"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "package.json"))).toBe(false);
  });
});
