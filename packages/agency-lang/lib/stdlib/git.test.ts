import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  gitRunImpl, assertPathsContained,
  statusArgs, parseStatus, logArgs, parseLog, commitArgs,
} from "./git.js";

const pexec = promisify(execFile);

async function seedRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "gitrun-"));
  await pexec("git", ["init", "-q"], { cwd: repo });
  await pexec("git", ["config", "user.email", "t@t.com"], { cwd: repo });
  await pexec("git", ["config", "user.name", "t"], { cwd: repo });
  await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
  await pexec("git", ["add", "a.txt"], { cwd: repo });
  await pexec("git", ["commit", "-q", "-m", "seed subject"], { cwd: repo });
  return repo;
}

describe("gitRunImpl explicit-cwd contract", () => {
  let repo: string;
  beforeAll(async () => { repo = await seedRepo(); });
  afterAll(async () => { await fs.rm(repo, { recursive: true, force: true }); });

  it("runs against an explicit repo and returns stdout", async () => {
    const status = parseStatus(await gitRunImpl(repo, statusArgs()));
    expect(status.branch.length).toBeGreaterThan(0);
  });
  it("THROWS on empty cwd (never inherits process.cwd())", async () => {
    await expect(gitRunImpl("", statusArgs())).rejects.toThrow(/absolute|repo directory/i);
  });
  it("THROWS on a relative cwd", async () => {
    await expect(gitRunImpl("relative/dir", statusArgs())).rejects.toThrow(/absolute|repo directory/i);
  });
  it("THROWS on a non-existent cwd", async () => {
    await expect(gitRunImpl(path.join(repo, "nope"), statusArgs())).rejects.toThrow(/exist|repo directory/i);
  });
  it("THROWS on a git error surfacing stderr", async () => {
    const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), "notrepo-"));
    try {
      await expect(gitRunImpl(nonRepo, statusArgs())).rejects.toThrow(/not a git repository/i);
    } finally {
      await fs.rm(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("format/parser round-trips against real git", () => {
  let repo: string;
  beforeAll(async () => { repo = await seedRepo(); });
  afterAll(async () => { await fs.rm(repo, { recursive: true, force: true }); });

  it("status", async () => {
    const s = parseStatus(await gitRunImpl(repo, statusArgs()));
    expect(s.entries.length).toBe(0); // clean tree after seed
    expect(s.branch.length).toBeGreaterThan(0);
  });
  it("log", async () => {
    const log = parseLog(await gitRunImpl(repo, logArgs({ n: 10, oneline: false, path: "", ref: "", author: "" })));
    expect(log.commits[0].subject).toBe("seed subject");
    expect(log.commits[0].sha.length).toBeGreaterThanOrEqual(7);
  });
  it("commit round-trips (write via commitArgs, read back via log)", async () => {
    await fs.writeFile(path.join(repo, "b.txt"), "more\n");
    await pexec("git", ["add", "b.txt"], { cwd: repo });
    await gitRunImpl(repo, commitArgs({ message: "add b" }));
    const log = parseLog(await gitRunImpl(repo, logArgs({ n: 10, oneline: false, path: "", ref: "", author: "" })));
    expect(log.commits[0].subject).toBe("add b");
  });
});

describe("env-scrub integration (the safety control end-to-end)", () => {
  let repo: string;
  let sentinel: string;
  beforeAll(async () => { repo = await seedRepo(); sentinel = path.join(repo, "PWNED"); });
  afterAll(async () => { await fs.rm(repo, { recursive: true, force: true }); });

  it("GIT_EXTERNAL_DIFF passed to gitRunImpl does NOT execute", async () => {
    // If scrubEnv were not applied, git would run this external diff driver.
    await fs.writeFile(path.join(repo, "a.txt"), "changed\n");
    const evilEnv = { ...process.env, GIT_EXTERNAL_DIFF: `sh -c 'touch ${sentinel}'` };
    await gitRunImpl(repo, ["diff"], { env: evilEnv });
    await expect(fs.access(sentinel)).rejects.toBeTruthy(); // sentinel was NOT created
  });
});

describe("assertPathsContained (symlink-aware, shared helper)", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "contain-"));
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, "src", "a.ts"), "x");
  });
  afterAll(async () => { await fs.rm(repo, { recursive: true, force: true }); });

  it("no-ops when allowedPaths empty", async () => {
    await expect(assertPathsContained(["anything"], [], repo)).resolves.toBeUndefined();
  });
  it("allows paths inside an allowed prefix", async () => {
    await expect(assertPathsContained(["src/a.ts"], ["src"], repo)).resolves.toBeUndefined();
  });
  it("rejects a path outside every allowed prefix", async () => {
    await expect(assertPathsContained(["../escape.ts"], ["src"], repo)).rejects.toThrow();
  });
  it("rejects a sibling with a shared prefix (boundary: srcfoo vs src)", async () => {
    await fs.mkdir(path.join(repo, "srcfoo"), { recursive: true });
    await fs.writeFile(path.join(repo, "srcfoo", "x.ts"), "x");
    await expect(assertPathsContained(["srcfoo/x.ts"], ["src"], repo)).rejects.toThrow();
  });
});
