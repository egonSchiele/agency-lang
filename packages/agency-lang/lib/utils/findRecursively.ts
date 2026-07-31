import * as fs from "fs";
import * as path from "path";

/** Yield every file under `dirName` with the given extension, skipping
 *  dotfiles, symlinks, and `ignoreDirs`, without revisiting directories. */
export function* findRecursively(
  dirName: string,
  ext: string = ".agency",
  searched: string[] = [],
  ignoreDirs: string[] = [],
): Generator<{ path: string }> {
  searched.push(path.resolve(dirName));
  // Find all .agency files in the directory
  const files = fs.readdirSync(dirName);
  const filesToProcess = files.filter((file) => {
    if (file.startsWith(".")) return false;
    if (ignoreDirs.includes(file)) return false;
    return (
      file.endsWith(ext) ||
      fs.statSync(path.join(dirName, file)).isDirectory()
    );
  });

  for (const file of filesToProcess) {
    const fullPath = path.join(dirName, file);
    if (fs.lstatSync(fullPath).isSymbolicLink()) {
      continue;
    }
    if (fs.statSync(fullPath).isDirectory()) {
      if (!searched.includes(path.resolve(fullPath))) {
        yield* findRecursively(fullPath, ext, searched, ignoreDirs);
      }
    } else {
      yield { path: fullPath };
    }
  }
}
