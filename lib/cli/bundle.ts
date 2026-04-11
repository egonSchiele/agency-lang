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

function readJsonlLines(filePath: string, label: string): string[] {
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (content.length === 0) {
    throw new Error(`Invalid ${label}: empty`);
  }
  return content.split("\n");
}

export function extractBundle(
  bundleFile: string,
  outputDir: string,
): void {
  const lines = readJsonlLines(bundleFile, "bundle file");
  const baseDir = path.resolve(outputDir);
  fs.mkdirSync(baseDir, { recursive: true });

  const header = JSON.parse(lines[0]);
  const traceLines: string[] = [];
  const createdDirs = new Set<string>();

  for (const line of lines) {
    const parsed = JSON.parse(line);
    if (parsed.type === "source") {
      if (path.isAbsolute(parsed.path)) {
        throw new Error(`Invalid source path: absolute paths not allowed: ${parsed.path}`);
      }
      const filePath = path.resolve(baseDir, parsed.path);
      if (!filePath.startsWith(baseDir + path.sep)) {
        throw new Error(`Invalid source path: escapes target directory: ${parsed.path}`);
      }
      const dir = path.dirname(filePath);
      if (!createdDirs.has(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        createdDirs.add(dir);
      }
      fs.writeFileSync(filePath, parsed.content, "utf-8");
      console.log(`  ${parsed.path}`);
    } else {
      traceLines.push(line);
    }
  }

  const traceName = path.basename(header.program || "trace").replace(/\.agency$/, "") + ".trace";
  const traceFilePath = path.resolve(baseDir, traceName);
  if (!traceFilePath.startsWith(baseDir + path.sep)) {
    throw new Error(`Invalid trace path: escapes target directory: ${traceName}`);
  }
  fs.writeFileSync(traceFilePath, traceLines.join("\n") + "\n", "utf-8");
  console.log(`  ${traceName}`);
}

export function createBundle(
  sourceFile: string,
  traceFile: string,
  outputFile: string,
): void {
  const traceLines = readJsonlLines(traceFile, "trace file");

  const sources = discoverSourceFiles(sourceFile);
  const entrypoint = path.basename(sourceFile);
  writeBundle(traceLines, sources, entrypoint, outputFile);
}
