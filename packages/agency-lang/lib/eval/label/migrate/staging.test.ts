import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inventoryChecklists,
  isEmptyDirectory,
  MARKER_PURPOSE,
  readMarker,
  removeStaging,
  StagingError,
  StagingMarkerSchema,
  writeMarker,
  type StagingMarker,
} from "./staging.js";

let root: string;
let stagingDir: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "label-staging-")));
  stagingDir = path.join(root, "labels.migrating");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function marker(over: Partial<StagingMarker> = {}): StagingMarker {
  return {
    purpose: MARKER_PURPOSE,
    sourceDir: path.join(root, "old"),
    destDir: path.join(root, "labels"),
    entries: [],
    ...over,
  };
}

function write(relative: string, contents = "x"): string {
  const target = path.join(stagingDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

describe("marker entries are untrusted data", () => {
  it("rejects a path that escapes the staging directory", () => {
    const parsed = StagingMarkerSchema.safeParse(
      marker({ entries: [{ path: "../precious", type: "file" }] }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects an absolute path", () => {
    expect(StagingMarkerSchema.safeParse(
      marker({ entries: [{ path: "/etc/passwd", type: "file" }] }),
    ).success).toBe(false);
  });

  it("rejects a path outside the one subtree migration copies", () => {
    expect(StagingMarkerSchema.safeParse(
      marker({ entries: [{ path: "outputs.jsonl", type: "file" }] }),
    ).success).toBe(false);
  });

  it("rejects a traversal hidden mid-path", () => {
    expect(StagingMarkerSchema.safeParse(
      marker({ entries: [{ path: "checklists/../../precious", type: "file" }] }),
    ).success).toBe(false);
  });

  it("rejects a duplicated entry path", () => {
    expect(StagingMarkerSchema.safeParse(marker({
      entries: [
        { path: "checklists/a", type: "file" },
        { path: "checklists/a", type: "file" },
      ],
    })).success).toBe(false);
  });

  it("accepts an ordinary checklist path", () => {
    expect(StagingMarkerSchema.safeParse(
      marker({ entries: [{ path: "checklists/cl_a/1.json", type: "file" }] }),
    ).success).toBe(true);
  });

  it("reads a malformed marker as absent rather than trusting it", () => {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, ".migration.json"), '{"purpose":"agency-eval-label-migrate","entries":[{"path":"../x","type":"file"}]}');
    expect(readMarker(stagingDir)).toBeUndefined();
  });
});

describe("removeStaging stays inside the staging directory", () => {
  it("does not follow a symlink that replaced an inventoried parent", () => {
    // lstat only declines to follow the FINAL component, so joining a
    // multi-segment path and checking the result still resolves an intermediate
    // link. Descending one verified component at a time is what prevents it.
    const external = path.join(root, "external");
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "1.json"), "PRECIOUS");

    fs.mkdirSync(path.join(stagingDir, "checklists"), { recursive: true });
    fs.symlinkSync(external, path.join(stagingDir, "checklists", "cl_a"));
    const owned = marker({
      entries: [
        { path: "checklists", type: "dir" },
        { path: "checklists/cl_a", type: "dir" },
        { path: "checklists/cl_a/1.json", type: "file" },
      ],
    });
    writeMarker(stagingDir, owned);

    removeStaging(stagingDir, owned);
    expect(fs.readFileSync(path.join(external, "1.json"), "utf8")).toBe("PRECIOUS");
    expect(fs.existsSync(stagingDir)).toBe(false);
  });

  it("leaves an unowned file in place and reports it", () => {
    const owned = marker({ entries: [{ path: "checklists", type: "dir" }] });
    fs.mkdirSync(path.join(stagingDir, "checklists"), { recursive: true });
    writeMarker(stagingDir, owned);
    write("checklists/not-ours.txt", "important");
    expect(() => removeStaging(stagingDir, owned)).toThrow(StagingError);
    expect(fs.readFileSync(path.join(stagingDir, "checklists", "not-ours.txt"), "utf8"))
      .toBe("important");
  });

  it("removes the marker LAST, so a crash mid-cleanup stays recognisable", () => {
    // Deleting it first leaves an unmarked half-cleaned directory that no later
    // attempt can recognise, and so refuses forever.
    const owned = marker({
      entries: [
        { path: "checklists", type: "dir" },
        { path: "checklists/1.json", type: "file" },
      ],
    });
    fs.mkdirSync(path.join(stagingDir, "checklists"), { recursive: true });
    writeMarker(stagingDir, owned);
    write("checklists/1.json");
    write("outputs.jsonl");

    // Make the final rmdir fail by leaving something unowned behind.
    write("checklists/intruder.txt");
    expect(() => removeStaging(stagingDir, owned)).toThrow();
    expect(fs.existsSync(path.join(stagingDir, ".migration.json"))).toBe(true);
  });

  it("refuses a staging root that is itself a symlink", () => {
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, stagingDir);
    expect(() => removeStaging(stagingDir, marker())).toThrow(StagingError);
  });
});

