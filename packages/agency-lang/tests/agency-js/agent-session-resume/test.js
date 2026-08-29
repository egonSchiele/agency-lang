import { main } from "./agent.js";
import { writeFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";

rmSync("sessions", { recursive: true, force: true });
process.env.LINES = "hello,world";
await main();

// Resume in a fresh Node process, the way `agency agent --continue` does.
execFileSync(process.execPath, ["./resume-stage.js"], {
  stdio: "inherit",
  env: { ...process.env, RESUME: "1", LINES: "third" },
});
