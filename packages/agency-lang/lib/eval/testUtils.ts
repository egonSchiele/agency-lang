import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

/** A local git repo with two commits on main and a v1 tag at the first.
 *  Callers own cleanup of the returned directory. */
export function makeRepo(): { repo: string; first: string; second: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  fs.writeFileSync(path.join(repo, "tests", "a.txt"), "v1");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one");
  const first = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "tests", "a.txt"), "v2");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two");
  const second = git("rev-parse", "HEAD");
  git("tag", "v1", first);
  return { repo, first, second };
}
