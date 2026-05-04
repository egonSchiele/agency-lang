import { AgencyConfig } from "@/config.js";
import { runBundledAgent } from "./runBundledAgent.js";

export function agent(config: AgencyConfig): void {
  runBundledAgent(config, "agency-agent");
}
