import path from "#path";
import type { Host } from "../host/host.js";

/** The agent home directory: `AGENCY_AGENT_HOME`, or `~/.agency-agent`.
 *  An empty variable counts as unset, so a set-but-blank value never
 *  turns the home into the current directory. A relative override is
 *  resolved against the working directory, the way the `--agent-home`
 *  launcher resolves it. Reads the variable and the directories through
 *  the host. */
export function agentHomeDir(host: Pick<Host, "settings" | "system">): string {
  const override = host.settings.read("AGENCY_AGENT_HOME");
  if (override !== null && override !== "") {
    return path.resolve(host.system.cwd(), override);
  }
  return path.join(host.system.homeDir(), ".agency-agent");
}
