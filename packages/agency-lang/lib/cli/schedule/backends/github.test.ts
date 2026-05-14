import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { GithubBackend } from "./github.js";
import type { ScheduleEntry } from "../registry.js";

type GithubOpts = NonNullable<ScheduleEntry["github"]>;

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
  let workdir: string;
  let cwd: string;
  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-gh-"));
    cwd = process.cwd();
    process.chdir(workdir);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it("writes <name>.yml in the current working directory", () => {
    const e = entry({
      agentFile: "agents/foo.agency",
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    expect(fs.existsSync(path.join(workdir, "test-sched.yml"))).toBe(true);
  });

  it("uses the agentFile string verbatim in the workflow", () => {
    const e = entry({
      agentFile: "some/other/repo/agents/foo.agency",
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(workdir, "test-sched.yml"), "utf-8");
    expect(yml).toContain("file: 'some/other/repo/agents/foo.agency'");
  });

  it("does not require git or any local file to exist", () => {
    // No `git init`, no `agents/foo.agency` on disk -- the backend treats
    // the agent path as a string for the workflow.
    const e = entry({
      agentFile: "definitely/not/here.agency",
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    expect(() => new GithubBackend().install(e)).not.toThrow();
  });

  it("emits SHA pins by default", () => {
    const e = entry({ agentFile: "agents/foo.agency" });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(workdir, "test-sched.yml"), "utf-8");
    expect(yml).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(yml).toMatch(/egonSchiele\/run-agency-action@[0-9a-f]{40}/);
    expect(yml).toMatch(/actions\/checkout@[0-9a-f]{40}\s+#\s+v\d/);
  });

  it("emits @<tag> when noPin: true", () => {
    const e = entry({
      agentFile: "agents/foo.agency",
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(workdir, "test-sched.yml"), "utf-8");
    expect(yml).toMatch(/egonSchiele\/run-agency-action@v\d/);
    expect(yml).not.toMatch(/egonSchiele\/run-agency-action@[0-9a-f]{40}/);
  });

  it("uses contents: read by default", () => {
    const e = entry({
      agentFile: "agents/foo.agency",
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(workdir, "test-sched.yml"), "utf-8");
    expect(yml).toContain("contents: read");
    expect(yml).not.toContain("contents: write");
  });

  it("uses contents: write + pull-requests: write when write: true", () => {
    const e = entry({
      agentFile: "agents/foo.agency",
      github: { secrets: [], write: true, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(workdir, "test-sched.yml"), "utf-8");
    expect(yml).toContain("contents: write");
    expect(yml).toContain("pull-requests: write");
  });

  it("wires extra secrets into env block", () => {
    const e = entry({
      agentFile: "agents/foo.agency",
      github: { secrets: ["FOO", "BAR"], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(workdir, "test-sched.yml"), "utf-8");
    expect(yml).toContain("FOO: ${{ secrets.FOO }}");
    expect(yml).toContain("BAR: ${{ secrets.BAR }}");
    expect(yml).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
    expect(yml).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  it("YAML-quotes the agent file path", () => {
    const e = entry({
      agentFile: "agents/foo.agency",
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(workdir, "test-sched.yml"), "utf-8");
    expect(yml).toContain("file: 'agents/foo.agency'");
  });

  it("YAML-escapes single quotes in the agent path", () => {
    const e = entry({
      agentFile: "weird's dir/x.agency",
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(workdir, "test-sched.yml"), "utf-8");
    expect(yml).toContain("file: 'weird''s dir/x.agency'");
  });

  it("rejects invalid secret names before writing the file", () => {
    const e = entry({
      agentFile: "agents/foo.agency",
      github: {
        secrets: ["valid_NAME", "with-dash"],
        write: false,
        noPin: true,
        force: false,
      },
    });
    expect(() => new GithubBackend().install(e)).toThrow(/invalid secret name/i);
    expect(fs.existsSync(path.join(workdir, "test-sched.yml"))).toBe(false);
  });

  it("throws on existing file without --force", () => {
    const e = entry({
      agentFile: "agents/foo.agency",
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    expect(() => new GithubBackend().install(e)).toThrow(/already exists/i);
  });

  it("overwrites with force: true", () => {
    const e = entry({
      agentFile: "agents/foo.agency",
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const e2 = entry({
      agentFile: "agents/foo.agency",
      github: { secrets: ["NEW"], write: false, noPin: true, force: true },
    });
    expect(() => new GithubBackend().install(e2)).not.toThrow();
    const yml = fs.readFileSync(path.join(workdir, "test-sched.yml"), "utf-8");
    expect(yml).toContain("NEW: ${{ secrets.NEW }}");
  });
});

describe("GithubBackend.uninstall", () => {
  it("throws (unreachable in normal flow; github schedules aren't registered)", () => {
    expect(() => new GithubBackend().uninstall("any")).toThrow(/not registered/i);
  });
});
