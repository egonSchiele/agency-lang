import * as path from "path";
import { getPackageRoot } from "./importPaths.js";

/** Where a build keeps the command line, below its root. */
const CLI_IN_BUILD = path.join("dist", "scripts", "agency.js");

/** The path of the `agency` command line, for a process that starts
 *  another `agency` command. Inside a command it is the script this
 *  process was started with. Anywhere else, such as a compiled program or
 *  a test, it is the package's own build.
 *
 *  The script counts as the command line only when it sits where a build
 *  puts it. The file name alone is not enough: a program compiled from
 *  `agency.agency` is also called `agency.js`. */
export function agencyCliPath(script: string = process.argv[1] ?? ""): string {
  if (script.endsWith(path.sep + CLI_IN_BUILD)) return script;
  return path.join(getPackageRoot(), CLI_IN_BUILD);
}
