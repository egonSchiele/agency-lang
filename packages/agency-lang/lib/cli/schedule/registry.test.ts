import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Registry } from "./registry.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function makeEntry(tmpDir: string, overrides = {}) {
  return {
    name: "test-agent",
    agentFile: "/path/to/agent.agency",
    cron: "0 9 * * *",
    preset: "daily",
    envFile: "",
    logDir: path.join(tmpDir, "test-agent", "logs"),
    createdAt: "2026-05-06T10:00:00-07:00",
    backend: "launchd" as const,
    ...overrides,
  };
}

describe("Registry", () => {
  let tmpDir: string;
  let registry: Registry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-schedule-test-"));
    registry = new Registry(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object when no registry file exists", () => {
    expect(registry.getAll()).toEqual({});
  });

  it("adds and retrieves an entry", () => {
    const entry = makeEntry(tmpDir);
    registry.set(entry);
    expect(registry.get("test-agent")).toEqual(entry);
  });

  it("removes an entry", () => {
    registry.set(makeEntry(tmpDir));
    registry.remove("test-agent");
    expect(registry.get("test-agent")).toBeUndefined();
  });

  it("persists across instances", () => {
    const entry = makeEntry(tmpDir);
    registry.set(entry);
    const registry2 = new Registry(tmpDir);
    expect(registry2.get("test-agent")).toEqual(entry);
  });

  it("has() returns true for existing entries", () => {
    registry.set(makeEntry(tmpDir));
    expect(registry.has("test-agent")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("throws helpful error on corrupted JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "schedules.json"), "{invalid json");
    expect(() => registry.getAll()).toThrow("Failed to parse schedule registry");
  });
});
