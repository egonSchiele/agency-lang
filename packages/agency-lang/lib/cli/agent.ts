import { AgencyConfig } from "@/config.js";
import { runBundledAgent } from "./runBundledAgent.js";

export function agent(
  config: AgencyConfig,
  args: string[] = [],
  budget?: { maxCost?: string; maxTime?: string },
): void {
  runBundledAgent(config, "agency-agent", args, {}, budget);
}
