// std::shell — run a command and capture its output.
import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);

export async function shell(command: string, args: string[]): Promise<string> {
  const { stdout } = await run(command, args);
  return stdout;
}
