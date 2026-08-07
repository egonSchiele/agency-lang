import { AgencyConfig } from "@/config.js";
import { runBundledAgent, type AgentLaunchOptions } from "./runBundledAgent.js";

export function agent(
  config: AgencyConfig,
  args: string[] = [],
  options: AgentLaunchOptions = {},
): void {
  // Budget flags travel inside args; the launcher pre-scans and validates
  // them (resolveAgentLaunchArgs) before spawn.
  runBundledAgent(config, "agency-agent", args, options);
}
