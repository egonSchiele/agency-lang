import * as path from "path";
import { getPackageRoot } from "./importPaths.js";

/** The path of the `agency` command line, for a process that starts
 *  another `agency` command. Inside a command it is the script this
 *  process was started with. Anywhere else, such as a compiled program or
 *  a test, it is the package's own build. */
export function agencyCliPath(): string {
  const argv1 = process.argv[1] ?? "";
  if (path.basename(argv1) === "agency.js") return argv1;
  return path.join(getPackageRoot(), "dist", "scripts", "agency.js");
}
