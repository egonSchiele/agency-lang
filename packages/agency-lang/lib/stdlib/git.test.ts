import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { nodeHost } from "../host/node/nodeHost.js";
import { safeDeleteDirectoryWithin } from "../utils.js";
import {
  gitRunImpl,
  _gitHardeningFlags,
  assertPathsContained,
  assertAllNotRestricted,
  statusArgs,
  parseStatus,
  logArgs,
  parseLog,
  commitArgs,
  diffArgs,
  parseDiff,
  showArgs,
  branchListArgs,
  parseBranchList,
  blameArgs,
  parseBlame,
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

const host = nodeHost();

describe("gitRunImpl explicit-cwd contract", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await seedRepo();
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("runs against an explicit repo and returns stdout", async () => {
    const status = parseStatus(await gitRunImpl(host, repo, statusArgs()));
    expect(status.branch.length).toBeGreaterThan(0);
  });
  it("THROWS on empty cwd (never inherits process.cwd())", async () => {
    await expect(gitRunImpl(host, "", statusArgs())).rejects.toThrow(/absolute|repo directory/i);
  });
  it("THROWS on a relative cwd", async () => {
    await expect(gitRunImpl(host, "relative/dir", statusArgs())).rejects.toThrow(
      /absolute|repo directory/i,
    );
  });
  it("THROWS on a non-existent cwd", async () => {
    await expect(gitRunImpl(host, path.join(repo, "nope"), statusArgs())).rejects.toThrow(
      /exist|repo directory/i,
    );
  });
  it("THROWS on a git error surfacing stderr", async () => {
    const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), "notrepo-"));
    try {
      await expect(gitRunImpl(host, nonRepo, statusArgs())).rejects.toThrow(
        /not a git repository/i,
      );
    } finally {
      await fs.rm(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("format/parser round-trips against real git", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await seedRepo();
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("status", async () => {
    const s = parseStatus(await gitRunImpl(host, repo, statusArgs()));
    expect(s.entries.length).toBe(0); // clean tree after seed
    expect(s.branch.length).toBeGreaterThan(0);
  });
  it("log", async () => {
    const log = parseLog(
      await gitRunImpl(
        host,
        repo,
        logArgs({ count: 10, oneline: false, path: "", ref: "", author: "" }),
      ),
    );
    expect(log.commits[0].subject).toBe("seed subject");
    expect(log.commits[0].sha.length).toBeGreaterThanOrEqual(7);
  });
  it("commit round-trips (write via commitArgs, read back via log)", async () => {
    await fs.writeFile(path.join(repo, "b.txt"), "more\n");
    await pexec("git", ["add", "b.txt"], { cwd: repo });
    await gitRunImpl(host, repo, commitArgs({ message: "add b" }));
    const log = parseLog(
      await gitRunImpl(
        host,
        repo,
        logArgs({ count: 10, oneline: false, path: "", ref: "", author: "" }),
      ),
    );
    expect(log.commits[0].subject).toBe("add b");
  });
  it("diff (staged edit -> parseDiff counts)", async () => {
    await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
    await pexec("git", ["add", "a.txt"], { cwd: repo });
    const diff = parseDiff(
      await gitRunImpl(host, repo, diffArgs({ ref: "", ref2: "", staged: true, path: "" })),
    );
    const file = diff.files.find((f) => f.path === "a.txt");
    expect(file).toBeTruthy();
    expect(file!.additions).toBe(1);
    expect(file!.deletions).toBe(0);
  });
  it("log with a path filter (exercises --end-of-options -- <path>)", async () => {
    const log = parseLog(
      await gitRunImpl(
        host,
        repo,
        logArgs({ count: 10, oneline: false, path: "a.txt", ref: "", author: "" }),
      ),
    );
    expect(log.commits.length).toBeGreaterThanOrEqual(1);
  });
  it("branchList", async () => {
    const branches = parseBranchList(await gitRunImpl(host, repo, branchListArgs()));
    expect(branches.some((b) => b.current)).toBe(true);
  });
  it("blame", async () => {
    const blame = parseBlame(await gitRunImpl(host, repo, blameArgs({ path: "a.txt", ref: "" })));
    expect(blame[0].content).toBe("one");
    expect(blame[0].sha.length).toBeGreaterThanOrEqual(7);
  });
  it("show (parseDiff skips the commit header preamble)", async () => {
    const show = parseDiff(await gitRunImpl(host, repo, showArgs({ ref: "HEAD" })));
    expect(show.files.length).toBeGreaterThanOrEqual(1); // regression: used to return []
    expect(show.patch).toContain("commit "); // full show output retained
  });
});

describe("a ref is never read as a file outside the repository", () => {
  const SECRET = "SECRET-CONTENT-OUTSIDE-REPO";
  let root: string;
  let repo: string;
  let secret: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "git-ref-path-"));
    repo = path.join(root, "repo");
    secret = path.join(root, "secret.txt");
    await fs.writeFile(secret, `${SECRET}\n`);
    await fs.mkdir(path.join(repo, "sub"), { recursive: true });
    await pexec("git", ["init", "-q"], { cwd: repo });
    await pexec("git", ["config", "user.email", "t@t.com"], { cwd: repo });
    await pexec("git", ["config", "user.name", "t"], { cwd: repo });
    await fs.writeFile(path.join(repo, "a.txt"), "one\n");
    await fs.writeFile(path.join(repo, "sub", "b.txt"), "two\n");
    await pexec("git", ["add", "."], { cwd: repo });
    await pexec("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
    // Untracked. `git diff <one word> --` compares the word with this file.
    await fs.writeFile(path.join(repo, "--"), "plain\n");
    await fs.writeFile(path.join(repo, "a.txt"), "one\nchanged\n");
  });
  afterAll(() => {
    safeDeleteDirectoryWithin(os.tmpdir(), root);
  });

  // Runs git directly and keeps its stdout whatever the exit code. Comparing
  // two files exits with code 1 when they differ, and `gitRunImpl` drops
  // stdout on a non-zero exit, so a check through it could not see a leak.
  // safeBash runs git through the shell, which shows stdout either way.
  type GitOutcome = { code: number; stdout: string };
  async function rawGit(args: string[]): Promise<GitOutcome> {
    return pexec("git", [..._gitHardeningFlags(), ...args], { cwd: repo }).then(
      (res) => ({ code: 0, stdout: res.stdout }),
      (err: { code: number; stdout: string }) => ({ code: err.code, stdout: err.stdout }),
    );
  }

  // Controls: the shapes the builders used to produce. If git stops
  // printing the file for these, the checks below no longer prove anything.
  it("control: two bare words print the outside file", async () => {
    const old = ["diff", "--patch", "-M", "--end-of-options", "/dev/null", secret];
    expect((await rawGit(old)).stdout).toContain(SECRET);
  });
  it("control: one word and a bare -- compare it with the file named --", async () => {
    const old = ["diff", "--patch", "-M", "--end-of-options", secret, "--"];
    expect((await rawGit(old)).stdout).toContain(SECRET);
  });

  const refused: [string, () => string[]][] = [
    [
      "diff, ref and ref2",
      () => diffArgs({ ref: "/dev/null", ref2: secret, staged: false, path: "" }),
    ],
    ["diff, ref alone", () => diffArgs({ ref: secret, ref2: "", staged: false, path: "" })],
    [
      "diff, staged with ref and ref2",
      () => diffArgs({ ref: "/dev/null", ref2: secret, staged: true, path: "" }),
    ],
    [
      "diff, staged with ref alone",
      () => diffArgs({ ref: secret, ref2: "", staged: true, path: "" }),
    ],
    ["diff, path alone", () => diffArgs({ ref: "", ref2: "", staged: false, path: secret })],
    [
      "diff, ref and path",
      () => diffArgs({ ref: "/dev/null", ref2: "", staged: false, path: secret }),
    ],
    ["log, ref", () => logArgs({ count: 1, oneline: true, path: "", ref: secret, author: "" })],
    ["show, ref", () => showArgs({ ref: secret })],
  ];
  for (const [name, args] of refused) {
    it(`${name}: git refuses and prints nothing from the file`, async () => {
      const result = await rawGit(args());
      expect(result.stdout).not.toContain(SECRET);
      expect(result.code).not.toBe(0);
    });
  }

  it("a diff with no path still covers the whole repository from a subdirectory", async () => {
    const args = diffArgs({ ref: "", ref2: "", staged: false, path: "" });
    const diff = parseDiff(await gitRunImpl(host, path.join(repo, "sub"), args));
    expect(diff.files.map((f) => f.path)).toEqual(["a.txt"]);
  });
  it("a diff against one ref still works", async () => {
    const args = diffArgs({ ref: "HEAD", ref2: "", staged: false, path: "" });
    const diff = parseDiff(await gitRunImpl(host, repo, args));
    expect(diff.files.map((f) => f.path)).toEqual(["a.txt"]);
  });
});

