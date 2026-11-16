import { AgencyConfig } from "@/config/config.js";
import { coreAgent } from "./coreAgent.js";
import { runBundledAgent, type AgentLaunchOptions } from "./runBundledAgent.js";

export function agent(
  config: AgencyConfig,
  args: string[] = [],
  options: AgentLaunchOptions = {},
): void {
  // SPIKE: the terminal front-end over the shared session core.
  if (args[0] === "--core") {
    void coreAgent(args.slice(1));
    return;
  }
  // Budget flags travel inside args; the launcher pre-scans and validates
  // them (resolveAgentLaunchArgs) before spawn.
  runBundledAgent(config, "agency-agent", args, options);
}
