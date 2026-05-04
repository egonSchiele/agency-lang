import { AgencyConfig } from "@/config.js";
import { runBundledAgent } from "./runBundledAgent.js";
import * as path from "path";

export function review(config: AgencyConfig, targetFile: string): void {
  runBundledAgent(config, "review", [process.argv[1], path.resolve(targetFile)]);
}
