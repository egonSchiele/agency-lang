import { describe, expect, test } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createManifestTracker, NOOP_TRACKER } from "./manifestTracker.js";
import { loadManifest, MANIFEST_DIR_NAME } from "./buildManifest.js";

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-tracker-"));
  fs.writeFileSync(path.join(dir, "main.agency"), "node main() {\n  return 1\n}\n");
  fs.writeFileSync(path.join(dir, "main.js"), "// out");
  return dir;
}

describe("createManifestTracker policy resolution", () => {
  test("always → NOOP: no reads, no writes, no manifest file", () => {
    const dir = tmp();
    const tracker = createManifestTracker({}, path.join(dir, "main.agency"), "always");
    expect(tracker).toBe(NOOP_TRACKER);
    tracker.record(path.join(dir, "main.agency"), path.join(dir, "main.js"), [], false);
    tracker.flush();
    expect(fs.existsSync(path.join(dir, MANIFEST_DIR_NAME))).toBe(false);
  });

  test("incremental: record + flush round-trips through isFresh and outputFor", () => {
    const dir = tmp();
    const entry = path.join(dir, "main.agency");
    const writer = createManifestTracker({}, entry, "incremental");
    expect(writer.isFresh(entry)).toBe(false); // nothing recorded yet
    writer.record(entry, path.join(dir, "main.js"), [], false);
    writer.flush();
    const reader = createManifestTracker({}, entry, "incremental");
    expect(reader.isFresh(entry)).toBe(true);
    expect(reader.allFresh([entry])).toBe(true);
    expect(reader.outputFor(entry)).toBe(path.join(dir, "main.js"));
  });

  test("force: reads disabled, writes enabled", () => {
    const dir = tmp();
    const entry = path.join(dir, "main.agency");
    const writer = createManifestTracker({}, entry, "incremental");
    writer.record(entry, path.join(dir, "main.js"), [], false);
    writer.flush();
    const forced = createManifestTracker({}, entry, "force");
    expect(forced.isFresh(entry)).toBe(false);
    forced.record(entry, path.join(dir, "main.js"), [], false);
    forced.flush();
    expect(loadManifest(dir).entries["main.agency"]).toBeDefined();
  });

  test("configKey mismatch across trackers → stale", () => {
    const dir = tmp();
    const entry = path.join(dir, "main.agency");
    const writer = createManifestTracker({}, entry, "incremental");
    writer.record(entry, path.join(dir, "main.js"), [], false);
    writer.flush();
    const other = createManifestTracker({ verbose: true }, entry, "incremental");
    expect(other.isFresh(entry)).toBe(false);
  });

  test("hasPkgImports recorded true → never fresh", () => {
    const dir = tmp();
    const entry = path.join(dir, "main.agency");
    const writer = createManifestTracker({}, entry, "incremental");
    writer.record(entry, path.join(dir, "main.js"), [], true);
    writer.flush();
    const reader = createManifestTracker({}, entry, "incremental");
    expect(reader.isFresh(entry)).toBe(false);
  });

  test("flush without records writes nothing", () => {
    const dir = tmp();
    createManifestTracker({}, path.join(dir, "main.agency"), "incremental").flush();
    expect(fs.existsSync(path.join(dir, MANIFEST_DIR_NAME))).toBe(false);
  });
});

describe("malformed manifest resilience", () => {
  test("outputFor returns null for a non-string outputPath", () => {
    const dir = tmp();
    const entry = path.join(dir, "main.agency");
    const writer = createManifestTracker({}, entry, "incremental");
    writer.record(entry, path.join(dir, "main.js"), [], false);
    writer.flush();
    const file = path.join(dir, MANIFEST_DIR_NAME, "manifest.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    raw.entries["main.agency"].outputPath = 42;
    fs.writeFileSync(file, JSON.stringify(raw));
    const reader = createManifestTracker({}, entry, "incremental");
    expect(reader.outputFor(entry)).toBeNull();
    expect(reader.isFresh(entry)).toBe(false); // shape guard: stale, not a throw
  });

  test("non-array deps is stale, not a crash", () => {
    const dir = tmp();
    const entry = path.join(dir, "main.agency");
    const writer = createManifestTracker({}, entry, "incremental");
    writer.record(entry, path.join(dir, "main.js"), [], false);
    writer.flush();
    const file = path.join(dir, MANIFEST_DIR_NAME, "manifest.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    raw.entries["main.agency"].deps = "not-an-array";
    fs.writeFileSync(file, JSON.stringify(raw));
    const reader = createManifestTracker({}, entry, "incremental");
    expect(reader.isFresh(entry)).toBe(false);
  });
});
