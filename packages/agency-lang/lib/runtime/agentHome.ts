import os from "os";
import path from "path";

/** The agent home directory: `AGENCY_AGENT_HOME`, or `~/.agency-agent`.
 *  An empty variable counts as unset, so a set-but-blank value never
 *  turns the home into the current directory. A relative override is
 *  resolved against the process cwd, the way the `--agent-home` launcher
 *  resolves it. */
export function agentHomeDir(): string {
  const override = process.env.AGENCY_AGENT_HOME;
  if (override !== undefined && override !== "") {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".agency-agent");
}
