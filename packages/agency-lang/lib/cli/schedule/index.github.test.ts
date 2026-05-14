import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { scheduleAdd, scheduleList } from "./index.js";
import { Registry } from "./registry.js";

describe("scheduleAdd --backend github", () => {
  let workdir: string;
  let baseDir: string;
  let cwd: string;
  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-gh-cli-"));
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-base-"));
    cwd = process.cwd();
    process.chdir(workdir);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("writes the workflow file in the current working directory", () => {
    scheduleAdd({
      file: "agents/foo.agency",
      every: "hourly",
      backend: "github",
      baseDir,
      noPin: true,
    });
    expect(fs.existsSync(path.join(workdir, "foo.yml"))).toBe(true);
  });

  it("does NOT require the agent file to exist locally", () => {
    expect(() =>
      scheduleAdd({
        file: "this/does/not/exist.agency",
        every: "hourly",
        backend: "github",
        baseDir,
        noPin: true,
      }),
    ).not.toThrow();
  });

  it("does NOT write to the registry", () => {
    scheduleAdd({
      file: "agents/foo.agency",
      every: "hourly",
      backend: "github",
      baseDir,
      noPin: true,
    });
    const reg = new Registry(baseDir);
    expect(Object.keys(reg.getAll())).toHaveLength(0);
  });

  it("rejects cron interval < 5min (step expression)", () => {
    expect(() =>
      scheduleAdd({
        file: "agents/foo.agency",
        cron: "*/2 * * * *",
        backend: "github",
        baseDir,
        noPin: true,
      }),
    ).toThrow(/5-minute minimum/i);
    expect(fs.existsSync(path.join(workdir, "foo.yml"))).toBe(false);
  });

  it("rejects --every minute (a `*` minutes field)", () => {
    expect(() =>
      scheduleAdd({
        file: "agents/foo.agency",
        every: "minute",
        backend: "github",
        baseDir,
        noPin: true,
      }),
    ).toThrow(/5-minute minimum/i);
  });

  it("accepts cron interval >= 5min", () => {
    expect(() =>
      scheduleAdd({
        file: "agents/foo.agency",
        cron: "*/5 * * * *",
        backend: "github",
        baseDir,
        noPin: true,
      }),
    ).not.toThrow();
    expect(fs.existsSync(path.join(workdir, "foo.yml"))).toBe(true);
  });

  it("passes secrets/write/noPin through to the backend", () => {
    scheduleAdd({
      file: "agents/foo.agency",
      every: "hourly",
      backend: "github",
      baseDir,
      secrets: ["FOO"],
      write: true,
      noPin: true,
    });
    const yml = fs.readFileSync(path.join(workdir, "foo.yml"), "utf-8");
    expect(yml).toContain("FOO: ${{ secrets.FOO }}");
    expect(yml).toContain("contents: write");
    expect(yml).toMatch(/egonSchiele\/run-agency-action@v\d/);
  });
});

describe("scheduleList / scheduleRemove are unaffected by github schedules", () => {
  let workdir: string;
  let baseDir: string;
  let cwd: string;
  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-gh-cli-"));
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-base-"));
    cwd = process.cwd();
    process.chdir(workdir);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("github add does not appear in scheduleList", () => {
    scheduleAdd({
      file: "agents/foo.agency",
      every: "hourly",
      backend: "github",
      baseDir,
      noPin: true,
    });
    const entries = scheduleList({ baseDir });
    expect(entries).toHaveLength(0);
  });
});
