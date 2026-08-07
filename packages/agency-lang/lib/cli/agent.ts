import { AgencyConfig } from "@/config.js";
import { runBundledAgent } from "./runBundledAgent.js";

export function agent(config: AgencyConfig, args: string[] = []): void {
  // Budget flags travel inside args; the launcher pre-scans and validates
  // them (resolveAgentLaunchArgs) before spawn.
  runBundledAgent(config, "agency-agent", args);
}
