import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { scheduleAdd, scheduleList } from "./index.js";
import { Registry } from "./registry.js";

function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-gh-cli-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.mkdirSync(path.join(dir, "agents"));
  fs.writeFileSync(
    path.join(dir, "agents/foo.agency"),
    "node main() { print(1) }\n",
  );
  return dir;
}

describe("scheduleAdd --backend github", () => {
  let repo: string;
  let baseDir: string;
  let cwd: string;
  beforeEach(() => {
    repo = setupRepo();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-base-"));
    cwd = process.cwd();
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("writes the workflow file", () => {
    scheduleAdd({
      file: path.join(repo, "agents/foo.agency"),
      every: "hourly",
      backend: "github",
      baseDir,
      noPin: true, // dodge placeholder check
    });
    expect(fs.existsSync(path.join(repo, ".github/workflows/foo.yml"))).toBe(
      true,
    );
  });

  it("does NOT write to the registry", () => {
    scheduleAdd({
      file: path.join(repo, "agents/foo.agency"),
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
        file: path.join(repo, "agents/foo.agency"),
        cron: "*/2 * * * *",
        backend: "github",
        baseDir,
        noPin: true,
      }),
    ).toThrow(/5-minute minimum/i);
    // No partial workflow file written.
    expect(fs.existsSync(path.join(repo, ".github/workflows/foo.yml"))).toBe(
      false,
    );
  });

  it("rejects --every minute (a `*` minutes field)", () => {
    expect(() =>
      scheduleAdd({
        file: path.join(repo, "agents/foo.agency"),
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
        file: path.join(repo, "agents/foo.agency"),
        cron: "*/5 * * * *",
        backend: "github",
        baseDir,
        noPin: true,
      }),
    ).not.toThrow();
    expect(fs.existsSync(path.join(repo, ".github/workflows/foo.yml"))).toBe(
      true,
    );
  });

  it("passes secrets/write/noPin through to the backend", () => {
    scheduleAdd({
      file: path.join(repo, "agents/foo.agency"),
      every: "hourly",
      backend: "github",
      baseDir,
      secrets: ["FOO"],
      write: true,
      noPin: true,
    });
    const yml = fs.readFileSync(
      path.join(repo, ".github/workflows/foo.yml"),
      "utf-8",
    );
    expect(yml).toContain("FOO: ${{ secrets.FOO }}");
    expect(yml).toContain("contents: write");
    expect(yml).toMatch(/egonSchiele\/run-agency-action@v\d/);
  });
});

describe("scheduleList / scheduleRemove are unaffected by github schedules", () => {
  let repo: string;
  let baseDir: string;
  let cwd: string;
  beforeEach(() => {
    repo = setupRepo();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-base-"));
    cwd = process.cwd();
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("github add does not appear in scheduleList", () => {
    scheduleAdd({
      file: path.join(repo, "agents/foo.agency"),
      every: "hourly",
      backend: "github",
      baseDir,
      noPin: true,
    });
    const entries = scheduleList({ baseDir });
    expect(entries).toHaveLength(0);
  });
});
