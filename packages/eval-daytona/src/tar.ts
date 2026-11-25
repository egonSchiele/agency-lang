import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const MAX_BUFFER = 1024 * 1024 * 1024;

/** The paths to pack from `dir` so that every entry of `exclude` is left
 *  out: whole entries where nothing under them is excluded, and a walk
 *  further down only along the way to an excluded path. Each entry of
 *  `exclude` is a path from the top of `dir`, such as "node_modules" or
 *  "runs/tonight"; a folder of the same name deeper down is kept.
 *
 *  The list is built here because tar's own `--exclude` anchors its
 *  patterns differently on macOS and on Linux. */
export function pathsToPack(dir: string, exclude: string[], under = ""): string[] {
  return fs.readdirSync(path.join(dir, under)).flatMap((name) => {
    const relative = under === "" ? name : `${under}/${name}`;
    if (exclude.includes(relative)) {
      return [];
    }
    const holdsExcluded = exclude.some((entry) => entry.startsWith(`${relative}/`));
    return holdsExcluded ? pathsToPack(dir, exclude, relative) : [relative];
  });
}

/** A tar of a directory's contents, with `exclude` left out (see
 *  `pathsToPack`).
 *
 *  macOS's tar adds a `._<name>` entry for each file that carries extended
 *  attributes unless told not to, and a test runner in the container takes
 *  those for test files. */
export function tarDirectory(dir: string, exclude: string[] = []): Buffer {
  const paths = pathsToPack(dir, exclude).map((entry) => `./${entry}`);
  // With nothing to pack, an empty file list still makes a valid, empty tar.
  const what = paths.length === 0 ? ["-T", "/dev/null"] : ["--", ...paths];
  return execFileSync("tar", ["-cf", "-", "--no-xattrs", "-C", dir, ...what], {
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Unpacks a gzipped tar into `dest`, which must exist. */
export function untarGz(archive: Buffer, dest: string): void {
  execFileSync("tar", ["-xzf", "-", "-C", dest], { input: archive, stdio: ["pipe", "ignore", "pipe"] });
}
