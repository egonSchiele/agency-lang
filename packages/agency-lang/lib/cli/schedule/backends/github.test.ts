import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { GithubBackend } from "./github.js";
import type { ScheduleEntry } from "../registry.js";

type GithubOpts = NonNullable<ScheduleEntry["github"]>;

function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-gh-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function entry(opts: {
  name?: string;
  agentFile: string;
  cron?: string;
  preset?: string;
  github?: GithubOpts;
}): ScheduleEntry {
  return {
    name: opts.name ?? "test-sched",
    agentFile: opts.agentFile,
    cron: opts.cron ?? "0 * * * *",
    preset: opts.preset ?? "1h",
    envFile: "",
    logDir: "",
    createdAt: new Date().toISOString(),
    backend: "launchd", // ignored by GithubBackend
    github: opts.github ?? { secrets: [], write: false, noPin: false, force: false },
  };
}

describe("GithubBackend.install", () => {
  let repo: string;
  let cwd: string;
  beforeEach(() => {
    repo = setupRepo();
    cwd = process.cwd();
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("writes .github/workflows/<name>.yml at repo root", () => {
    // noPin: true to avoid the placeholder-SHA check until Task 14 lands real
    // SHAs for egonSchiele/run-agency-action.
    const e = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const target = path.join(repo, ".github/workflows/test-sched.yml");
    expect(fs.existsSync(target)).toBe(true);
  });

  it("emits @<tag> when noPin: true", () => {
    const e = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(
      path.join(repo, ".github/workflows/test-sched.yml"),
      "utf-8",
    );
    expect(yml).toMatch(/egonSchiele\/run-agency-action@v\d/);
    expect(yml).not.toMatch(/egonSchiele\/run-agency-action@[0-9a-f]{40}/);
  });

  it("uses contents: read by default", () => {
    const e = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(
      path.join(repo, ".github/workflows/test-sched.yml"),
      "utf-8",
    );
    expect(yml).toContain("contents: read");
    expect(yml).not.toContain("contents: write");
  });

  it("uses contents: write + pull-requests: write when write: true", () => {
    const e = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: [], write: true, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(
      path.join(repo, ".github/workflows/test-sched.yml"),
      "utf-8",
    );
    expect(yml).toContain("contents: write");
    expect(yml).toContain("pull-requests: write");
  });

  it("wires extra secrets into env block", () => {
    const e = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: ["FOO", "BAR"], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(
      path.join(repo, ".github/workflows/test-sched.yml"),
      "utf-8",
    );
    expect(yml).toContain("FOO: ${{ secrets.FOO }}");
    expect(yml).toContain("BAR: ${{ secrets.BAR }}");
    expect(yml).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
    expect(yml).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  it("computes agent path relative to repo root", () => {
    const e = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(
      path.join(repo, ".github/workflows/test-sched.yml"),
      "utf-8",
    );
    expect(yml).toContain("file: agents/foo.agency");
  });

  it("throws when not in a git repo", () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "non-git-"));
    process.chdir(nonGit);
    try {
      const e = entry({ agentFile: path.join(nonGit, "x.agency") });
      expect(() => new GithubBackend().install(e)).toThrow(/git repo/i);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("throws when agentFile is outside the repo", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-outside-"));
    try {
      const e = entry({
        agentFile: path.join(otherDir, "elsewhere.agency"),
        github: { secrets: [], write: false, noPin: true, force: false },
      });
      expect(() => new GithubBackend().install(e)).toThrow(/outside the repo/i);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("throws on existing file without --force", () => {
    const e = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    expect(() => new GithubBackend().install(e)).toThrow(/already exists/i);
  });

  it("overwrites with force: true", () => {
    const e = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const e2 = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: ["NEW"], write: false, noPin: true, force: true },
    });
    expect(() => new GithubBackend().install(e2)).not.toThrow();
    const yml = fs.readFileSync(
      path.join(repo, ".github/workflows/test-sched.yml"),
      "utf-8",
    );
    expect(yml).toContain("NEW: ${{ secrets.NEW }}");
  });

  it("emits SHA pins by default", () => {
    // Default opts: noPin: false → both actions get SHA-pinned.
    const e = entry({ agentFile: path.join(repo, "agents/foo.agency") });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(
      path.join(repo, ".github/workflows/test-sched.yml"),
      "utf-8",
    );
    expect(yml).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(yml).toMatch(/egonSchiele\/run-agency-action@[0-9a-f]{40}/);
    // Verify the inline-comment idiom (`@<sha>  # <tag>`) is preserved.
    expect(yml).toMatch(/actions\/checkout@[0-9a-f]{40}\s+#\s+v\d/);
  });
});

describe("GithubBackend.uninstall", () => {
  it("throws (unreachable in normal flow; github schedules aren't registered)", () => {
    expect(() => new GithubBackend().uninstall("any")).toThrow(/not registered/i);
  });
});