describe("inventoryChecklists", () => {
  let sourceDir: string;

  beforeEach(() => {
    sourceDir = path.join(root, "old");
    fs.mkdirSync(sourceDir, { recursive: true });
  });

  it("reports no entries when there are no checklists", () => {
    expect(inventoryChecklists(sourceDir)).toEqual([]);
  });

  it("refuses a checklists ROOT that is a symlink", () => {
    // existsSync follows links, so the root used to be inventoried straight
    // through into whatever it pointed at.
    const external = path.join(root, "external");
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "1.json"), "x");
    fs.symlinkSync(external, path.join(sourceDir, "checklists"));
    expect(() => inventoryChecklists(sourceDir)).toThrow(/symbolic link/);
  });

  it("refuses a DANGLING checklists root link rather than calling it absent", () => {
    fs.symlinkSync(path.join(root, "nowhere"), path.join(sourceDir, "checklists"));
    expect(() => inventoryChecklists(sourceDir)).toThrow(/symbolic link/);
  });

  it("refuses a checklists root that is a file", () => {
    fs.writeFileSync(path.join(sourceDir, "checklists"), "x");
    expect(() => inventoryChecklists(sourceDir)).toThrow(/not a directory/);
  });

  it("refuses a symlink nested inside the tree", () => {
    fs.mkdirSync(path.join(sourceDir, "checklists"), { recursive: true });
    fs.symlinkSync(root, path.join(sourceDir, "checklists", "shared"));
    expect(() => inventoryChecklists(sourceDir)).toThrow(/symbolic link/);
  });

  it("inventories a real tree, deterministically", () => {
    fs.mkdirSync(path.join(sourceDir, "checklists", "cl_a"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "checklists", "cl_a", "1.json"), "x");
    expect(inventoryChecklists(sourceDir)).toEqual([
      { path: "checklists", type: "dir" },
      { path: "checklists/cl_a", type: "dir" },
      { path: "checklists/cl_a/1.json", type: "file" },
    ]);
  });
});

describe("isEmptyDirectory", () => {
  it("recognises the shell left by a crash after the marker was unlinked", () => {
    fs.mkdirSync(stagingDir, { recursive: true });
    expect(isEmptyDirectory(stagingDir)).toBe(true);
  });

  it("is false for a directory holding anything", () => {
    write("outputs.jsonl");
    expect(isEmptyDirectory(stagingDir)).toBe(false);
  });

  it("is false for a symlink, even one pointing at an empty directory", () => {
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty, { recursive: true });
    fs.symlinkSync(empty, stagingDir);
    expect(isEmptyDirectory(stagingDir)).toBe(false);
  });

  it("is false for a path that does not exist", () => {
    expect(isEmptyDirectory(path.join(root, "nope"))).toBe(false);
  });
});
