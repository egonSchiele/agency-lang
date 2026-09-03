import { lstat, mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";

export { bashParser as _bashParser, astToBash as _astToBash } from "tarsec/parsers/bash";

/** Where safeBash keeps command output too long to return in full, relative
 * to the working directory the command ran in. Inside the project on
 * purpose: the agent's read tools are auto-approved there and nowhere else. */
export const TOOL_OUTPUT_DIR = ".agency-agent/tool-output";

/** Write `text` to a fresh file under TOOL_OUTPUT_DIR in `cwd`. Returns the
 * directory (absolute) and the file name, the two arguments the read tool
 * takes. Refuses to write through a symlink in the output path, since a
 * repository could otherwise redirect saved output outside `cwd`. */
export async function _spillOutput(
  cwd: string,
  text: string,
): Promise<{ dir: string; filename: string }> {
  let dir = path.resolve(cwd);
  for (const segment of TOOL_OUTPUT_DIR.split("/")) {
    dir = path.join(dir, segment);
    await refuseSymlink(dir);
    await mkdir(dir, { recursive: true });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${stamp}-${randomBytes(3).toString("hex")}.log`;
  // "wx": never overwrite, even on a clock collision.
  await writeFile(path.join(dir, filename), text, { flag: "wx", mode: 0o600 });
  return { dir, filename };
}

async function refuseSymlink(p: string): Promise<void> {
  try {
    if ((await lstat(p)).isSymbolicLink()) {
      throw new Error(`refused: '${p}' is a symlink`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
