import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { remove, root } from "agency-lang/stdlib-lib/contained.js";

/** A new directory directly under the temp directory, spelled without
 *  symlinks, which the contained file helpers refuse. */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(root(os.tmpdir()).real, prefix));
}

/** Deletes a directory made by makeTempDir. Refuses anything that is not
 *  directly under the temp directory. */
export function removeTempDir(dir: string): void {
  const tmp = root(os.tmpdir());
  if (path.dirname(dir) !== tmp.real) {
    throw new Error(`refusing to delete ${dir}: it is not directly under ${tmp.real}`);
  }
  remove(tmp, path.basename(dir));
}
