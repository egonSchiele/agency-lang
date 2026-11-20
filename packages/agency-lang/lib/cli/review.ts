import { AgencyConfig } from "@/config/config.js";
import { runBundledAgent } from "./runBundledAgent.js";
import * as path from "path";

export function review(config: AgencyConfig, targetFile: string): Promise<void> {
  return runBundledAgent(config, "review", [process.argv[1], path.resolve(targetFile)]);
}
