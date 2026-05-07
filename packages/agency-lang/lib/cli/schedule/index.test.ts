import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { scheduleAdd, scheduleList, scheduleRemove, scheduleEdit } from "./index.js";

vi.mock("./backends/index.js", () => ({
  detectBackend: () => "launchd" as const,
  getBackend: () => ({
    install: vi.fn(),
    uninstall: vi.fn(),
  }),
}));

describe("scheduleAdd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sched-test-"));
    fs.writeFileSync(path.join(tmpDir, "agent.agency"), "node main() {}");
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("adds a schedule with a preset", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", baseDir: tmpDir });
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "schedules.json"), "utf-8"));
    expect(reg["agent"].cron).toBe("0 9 * * *");
    expect(reg["agent"].preset).toBe("daily");
  });

  it("adds a schedule with a cron expression", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), cron: "*/15 * * * *", baseDir: tmpDir });
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "schedules.json"), "utf-8"));
    expect(reg["agent"].cron).toBe("*/15 * * * *");
    expect(reg["agent"].preset).toBe("");
  });

  it("uses custom name when provided", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", name: "custom", baseDir: tmpDir });
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "schedules.json"), "utf-8"));
    expect(reg["custom"]).toBeDefined();
  });

  it("stores env-file and command", () => {
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "KEY=value");
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", envFile, command: "pnpm run agency", baseDir: tmpDir });
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "schedules.json"), "utf-8"));
    expect(reg["agent"].envFile).toBe(envFile);
    expect(reg["agent"].command).toBe("pnpm run agency");
  });

  it("throws if agent file does not exist", () => {
    expect(() => scheduleAdd({ file: path.join(tmpDir, "nope.agency"), every: "daily", baseDir: tmpDir })).toThrow("does not exist");
  });

  it("throws if cron expression is invalid", () => {
    expect(() => scheduleAdd({ file: path.join(tmpDir, "agent.agency"), cron: "bad", baseDir: tmpDir })).toThrow("Invalid cron expression");
  });

  it("throws if neither --every nor --cron is provided", () => {
    expect(() => scheduleAdd({ file: path.join(tmpDir, "agent.agency"), baseDir: tmpDir })).toThrow("--every or --cron");
  });
});

describe("scheduleList", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sched-test-"));
    fs.writeFileSync(path.join(tmpDir, "agent.agency"), "node main() {}");
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns empty array when no schedules exist", () => {
    expect(scheduleList({ baseDir: tmpDir })).toEqual([]);
  });

  it("returns entries after adding", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", baseDir: tmpDir });
    const result = scheduleList({ baseDir: tmpDir });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("agent");
  });
});

describe("scheduleRemove", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sched-test-"));
    fs.writeFileSync(path.join(tmpDir, "agent.agency"), "node main() {}");
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("removes an existing schedule", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", baseDir: tmpDir });
    scheduleRemove({ name: "agent", baseDir: tmpDir });
    expect(scheduleList({ baseDir: tmpDir })).toEqual([]);
  });

  it("throws if name does not exist", () => {
    expect(() => scheduleRemove({ name: "nope", baseDir: tmpDir })).toThrow("No schedule named");
  });
});

describe("scheduleEdit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sched-test-"));
    fs.writeFileSync(path.join(tmpDir, "agent.agency"), "node main() {}");
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("updates cron expression", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", baseDir: tmpDir });
    scheduleEdit({ name: "agent", cron: "0 8 * * *", baseDir: tmpDir });
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "schedules.json"), "utf-8"));
    expect(reg["agent"].cron).toBe("0 8 * * *");
    expect(reg["agent"].preset).toBe("");
  });

  it("updates command while keeping other fields", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", baseDir: tmpDir });
    scheduleEdit({ name: "agent", command: "npx agency-lang", baseDir: tmpDir });
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "schedules.json"), "utf-8"));
    expect(reg["agent"].command).toBe("npx agency-lang");
    expect(reg["agent"].cron).toBe("0 9 * * *");
  });

  it("throws if name does not exist", () => {
    expect(() => scheduleEdit({ name: "nope", baseDir: tmpDir })).toThrow("No schedule named");
  });
});
