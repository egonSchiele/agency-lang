import { AgencyConfig } from "@/config/config.js";
import { runBundledAgent, type AgentLaunchOptions } from "./runBundledAgent.js";

export function agent(
  config: AgencyConfig,
  args: string[] = [],
  options: AgentLaunchOptions = {},
): Promise<void> {
  // Budget flags travel inside args; the launcher pre-scans and validates
  // them (resolveAgentLaunchArgs) before spawn.
  return runBundledAgent(config, "agency-agent", args, options);
}
