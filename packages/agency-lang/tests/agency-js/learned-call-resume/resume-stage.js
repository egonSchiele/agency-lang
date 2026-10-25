import { approve, hasInterrupts, respondToInterrupts } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const persisted = JSON.parse(readFileSync("test-output/interrupts.json", "utf8"));
const resumed = await respondToInterrupts(persisted, persisted.map(() => approve()));
writeFileSync("__result.json", JSON.stringify({
  before: JSON.parse(readFileSync("test-output/before.json", "utf8")),
  finalData: resumed.data,
  handlersRestored: !hasInterrupts(resumed.data),
  effectsAfter: readFileSync("test-output/effects.log", "utf8"),
}, null, 2));
