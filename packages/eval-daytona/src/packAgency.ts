import { execFileSync } from "child_process";
import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";

/** A tarball of the agency-lang package installed in the project, written
 *  into `destDir`. Installing it in the container gives the container the
 *  same agency the project uses, so the wrapper and the inner `agency eval
 *  run` cannot disagree about flags or about the run directory. */
export function packInstalledAgency(projectDir: string, destDir: string): string {
  const require = createRequire(path.join(projectDir, "package.json"));
  let packageJson: string;
  try {
    packageJson = require.resolve("agency-lang/package.json");
  } catch {
    throw new Error(
      `agency-lang is not installed in ${projectDir}; install it there, or name a tarball with "agency": { "tarball": … } in eval-daytona.json`,
    );
  }
  fs.mkdirSync(destDir, { recursive: true });
  // --pack-destination: without it the tarball lands in the package's own
  // folder, which for pnpm is the shared store.
  const printed = execFileSync("npm", ["pack", "--pack-destination", destDir], {
    cwd: path.dirname(packageJson),
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
  const name = printed.trim().split("\n").pop() ?? "";
  const tarball = path.join(destDir, name);
  if (name === "" || !fs.existsSync(tarball)) {
    throw new Error(`npm pack did not write a tarball into ${destDir}`);
  }
  return tarball;
}
