import fs from "fs";
import path from "path";

/**
 * A discovered .agency file with its name and path.
 */
export type AgencyFile = {
  name: string;
  filePath: string;
};

/**
 * A discovered .agency file paired with a companion file (.mjs, .json, etc.).
 */
export type FixturePair = AgencyFile & {
  agencyContent: string;
  companionPath: string;
  companionContent: string;
};

/**
 * Recursively discovers all .agency files in a directory.
 */
export function discoverAgencyFiles(fixtureDir: string): AgencyFile[] {
  const files: AgencyFile[] = [];

  function scanDirectory(dir: string, relativePath: string = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        scanDirectory(fullPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith(".agency")) {
        const baseName = entry.name.replace(".agency", "");
        const nameWithoutExt = relativePath
          ? `${relativePath}/${baseName}`
          : baseName;
        files.push({ name: nameWithoutExt, filePath: fullPath });
      }
    }
  }

  scanDirectory(fixtureDir);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Recursively discovers .agency files paired with a companion file
 * (e.g. .mjs or .json) in a directory. Only returns pairs where both
 * files exist.
 */
export function discoverFixturePairs(
  fixtureDir: string,
  companionExt: string,
): FixturePair[] {
  const fixtures: FixturePair[] = [];

  for (const { name, filePath } of discoverAgencyFiles(fixtureDir)) {
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, ".agency");
    const companionPath = path.join(dir, `${baseName}${companionExt}`);

    if (fs.existsSync(companionPath)) {
      try {
        fixtures.push({
          name,
          filePath,
          agencyContent: fs.readFileSync(filePath, "utf-8"),
          companionPath,
          companionContent: fs.readFileSync(companionPath, "utf-8"),
        });
      } catch (error) {
        console.error(
          `Cannot read fixture ${filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      console.warn(
        `Warning: No corresponding ${companionExt} file for ${filePath}`,
      );
    }
  }

  return fixtures;
}
