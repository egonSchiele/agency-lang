// Launches the bundled agent as a separate child process. The agent
// reaches waypoint-lang only through the package's public `exports`,
// the same surface a user's compiled program uses.
import { spawn } from "child_process";
import { fileURLToPath } from "url";

export function runBundledAgent(args: string[]): void {
  const entry = fileURLToPath(new URL("../agent/harness/session.js", import.meta.url));
  const child = spawn(process.execPath, [entry, ...args], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}
