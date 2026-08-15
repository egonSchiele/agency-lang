import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { afterEach, describe, expect, it } from "vitest";

import { parseSource, resolveSource } from "./sources.js";
import { makeRepo } from "./testUtils.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
  // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "src-"));
  dirs.push(tempDir);
  return tempDir;
}

function trackedRepo(): ReturnType<typeof makeRepo> {
  const made = makeRepo();
  dirs.push(made.repo);
  return made;
}

describe("parseSource", () => {
  const base = "/base";

  it("a plain path is local, resolved against baseDir", () => {
    expect(parseSource("./fixtures/x", base)).toEqual({ kind: "local", path: "/base/fixtures/x" });
  });

  it("ssh URLs are git", () => {
    expect(parseSource("git@github.com:egonSchiele/agency-evals.git", base)).toEqual({
      kind: "git",
      url: "git@github.com:egonSchiele/agency-evals.git",
      display: "git@github.com:egonSchiele/agency-evals.git",
    });
  });

  it("GitHub https URLs derive the clone URL; //subdir and ?ref= parse out", () => {
    expect(
      parseSource("https://github.com/egonSchiele/agency-evals//tests/git-tasks?ref=v1.2", base),
    ).toEqual({
      kind: "git",
      url: "https://github.com/egonSchiele/agency-evals.git",
      subdir: "tests/git-tasks",
      ref: "v1.2",
      display: "https://github.com/egonSchiele/agency-evals//tests/git-tasks?ref=v1.2",
    });
  });

  it("a schemeless github.com form works", () => {
    expect(parseSource("github.com/egonSchiele/agency-evals//tests?ref=main", base)).toMatchObject({
      kind: "git",
      url: "https://github.com/egonSchiele/agency-evals.git",
      subdir: "tests",
      ref: "main",
    });
  });

  it("a local path with ?ref= is a git source cloning from that path", () => {
    expect(parseSource("./fixtures?ref=8d601eb1", base)).toMatchObject({
      kind: "git",
      url: "/base/fixtures",
      ref: "8d601eb1",
    });
  });

  it("an empty ref is an error", () => {
    expect(() => parseSource("./fixtures?ref=", base)).toThrow(/ref/);
  });
});

describe("resolveSource", () => {
  it("a local source passes through with no sha", () => {
    const localDir = tmp();
    expect(resolveSource({ kind: "local", path: localDir })).toEqual({
      dir: localDir,
      display: localDir,
    });
  });

  it("resolves a sha ref to that exact commit and records it", () => {
    const { repo, first } = trackedRepo();
    const resolved = resolveSource(parseSource(`${repo}//tests?ref=${first}`, "/"), {
      cacheRoot: tmp(),
    });
    expect(resolved.sha).toBe(first);
    expect(fs.readFileSync(path.join(resolved.dir, "a.txt"), "utf8")).toBe("v1");
  });

  it("resolves a tag and a branch, recording the resolved sha", () => {
    const { repo, first, second } = trackedRepo();
    const cacheRoot = tmp();
    expect(resolveSource(parseSource(`${repo}//tests?ref=v1`, "/"), { cacheRoot }).sha).toBe(first);
    expect(resolveSource(parseSource(`${repo}//tests?ref=main`, "/"), { cacheRoot }).sha).toBe(
      second,
    );
  });

  it("a branch re-resolves after the upstream moves", () => {
    const { repo, second } = trackedRepo();
    const cacheRoot = tmp();
    resolveSource(parseSource(`${repo}?ref=main`, "/"), { cacheRoot });
    fs.writeFileSync(path.join(repo, "tests", "a.txt"), "v3");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "three"], {
      cwd: repo,
    });

    const moved = resolveSource(parseSource(`${repo}?ref=main`, "/"), { cacheRoot });

    expect(moved.sha).not.toBe(second);
    expect(fs.readFileSync(path.join(moved.dir, "tests", "a.txt"), "utf8")).toBe("v3");
  });

  it("errors clearly on a bad ref, naming the source", () => {
    const { repo } = trackedRepo();
    expect(() =>
      resolveSource(parseSource(`${repo}?ref=nope-does-not-exist`, "/"), { cacheRoot: tmp() }),
    ).toThrow(/nope-does-not-exist/);
  });

  it("errors clearly when the subdir does not exist at the ref", () => {
    const { repo, first } = trackedRepo();
    expect(() =>
      resolveSource(parseSource(`${repo}//no-such-dir?ref=${first}`, "/"), { cacheRoot: tmp() }),
    ).toThrow(/no-such-dir/);
  });
});
