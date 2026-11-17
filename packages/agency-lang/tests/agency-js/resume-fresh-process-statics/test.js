// Pauses in this process, then resumes the saved interrupts in a new
// process that never calls `main()`. The resumed run reads a static
// from the entry module and one from an imported module, so both
// modules' static values must be set up by the resume itself.
import { main, hasInterrupts } from "./agent.js";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const initial = await main();
if (!hasInterrupts(initial.data)) throw new Error("Expected main() to pause");
writeFileSync("interrupts.json", JSON.stringify(initial.data));
execFileSync(process.execPath, ["./resume-stage.js"], { stdio: "inherit" });
const result = JSON.parse(readFileSync("result.json", "utf8"));
unlinkSync("interrupts.json");
unlinkSync("result.json");
writeFileSync("__result.json", JSON.stringify(result, null, 2));
