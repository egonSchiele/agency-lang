import * as fs from "fs";
import * as path from "path";
import { buildSymbolTable } from "@/symbolTable.js";

type FileData = {
  path: string;
  content: string;
};

// Recursively discover and read all user source files reachable from the entrypoint.
// Excludes stdlib files (only includes files under the source directory).
function discoverSourceFiles(sourceFile: string): FileData[] {
  const sourceDir = path.dirname(path.resolve(sourceFile));
  const symbolTable = buildSymbolTable(sourceFile);
  const absSourceFile = path.resolve(sourceFile);

  // buildSymbolTable silently skips missing files, so check the entrypoint is in the table
  if (!symbolTable[absSourceFile]) {
    throw new Error(`Source file not found or failed to parse: ${sourceFile}`);
  }

  return Object.keys(symbolTable)
    .filter((absPath) => {
      const rel = path.relative(sourceDir, absPath);
      return !path.isAbsolute(rel) && !rel.startsWith("..");
    })
    .map((absPath) => ({
      // Normalize to POSIX separators for cross-platform portability
      path: path.relative(sourceDir, absPath).split(path.sep).join("/"),
      content: fs.readFileSync(absPath, "utf-8"),
    }));
}

function writeBundle(
  traceLines: string[],
  sources: FileData[],
  entrypoint: string,
  outputFile: string,
): void {
  const header = { ...JSON.parse(traceLines[0]), bundle: true, program: entrypoint };

  const fd = fs.openSync(outputFile, "w");
  try {
    fs.writeSync(fd, JSON.stringify(header) + "\n");

    for (const source of sources) {
      fs.writeSync(fd, JSON.stringify({
        type: "source",
        path: source.path,
        content: source.content,
      }) + "\n");
    }

    // Copy trace lines after the header, skipping any existing source lines
    for (let i = 1; i < traceLines.length; i++) {
      const parsed = JSON.parse(traceLines[i]);
      if (parsed.type !== "source") {
        fs.writeSync(fd, traceLines[i] + "\n");
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function createBundle(
  sourceFile: string,
  traceFile: string,
  outputFile: string,
): void {
  const traceContent = fs.readFileSync(traceFile, "utf-8").trim();
  const traceLines = traceContent.split("\n");
  if (traceLines.length === 0) {
    throw new Error("Invalid trace file: empty");
  }

  const sources = discoverSourceFiles(sourceFile);
  const entrypoint = path.basename(sourceFile);
  writeBundle(traceLines, sources, entrypoint, outputFile);
}
