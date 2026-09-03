import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";

export { bashParser as _bashParser, astToBash as _astToBash } from "tarsec/parsers/bash";

/** Where safeBash keeps command output too long to return in full, relative
 * to the working directory the command ran in. Inside the project on
 * purpose: the agent's read tools are auto-approved there and nowhere else. */
export const TOOL_OUTPUT_DIR = ".agency-agent/tool-output";

/** Write `text` to a fresh file under TOOL_OUTPUT_DIR in `cwd` and return the
 * file's path relative to `cwd`, ready to hand to the read tool. */
export async function _spillOutput(cwd: string, text: string): Promise<string> {
  const dir = path.resolve(cwd, TOOL_OUTPUT_DIR);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}-${randomBytes(3).toString("hex")}.log`;
  // "wx": never overwrite, even on a clock collision.
  await writeFile(path.join(dir, name), text, { flag: "wx" });
  return `${TOOL_OUTPUT_DIR}/${name}`;
}
