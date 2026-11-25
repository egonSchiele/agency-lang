import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** The folder of the agency-lang package installed for a project: the
 *  nearest `node_modules/agency-lang` at or above the project directory,
 *  which is where Node would find it. Looked up by hand, because the
 *  package's `exports` do not include its package.json, so `require.resolve`
 *  cannot be asked for it. */
export function installedAgencyDir(projectDir: string): string {
  let dir = path.resolve(projectDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", "agency-lang");
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return fs.realpathSync(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `agency-lang is not installed in ${projectDir}; install it there, or name a tarball with "agency": { "tarball": … } in eval-daytona.json`,
      );
    }
    dir = parent;
  }
}

/** A tarball of the agency-lang package installed in the project, written
 *  into `destDir`. Installing it in the container gives the container the
 *  same agency the project uses, so the wrapper and the inner `agency eval
 *  run` cannot disagree about flags or about the run directory. */
export function packInstalledAgency(projectDir: string, destDir: string): string {
  const packageDir = installedAgencyDir(projectDir);
  fs.mkdirSync(destDir, { recursive: true });
  // --pack-destination: without it the tarball lands in the package's own
  // folder, which for pnpm is the shared store.
  const printed = execFileSync("npm", ["pack", "--pack-destination", destDir], {
    cwd: packageDir,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
  const name = printed.trim().split("\n").pop() ?? "";
  const tarball = path.join(destDir, name);
  if (name === "" || !fs.existsSync(tarball)) {
    throw new Error(`npm pack did not write a tarball into ${destDir}`);
  }
  return tarball;
}
