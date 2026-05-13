import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoverageCollector } from "./coverageCollector.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("CoverageCollector", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "agency-cov-test-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("records hits with correct structure", () => {
    const collector = new CoverageCollector();
    collector.hit("stdlib/fs.agency", "mkdir", "0");
    collector.hit("stdlib/fs.agency", "mkdir", "1");
    collector.hit("stdlib/fs.agency", "copy", "0");

    const hits = collector.getHits();
    expect(hits["stdlib/fs.agency:mkdir"]).toEqual({ "0": true, "1": true });
    expect(hits["stdlib/fs.agency:copy"]).toEqual({ "0": true });
  });

  it("deduplicates repeated hits", () => {
    const collector = new CoverageCollector();
    collector.hit("mod", "fn", "0");
    collector.hit("mod", "fn", "0");
    collector.hit("mod", "fn", "0");

    const hits = collector.getHits();
    expect(Object.keys(hits["mod:fn"])).toHaveLength(1);
  });

  it("ignores hits for pkg:: imported modules", () => {
    const collector = new CoverageCollector();
    collector.hit("pkg::some-pkg/foo.agency", "fn", "0");
    collector.hit("/abs/path/node_modules/some-pkg/foo.agency", "fn", "0");
    collector.hit("real/module.agency", "fn", "0");

    const hits = collector.getHits();
    expect(hits["pkg::some-pkg/foo.agency:fn"]).toBeUndefined();
    expect(hits["/abs/path/node_modules/some-pkg/foo.agency:fn"]).toBeUndefined();
    expect(hits["real/module.agency:fn"]).toEqual({ "0": true });
  });

  it("writes JSON file to output directory", () => {
    const collector = new CoverageCollector();
    collector.hit("mod", "fn", "0");
    collector.write(outDir);

    const files = readdirSync(outDir).filter((f) => f.startsWith("cov-"));
    expect(files).toHaveLength(1);

    const data = JSON.parse(readFileSync(join(outDir, files[0]), "utf-8"));
    expect(data["mod:fn"]).toEqual({ "0": true });
  });

  it("generates unique filenames", () => {
    const c1 = new CoverageCollector();
    const c2 = new CoverageCollector();
    c1.hit("a", "b", "0");
    c2.hit("a", "b", "0");
    c1.write(outDir);
    c2.write(outDir);

    const files = readdirSync(outDir).filter((f) => f.startsWith("cov-"));
    expect(files).toHaveLength(2);
  });
});
