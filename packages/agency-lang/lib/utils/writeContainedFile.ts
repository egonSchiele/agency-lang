/**
 * Writes a regular file that must live inside `root`, with no window in
 * which a swap can redirect the write. The write-side twin of
 * readContainedFile: the descriptor is what gets validated, and no byte
 * is written before it passes.
 *
 *   1. open O_WRONLY|O_NOFOLLOW — a final-component symlink fails to open.
 *      A file that does not exist yet is created with O_CREAT|O_EXCL after
 *      its parent directory is validated the same way (below).
 *   2. fstat the descriptor: must be a regular file.
 *   3. realpath the path AFTER the open and require it to sit strictly
 *      inside root — this catches an ancestor swapped to a link that is
 *      still in place.
 *   4. stat that real path and require the same (dev, ino) as the
 *      descriptor — this catches a swap that was undone again after the
 *      open.
 *   5. truncate and write through the descriptor.
 *
 * Creating a file has one residue: if an ancestor is swapped to a link
 * between the parent check and the create, an empty file can be left at
 * the link's target. Nothing is written into it, and the call fails.
 */
import * as fs from "fs";
import * as path from "path";
import { isStrictDescendant } from "../utils.js";

export type WriteContainedFileSeams = {
  /** Test-only: runs between the open and the validation, where a
   *  concurrent swap would land. */
  afterOpen?: () => void;
};

export function writeContainedFile(
  root: string,
  target: string,
  content: string,
  seams: WriteContainedFileSeams = {},
): void {
  const realRoot = fs.realpathSync(path.resolve(root));
  const fd = openForWrite(realRoot, target);
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
      throw new Error(`'${target}' changed between validation and write`);
    }
    fs.ftruncateSync(fd);
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

function openForWrite(realRoot: string, target: string): number {
  const noFollow = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
  try {
    return fs.openSync(target, noFollow);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  // The file is new. Its parent must already be a real directory strictly
  // inside root, so a symlinked tool directory cannot receive a new file.
  const parent = path.dirname(target);
  if (fs.lstatSync(parent).isSymbolicLink()) {
    throw new Error(`'${parent}' is a symlink`);
  }
  const realParent = fs.realpathSync(parent);
  if (!isStrictDescendant(realRoot, realParent)) {
    throw new Error(`'${parent}' resolves to '${realParent}', which is outside '${realRoot}'`);
  }
  return fs.openSync(target, noFollow | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
}