describe("gitRunImpl output cap (bytes, not code units)", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await seedRepo();
    // Multi-byte content so a UTF-16-length cap would misjudge the byte size.
    await fs.writeFile(path.join(repo, "big.txt"), "é".repeat(5000) + "\n");
    await pexec("git", ["add", "big.txt"], { cwd: repo });
    await pexec("git", ["commit", "-q", "-m", "big"], { cwd: repo });
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("truncates by UTF-8 bytes and still succeeds", async () => {
    // `git show HEAD` includes the big.txt diff (~10 KB of multi-byte "é").
    const out = await gitRunImpl(host, repo, showArgs({ ref: "HEAD" }), { maxBytes: 200 });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(500); // bounded near the 200-byte cap
    expect(out).toContain("[output truncated");
  });
});

describe("assertAllNotRestricted (gitAdd -A + allowedPaths bypass)", () => {
  it("rejects all=true when allowedPaths is set", () => {
    expect(() => assertAllNotRestricted(true, ["src"])).toThrow(/allowedPaths/);
  });
  it("allows all=true with no restriction, and all=false with a restriction", () => {
    expect(() => assertAllNotRestricted(true, [])).not.toThrow();
    expect(() => assertAllNotRestricted(false, ["src"])).not.toThrow();
  });
});

describe("env-scrub integration (the safety control end-to-end)", () => {
  let repo: string;
  let sentinel: string;
  beforeAll(async () => {
    repo = await seedRepo();
    sentinel = path.join(repo, "PWNED");
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("GIT_EXTERNAL_DIFF passed to gitRunImpl does NOT execute", async () => {
    // If scrubEnv were not applied, git would run this external diff driver.
    await fs.writeFile(path.join(repo, "a.txt"), "changed\n");
    const evilEnv = { ...process.env, GIT_EXTERNAL_DIFF: `sh -c 'touch ${sentinel}'` };
    await gitRunImpl(host, repo, ["diff"], { env: evilEnv });
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
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

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
