import { main } from "./agent.js";
import { rmSync } from "fs";
import { execFileSync } from "child_process";

rmSync("sessions", { recursive: true, force: true });
process.env.PALETTE = "A";
await main();

// Resume in a fresh process that registers a different palette first.
execFileSync(process.execPath, ["./resume-stage.js"], {
  stdio: "inherit",
  env: { ...process.env, RESUME: "1", PALETTE: "B" },
});
