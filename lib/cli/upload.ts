import { parseAgency } from "../parser.js";
import { AgencyConfig } from "@/config.js";
import fs from "fs";
import path from "path";
import { findRecursively } from "./util.js";
import {
  getStatelogClient,
  mergeUploadResults,
  UploadResult,
} from "@/statelogClient.js";
import { Result } from "@/types/result.js";
import { getImports } from "./commands.js";

export async function upload(
  config: AgencyConfig,
  inputFile: string,
): Promise<UploadResult> {
  // Check if the input is a directory
  const stats = fs.statSync(inputFile);
  const verbose = config.verbose ?? false;
  if (stats.isDirectory()) {
    const results: UploadResult[] = [];
    for (const { path } of findRecursively(inputFile)) {
      const result = await upload(config, path);
      results.push(result);
    }
    const allResults = mergeUploadResults(results);
    if (!allResults.success) {
      console.log("Failure uploading files", allResults.error);
    } else {
      console.log("Successfully uploaded files to Statelog");
      console.log(allResults.value);
    }
    return allResults;
  }
  const imports = getImportsRecursively(inputFile);
  const allFiles = [inputFile, ...imports];
  const files = allFiles.map((file) => ({
    name: path.relative(process.cwd(), file),
    contents: fs.readFileSync(file, "utf-8"),
  }));
  const client = getStatelogClient({
    host: config.log?.host || "http://localhost:1065",
    projectId: config.log?.projectId || "agency-lang",
    debugMode: config.log?.debugMode || false,
  });
  console.log(files);
  const result = await client.upload({
    projectId: config.log?.projectId || "agency-lang",
    entrypoint: inputFile,
    files,
  });

  if (!result.success) {
    console.log("Failure uploading files", result.error);
  } else {
    console.log("Successfully uploaded files to Statelog");
    console.log(result.value);
  }
  return result;
}

export async function remoteRun(
  config: AgencyConfig,
  filename: string,
): Promise<Result<any>> {
  const client = getStatelogClient({
    host: config.log?.host || "http://localhost:1065",
    projectId: config.log?.projectId || "agency-lang",
    debugMode: config.log?.debugMode || false,
  });

  const result = await client.remoteRun({
    userId: "1",
    projectId: config.log?.projectId || "agency-lang",
    filename,
    nodeName: "bar",
    body: "",
  });
  console.log(JSON.stringify(result));
  return result;
}

export function getImportsRecursively(
  filename: string,
  visited = new Set<string>(),
): string[] {
  if (visited.has(filename)) {
    return [];
  }
  visited.add(filename);
  const contents = fs.readFileSync(filename, "utf-8");
  const parsed = parseAgency(contents, { verbose: false });
  if (!parsed.success) {
    console.error(`Error parsing ${filename}:`, parsed);
    return [];
  }
  const program = parsed.result;
  const imports = getImports(program);
  for (const imp of imports) {
    const importedFile = path.resolve(path.dirname(filename), imp);
    if (fs.existsSync(importedFile)) {
      imports.push(...getImportsRecursively(importedFile, visited));
    } else {
      console.warn(`Warning: Imported file ${importedFile} not found.`);
    }
  }
  return imports;
}
