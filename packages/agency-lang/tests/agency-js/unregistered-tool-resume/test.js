import { main, hasInterrupts, __setLLMClient } from "./agent.js";
import { scriptedClient } from "./client.js";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const results = {};
for (const kind of ["unregistered", "created"]) {
  __setLLMClient(scriptedClient("initial", kind, {}));
  const initial = await main(kind);
  if (!hasInterrupts(initial.data)) throw new Error(`Expected ${kind} to pause`);
  const saved = `${kind}-interrupts.json`;
  const result = `${kind}-result.json`;
  writeFileSync(saved, JSON.stringify(initial.data));
  execFileSync(process.execPath, ["./resume-stage.js", kind], { stdio: "inherit" });
  results[kind] = JSON.parse(readFileSync(result, "utf8"));
  unlinkSync(saved);
  unlinkSync(result);
}
writeFileSync("__result.json", JSON.stringify(results, null, 2));
