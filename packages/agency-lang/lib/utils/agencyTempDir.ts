import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

/**
 * A fresh scratch directory under `.agency-tmp/`.
 *
 * Three places needed one and each built the path by hand: the subprocess
 * runner in `lib/runtime/ipc.ts`, the checker in `lib/compiler/typecheck.ts`,
 * and the splice runner. Same shape, three copies, and getting it wrong is
 * not obvious.
 *
 * The location is not arbitrary. It has to sit inside the project so that
 * Node resolves `agency-lang` package imports through the project's own
 * `node_modules`, and so that `safeDeleteDirectory` will agree to remove it
 * afterwards. `os.tmpdir()` fails both.
 *
 * @param label short prefix naming the caller, so a leftover directory says
 *   who left it
 * @param parent directory that should contain `.agency-tmp/`; defaults to
 *   the current working directory
 */
export function makeAgencyTempDir(label: string, parent: string = process.cwd()): string {
  const dir = path.join(parent, ".agency-tmp", `${label}-${nanoid()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
