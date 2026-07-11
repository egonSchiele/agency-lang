import { AgencyConfig } from "@/config.js";
import { runBundledAgent } from "./runBundledAgent.js";
import { mcpCommand } from "./mcpCommand.js";

export function agent(config: AgencyConfig, args: string[] = []): void {
  // `agency agent mcp …` manages MCP servers in config files (TS, no agent
  // boot). Everything else launches the bundled agent.
  if (args[0] === "mcp") {
    void mcpCommand(config, args.slice(1)).then((code) => {
      process.exitCode = code;
    });
    return;
  }
  runBundledAgent(config, "agency-agent", args);
}
