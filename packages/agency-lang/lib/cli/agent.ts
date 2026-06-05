import { AgencyConfig } from "@/config.js";
import { runBundledAgent } from "./runBundledAgent.js";

export function agent(config: AgencyConfig, args: string[] = []): void {
  runBundledAgent(config, "agency-agent", args);
}
