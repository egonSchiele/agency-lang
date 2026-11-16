import { approve, respondToInterrupts } from "./agent.js";
import { readFileSync, writeFileSync } from "node:fs";

const saved = JSON.parse(readFileSync("interrupts.json", "utf8"));
const resumed = await respondToInterrupts(saved, [approve("Ada")]);
writeFileSync("result.json", JSON.stringify({ finalData: resumed.data }));
