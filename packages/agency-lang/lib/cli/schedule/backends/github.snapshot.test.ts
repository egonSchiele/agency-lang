import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { GithubBackend } from "./github.js";
import type { ScheduleEntry } from "../registry.js";

type GithubOpts = NonNullable<ScheduleEntry["github"]>;

function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-gh-snap-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function entry(repo: string, github: GithubOpts): ScheduleEntry {
  return {
    name: "snap",
    agentFile: path.join(repo, "agents/foo.agency"),
    cron: "0 * * * *",
    preset: "hourly",
    envFile: "",
    logDir: "",
    createdAt: "1970-01-01T00:00:00.000Z",
    backend: "launchd",
    github,
  };
}

describe.each<[string, GithubOpts]>([
  ["readonly-sha", { secrets: [], write: false, noPin: false, force: false }],
  ["write-sha", { secrets: [], write: true, noPin: false, force: false }],
  [
    "with-secrets-sha",
    { secrets: ["FOO", "BAR"], write: false, noPin: false, force: false },
  ],
  [
    "all-sha",
    { secrets: ["FOO"], write: true, noPin: false, force: false },
  ],
  ["readonly-tag", { secrets: [], write: false, noPin: true, force: false }],
  ["write-tag", { secrets: [], write: true, noPin: true, force: false }],
  [
    "with-secrets-tag",
    { secrets: ["FOO", "BAR"], write: false, noPin: true, force: false },
  ],
  [
    "all-tag",
    { secrets: ["FOO"], write: true, noPin: true, force: false },
  ],
])("snapshot: %s", (_label, github) => {
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

  it("matches snapshot", () => {
    new GithubBackend().install(entry(repo, github));
    const yml = fs.readFileSync(
      path.join(repo, ".github/workflows/snap.yml"),
      "utf-8",
    );
    expect(yml).toMatchSnapshot();
  });
});
