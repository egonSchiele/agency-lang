/**
 * Reads a regular file that must live inside `root`, with no window in
 * which a swap can redirect the read.
 *
 * A plain "resolve, check containment, then readFileSync(path)" has a gap:
 * between the check and the read, the file or any ancestor directory can be
 * replaced with a symlink pointing outside, and the read follows it. Here
 * the bytes always come from one descriptor, and the descriptor itself is
 * what gets validated:
 *
 *   1. open O_RDONLY|O_NONBLOCK|O_NOFOLLOW — a final-component symlink
 *      fails to open; a FIFO returns instead of blocking.
 *   2. fstat the descriptor: must be a regular file.
 *   3. realpath the path AFTER the open and require it to sit strictly
 *      inside root — this catches an ancestor swapped to a link that is
 *      still in place.
 *   4. stat that real path and require the same (dev, ino) as the
 *      descriptor — this catches a swap that was undone again after the
 *      open: the descriptor would then name a different file than the
 *      one now at the validated path.
 *   5. read from the descriptor.
 */
import * as fs from "fs";
import * as path from "path";
import { isStrictDescendant } from "../utils.js";

export type ReadContainedFileSeams = {
  /** Test-only: runs between the open and the validation, where a
   *  concurrent swap would land. */
  afterOpen?: () => void;
};

export function readContainedFile(
  root: string,
  target: string,
  seams: ReadContainedFileSeams = {},
): string {
  const realRoot = fs.realpathSync(path.resolve(root));
  const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(target, flags);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error(`'${target}' is not a regular file`);
    }
    seams.afterOpen?.();
    const real = fs.realpathSync(target);
    if (!isStrictDescendant(realRoot, real)) {
      throw new Error(`'${target}' resolves to '${real}', which is outside '${realRoot}'`);
    }
    const onDisk = fs.statSync(real);
    if (onDisk.dev !== opened.dev || onDisk.ino !== opened.ino) {
      throw new Error(`'${target}' changed between validation and read`);
    }
    return fs.readFileSync(fd, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}
