import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GithubBackend } from "./github.js";
import type { ScheduleEntry } from "../registry.js";

type GithubOpts = NonNullable<ScheduleEntry["github"]>;

function entry(github: GithubOpts): ScheduleEntry {
  return {
    name: "snap",
    agentFile: "agents/foo.agency",
    cron: "0 * * * *",
    preset: "hourly",
    envFile: "",
    logDir: "",
    createdAt: "1970-01-01T00:00:00.000Z",
    backend: "launchd",
    github,
  };
}

// Snapshot file naming convention: each case maps to a single readable
// `.yml` snapshot in `__snapshots__/`. This keeps the snapshots browseable
// as actual YAML rather than escaped strings inside a single `.snap` file.
const CASES: Array<{ label: string; github: GithubOpts }> = [
  { label: "readonly-sha", github: { secrets: [], write: false, noPin: false, force: false } },
  { label: "write-sha", github: { secrets: [], write: true, noPin: false, force: false } },
  { label: "with-secrets-sha", github: { secrets: ["FOO", "BAR"], write: false, noPin: false, force: false } },
  { label: "all-sha", github: { secrets: ["FOO"], write: true, noPin: false, force: false } },
  { label: "readonly-tag", github: { secrets: [], write: false, noPin: true, force: false } },
  { label: "write-tag", github: { secrets: [], write: true, noPin: true, force: false } },
  { label: "with-secrets-tag", github: { secrets: ["FOO", "BAR"], write: false, noPin: true, force: false } },
  { label: "all-tag", github: { secrets: ["FOO"], write: true, noPin: true, force: false } },
];

describe.each(CASES)("snapshot: $label", ({ label, github }) => {
  let workdir: string;
  let cwd: string;
  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-gh-snap-"));
    cwd = process.cwd();
    process.chdir(workdir);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it("matches snapshot", async () => {
    new GithubBackend().install(entry(github));
    const yml = fs.readFileSync(path.join(workdir, "snap.yml"), "utf-8");
    // Each snapshot lives in its own readable `.yml` file under `__snapshots__/`.
    await expect(yml).toMatchFileSnapshot(`./__snapshots__/${label}.yml`);
  });
});
