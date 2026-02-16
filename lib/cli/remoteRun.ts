import { AgencyConfig } from "@/config.js";
import { getStatelogClient } from "@/statelogClient.js";
import { Result } from "@/types/result.js";
import { getImportsRecursively } from "./util.js";
import fs from "fs";
import { parseAgency } from "@/parser.js";
import { exit } from "process";
export async function remoteRun(
  config: AgencyConfig,
  filename: string,
): Promise<Result<any>> {
  const client = getStatelogClient({
    host: config.log?.host || "http://localhost:1065",
    projectId: config.log?.projectId || "agency-lang",
    debugMode: config.log?.debugMode || false,
  });

  const imports = getImportsRecursively(filename);
  const allFiles = [filename, ...imports];
  const files = allFiles.map((file) => ({
    name: file,
    contents: fs.readFileSync(file, "utf-8"),
  }));

  const parsed = files.map((file) => {
    return parseAgency(file.contents, config);
  });

  const errors = parsed
    .filter((p) => p.success === false)
    .map((p) => p.message);

  if (errors.length > 0) {
    console.error("Errors parsing agency files:", errors);
    exit(1);
  }

  const result = await client.remoteRun({
    files,
    entrypoint: filename,
    args: [],
  });
  console.log(JSON.stringify(result));
  return result;
}
