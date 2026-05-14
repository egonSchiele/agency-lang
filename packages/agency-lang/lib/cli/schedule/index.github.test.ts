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

  it("warns on cron interval < 5min", () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
    try {
      scheduleAdd({
        file: path.join(repo, "agents/foo.agency"),
        cron: "*/2 * * * *",
        backend: "github",
        baseDir,
        noPin: true,
      });
      expect(warns.join("\n")).toMatch(/5.?min/i);
    } finally {
      console.warn = origWarn;
    }
  });

  it("does NOT warn on cron interval >= 5min", () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
    try {
      scheduleAdd({
        file: path.join(repo, "agents/foo.agency"),
        cron: "*/5 * * * *",
        backend: "github",
        baseDir,
        noPin: true,
      });
      expect(warns.join("\n")).not.toMatch(/5.?min/i);
    } finally {
      console.warn = origWarn;
    }
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
