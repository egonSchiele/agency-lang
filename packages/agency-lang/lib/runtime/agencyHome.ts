import path from "#path";
import type { Host } from "../host/host.js";

/** Agency's own per-user directory: `AGENCY_HOME`, or `~/.agency`. This
 *  is where Agency keeps what belongs to the user rather than to a project
 *  or to the built-in agent (`agentHomeDir` is the agent's). An empty
 *  variable counts as unset, and a relative override is resolved against
 *  the working directory, as `agentHomeDir` does. Reads the variable and
 *  the directories through the host, so a test points it at a temporary
 *  directory and no test touches the real home. */
export function agencyHomeDir(host: Pick<Host, "settings" | "system">): string {
  const override = host.settings.read("AGENCY_HOME");
  if (override !== null && override !== "") {
    return path.resolve(host.system.cwd(), override);
  }
  return path.join(host.system.homeDir(), ".agency");
}
