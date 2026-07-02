// Stage 2 of the durability test: a fresh Node process that resumes purely
// from the persisted interrupts JSON. Nothing from stage 1 survives except
// that file — no in-memory state, no compiled artifacts on disk.
import { approve, respondToInterrupts } from "./agent.js";
import { readFileSync, writeFileSync, rmSync } from "fs";

const persisted = JSON.parse(readFileSync("persisted-interrupts.json", "utf-8"));
const resumed = await respondToInterrupts(persisted, persisted.map(() => approve()));
rmSync("persisted-interrupts.json", { force: true });

writeFileSync("__result.json", JSON.stringify({
  finalData: resumed.data,
}, null, 2));
